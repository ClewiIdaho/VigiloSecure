/* ============================================================
   app.js — Vigilo bootstrap & orchestration.
   Wires the lock screen, tabs, status bar and camera grid.
   ============================================================ */

import { auth } from './auth.js';
import { store } from './store.js';
import { Camera } from './camera.js';
import { Recorder } from './recorder.js';
import { notifications, toast } from './notify.js';

const $ = sel => document.querySelector(sel);

const state = {
  cameras: [],   // Camera[]
  started: false,
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
  // Privacy: stop all cameras and return to lock screen.
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
   GO
   ============================================================ */
initLock();
