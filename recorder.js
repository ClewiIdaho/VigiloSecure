/* ============================================================
   recorder.js — MediaRecorder wrapper with 2-hour rolling clips.
   Recordings are saved straight to the user's Downloads folder.
   Nothing is uploaded.
   ============================================================ */

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

function pickMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
  ];
  for (const t of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

function timestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function safeName(s) {
  return (s || 'camera').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'camera';
}

export class Recorder {
  /**
   * @param {MediaStream} stream
   * @param {() => string} nameFn  returns the current camera nickname
   */
  constructor(stream, nameFn) {
    this.stream = stream;
    this.nameFn = nameFn;
    this.mimeType = pickMimeType();
    this.recorder = null;
    this.chunks = [];
    this.active = false;
    this.rollTimer = null;
  }

  static supported() {
    return typeof window.MediaRecorder !== 'undefined' && pickMimeType() !== '';
  }

  start() {
    if (this.active || !Recorder.supported()) return false;
    try {
      this.recorder = new MediaRecorder(this.stream, this.mimeType ? { mimeType: this.mimeType } : undefined);
    } catch (e) {
      console.warn('Vigilo: MediaRecorder failed to start', e);
      return false;
    }
    this.chunks = [];
    this.recorder.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.recorder.onstop = () => this._finalize();
    this.recorder.start(1000); // gather data every second
    this.active = true;

    // 2-hour rolling: stop & immediately restart to split the file.
    this.rollTimer = setTimeout(() => this._roll(), TWO_HOURS_MS);
    return true;
  }

  _roll() {
    if (!this.active) return;
    this._restartAfterStop = true;
    this.recorder.stop();
  }

  stop() {
    if (!this.active) return;
    this._restartAfterStop = false;
    clearTimeout(this.rollTimer);
    this.recorder.stop();
    this.active = false;
  }

  _finalize() {
    const chunks = this.chunks;
    this.chunks = [];
    if (chunks.length) {
      const blob = new Blob(chunks, { type: this.mimeType || 'video/webm' });
      this._download(blob);
    }
    if (this._restartAfterStop) {
      this._restartAfterStop = false;
      // continue a fresh rolling clip
      this.start();
    }
  }

  _download(blob) {
    const ext = (this.mimeType.includes('mp4')) ? 'mp4' : 'webm';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vigilo_${safeName(this.nameFn())}_${timestamp()}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
}
