/* ============================================================
   motion.js — frame-differencing motion detection via Canvas.
   Downsamples each frame to a tiny grayscale grid and compares
   it to the previous frame. Cheap enough to run on many cams.
   ============================================================ */

const SAMPLE_W = 64;   // downsample width
const SAMPLE_H = 48;   // downsample height
const PIXEL_DELTA = 28; // per-pixel luminance change to count as "changed"

export class MotionDetector {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = SAMPLE_W;
    this.canvas.height = SAMPLE_H;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.prev = null;       // previous grayscale Uint8 frame
    this.score = 0;         // 0..100 percent of pixels that changed
  }

  /**
   * Analyse the current video frame.
   * @returns {number} motion score (percent of changed pixels, 0..100)
   */
  sample(video) {
    if (!video || video.readyState < 2 || video.videoWidth === 0) {
      return this.score;
    }
    this.ctx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
    let data;
    try {
      data = this.ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
    } catch {
      return this.score; // e.g. tainted canvas — shouldn't happen with getUserMedia
    }

    const len = SAMPLE_W * SAMPLE_H;
    const gray = new Uint8Array(len);
    for (let i = 0, p = 0; i < len; i++, p += 4) {
      // fast luminance approximation
      gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
    }

    if (!this.prev) {
      this.prev = gray;
      this.score = 0;
      return 0;
    }

    let changed = 0;
    for (let i = 0; i < len; i++) {
      if (Math.abs(gray[i] - this.prev[i]) > PIXEL_DELTA) changed++;
    }
    this.prev = gray;
    this.score = (changed / len) * 100;
    return this.score;
  }

  /**
   * Map a 1..100 sensitivity to a trigger threshold (percent changed).
   * Higher sensitivity => lower threshold => triggers more easily.
   */
  isTriggered(sensitivity) {
    // sensitivity 1  -> need ~15% of frame to change
    // sensitivity 100-> need ~0.4% of frame to change
    const threshold = 15 - (sensitivity / 100) * 14.6;
    return this.score >= threshold;
  }

  reset() { this.prev = null; this.score = 0; }
}
