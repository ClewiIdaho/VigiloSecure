# 🛡️ Vigilo — Private Home Security

**Turn the webcams you already own into a private security system that runs entirely on your own device.**

Vigilo is a free, open-source, privacy-first home security app. It is a plain folder of HTML/CSS/JavaScript — no backend, no cloud, no accounts, no installs. You run it with one command and open it in your browser. **Your video never leaves your computer.**

---

## Why Vigilo exists

Most "smart" security cameras send your footage to a company's servers, lock features behind a subscription, and ask you to trust them with the inside of your home. Vigilo is the opposite:

- 🆓 **Free forever** — no subscriptions, no paywalls.
- 🔒 **Private by design** — feeds, recordings, and your password stay on your device.
- 🌐 **No cloud** — there is literally no server to send your data to.
- 🧩 **Open source** — read every line, audit it, change it (MIT licensed).
- ⚡ **No install** — pure browser tech, works offline.

If you have a laptop with a built-in webcam, or a few USB webcams, you already have everything you need.

---

## Features

- **Multi-camera dashboard** — auto-detects every connected webcam (USB or built-in) and shows them in a responsive grid that adapts from 1 to 6+ cameras.
- **Motion detection** — per-camera detection with a sensitivity slider, an on-screen indicator, and optional browser notifications.
- **Recording** — save clips to your Downloads folder with the MediaRecorder API. Continuous recordings auto-split every 2 hours, plus an optional **motion-only** mode that records solely when something moves.
- **Per-camera controls** — nickname each camera, toggle it on/off, and click to go fullscreen.
- **Clean dark UI** — modern security-app look, fully mobile responsive.
- **Password lock** — a simple password gate stored only in your browser (no server, no account).
- **Remote access guide** — built-in step-by-step instructions for free, encrypted remote viewing via Tailscale.

---

## Requirements

You only need two things:

1. **A modern web browser** — Chrome or Firefox recommended.
2. **Python** — almost certainly already installed. Check with:
   ```bash
   python --version
   ```
   If that fails, try `python3 --version`. No Python? Get it free at [python.org](https://www.python.org/downloads/).

That's it. No Node, no npm, no build step, no dependencies to download.

---

## Setup — step by step

**1. Get the files.** Download this folder (or `git clone` it) to your computer.

**2. Open a terminal in the Vigilo folder.**
   - **Windows:** open the folder in File Explorer, click the address bar, type `cmd`, press Enter.
   - **macOS:** right-click the folder → *New Terminal at Folder*.
   - **Linux:** open your terminal and `cd` into the folder.

**3. Start the local server:**
   ```bash
   python -m http.server 8000
   ```
   (If `python` doesn't work, use `python3 -m http.server 8000`.)

**4. Open Vigilo in your browser:**
   ```
   http://localhost:8000
   ```

**5. Create a password** when prompted (stored only in your browser), then click **Enable Cameras** and allow access when the browser asks.

> 💡 **Why a server instead of double-clicking `index.html`?** Browsers only allow camera access on `http://localhost` or `https://` for security. Opening the file directly (`file://`) will block the cameras. The tiny Python server fixes this — it serves everything locally and uploads nothing.

---

## View from your phone or another device

Want to watch from your phone while the cameras run on a laptop? Use the included launcher — it serves Vigilo over **HTTPS** so the camera works on *any* device, not just the host:

```bash
python serve.py
```
(Use `python3 serve.py` if `python` isn't found.)

It auto-creates a self-signed certificate, listens on every network interface, and prints two addresses:

```
On this computer : https://localhost:8443
On your phone    : https://192.168.1.50:8443   ← your host's real IP
```

On your phone (same Wi-Fi, or over Tailscale — see below), open the **phone** address. The first visit shows a "not secure" warning — that's expected for a self-signed certificate. Tap **Advanced → Proceed/Continue** once, and the camera will work because the page is now HTTPS.

> 💡 **Why HTTPS?** Browsers only allow camera access (`getUserMedia`) on `https://` or `localhost`. That's why `http://localhost:8000` works on the host but `http://<ip>:8000` fails on a phone — the phone is on a plain-HTTP origin, so the browser disables the camera. `serve.py` gives every device a secure origin. The dashboard even shows a banner explaining this if you ever land on an insecure address.

**Just want plain HTTP on the host only?** The original one-liner still works for local use:
```bash
python -m http.server 8000 --bind 0.0.0.0
```
…but cameras will only grant on `localhost`/HTTPS, so phones can view the page without live camera permissions. Prefer `serve.py` for multi-device.

**Finding your host's IP** (if you need it manually):
- **Windows:** `ipconfig` → *IPv4 Address* (e.g. `192.168.1.50`)
- **macOS/Linux:** `ipconfig getifaddr en0` or `hostname -I`

---

## Remote viewing from anywhere

Vigilo can stream the **host computer's cameras** straight to a phone or laptop using **WebRTC peer-to-peer** — the video travels directly between your two devices and never touches any server. There are two pieces:

1. **Pairing** (built into the **Remote Access** tab) connects the two devices.
2. **Tailscale** (optional) lets them find each other across the internet.

### Pairing — Host & Viewer

The device **with the cameras** is the **Host**; the device you **watch from** is the **Viewer**.

1. On the **Host** (the computer with webcams): enable your cameras on the Dashboard, open **Remote Access → Host**, click **Create invite code**, and copy it.
2. Send that code to your other device (paste into a note, message, etc.).
3. On the **Viewer** (phone/laptop): open Vigilo → **Remote Access → Viewer**, paste the invite code, click **Generate reply code**, and copy the reply.
4. Paste the reply code back on the **Host** and click **Connect**.

The Host's live camera feeds now appear on the Viewer. This works on the same Wi-Fi out of the box; for internet access, do the pairing while both devices are on Tailscale (below).

> The pairing code is a one-time handshake (an encrypted WebRTC offer/answer). It carries no video — it just lets the two devices open a direct, encrypted connection. No code or video is ever sent to a third party.

### Tailscale — connect across the internet

To reach your cameras when you're away from home — without any cloud — Vigilo recommends **Tailscale**, a free, encrypted private network. The app has a built-in **Remote Access** tab with these steps, summarized here:

1. **Install Tailscale on the host computer** (the one running the server): [tailscale.com/download](https://tailscale.com/download). Sign in. Note its Tailscale IP (`100.x.x.x`) via `tailscale ip -4`.
2. **Install Tailscale on your phone/laptop** and sign in with the **same account**.
3. **Start the server** on the host: `python serve.py`
4. **Open** `https://100.x.x.x:8443` on your phone (with Tailscale on), and accept the one-time certificate warning. Because `serve.py` serves HTTPS, cameras work right away — no extra steps.

Prefer a trusted certificate with no browser warning? Use Tailscale's free HTTPS instead:
```bash
tailscale cert
tailscale serve https / http://localhost:8000   # with: python -m http.server 8000
```
Then visit `https://your-machine.your-tailnet.ts.net`. See the [Tailscale HTTPS docs](https://tailscale.com/kb/1153/enabling-https).

Your video travels only through Tailscale's end-to-end encrypted tunnel directly between your devices — it never touches anyone else's servers.

---

## What this app does **NOT** do — by design

- ❌ **No cloud storage or streaming.** Footage never goes to any server.
- ❌ **No accounts, email, or sign-ups.** Nothing to register.
- ❌ **No telemetry, analytics, or tracking.** Zero external requests.
- ❌ **No background/always-on recording when the tab is closed.** It runs while the page is open in your browser.
- ❌ **No AI person/face recognition.** Motion detection is simple pixel-difference comparison, done locally.

The password lock is convenience-grade snooping protection stored in your browser's localStorage — it is **not** a replacement for locking your actual computer.

---

## Project structure

```
VigiloSecure/
├── serve.py        # One-command HTTPS launcher (works on any device)
├── index.html      # App shell: lock screen, dashboard, tabs
├── style.css       # Dark, mobile-first theme
├── app.js          # Bootstrap & orchestration
├── camera.js       # Camera class (stream + tile + motion + recording)
├── motion.js       # Canvas frame-difference motion detection
├── recorder.js     # MediaRecorder wrapper with 2-hour rolling clips
├── webrtc.js       # Peer-to-peer camera streaming (Host/Viewer)
├── notify.js       # Browser notifications + in-app toasts
├── auth.js         # Serverless salted-hash password gate
├── store.js        # localStorage settings persistence
├── README.md
└── LICENSE
```

Built with only **getUserMedia**, **MediaRecorder**, and **Canvas** — standard browser APIs, no frameworks.

---

## Screenshots

> _Add your own screenshots here._

| Dashboard | Mobile | Remote Access |
|-----------|--------|---------------|
| _(screenshot placeholder)_ | _(screenshot placeholder)_ | _(screenshot placeholder)_ |

---

## Browser support

| Browser | Cameras | Recording | Notifications |
|---------|:-------:|:---------:|:-------------:|
| Chrome / Edge | ✅ | ✅ | ✅ |
| Firefox | ✅ | ✅ | ✅ |
| Safari | ✅ | ⚠️ partial | ⚠️ partial |

Use Chrome or Firefox for the full feature set.

---

## Troubleshooting

- **Works on the host, but the camera is dead on my phone.** This is the #1 gotcha: browsers block cameras on plain `http://<ip>` addresses. Run `python serve.py` on the host and open the **https://** address it prints on your phone (accept the one-time certificate warning). The dashboard shows a yellow banner whenever you're on an insecure address.
- **Cameras won't start / "Permission denied".** Make sure you opened `http://localhost:8000` (or an `https://` address from `serve.py`), not the file directly. Allow camera access in the browser prompt (and in the site permissions if you previously blocked it).
- **"In use by another app".** Close other apps using the webcam (Zoom, Teams, etc.), then click **Re-scan**.
- **No cameras detected.** Plug in the webcam and click **Re-scan**. Built-in laptop cameras are detected automatically.
- **No motion notifications.** Toggle *Notify on motion* and allow notifications when prompted. Some browsers suppress notifications on insecure origins.

---

## License

Released under the **MIT License** — free to use, modify, and share. See [LICENSE](LICENSE).

---

_Vigilo — privacy-first, people-first home security. Watch your home, not the cloud._
