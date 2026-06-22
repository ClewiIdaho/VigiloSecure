/* ============================================================
   remote.js — auto-connecting remote access over the local relay.

   No copy/paste codes. The "Home Hub" (the computer with cameras)
   and each remote Viewer (your phone) find each other through the
   tiny /api/* relay in serve.py, do a one-time WebRTC handshake,
   then stream video and exchange control commands directly,
   peer-to-peer. The relay never sees your video.
   ============================================================ */

const RTC_CONFIG = { iceServers: [] }; // peer-to-peer only — nothing external

/** Resolve once ICE gathering finishes (non-trickle keeps signaling simple). */
function waitForIce(pc) {
  return new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const check = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(resolve, 3000);
  });
}

/* ============================================================
   RelayClient — join the switchboard, long-poll for messages.
   ============================================================ */
export class RelayClient {
  constructor(role, { onMessage = () => {}, onPresence = () => {} } = {}) {
    this.role = role;
    this.onMessage = onMessage;
    this.onPresence = onPresence;
    this.id = null;
    this.alive = false;
  }

  /** Is the relay (serve.py) even running here? */
  static async available() {
    try {
      const r = await fetch('/api/presence', { cache: 'no-store' });
      if (!r.ok) return false;
      await r.json();
      return true;
    } catch {
      return false;
    }
  }

  static async presence() {
    try {
      const r = await fetch('/api/presence', { cache: 'no-store' });
      return r.ok ? (await r.json()).hostOnline : false;
    } catch {
      return false;
    }
  }

  async join() {
    const r = await fetch('/api/join', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: this.role }),
    });
    const data = await r.json();
    this.id = data.id;
    this.alive = true;
    this._loop();
    return data;
  }

  async send(to, type, data) {
    if (!this.id) return;
    try {
      await fetch('/api/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: this.id, to, type, data }),
      });
    } catch { /* transient — caller retries via its own logic */ }
  }

  async _loop() {
    while (this.alive) {
      try {
        const r = await fetch('/api/poll?id=' + encodeURIComponent(this.id), { cache: 'no-store' });
        const data = await r.json();
        if (data.expired) { await this._rejoin(); continue; }
        this.onPresence(!!data.hostOnline);
        for (const msg of data.messages || []) this.onMessage(msg);
      } catch {
        await new Promise(res => setTimeout(res, 1500)); // network blip — back off
      }
    }
  }

  async _rejoin() {
    try { const d = await this.join(); return d; }
    catch { await new Promise(res => setTimeout(res, 1500)); }
  }

  leave() {
    this.alive = false;
    if (this.id) navigator.sendBeacon?.('/api/leave', JSON.stringify({ id: this.id }));
    this.id = null;
  }
}

/* ============================================================
   HostBroadcaster — shares this computer's cameras + obeys
   remote control commands.
   ============================================================ */
export class HostBroadcaster {
  /**
   * @param {object} api  {
   *   getSources()  -> [{ id, stream }]   running cameras
   *   getState()    -> [{ id,name,sensitivity,running,recording,motion }]
   *   applyCommand(cmd)                   mutate a camera
   * }
   */
  constructor(api) {
    this.api = api;
    this.relay = new RelayClient('host', { onMessage: m => this._onMessage(m) });
    this.peers = new Map();   // viewerId -> { pc, dc, sig }
    this._stateTimer = null;
  }

  async start() {
    await this.relay.join();
    this._stateTimer = setInterval(() => this.broadcastState(), 1500);
  }

  _sourceSignature() {
    return this.api.getSources().map(s => s.id).sort().join('|');
  }

  _onMessage(msg) {
    if (msg.type === 'connect-request') this._createPeer(msg.from);
    else if (msg.type === 'answer') {
      const peer = this.peers.get(msg.from);
      if (peer) peer.pc.setRemoteDescription(msg.data).catch(() => {});
    } else if (msg.type === 'bye') {
      this._dropPeer(msg.from);
    }
  }

  async _createPeer(viewerId) {
    this._dropPeer(viewerId);
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const midToCam = {};
    const pending = [];

    for (const { id, stream } of this.api.getSources()) {
      for (const track of stream.getVideoTracks()) {
        const tx = pc.addTransceiver(track, { direction: 'sendonly' });
        pending.push({ tx, id });
      }
    }

    const dc = pc.createDataChannel('ctl');
    dc.onopen = () => { this._sendMap(dc, this.peers.get(viewerId)); this.broadcastState(); };
    dc.onmessage = e => this._onControl(e.data);

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) this._dropPeer(viewerId);
    };

    await pc.setLocalDescription(await pc.createOffer());
    await waitForIce(pc);
    for (const { tx, id } of pending) if (tx.mid != null) midToCam[tx.mid] = id;

    const peer = { pc, dc, sig: this._sourceSignature(), midToCam };
    this.peers.set(viewerId, peer);
    this.relay.send(viewerId, 'offer', { sdp: pc.localDescription, map: midToCam });
  }

  _sendMap(dc, peer) {
    if (dc.readyState === 'open' && peer) {
      try { dc.send(JSON.stringify({ t: 'map', map: peer.midToCam })); } catch {}
    }
  }

  _onControl(raw) {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t === 'cmd') { this.api.applyCommand(msg); this.broadcastState(); }
  }

  broadcastState() {
    const payload = JSON.stringify({ t: 'state', cameras: this.api.getState() });
    for (const { dc } of this.peers.values()) {
      if (dc.readyState === 'open') { try { dc.send(payload); } catch {} }
    }
  }

  /** Rebuild any peer whose camera set changed (e.g. a camera was toggled). */
  syncCameras() {
    const sig = this._sourceSignature();
    for (const [viewerId, peer] of this.peers) {
      if (peer.sig !== sig) this._createPeer(viewerId);
    }
    this.broadcastState();
  }

  _dropPeer(viewerId) {
    const peer = this.peers.get(viewerId);
    if (peer) { try { peer.pc.close(); } catch {} this.peers.delete(viewerId); }
  }

  stop() {
    clearInterval(this._stateTimer);
    for (const id of [...this.peers.keys()]) this._dropPeer(id);
    this.relay.leave();
  }
}

/* ============================================================
   RemoteViewer — connects to the Home Hub and renders/controls it.
   ============================================================ */
export class RemoteViewer {
  constructor({ onTrack = () => {}, onState = () => {}, onStatus = () => {} } = {}) {
    this.onTrack = onTrack;
    this.onState = onState;
    this.onStatus = onStatus;
    this.relay = new RelayClient('viewer', {
      onMessage: m => this._onMessage(m),
      onPresence: online => this._onPresence(online),
    });
    this.pc = null;
    this.dc = null;
    this.hostId = null;
    this.connecting = false;
    this._requestTimer = null;
  }

  async start() {
    await this.relay.join();
    this.onStatus('searching');
    this._requestConnection();
  }

  _onPresence(online) {
    if (online && !this.pc && !this.connecting) this._requestConnection();
    if (!online) this.onStatus('offline');
  }

  _requestConnection() {
    if (this.pc || this.connecting) return;
    this.relay.send('host', 'connect-request', {});
    this.onStatus('connecting');
    clearTimeout(this._requestTimer);
    this._requestTimer = setTimeout(() => {            // retry if no offer arrives
      if (!this.pc) this._requestConnection();
    }, 5000);
  }

  async _onMessage(msg) {
    if (msg.type !== 'offer') return;
    clearTimeout(this._requestTimer);
    this.connecting = true;
    this.hostId = msg.from;
    this._teardownPeer();

    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.pc = pc;
    this.midToCam = (msg.data && msg.data.map) || {};

    pc.ontrack = e => {
      const mid = e.transceiver ? e.transceiver.mid : null;
      this.onTrack({ camId: this.midToCam[mid] || mid, track: e.track });
    };
    pc.ondatachannel = e => {
      this.dc = e.channel;
      this.dc.onmessage = m => this._onData(m.data);
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') { this.connecting = false; this.onStatus('connected'); }
      else if (['failed', 'disconnected', 'closed'].includes(s)) {
        this.connecting = false;
        this._teardownPeer();
        this.onStatus('reconnecting');
        setTimeout(() => this._requestConnection(), 1200);
      }
    };

    try {
      await pc.setRemoteDescription(msg.data.sdp);
      await pc.setLocalDescription(await pc.createAnswer());
      await waitForIce(pc);
      this.relay.send(this.hostId, 'answer', pc.localDescription);
    } catch {
      this.connecting = false;
      this._teardownPeer();
      setTimeout(() => this._requestConnection(), 1500);
    }
  }

  _onData(raw) {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t === 'map') this.midToCam = Object.assign(this.midToCam || {}, msg.map);
    else if (msg.t === 'state') this.onState(msg.cameras || []);
  }

  /** Send a control command to the Home Hub. */
  command(cmd) {
    if (this.dc && this.dc.readyState === 'open') {
      try { this.dc.send(JSON.stringify(Object.assign({ t: 'cmd' }, cmd))); } catch {}
    }
  }

  _teardownPeer() {
    if (this.pc) { try { this.pc.close(); } catch {} this.pc = null; }
    this.dc = null;
  }

  stop() {
    clearTimeout(this._requestTimer);
    if (this.hostId) this.relay.send(this.hostId, 'bye', {});
    this._teardownPeer();
    this.relay.leave();
  }
}
