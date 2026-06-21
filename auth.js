/* ============================================================
   auth.js — simple, serverless password gate.
   The password is never stored in plain text: we keep a salted
   SHA-256 hash in localStorage. This protects against casual
   snooping. It is NOT a substitute for OS-level security.
   ============================================================ */

const AUTH_KEY = 'vigilo.auth.v1';

function buf2hex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hash(password, saltHex) {
  const data = new TextEncoder().encode(saltHex + ':' + password);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return buf2hex(digest);
}

function randomSalt() {
  return buf2hex(crypto.getRandomValues(new Uint8Array(16)));
}

export const auth = {
  isConfigured() {
    return !!localStorage.getItem(AUTH_KEY);
  },

  async setPassword(password) {
    const salt = randomSalt();
    const digest = await hash(password, salt);
    localStorage.setItem(AUTH_KEY, JSON.stringify({ salt, digest }));
  },

  async verify(password) {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return false;
    try {
      const { salt, digest } = JSON.parse(raw);
      const candidate = await hash(password, salt);
      return candidate === digest;
    } catch {
      return false;
    }
  },

  reset() {
    localStorage.removeItem(AUTH_KEY);
  },
};
