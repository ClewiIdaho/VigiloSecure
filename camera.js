/* ============================================================
   camera.js — one Camera = one webcam + tile + motion + recorder.
   ============================================================ */

import { MotionDetector } from './motion.js';
import { Recorder } from './recorder.js';
import { store } from './store.js';
import { notifications } from './notify.js';

const SAMPLE_INTERVAL = 150;     // ms between motion samples
const MOTION_HOLD = 1000;        // keep "motion" state this long after last trigger
const MOTION_REC_COOLDOWN = 6000;// keep recording this long after motion stops
const NOTIFY_COOLDOWN = 15000;   // min ms between push notifications per camera

export class Camera {
  /**
   * @param {MediaDeviceInfo} device
   * @param {number} index
   * @param {object} hooks  { getNotifyEnabled, getMotionOnlyRecording, onChange }
   */
  constructor(device, index, hooks) {
    this.deviceId = device.deviceId;
    this.hooks = hooks;
    this.index = index;

    const saved = store.getCamera(this.deviceId);
    this.name = saved.name || device.label || `Camera ${index + 1}`;
    this.sensitivity = saved.sensitivity;
    this.enabled = saved.enabled;

    this.stream = null;
    this.detector = new MotionDetector();
    this.recorder = null;

    this.running = false;
    this.motionActive = false;
    this.lastTriggerTs = 0;
    this.lastNotifyTs = 0;
    this.manualRecording = false;
    this.motionRecording = false;
    this.loopTimer = null;

    this._buildTile();
  }

  /* ---------- DOM ---------- */
  _buildTile() {
    const tpl = document.getElementById('camera-tile-template');
    this.el = tpl.content.firstElementChild.cloneNode(true);
    this.video = this.el.querySelector('.cam-video');
    this.nameInput = this.el.querySelector('.cam-name');
    this.motionBadge = this.el.querySelector('.motion-badge');
    this.recBadge = this.el.querySelector('.rec-badge');
    this.sensInput = this.el.querySelector('.cam-sens');
    this.toggleBtn = this.el.querySelector('.cam-toggle');
    this.recordBtn = this.el.querySelector('.cam-record');
    this.fsBtn = this.el.querySelector('.cam-fs');

    this.nameInput.value = this.name;
    this.sensInput.value = this.sensitivity;

    // Rename
    this.nameInput.addEventListener('change', () => {
      this.name = this.nameInput.value.trim() || `Camera ${this.index + 1}`;
      this.nameInput.value = this.name;
      store.setCamera(this.deviceId, { name: this.name });
    });
    this.nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') this.nameInput.blur(); });

    // Sensitivity
    this.sensInput.addEventListener('input', () => {
      this.sensitivity = Number(this.sensInput.value);
      store.setCamera(this.deviceId, { sensitivity: this.sensitivity });
    });

    // On/off
    this.toggleBtn.addEventListener('click', () => {
      this.enabled = !this.running;
      store.setCamera(this.deviceId, { enabled: this.enabled });
      this.enabled ? this.start() : this.stop();
    });

    // Record
    this.recordBtn.addEventListener('click', () => this.toggleManualRecording());

    // Fullscreen (button + double-click on video)
    this.fsBtn.addEventListener('click', () => this.toggleFullscreen());
    this.el.querySelector('.cam-video-wrap').addEventListener('dblclick', () => this.toggleFullscreen());

    this._renderState();
  }

  /* ---------- Lifecycle ---------- */
  async start() {
    if (this.running) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: this.deviceId ? { exact: this.deviceId } : undefined },
        audio: false,
      });
    } catch (e) {
      console.warn('Vigilo: could not start camera', this.name, e);
      this._error = e.name === 'NotReadableError'
        ? 'In use by another app'
        : (e.name === 'NotAllowedError' ? 'Permission denied' : 'Unavailable');
      this._renderState();
      throw e;
    }
    this.video.srcObject = this.stream;
    this.running = true;
    this.enabled = true;
    this._error = null;
    this.detector.reset();
    this._startLoop();
    this._renderState();
    this.hooks.onChange?.();
  }

  stop() {
    if (!this.running && !this.stream) { this._renderState(); return; }
    this._stopLoop();
    this._setRecording(false, false);
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.running = false;
    this.motionActive = false;
    this._renderState();
    this.hooks.onChange?.();
  }

  destroy() { this.stop(); this.el.remove(); }

  /* ---------- Motion loop ---------- */
  _startLoop() {
    this._stopLoop();
    this.loopTimer = setInterval(() => this._tick(), SAMPLE_INTERVAL);
  }
  _stopLoop() {
    if (this.loopTimer) { clearInterval(this.loopTimer); this.loopTimer = null; }
  }

  _tick() {
    if (!this.running) return;
    this.detector.sample(this.video);
    const now = Date.now();
    const triggered = this.detector.isTriggered(this.sensitivity);

    if (triggered) {
      this.lastTriggerTs = now;
      if (!this.motionActive) this._onMotionStart();
    }

    // Hold the motion state briefly to avoid flicker
    const stillActive = now - this.lastTriggerTs < MOTION_HOLD;
    if (this.motionActive && !stillActive) {
      this.motionActive = false;
      this._renderState();
    }

    this._updateMotionRecording(now);
  }

  _onMotionStart() {
    this.motionActive = true;
    this._renderState();

    // Notification (rate-limited + only if globally enabled)
    const now = Date.now();
    if (this.hooks.getNotifyEnabled?.() && now - this.lastNotifyTs > NOTIFY_COOLDOWN) {
      this.lastNotifyTs = now;
      notifications.push('Motion detected', `${this.name} · ${new Date().toLocaleTimeString()}`);
    }
    this.hooks.onMotion?.(this);
  }

  /* ---------- Recording ---------- */
  _ensureRecorder() {
    if (!this.recorder) this.recorder = new Recorder(this.stream, () => this.name);
    return this.recorder;
  }

  toggleManualRecording() {
    if (!this.running) return;
    if (!Recorder.supported()) return;
    this.manualRecording = !this.manualRecording;
    this._applyRecording();
  }

  _updateMotionRecording(now) {
    if (!this.hooks.getMotionOnlyRecording?.() || !this.running) {
      if (this.motionRecording) { this.motionRecording = false; this._applyRecording(); }
      return;
    }
    const wantRec = now - this.lastTriggerTs < MOTION_REC_COOLDOWN;
    if (wantRec !== this.motionRecording) {
      this.motionRecording = wantRec;
      this._applyRecording();
    }
  }

  /** Reconcile the actual recorder with desired state (manual OR motion). */
  _applyRecording() {
    const shouldRecord = this.manualRecording || this.motionRecording;
    this._setRecording(shouldRecord, shouldRecord);
  }

  _setRecording(on) {
    const rec = on ? this._ensureRecorder() : this.recorder;
    if (!rec) { this._renderRecBadge(); return; }
    if (on && !rec.active) rec.start();
    else if (!on && rec.active) rec.stop();
    this._renderRecBadge();
    this.hooks.onChange?.();
  }

  get isRecording() { return !!(this.recorder && this.recorder.active); }

  /* ---------- Fullscreen ---------- */
  toggleFullscreen() {
    if (document.fullscreenElement === this.el) {
      document.exitFullscreen?.();
    } else if (this.el.requestFullscreen) {
      this.el.requestFullscreen().catch(() => {});
    }
  }

  /* ---------- Rendering ---------- */
  _renderState() {
    let state = 'off';
    if (this.running) state = this.motionActive ? 'motion' : 'on';
    this.el.dataset.state = state;

    this.toggleBtn.classList.toggle('on', this.running);
    this.motionBadge.hidden = !this.motionActive;

    const offline = this.el.querySelector('.cam-offline span');
    offline.textContent = this._error ? `Camera off — ${this._error}` : 'Camera off';

    this.recordBtn.disabled = !this.running || !Recorder.supported();
    this._renderRecBadge();
  }

  _renderRecBadge() {
    const rec = this.isRecording;
    this.recBadge.hidden = !rec;
    this.recordBtn.classList.toggle('recording', rec);
  }
}
