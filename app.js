/* ============================================================
   app.js — Vigilo bootstrap & orchestration.
   Wires the lock screen, tabs, status bar and camera grid.
   ============================================================ */

import { auth } from './auth.js';
import { store } from './store.js';
import { Camera } from './camera.js';
import { Recorder } from './recorder.js';
import { notifications, toast } from './notify.js';
import { RelayClient, HostBroadcaster, RemoteViewer } from './remote.js';

const $ = sel => document.querySelector(sel);

const state = {
  cameras: [],       // Camera[]
  started: false,
  remoteAvailable: false,
  isHub: false,      // this device is sharing its cameras
  host: null,        // HostBroadcaster
  viewerMode: false, // this device is watching a hub
  viewer: null,      // RemoteViewer
  remoteTiles: {},   // camId -> { el, video, ... } (viewer mode)
  hostOnline: false,
};

/* ============================================================
   LOCK SCREEN
   ============================================================ */
function initLock() {
  const lock = $('#lock-screen');
  const setupForm = $('#setup-form');
  const unlockForm = $('#unlock-form');

  if (auth.isConfigured()) {
    unlockForm.hidden = false;
    $('#unlock-pass').focus();
  } else {
    setupForm.hidden = false;
    $('#setup-pass').focus();
  }

  setupForm.addEventListener('submit', async e => {
    e.preventDefault();
    const p1 = $('#setup-pass').value;
    const p2 = $('#setup-pass2').value;
    const err = $('#setup-error');
    if (p1.length < 4) { err.textContent = 'Use at least 4 characters.'; return; }
    if (p1 !== p2) { err.textContent = 'Passwords do not match.'; return; }
    await auth.setPassword(p1);
    unlock();
  });

  unlockForm.addEventListener('submit', async e => {
    e.preventDefault();
    const ok = await auth.verify($('#unlock-pass').value);
    if (ok) { unlock(); }
    else { $('#unlock-error').textContent = 'Incorrect password.'; $('#unlock-pass').select(); }
  });

  $('#reset-pass').addEventListener('click', () => {
    if (confirm('Reset password? This clears your saved password and camera settings on this device.')) {
      auth.reset();
      store.clearAll();
      location.reload();
    }
  });

  function unlock() {
    lock.hidden = true;
    $('#app').hidden = false;
    initApp();
  }
}

/* ============================================================
   APP
   ============================================================ */
function initApp() {
  initTabs();
  initToolbar();
  initClock();
  initRemote();
  restoreToggles();
  checkSecureContext();
  $('#lock-btn').addEventListener('click', lockNow);
}

/* ---------- Secure-context check ----------
   Browsers only expose cameras on a secure origin (https:// or localhost).
   Opening http://<ip> on a phone is insecure, so getUserMedia is missing.
   Detect that up front and tell the user exactly how to fix it. */
function cameraReady() {
  return window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
}

function checkSecureContext() {
  const banner = $('#insecure-banner');
  if (!banner) return;
  if (cameraReady()) { banner.hidden = true; return; }

  const host = location.hostname || 'this-computer';
  const httpsUrl = `https://${host}:8443`;
  $('#insecure-banner-msg').innerHTML =
    `Your browser only allows camera access over <code>https://</code> or ` +
    `<code>localhost</code>. On the computer running Vigilo, start it with ` +
    `<code>python serve.py</code>, then open the secure address it prints — ` +
    `for this device that's about <code>${httpsUrl}</code> ` +
    `(accept the one-time certificate warning). The <strong>Enable Cameras</strong> ` +
    `button stays disabled until then.`;
  banner.hidden = false;

  // Block the camera button so the failure isn't a mystery.
  const start = $('#start-btn');
  start.disabled = true;
  start.textContent = 'Cameras need HTTPS';
}

function lockNow() {
  // Privacy: stop all cameras, tear down streaming, return to lock screen.
  closeStreaming();
  state.cameras.forEach(c => c.destroy());
  state.cameras = [];
  state.started = false;
  renderGrid();
  updateStatus();
  $('#app').hidden = true;
  const lock = $('#lock-screen');
  lock.hidden = false;
  $('#unlock-form').hidden = false;
  $('#setup-form').hidden = true;
  $('#unlock-pass').value = '';
  $('#unlock-error').textContent = '';
  $('#unlock-pass').focus();
}

/* ---------- Tabs ---------- */
function selectTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $('#view-' + tab).classList.add('active');
}

function initTabs() {
  $('#tabs').addEventListener('click', e => {
    const btn = e.target.closest('.tab');
    if (btn) selectTab(btn.dataset.tab);
  });
}

/* ---------- Toolbar / toggles ---------- */
function initToolbar() {
  $('#start-btn').addEventListener('click', startCameras);
  $('#refresh-btn').addEventListener('click', rescanCameras);

  const notifyToggle = $('#notify-toggle');
  notifyToggle.addEventListener('change', async () => {
    if (notifyToggle.checked) {
      const res = await notifications.request();
      if (res !== 'granted') notifyToggle.checked = false;
    }
    store.set('notifyOnMotion', notifyToggle.checked);
  });

  const motionRec = $('#motion-rec-toggle');
  motionRec.addEventListener('change', () => {
    store.set('motionOnlyRecording', motionRec.checked);
    if (motionRec.checked && !Recorder.supported()) {
      toast('Recording unavailable', 'This browser does not support MediaRecorder.', 'warn');
    }
  });
}

function restoreToggles() {
  $('#notify-toggle').checked = store.get('notifyOnMotion') && notifications.permission === 'granted';
  $('#motion-rec-toggle').checked = !!store.get('motionOnlyRecording');
}

/* ---------- Clock & status ---------- */
function initClock() {
  const tick = () => {
    $('#status-clock').textContent = new Date().toLocaleTimeString();
  };
  tick();
  setInterval(tick, 1000);
}

function updateStatus() {
  const active = state.cameras.filter(c => c.running).length;
  $('#status-cams').textContent = `${active} camera${active === 1 ? '' : 's'}`;

  const recording = state.cameras.filter(c => c.isRecording).length;
  const recChip = $('#status-rec');
  if (recording > 0) {
    recChip.hidden = false;
    recChip.innerHTML = `<span class="dot"></span> REC ${recording}`;
  } else {
    recChip.hidden = true;
  }

  // Keep remote viewers in sync when the shared camera set changes.
  if (state.host) state.host.syncCameras();
}

/* ============================================================
   CAMERA DETECTION
   ============================================================ */
async function startCameras() {
  if (!cameraReady()) {
    checkSecureContext();
    toast('Cameras need a secure connection',
      'Open Vigilo over https:// (run "python serve.py") or on localhost. See the banner above.',
      'danger', 9000);
    return;
  }

  const btn = $('#start-btn');
  btn.disabled = true;
  btn.textContent = 'Requesting…';

  // 1) Prompt for permission so device labels become available.
  let probe;
  try {
    probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Enable Cameras';
    const msg = e.name === 'NotAllowedError'
      ? 'Permission denied. Allow camera access and try again.'
      : 'Could not access any camera.';
    toast('Camera blocked', msg, 'danger', 7000);
    return;
  }
  // Release the probe stream; individual cameras open their own.
  probe.getTracks().forEach(t => t.stop());

  await buildCameras();

  state.started = true;
  btn.disabled = false;
  btn.textContent = 'Cameras Enabled';
}

async function rescanCameras() {
  if (!state.started) { startCameras(); return; }
  await buildCameras();
  toast('Re-scanned', `${state.cameras.length} camera${state.cameras.length === 1 ? '' : 's'} detected.`);
}

async function buildCameras() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter(d => d.kind === 'videoinput');

  // Remove cameras that disappeared.
  const liveIds = new Set(cams.map(c => c.deviceId));
  state.cameras = state.cameras.filter(c => {
    if (!liveIds.has(c.deviceId)) { c.destroy(); return false; }
    return true;
  });

  // Add cameras that are new.
  const existingIds = new Set(state.cameras.map(c => c.deviceId));
  cams.forEach((device, i) => {
    if (existingIds.has(device.deviceId)) return;
    const cam = new Camera(device, i, {
      getNotifyEnabled: () => $('#notify-toggle').checked,
      getMotionOnlyRecording: () => $('#motion-rec-toggle').checked,
      onChange: updateStatus,
      onMotion: () => {},
    });
    state.cameras.push(cam);
  });

  renderGrid();

  // Start each camera that the user has enabled.
  for (const cam of state.cameras) {
    if (cam.enabled && !cam.running) {
      try { await cam.start(); } catch { /* surfaced on the tile */ }
    }
  }
  updateStatus();

  if (cams.length === 0) {
    toast('No cameras found', 'Connect a webcam and click Re-scan.', 'warn', 6000);
  }
}

function renderGrid() {
  const grid = $('#camera-grid');
  const empty = $('#empty-state');
  grid.innerHTML = '';
  state.cameras.forEach(c => grid.appendChild(c.el));
  empty.hidden = state.cameras.length > 0;
}

/* ============================================================
   Device hot-plug: refresh list when webcams change.
   ============================================================ */
if (navigator.mediaDevices) {
  navigator.mediaDevices.addEventListener?.('devicechange', () => {
    if (state.started) buildCameras().then(updateStatus);
  });
}

/* Warn before closing while recording. */
window.addEventListener('beforeunload', e => {
  if (state.cameras.some(c => c.isRecording)) {
    e.preventDefault();
    e.returnValue = '';
  }
});

/* Leave the relay cleanly so we don't linger as a stale host/viewer. */
window.addEventListener('pagehide', () => {
  state.host?.relay.leave();
  state.viewer?.relay.leave();
});

/* ============================================================
   REMOTE ACCESS (Home Hub + auto-connecting Viewer)
   ============================================================ */

/** The bridge the Home Hub exposes to remote viewers. */
const hubApi = {
  getSources: () => state.cameras
    .filter(c => c.running && c.stream)
    .map(c => ({ id: c.deviceId, stream: c.stream })),
  getState: () => state.cameras
    .filter(c => c.running)
    .map(c => ({
      id: c.deviceId, name: c.name, sensitivity: c.sensitivity,
      running: c.running, recording: c.isRecording, motion: c.motionActive,
    })),
  applyCommand: (cmd) => {
    const cam = state.cameras.find(c => c.deviceId === cmd.camId);
    if (!cam) return;
    switch (cmd.cmd) {
      case 'record':      cam.setManualRecording(cmd.on); break;  // record on the hub
      case 'sensitivity': cam.setSensitivity(cmd.value);   break;
      case 'toggle':      cam.setEnabled(cmd.on);          break;
      case 'rename':      cam.setName(cmd.name);           break;
    }
  },
};

async function initRemote() {
  state.remoteAvailable = await RelayClient.available();
  if (!state.remoteAvailable) {
    $('#hub-label').hidden = true;
    renderRemotePanel();
    return;
  }
  $('#hub-label').hidden = false;

  $('#hub-toggle').addEventListener('change', e => {
    if (e.target.checked) enableHub(); else disableHub();
  });
  $('#viewer-exit').addEventListener('click', exitViewerMode);

  // Watch for a hub coming online so the phone auto-connects.
  renderRemotePanel();
  setInterval(pollPresence, 5000);
  pollPresence();
}

async function pollPresence() {
  if (state.isHub || state.viewerMode) return;
  state.hostOnline = await RelayClient.presence();
  renderRemotePanel();
  if (state.hostOnline) enterViewerMode();   // a hub appeared — connect to it
}

/* ---------- Home Hub (host) ---------- */
async function enableHub() {
  if (state.host) return;
  if (!cameraReady()) {
    toast('Hub needs HTTPS', 'Start Vigilo with "python serve.py" so cameras work here first.', 'warn', 7000);
    $('#hub-toggle').checked = false;
    return;
  }
  if (state.cameras.filter(c => c.running).length === 0) {
    toast('Enable cameras first', 'Turn on the cameras you want to share, then enable the Hub.', 'warn');
    $('#hub-toggle').checked = false;
    return;
  }
  state.host = new HostBroadcaster(hubApi);
  try {
    await state.host.start();
    state.isHub = true;
    $('#status-hub').hidden = false;
    $('#hub-toggle').checked = true;
    toast('Home Hub on', 'Your phone can now connect from anywhere.', 'info');
  } catch (e) {
    state.host = null;
    $('#hub-toggle').checked = false;
    toast('Could not start Hub', String(e), 'danger');
  }
  renderRemotePanel();
}

function disableHub() {
  if (state.host) { state.host.stop(); state.host = null; }
  state.isHub = false;
  $('#status-hub').hidden = true;
  $('#hub-toggle').checked = false;
  renderRemotePanel();
}

/* ---------- Remote Viewer (this device watches a hub) ---------- */
function enterViewerMode() {
  if (state.viewerMode || state.isHub) return;
  state.viewerMode = true;

  // Hide local-camera controls; the dashboard becomes the remote view.
  $('#start-btn').hidden = true;
  $('#refresh-btn').hidden = true;
  $('#hub-label').hidden = true;
  $('#empty-state').hidden = true;
  $('#insecure-banner').hidden = true;
  $('#camera-grid').innerHTML = '';
  state.remoteTiles = {};
  $('#viewer-banner').hidden = false;
  selectTab('dashboard');

  state.viewer = new RemoteViewer({
    onTrack: ({ camId, track }) => attachRemoteTrack(camId, track),
    onState: cams => updateRemoteTiles(cams),
    onStatus: s => updateViewerBanner(s),
  });
  state.viewer.start();
  renderRemotePanel();
}

function exitViewerMode() {
  if (state.viewer) { state.viewer.stop(); state.viewer = null; }
  state.viewerMode = false;
  Object.values(state.remoteTiles).forEach(t => { try { t.localRec?.stop(); } catch {} });
  state.remoteTiles = {};
  $('#camera-grid').innerHTML = '';
  $('#viewer-banner').hidden = true;
  $('#start-btn').hidden = false;
  $('#refresh-btn').hidden = false;
  $('#hub-label').hidden = !state.remoteAvailable;
  $('#empty-state').hidden = state.cameras.length > 0;
  renderGrid();
  renderRemotePanel();
}

function updateViewerBanner(status) {
  const title = $('#viewer-banner-title');
  const msg = $('#viewer-banner-msg');
  const map = {
    searching:    ['Looking for your Home Hub…', 'Make sure the camera computer has 📡 Home Hub switched on.'],
    connecting:   ['Connecting to your Home Hub…', 'Setting up a private, direct link.'],
    connected:    ['📡 Live — viewing your Home Hub', 'Full control: record, sensitivity, on/off, rename.'],
    reconnecting: ['Reconnecting…', 'The link dropped — getting it back automatically.'],
    offline:      ['Home Hub is offline', 'Waiting for the camera computer to come back online.'],
  };
  const [t, m] = map[status] || map.connecting;
  title.textContent = t;
  msg.textContent = m;
}

/* ---- remote tiles (rendered on the viewer) ---- */
function ensureRemoteTile(camId) {
  if (state.remoteTiles[camId]) return state.remoteTiles[camId];
  const tpl = document.getElementById('remote-tile-template');
  const el = tpl.content.firstElementChild.cloneNode(true);
  const t = {
    el,
    video: el.querySelector('.cam-video'),
    nameInput: el.querySelector('.cam-name'),
    sens: el.querySelector('.cam-sens'),
    toggleBtn: el.querySelector('.cam-toggle'),
    recordBtn: el.querySelector('.cam-record'),
    recTarget: el.querySelector('.rec-target'),
    fsBtn: el.querySelector('.cam-fs'),
    motionBadge: el.querySelector('.motion-badge'),
    recBadge: el.querySelector('.rec-badge'),
    running: true, recording: false, stream: null, localRec: null,
  };

  t.nameInput.addEventListener('change', () =>
    state.viewer?.command({ cmd: 'rename', camId, name: t.nameInput.value.trim() }));
  t.sens.addEventListener('input', () =>
    state.viewer?.command({ cmd: 'sensitivity', camId, value: Number(t.sens.value) }));
  t.toggleBtn.addEventListener('click', () =>
    state.viewer?.command({ cmd: 'toggle', camId, on: !t.running }));
  t.fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement === el) document.exitFullscreen?.();
    else el.requestFullscreen?.().catch(() => {});
  });
  t.recordBtn.addEventListener('click', () => toggleRemoteRecording(camId, t));

  $('#camera-grid').appendChild(el);
  state.remoteTiles[camId] = t;
  return t;
}

function attachRemoteTrack(camId, track) {
  const t = ensureRemoteTile(camId);
  t.stream = new MediaStream([track]);
  t.video.srcObject = t.stream;
}

function updateRemoteTiles(cams) {
  const present = new Set(cams.map(c => c.id));
  for (const cam of cams) {
    const t = ensureRemoteTile(cam.id);
    t.running = cam.running;
    if (document.activeElement !== t.nameInput) t.nameInput.value = cam.name;
    if (document.activeElement !== t.sens) t.sens.value = cam.sensitivity;
    t.toggleBtn.classList.toggle('on', cam.running);
    t.motionBadge.hidden = !cam.motion;
    t.el.dataset.state = cam.motion ? 'motion' : 'on';
    // "recording" badge reflects hub-side recording; local recording shown via button.
    t.hostRecording = cam.recording;
    t.recBadge.hidden = !(cam.recording || (t.localRec && t.localRec.active));
    t.recordBtn.classList.toggle('recording', cam.recording || (t.localRec && t.localRec.active));
  }
  // Cameras that vanished from the hub (turned off) — mark their tiles off.
  for (const [id, t] of Object.entries(state.remoteTiles)) {
    if (!present.has(id)) { t.el.dataset.state = 'off'; t.toggleBtn.classList.remove('on'); t.running = false; }
  }
}

function toggleRemoteRecording(camId, t) {
  const target = t.recTarget.value; // host | phone | both
  // Hub-side recording
  if (target === 'host' || target === 'both') {
    state.viewer?.command({ cmd: 'record', camId, on: !t.hostRecording });
  }
  // Phone-side recording (record the incoming stream locally)
  if (target === 'phone' || target === 'both') {
    if (t.localRec && t.localRec.active) {
      t.localRec.stop(); t.localRec = null;
    } else if (t.stream && Recorder.supported()) {
      t.localRec = new Recorder(t.stream, () => (t.nameInput.value || 'remote') + '_phone');
      t.localRec.start();
    } else if (!Recorder.supported()) {
      toast('Phone recording unavailable', 'This browser can’t record. Try "Save: Home" instead.', 'warn');
    }
    const recAny = t.hostRecording || (t.localRec && t.localRec.active);
    t.recBadge.hidden = !recAny;
    t.recordBtn.classList.toggle('recording', !!recAny);
  }
}

/* ---- remote status panel (Remote Access tab) ---- */
function renderRemotePanel() {
  const dot = $('#remote-dot'), head = $('#remote-headline'),
        detail = $('#remote-detail'), actions = $('#remote-actions');
  if (!dot) return;
  actions.innerHTML = '';
  const setDot = c => { dot.className = 'remote-dot ' + c; };

  if (!state.remoteAvailable) {
    setDot('grey');
    head.textContent = 'Remote access is off';
    detail.innerHTML = 'Start Vigilo with <code>python serve.py</code> (not <code>python -m http.server</code>) to turn on remote access.';
    return;
  }
  if (state.viewerMode) {
    setDot('green');
    head.textContent = '📡 Viewing your Home Hub';
    detail.textContent = 'You are controlling the cameras remotely. Open the Dashboard to see them.';
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'Stop viewing';
    btn.onclick = exitViewerMode;
    actions.appendChild(btn);
    return;
  }
  if (state.isHub) {
    setDot('green');
    head.textContent = 'This computer is the Home Hub';
    const addr = location.host;
    detail.innerHTML = `Sharing your cameras. On your phone (over Tailscale when away), open <code>${location.protocol}//${addr}</code> and it connects automatically.`;
    return;
  }
  if (state.hostOnline) {
    setDot('green');
    head.textContent = 'Your Home Hub is online';
    detail.textContent = 'Connecting you to the live cameras…';
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.textContent = 'Watch live now';
    btn.onclick = enterViewerMode;
    actions.appendChild(btn);
    return;
  }
  setDot('amber');
  head.textContent = 'No Home Hub online yet';
  detail.innerHTML = 'On the computer with your cameras, enable cameras then switch on <strong>📡 Home Hub</strong> in the Dashboard toolbar.';
}

function closeStreaming() {
  if (state.host) { state.host.stop(); state.host = null; }
  if (state.viewer) { state.viewer.stop(); state.viewer = null; }
  state.isHub = false;
  state.viewerMode = false;
  Object.values(state.remoteTiles).forEach(t => { try { t.localRec?.stop(); } catch {} });
  state.remoteTiles = {};
  $('#status-hub').hidden = true;
}

/* ============================================================
   GO
   ============================================================ */
initLock();
