/* ============================================================
   app.js — Vigilo bootstrap & orchestration.
   Wires the lock screen, tabs, status bar and camera grid.
   ============================================================ */

import { auth } from './auth.js';
import { store } from './store.js';
import { Camera } from './camera.js';
import { Recorder } from './recorder.js';
import { notifications, toast } from './notify.js';
import { HostSession, ViewerSession } from './webrtc.js';

const $ = sel => document.querySelector(sel);

const state = {
  cameras: [],   // Camera[]
  started: false,
  host: null,    // HostSession
  viewer: null,  // ViewerSession
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
  initStreaming();
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
function initTabs() {
  $('#tabs').addEventListener('click', e => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === btn));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    $('#view-' + tab).classList.add('active');
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

/* ============================================================
   PEER-TO-PEER STREAMING (Host / Viewer)
   ============================================================ */
function setStatus(el, msg, kind = '') {
  el.textContent = msg;
  el.className = 'stream-status' + (kind ? ' ' + kind : '');
}

function copyFrom(textarea, btn) {
  textarea.select();
  navigator.clipboard?.writeText(textarea.value).catch(() => {});
  try { document.execCommand('copy'); } catch {}
  const orig = btn.textContent;
  btn.textContent = 'Copied ✓';
  setTimeout(() => { btn.textContent = orig; }, 1500);
}

function activeStreamSources() {
  return state.cameras
    .filter(c => c.running && c.stream)
    .map(c => ({ name: c.name, stream: c.stream }));
}

function initStreaming() {
  /* ---- HOST ---- */
  const hostStart = $('#host-start');
  hostStart.addEventListener('click', async () => {
    const sources = activeStreamSources();
    if (sources.length === 0) {
      toast('No cameras to share', 'Enable cameras on the Dashboard first.', 'warn');
      return;
    }
    if (state.host) state.host.close();
    state.host = new HostSession(sources, s => {
      const st = $('#host-status');
      if (s === 'connected') setStatus(st, '✓ Viewer connected — streaming live.', 'ok');
      else if (s === 'failed' || s === 'disconnected') setStatus(st, 'Connection lost. Create a new invite code to reconnect.', 'err');
      else setStatus(st, 'Status: ' + s);
    });
    hostStart.disabled = true;
    hostStart.textContent = 'Generating…';
    try {
      const code = await state.host.createInvite();
      $('#host-offer').value = code;
      $('#host-flow').hidden = false;
      setStatus($('#host-status'), 'Waiting for the Viewer’s reply code…');
    } catch (e) {
      toast('Could not create invite', String(e), 'danger');
    }
    hostStart.disabled = false;
    hostStart.textContent = 'Create new invite code';
  });

  $('#host-offer-copy').addEventListener('click', () => copyFrom($('#host-offer'), $('#host-offer-copy')));
  $('#host-connect').addEventListener('click', async () => {
    const code = $('#host-answer').value.trim();
    if (!code || !state.host) return;
    try {
      await state.host.acceptReply(code);
      setStatus($('#host-status'), 'Connecting…');
    } catch (e) {
      setStatus($('#host-status'), 'That reply code was not valid. Copy it again from the Viewer.', 'err');
    }
  });

  /* ---- VIEWER ---- */
  const remoteTiles = {}; // mid -> { tile, video, nameEl }
  let pendingNames = {};

  function ensureTile(mid) {
    if (remoteTiles[mid]) return remoteTiles[mid];
    const tile = document.createElement('div');
    tile.className = 'remote-tile';
    const video = document.createElement('video');
    video.autoplay = true; video.playsInline = true; video.muted = true;
    const nameEl = document.createElement('div');
    nameEl.className = 'remote-name';
    nameEl.textContent = pendingNames[mid] || `Remote camera ${Object.keys(remoteTiles).length + 1}`;
    tile.append(video, nameEl);
    $('#remote-grid').appendChild(tile);
    remoteTiles[mid] = { tile, video, nameEl };
    return remoteTiles[mid];
  }

  $('#viewer-generate').addEventListener('click', async () => {
    const offer = $('#viewer-offer').value.trim();
    if (!offer) { toast('Paste the invite code first', '', 'warn'); return; }
    if (state.viewer) state.viewer.close();
    Object.keys(remoteTiles).forEach(k => { remoteTiles[k].tile.remove(); delete remoteTiles[k]; });
    pendingNames = {};

    state.viewer = new ViewerSession(
      ({ mid, track }) => {
        const t = ensureTile(mid ?? track.id);
        t.video.srcObject = new MediaStream([track]);
      },
      names => {
        pendingNames = names;
        for (const [mid, name] of Object.entries(names)) {
          if (remoteTiles[mid]) remoteTiles[mid].nameEl.textContent = name;
        }
      },
      s => {
        const st = $('#viewer-status');
        if (s === 'connected') setStatus(st, '✓ Connected — live video below.', 'ok');
        else if (s === 'failed' || s === 'disconnected') setStatus(st, 'Connection lost.', 'err');
        else setStatus(st, 'Status: ' + s);
      }
    );

    try {
      const reply = await state.viewer.answer(offer);
      $('#viewer-answer').value = reply;
      $('#viewer-flow').hidden = false;
      setStatus($('#viewer-status'), 'Now copy this reply code back to the Host.');
    } catch (e) {
      toast('Invalid invite code', 'Copy the full code from the Host and try again.', 'danger');
    }
  });

  $('#viewer-answer-copy').addEventListener('click', () => copyFrom($('#viewer-answer'), $('#viewer-answer-copy')));
}

function closeStreaming() {
  if (state.host) { state.host.close(); state.host = null; }
  if (state.viewer) { state.viewer.close(); state.viewer = null; }
}

/* ============================================================
   GO
   ============================================================ */
initLock();
