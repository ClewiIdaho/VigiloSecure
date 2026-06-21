/* ============================================================
   store.js — tiny localStorage wrapper for Vigilo settings.
   Everything lives in this browser only. No server, ever.
   ============================================================ */

const KEY = 'vigilo.settings.v1';

const defaults = {
  notifyOnMotion: false,
  motionOnlyRecording: false,
  // per-camera config keyed by deviceId:
  // { name, enabled, sensitivity }
  cameras: {},
};

let cache = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(defaults);
    return Object.assign(structuredClone(defaults), JSON.parse(raw));
  } catch {
    return structuredClone(defaults);
  }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch (e) {
    console.warn('Vigilo: could not save settings', e);
  }
}

export const store = {
  get(key) { return cache[key]; },

  set(key, value) { cache[key] = value; persist(); },

  /** Returns saved config for a camera, merged with sensible defaults. */
  getCamera(deviceId) {
    return Object.assign(
      { name: '', enabled: true, sensitivity: 40 },
      cache.cameras[deviceId] || {}
    );
  },

  setCamera(deviceId, patch) {
    cache.cameras[deviceId] = Object.assign(this.getCamera(deviceId), patch);
    persist();
  },

  /** Wipe everything (used by "reset password"). */
  clearAll() {
    cache = structuredClone(defaults);
    localStorage.removeItem(KEY);
  },
};
