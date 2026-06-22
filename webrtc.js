/* ============================================================
   webrtc.js — private peer-to-peer camera streaming.

   The HOST (computer with the webcams) sends its live camera
   tracks directly to a VIEWER (e.g. your phone). Signaling is
   done by copy/pasting a short code — no signaling server, no
   STUN/TURN, no cloud. On a Tailscale (or LAN) network the
   devices reach each other directly via host ICE candidates.
   ============================================================ */

const RTC_CONFIG = { iceServers: [] }; // no external servers — fully private

const encode = desc => btoa(JSON.stringify({ type: desc.type, sdp: desc.sdp }));
const decode = code => {
  const obj = JSON.parse(atob(code.trim()));
  if (!obj.type || !obj.sdp) throw new Error('bad code');
  return obj;
};

/** Resolve once ICE gathering finishes so the SDP carries all candidates. */
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
    // Safety net: LAN/Tailscale gathering is fast; don't hang forever.
    setTimeout(resolve, 3000);
  });
}

/* ============================================================
   HOST — shares local camera streams with one viewer.
   ============================================================ */
export class HostSession {
  /**
   * @param {{name:string, stream:MediaStream}[]} sources
   * @param {(state:string)=>void} onState
   */
  constructor(sources, onState = () => {}) {
    this.pc = new RTCPeerConnection(RTC_CONFIG);
    this.onState = onState;
    this._pending = [];   // [{ transceiver, name }]
    this.nameByMid = {};

    for (const { name, stream } of sources) {
      for (const track of stream.getVideoTracks()) {
        const transceiver = this.pc.addTransceiver(track, { direction: 'sendonly' });
        this._pending.push({ transceiver, name });
      }
    }

    // Data channel carries the camera-name labels to the viewer.
    this.dc = this.pc.createDataChannel('meta');
    this.dc.onopen = () => this.dc.send(JSON.stringify({ type: 'names', map: this.nameByMid }));

    this.pc.onconnectionstatechange = () => this.onState(this.pc.connectionState);
  }

  /** Build the invite code to hand to the viewer. */
  async createInvite() {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await waitForIce(this.pc);
    // mids are assigned after setLocalDescription.
    for (const { transceiver, name } of this._pending) {
      if (transceiver.mid != null) this.nameByMid[transceiver.mid] = name;
    }
    return encode(this.pc.localDescription);
  }

  /** Finish the handshake with the viewer's reply code. */
  async acceptReply(code) {
    await this.pc.setRemoteDescription(decode(code));
  }

  close() { try { this.pc.close(); } catch {} }
}

/* ============================================================
   VIEWER — receives and displays the host's camera streams.
   ============================================================ */
export class ViewerSession {
  /**
   * @param {(info:{mid:string, track:MediaStreamTrack})=>void} onTrack
   * @param {(map:Object)=>void} onNames
   * @param {(state:string)=>void} onState
   */
  constructor(onTrack = () => {}, onNames = () => {}, onState = () => {}) {
    this.pc = new RTCPeerConnection(RTC_CONFIG);
    this.onTrack = onTrack;
    this.onNames = onNames;
    this.onState = onState;

    this.pc.ontrack = e => {
      const mid = e.transceiver ? e.transceiver.mid : null;
      this.onTrack({ mid, track: e.track });
    };
    this.pc.ondatachannel = e => {
      e.channel.onmessage = m => {
        try {
          const msg = JSON.parse(m.data);
          if (msg.type === 'names') this.onNames(msg.map || {});
        } catch {}
      };
    };
    this.pc.onconnectionstatechange = () => this.onState(this.pc.connectionState);
  }

  /** Take the host's invite code, return a reply code to paste back. */
  async answer(inviteCode) {
    await this.pc.setRemoteDescription(decode(inviteCode));
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await waitForIce(this.pc);
    return encode(this.pc.localDescription);
  }

  close() { try { this.pc.close(); } catch {} }
}
