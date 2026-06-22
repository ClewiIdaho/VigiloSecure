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
"""

import argparse
import functools
import http.server
import os
import shutil
import socket
import ssl
import subprocess
import sys

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


# ----- server --------------------------------------------------------------

class Handler(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        # Never serve the certificate/private key over the network.
        if ".vigilo-cert" in self.path:
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

    bar = "─" * 52
    print()
    print(c("  🛡️  Vigilo is running", "1;32"))
    print(c("  " + bar, "90"))
    print(f"  On this computer : {c(f'{scheme}://localhost:{port}', '36')}")
    if host in ("0.0.0.0", "::"):
        print(f"  On your phone    : {c(f'{scheme}://{ip}:{port}', '36')}")
        print(c("                     (same Wi-Fi, or your Tailscale IP)", "90"))
    print(c("  " + bar, "90"))
    if use_https:
        print(c("  First visit on each device shows a 'not secure' warning —", "33"))
        print(c("  that's expected for a self-signed cert. Tap Advanced →", "33"))
        print(c("  Proceed/Continue. Cameras then work because it's HTTPS.", "33"))
    else:
        print(c("  Plain HTTP: cameras work on THIS computer only.", "33"))
        print(c("  For phone/remote camera access, run without --http.", "33"))
    print(c("  " + bar, "90"))
    print(c("  Press Ctrl+C to stop.", "90"))
    print()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n" + c("Vigilo stopped. Your data never left this machine. 👋", "90"))
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
