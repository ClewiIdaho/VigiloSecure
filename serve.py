#!/usr/bin/env python3
"""
Vigilo launcher — serve the dashboard so it works on EVERY device.

Why this exists
---------------
Browsers only allow camera access (getUserMedia) in a "secure context":
that means https:// OR localhost. Opening the app on your computer at
http://localhost works, but opening http://<your-ip> on your phone does
NOT — the phone is on a plain-HTTP origin, so the browser disables the
camera entirely.

This script fixes that by serving Vigilo over HTTPS with a self-signed
certificate, bound to every network interface. Your phone (on the same
Wi-Fi, or over Tailscale) then loads a secure origin and cameras work.

Usage
-----
    python serve.py            # HTTPS on port 8443 (recommended)
    python serve.py --port 9000
    python serve.py --http     # plain HTTP, localhost-only camera access

No dependencies beyond Python's standard library (and `openssl`, which
ships with macOS/Linux and Git-for-Windows, to mint the certificate).
Nothing is uploaded anywhere — the server runs entirely on your machine.

It also runs a tiny in-memory "relay" (the /api/* endpoints) that lets a
remote device (your phone over Tailscale) auto-connect to this computer's
cameras and control them — no copy/paste codes. The relay only passes the
initial WebRTC handshake; the actual video and commands flow directly
device-to-device. Nothing is stored on disk and nothing leaves your machine.
"""

import argparse
import functools
import http.server
import ipaddress
import json
import os
import shutil
import socket
import ssl
import subprocess
import sys
import threading
import time
import uuid
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
CERT_DIR = os.path.join(HERE, ".vigilo-cert")
CERT_FILE = os.path.join(CERT_DIR, "cert.pem")
KEY_FILE = os.path.join(CERT_DIR, "key.pem")
IP_MARKER = os.path.join(CERT_DIR, "issued-for")

# ----- pretty output -------------------------------------------------------

def c(text, code):
    """Colorize text when stdout is a TTY."""
    if sys.stdout.isatty():
        return f"\033[{code}m{text}\033[0m"
    return text


# Tailscale hands out addresses in the 100.64.0.0/10 CGNAT range, which
# Python's ipaddress does NOT classify as "private". Cover it explicitly.
_TAILSCALE_NET = ipaddress.ip_network("100.64.0.0/10")


def _host_only(host_header):
    """Extract the bare hostname from a `Host:`/Origin netloc (strip port)."""
    h = (host_header or "").strip()
    if h.startswith("["):                      # [::1]:8443  -> ::1
        return h[1:].split("]", 1)[0].lower()
    if h.count(":") == 1:                       # 192.168.1.5:8443 -> 192.168.1.5
        h = h.rsplit(":", 1)[0]
    return h.lower()


def allowed_host(host_header):
    """True only for addresses Vigilo is ever meant to be reached at:
    loopback, the local LAN, link-local, Tailscale, and *.local/*.ts.net.

    This is the anti-DNS-rebinding / anti-CSRF check for the relay: a request
    arriving with a public hostname in its Host header (the hallmark of a
    rebinding attack from a malicious website) is refused."""
    h = _host_only(host_header)
    if not h:
        return False
    if h == "localhost" or h.endswith(".local") or h.endswith(".ts.net"):
        return True
    try:
        ip = ipaddress.ip_address(h)
    except ValueError:
        return False
    return (ip.is_loopback or ip.is_private or ip.is_link_local
            or ip in _TAILSCALE_NET)


def lan_ip():
    """Best-effort local network IP (the address phones on your Wi-Fi use)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # No packets are actually sent; this just picks the right interface.
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


# ----- certificate ---------------------------------------------------------

def ensure_cert(ip):
    """Create a self-signed cert covering localhost + this machine's LAN IP.

    Regenerates if the cert is missing or was issued for a different IP
    (e.g. you switched networks)."""
    have_cert = os.path.exists(CERT_FILE) and os.path.exists(KEY_FILE)
    issued_for = ""
    if os.path.exists(IP_MARKER):
        with open(IP_MARKER, encoding="utf-8") as fh:
            issued_for = fh.read().strip()
    if have_cert and issued_for == ip:
        return True

    if not shutil.which("openssl"):
        print(c("⚠  openssl was not found, so HTTPS can't be set up automatically.", "33"))
        print("   Install it (macOS/Linux usually have it; on Windows use Git Bash),")
        print("   or run plain HTTP with:  " + c("python serve.py --http", "36"))
        return False

    os.makedirs(CERT_DIR, exist_ok=True)
    san = f"subjectAltName=DNS:localhost,IP:127.0.0.1,IP:{ip}"
    base = [
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", KEY_FILE, "-out", CERT_FILE,
        "-days", "825", "-subj", "/CN=Vigilo",
    ]
    print(c("→ Generating a self-signed certificate (one time)…", "90"))
    try:
        # -addext needs OpenSSL 1.1.1+; fall back gracefully if unsupported.
        subprocess.run(base + ["-addext", san], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError:
        try:
            subprocess.run(base, check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except subprocess.CalledProcessError:
            print(c("⚠  Certificate generation failed.", "33"))
            return False

    with open(IP_MARKER, "w", encoding="utf-8") as fh:
        fh.write(ip)
    return True


# ----- signaling relay -----------------------------------------------------
#
# A minimal in-memory message switchboard so a phone can auto-connect to this
# computer's cameras. The host (this computer's dashboard) and each viewer
# (phone/laptop) "join", then exchange a one-time WebRTC offer/answer through
# here. After that, video + control flow peer-to-peer and the relay is idle.
# Everything is in RAM; nothing is written to disk.

CLIENT_TTL = 30          # seconds before an unseen client is dropped
POLL_TIMEOUT = 25        # seconds a long-poll waits for a message
MAX_CLIENTS = 64         # cap live clients so a join-flood can't exhaust RAM
MAX_MAILBOX = 100        # cap queued messages per client (drop-oldest)

_lock = threading.Lock()
_clients = {}            # id -> {"role": str, "seen": float}
_mailboxes = {}          # id -> [ {from,type,data}, ... ]
_host_id = None          # id of the current "home hub"


def _prune(now):
    global _host_id
    for cid in [c for c, info in _clients.items() if now - info["seen"] > CLIENT_TTL]:
        _clients.pop(cid, None)
        _mailboxes.pop(cid, None)
        if cid == _host_id:
            _host_id = None


# ----- server --------------------------------------------------------------

class Handler(http.server.SimpleHTTPRequestHandler):
    # ---- shared helpers ----
    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length else b""
        try:
            return json.loads(raw or b"{}")
        except (ValueError, TypeError):
            return {}

    def _send_json(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    # ---- request-origin guard ----
    def _api_allowed(self):
        """Refuse relay requests that don't originate from the local app.

        Two checks, both cheap and standard for a localhost-bound service:
          1. Host header must be a local/LAN/Tailscale address — blocks DNS
             rebinding, where a malicious site rebinds its domain to 127.0.0.1
             and drives the relay from the victim's browser.
          2. If an Origin header is present it must be same-origin — blocks a
             random website from POSTing to the relay (e.g. claiming the Hub
             slot) via a cross-site `fetch`.
        The legitimate app is always same-origin, so this is transparent."""
        host = self.headers.get("Host", "")
        if not allowed_host(host):
            return False
        origin = self.headers.get("Origin")
        if origin:
            netloc = urlparse(origin).netloc
            if not netloc or netloc.lower() != host.strip().lower():
                return False
        return True

    # ---- relay endpoints ----
    def _api_get(self, parsed):
        global _host_id
        if parsed.path == "/api/presence":
            with _lock:
                _prune(time.time())
                self._send_json({"hostOnline": _host_id is not None})
            return

        if parsed.path == "/api/poll":
            cid = (parse_qs(parsed.query).get("id") or [""])[0]
            deadline = time.time() + POLL_TIMEOUT
            while True:
                with _lock:
                    now = time.time()
                    _prune(now)
                    if cid not in _clients:
                        self._send_json({"messages": [], "hostOnline": _host_id is not None,
                                         "expired": True})
                        return
                    _clients[cid]["seen"] = now
                    msgs = _mailboxes.get(cid) or []
                    if msgs or time.time() >= deadline:
                        _mailboxes[cid] = []
                        self._send_json({"messages": msgs, "hostOnline": _host_id is not None})
                        return
                time.sleep(0.3)

        self._send_json({"error": "unknown"}, 404)

    def _api_post(self, parsed):
        global _host_id
        data = self._read_json()
        now = time.time()

        if parsed.path == "/api/join":
            with _lock:
                _prune(now)
                if len(_clients) >= MAX_CLIENTS:
                    self._send_json({"error": "busy"}, 503)
                    return
                cid = uuid.uuid4().hex[:12]
                if data.get("role") == "host":
                    _host_id = cid          # newest host takes the hub slot
                _clients[cid] = {"role": data.get("role"), "seen": now}
                _mailboxes[cid] = []
                self._send_json({"id": cid, "hostOnline": _host_id is not None})
            return

        if parsed.path == "/api/leave":
            with _lock:
                cid = data.get("id")
                _clients.pop(cid, None)
                _mailboxes.pop(cid, None)
                if cid == _host_id:
                    _host_id = None
                self._send_json({"ok": True})
            return

        if parsed.path == "/api/send":
            with _lock:
                _prune(now)
                target = _host_id if data.get("to") == "host" else data.get("to")
                if target and target in _mailboxes:
                    box = _mailboxes[target]
                    box.append({
                        "from": data.get("from"),
                        "type": data.get("type"),
                        "data": data.get("data"),
                    })
                    del box[:-MAX_MAILBOX]   # bound the queue (drop oldest)
                    self._send_json({"ok": True})
                else:
                    self._send_json({"ok": False, "error": "no-recipient"})
            return

        self._send_json({"error": "unknown"}, 404)

    # ---- HTTP verbs ----
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            if not self._api_allowed():
                return self._send_json({"error": "forbidden"}, 403)
            return self._api_get(parsed)
        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            if not self._api_allowed():
                return self._send_json({"error": "forbidden"}, 403)
            return self._api_post(parsed)
        self.send_error(404, "Not found")

    def send_head(self):
        # Never serve the certificate directory (it holds the private key).
        # Resolve the request to a real filesystem path FIRST: a raw-string
        # check on self.path is bypassable with URL-encoding (e.g. %2D), but
        # translate_path() decodes and normalises, so this catches every form.
        fs = os.path.abspath(self.translate_path(self.path))
        cert_dir = os.path.abspath(CERT_DIR)
        if fs == cert_dir or fs.startswith(cert_dir + os.sep):
            self.send_error(404, "Not found")
            return None
        return super().send_head()

    def end_headers(self):
        # Don't cache aggressively, so edits show up on reload across devices.
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Keep the console quiet and friendly; drop the per-request noise.
        pass


def run(host, port, use_https, ip):
    handler = functools.partial(Handler, directory=HERE)
    try:
        httpd = http.server.ThreadingHTTPServer((host, port), handler)
    except OSError as e:
        print(c(f"✗ Could not start on port {port}: {e}", "31"))
        print(f"  Another program may be using it — try:  python serve.py --port {port + 1}")
        sys.exit(1)

    scheme = "http"
    if use_https:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(CERT_FILE, KEY_FILE)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        scheme = "https"

    bar = "-" * 52
    print()
    print(c("  Vigilo is running.", "1;32"))
    print(c("  " + bar, "90"))
    print(f"  On this computer : {c(f'{scheme}://localhost:{port}', '36')}")
    if host in ("0.0.0.0", "::"):
        print(f"  On your phone    : {c(f'{scheme}://{ip}:{port}', '36')}")
        print(c("                     (same Wi-Fi, or your Tailscale address)", "90"))
    print(c("  " + bar, "90"))
    if use_https:
        print(c("  The first time you open this on a device, the browser", "33"))
        print(c("  shows a 'not secure' warning. That is expected, because", "33"))
        print(c("  the certificate is one Vigilo made itself. It is safe", "33"))
        print(c("  here. Tap Advanced, then Proceed. The camera then works.", "33"))
    else:
        print(c("  Plain HTTP: the camera works on THIS computer only.", "33"))
        print(c("  To use cameras on a phone, run without --http.", "33"))
    print(c("  " + bar, "90"))
    print(c("  Remote control is on. On this computer, open the dashboard", "32"))
    print(c("  and turn on the 'Home Hub' switch. Then open the same", "32"))
    print(c("  address on your phone to watch and control from anywhere.", "32"))
    print(c("  " + bar, "90"))
    print(c("  Press Ctrl+C to stop.", "90"))
    print()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n" + c("Vigilo stopped. Your data never left this machine.", "90"))
        httpd.server_close()


def main():
    ap = argparse.ArgumentParser(
        description="Serve Vigilo over HTTPS so it works on phones and other devices.")
    ap.add_argument("--port", type=int, default=8443,
                    help="Port to listen on (default: 8443, or 8000 with --http).")
    ap.add_argument("--host", default="0.0.0.0",
                    help="Interface to bind (default: 0.0.0.0 = all, reachable by other devices).")
    ap.add_argument("--http", action="store_true",
                    help="Serve plain HTTP instead of HTTPS (camera access localhost-only).")
    args = ap.parse_args()

    ip = lan_ip()
    use_https = not args.http
    port = args.port
    if args.http and port == 8443:
        port = 8000  # friendlier default for the plain-HTTP path

    if use_https:
        if not ensure_cert(ip):
            print(c("→ Falling back to plain HTTP (localhost-only cameras).", "33"))
            use_https = False
            if port == 8443:
                port = 8000

    run(args.host, port, use_https, ip)


if __name__ == "__main__":
    main()
