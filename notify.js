/* ============================================================
   notify.js — browser push notifications + in-app toasts.
   ============================================================ */

const toastStack = () => document.getElementById('toast-stack');

/** Show a small in-app toast. type: 'info' | 'warn' | 'danger' */
export function toast(title, body = '', type = 'info', timeout = 4000) {
  const stack = toastStack();
  if (!stack) return;
  const el = document.createElement('div');
  el.className = 'toast' + (type !== 'info' ? ' ' + type : '');
  el.innerHTML = `<strong></strong><span></span>`;
  el.querySelector('strong').textContent = title;
  el.querySelector('span').textContent = body;
  stack.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(20px)';
    setTimeout(() => el.remove(), 300);
  }, timeout);
}

export const notifications = {
  get permission() {
    return ('Notification' in window) ? Notification.permission : 'denied';
  },

  supported() {
    return 'Notification' in window;
  },

  async request() {
    if (!this.supported()) {
      toast('Notifications unavailable', 'This browser does not support push notifications.', 'warn');
      return 'denied';
    }
    if (Notification.permission === 'granted') return 'granted';
    try {
      const result = await Notification.requestPermission();
      if (result === 'granted') {
        toast('Notifications on', 'You will be alerted when motion is detected.');
      } else {
        toast('Notifications blocked', 'Enable them in your browser to get motion alerts.', 'warn');
      }
      return result;
    } catch {
      return 'denied';
    }
  },

  /** Fire a system notification (rate-limited by caller). */
  push(title, body) {
    if (this.permission !== 'granted') return;
    try {
      const n = new Notification(title, {
        body,
        tag: 'vigilo-motion',      // collapses repeat alerts
        renotify: false,
        silent: false,
      });
      setTimeout(() => n.close(), 6000);
    } catch (e) {
      console.warn('Vigilo: notification failed', e);
    }
  },
};
