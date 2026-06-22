# Vigilo — Private Home Security

Turn the webcams you already own into a home security system that runs entirely on your own computer. Your video never leaves your machine.

Vigilo is a plain folder of HTML, CSS, and JavaScript. There is no backend, no cloud, no account to create, and nothing to install. You start it with one command and open it in your web browser.

---

## What you need

Two things, and you probably already have both:

1. A web browser. Chrome or Firefox work best.
2. Python. Most computers already have it.

To check if you have Python, open a terminal (see Step 2 below for how) and type:

```
python --version
```

If that prints a version number, you are good. If it says "command not found," try `python3 --version`. If neither works, download Python for free from https://www.python.org/downloads/ and install it.

That is the whole list. No Node, no npm, no build step.

---

## Quick start (on one computer)

This runs Vigilo on the same computer the cameras are plugged into.

**Step 1 — Get the files onto your computer.**
Download this folder, or if you use git: `git clone` it.

**Step 2 — Open a terminal inside the Vigilo folder.**

- Windows: open the folder in File Explorer, click the address bar at the top, type `cmd`, and press Enter.
- Mac: right-click the folder and choose "New Terminal at Folder."
- Linux: open your terminal and use `cd` to move into the folder.

**Step 3 — Start Vigilo.** Type this and press Enter:

```
python -m http.server 8000
```

(If `python` does not work, use `python3 -m http.server 8000`.)

Leave that terminal window open. It is the server. Closing it stops Vigilo.

**Step 4 — Open Vigilo in your browser.** Go to this address:

```
http://localhost:8000
```

**Step 5 — Set it up.** The first time, Vigilo asks you to create a password. This password is stored only in your browser; there is no account and nothing is sent anywhere. Then click "Enable Cameras" and click "Allow" when the browser asks for camera permission.

That's it. Your cameras show up in a grid.

> Why a server instead of just double-clicking `index.html`? Web browsers only let a page use your camera when it is served from `http://localhost` or a secure `https://` address. Opening the file directly does not count, so the camera stays blocked. The little Python server fixes that. It runs only on your computer and uploads nothing.

---

## Watch from your phone or another device

Want the cameras to run on a laptop and watch them from your phone? Use the included launcher instead of the command above. It serves Vigilo over HTTPS, which is what lets the camera work on devices other than the host.

On the computer with the cameras, run:

```
python serve.py
```

(Use `python3 serve.py` if `python` does not work.)

The first time, it creates a security certificate for itself and then prints two addresses, like this:

```
On this computer : https://localhost:8443
On your phone    : https://192.168.1.50:8443   (this is your computer's address on the network)
```

On your phone, open the second address (the "On your phone" one). The phone must be on the same Wi-Fi as the computer, or connected through Tailscale (explained below).

The first time you open it, the phone shows a "not secure" or "your connection is not private" warning. This is expected, because the certificate is one Vigilo made itself rather than buying from a company. It is safe here because the connection only goes to your own computer. Tap "Advanced," then "Proceed" or "Continue." After that, the camera works because the page is now on a secure HTTPS address.

> How do I find my computer's address by hand? You usually don't need to; `serve.py` prints it for you. But if you want it: on Windows, run `ipconfig` and look at "IPv4 Address." On Mac or Linux, run `hostname -I` (or `ipconfig getifaddr en0` on Mac).

---

## Control your cameras from anywhere — the Home Hub

The "Home Hub" lets you watch and fully control your cameras from your phone, even when you are away from home. The phone sees live video, gets motion alerts, can record, and can change every setting — the same as sitting at the computer.

Here is how it works in plain terms: `serve.py` runs a tiny helper on your home computer that introduces your phone to the home computer. Once they are introduced, the video and your commands travel straight between your phone and your computer. Nothing passes through anyone else's servers, and the helper never sees your video.

### Setting up the Home Hub

**On the computer with the cameras:**

1. Run `python serve.py`.
2. Open the address it prints and click "Enable Cameras."
3. On the Dashboard, turn on the "Home Hub" switch in the toolbar.

**On your phone:**

1. Open the same address the computer printed (use Tailscale if you are away from home — see below).
2. Vigilo finds the hub and connects on its own. You land right on the live cameras.

From the phone you can:

- See live video from every camera on the home computer.
- Record, and choose where the clip is saved: on the home computer, on the phone, or both.
- Change motion sensitivity, turn cameras on or off, and rename them. The change happens on the home computer right away.

Only one device is the Home Hub (the computer with the cameras). Everything else just watches. If the connection drops, the watching devices reconnect on their own.

### Reaching home when you are away (Tailscale)

When your phone and computer are on the same Wi-Fi, the steps above are all you need. To connect from somewhere else — without any cloud — use Tailscale. It is a free private network that links your own devices together over an encrypted connection. Setup takes about five minutes.

1. Install Tailscale on the home computer from https://tailscale.com/download and sign in. After it connects, find its Tailscale address (it looks like `100.x.x.x`) by running `tailscale ip -4`.
2. Install the Tailscale app on your phone and sign in with the **same account**.
3. On the home computer, run `python serve.py` and turn on the Home Hub.
4. On your phone, with Tailscale switched on, open `https://100.x.x.x:8443` (use the address from step 1). Accept the one-time "not secure" warning, and it connects.

Prefer not to see the certificate warning at all? Tailscale can provide a trusted certificate for free:

```
tailscale cert
tailscale serve https / http://localhost:8443
```

Then open `https://your-machine.your-tailnet.ts.net`. Details are in the Tailscale HTTPS guide: https://tailscale.com/kb/1153/enabling-https

Your video only ever travels directly between your own devices over Tailscale's encrypted connection. It never touches anyone else's servers.

---

## What Vigilo does not do, on purpose

- No cloud. Your footage, settings, and password never go to anyone's servers. The only "server" is the small helper that runs on your own computer.
- No accounts, no email, no sign-up.
- No tracking, no analytics, no third-party requests.
- No recording when the tab is closed. The Home Hub records only while its dashboard is open.
- No face recognition or AI. Motion detection is a simple comparison of one video frame to the next, done on your computer.

The password lock keeps a casual snooper out of the dashboard. It is stored in your browser only. It is not a replacement for locking your actual computer.

---

## What each file does

```
VigiloSecure/
  serve.py        HTTPS launcher and the small helper for remote access
  index.html      The app itself: lock screen, dashboard, tabs
  style.css       The dark, mobile-friendly look
  app.js          Wires everything together
  camera.js       One camera: its video, tile, motion, and recording
  motion.js       Detects motion by comparing video frames
  recorder.js     Saves video clips, splitting every 2 hours
  remote.js       Home Hub and the remote viewer (the phone connection)
  notify.js       Browser notifications and in-app messages
  auth.js         The password lock (stores a scrambled hash, never the password)
  store.js        Saves your settings in the browser
  README.md       This file
  LICENSE         The license (MIT)
```

Vigilo is built only with standard browser features: getUserMedia, MediaRecorder, and Canvas. No frameworks.

---

## Which browsers work

| Browser       | Cameras | Recording | Notifications |
|---------------|:-------:|:---------:|:-------------:|
| Chrome / Edge | Yes     | Yes       | Yes           |
| Firefox       | Yes     | Yes       | Yes           |
| Safari        | Yes     | Partial   | Partial       |

Use Chrome or Firefox for everything to work.

---

## When something goes wrong

- **It works on the computer, but the camera is dead on my phone.** This is the most common problem. Browsers block cameras on plain `http://` addresses. On the computer, run `python serve.py` and open the `https://` address it prints on your phone. Accept the one-time security warning. Vigilo also shows a yellow banner whenever you are on an address that cannot use the camera.
- **The camera will not start, or it says "Permission denied."** Make sure you opened `http://localhost:8000` (or an `https://` address from `serve.py`), not the file by double-clicking it. Click "Allow" when the browser asks. If you blocked it before, fix that in the browser's site permissions.
- **It says "In use by another app."** Close other programs using the webcam (Zoom, Teams, FaceTime, and so on), then click "Re-scan."
- **No cameras show up.** Plug in the webcam and click "Re-scan." Built-in laptop cameras are found automatically.
- **No motion alerts.** Turn on "Notify on motion" and click "Allow" when the browser asks. Some browsers hide notifications on insecure addresses.

---

## License

Released under the MIT License. Free to use, change, and share. See the LICENSE file.
