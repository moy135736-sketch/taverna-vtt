// Голосовой и видеочат за столом.
// WebRTC «каждый с каждым»: звук и видео идут напрямую между браузерами,
// через сервер (Socket.IO) проходят только служебные сигналы — предложения, ответы, ICE-кандидаты.
// Согласование по схеме «perfect negotiation»: у каждой пары есть «вежливая» сторона,
// которая уступает при одновременных предложениях.
import { Emitter } from './store.js';

const LS = 'tv:voice:';
function lsGet(k, d) {
  try {
    const v = localStorage.getItem(LS + k);
    return v === null ? d : JSON.parse(v);
  } catch {
    return d;
  }
}
function lsSet(k, v) {
  try {
    localStorage.setItem(LS + k, JSON.stringify(v));
  } catch {
    /* нет хранилища */
  }
}

const SPEAK_LEVEL = 0.018; // порог громкости (RMS), выше — «говорит»
const SPEAK_HOLD = 350; // мс подсветки после последнего звука

export class Voice extends Emitter {
  constructor(store, net) {
    super();
    this.store = store;
    this.net = net;
    this.state = 'off'; // off | joining | on | reconnecting
    this.wantOn = false;
    this.sid = null;
    this.iceServers = [];
    this.peers = new Map(); // sid -> peer
    this.local = null; // поток микрофона
    this.camera = null; // дорожка камеры
    this.muted = !!lsGet('muted', false);
    this.deaf = false;
    this.micError = '';
    this.meters = new Map(); // 'me' | sid -> {an, buf, src, until, speaking}
    this.audioBox = null;
    this.offs = [
      net.on('rtc:joined', (p) => this.state === 'on' && p.sid !== this.sid && this.makePeer(p, false)),
      net.on('rtc:left', ({ sid }) => this.dropPeer(sid)),
      net.on('rtc:signal', (m) => this.onSignal(m)),
      net.on('rtc:replaced', () => {
        if (this.state === 'off') return;
        this.sid = null; // сервер уже убрал нас из чата
        this.leave();
        this.emit('notice', 'Голосовой чат продолжен в другой вкладке');
      }),
      net.on('status', (st) => {
        if (st !== 'connected' && (this.state === 'on' || this.state === 'joining')) {
          for (const sid of [...this.peers.keys()]) this.dropPeer(sid);
          this.setState('reconnecting');
        }
      }),
      // после переподключения сокет новый — входим в голосовой чат заново
      store.on('snapshot', () => {
        if (this.wantOn && this.state === 'reconnecting') this.rejoin();
      }),
    ];
  }

  destroy() {
    this.leave();
    this.offs.forEach((o) => o());
    this.actx?.close().catch(() => {});
  }

  get supported() {
    return typeof window !== 'undefined' && !!window.RTCPeerConnection;
  }

  get canCapture() {
    return !!navigator.mediaDevices?.getUserMedia;
  }

  setState(s) {
    this.state = s;
    this.emit('change');
  }

  micTrack() {
    return this.local?.getAudioTracks()[0] || null;
  }

  // ------------------------------------------------------------------
  // Вход и выход
  // ------------------------------------------------------------------

  async join({ video = false } = {}) {
    if (!this.supported) throw new Error('Этот браузер не поддерживает голосовой чат');
    if (this.state !== 'off') return;
    this.wantOn = true;
    this.setState('joining');
    this.ensureAudioContext();
    try {
      await this.ensureMic();
      if (video) await this.setVideo(true, { silent: true }).catch((e) => this.emit('notice', e.message));
      await this.signalJoin();
      this.setState('on');
    } catch (e) {
      this.leave();
      throw e;
    }
  }

  async signalJoin() {
    const r = await this.net.request('rtc:join', { muted: this.muted || !this.micTrack(), video: !!this.camera });
    if (r?.error) throw new Error(r.error);
    this.sid = r.sid;
    this.iceServers = Array.isArray(r.iceServers) ? r.iceServers : [];
    // новичок сам предлагает соединение всем, кто уже в чате
    for (const p of r.peers || []) this.makePeer(p, true);
  }

  rejoin() {
    this.setState('joining');
    this.signalJoin()
      .then(() => this.setState('on'))
      .catch((e) => {
        this.emit('notice', 'Голосовой чат: ' + e.message);
        this.leave();
      });
  }

  leave() {
    const was = this.state;
    this.wantOn = false;
    for (const sid of [...this.peers.keys()]) this.dropPeer(sid);
    if (was !== 'off' && this.sid && this.net.connected) this.net.request('rtc:leave', {});
    this.local?.getTracks().forEach((t) => t.stop());
    this.local = null;
    this.camera?.stop();
    this.camera = null;
    for (const m of this.meters.values()) m.src.disconnect();
    this.meters.clear();
    clearInterval(this.meterTimer);
    this.meterTimer = null;
    this.sid = null;
    if (was !== 'off') this.setState('off');
  }

  // ------------------------------------------------------------------
  // Микрофон, камера, звук
  // ------------------------------------------------------------------

  async ensureMic() {
    if (this.micTrack()) return true;
    if (!this.canCapture) {
      this.micError = location.protocol === 'https:' ? 'Браузер не даёт доступ к микрофону' : 'Микрофон доступен только по HTTPS';
      this.emit('notice', this.micError + ' — вы только слушаете.');
      return false;
    }
    try {
      const deviceId = lsGet('mic', '');
      this.local = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(deviceId ? { deviceId: { ideal: deviceId } } : {}) },
      });
      const t = this.micTrack();
      t.enabled = !this.muted;
      this.watchLevel('me', t);
      this.micError = '';
      for (const p of this.peers.values()) p.audioTx?.sender.replaceTrack(t).catch(() => {});
      return true;
    } catch (e) {
      this.local = null;
      this.micError = e?.name === 'NotAllowedError' ? 'Нет разрешения на микрофон' : e?.name === 'NotFoundError' ? 'Микрофон не найден' : 'Микрофон недоступен';
      this.emit('notice', this.micError + ' — вы только слушаете.');
      return false;
    }
  }

  async setMuted(m) {
    if (!m && !this.micTrack()) {
      // слушатель решил заговорить — пробуем включить микрофон
      if (!(await this.ensureMic())) return;
    }
    this.muted = !!m;
    lsSet('muted', this.muted);
    const t = this.micTrack();
    if (t) t.enabled = !this.muted;
    if (this.state === 'on') this.net.request('rtc:state', { muted: this.muted || !t });
    this.emit('change');
  }

  async setVideo(on, { silent = false } = {}) {
    if (on) {
      if (!this.canCapture) throw new Error('Камера доступна только по HTTPS');
      const deviceId = lsGet('cam', '');
      let s;
      try {
        s = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 24 }, ...(deviceId ? { deviceId: { ideal: deviceId } } : {}) },
        });
      } catch (e) {
        throw new Error(e?.name === 'NotAllowedError' ? 'Нет разрешения на камеру' : 'Камера недоступна');
      }
      this.camera?.stop();
      this.camera = s.getVideoTracks()[0];
      this.camera.onended = () => this.setVideo(false);
    } else {
      this.camera?.stop();
      this.camera = null;
    }
    for (const p of this.peers.values()) p.videoTx?.sender.replaceTrack(this.camera || null).catch(() => {});
    if (!silent && this.state === 'on') this.net.request('rtc:state', { video: !!this.camera });
    this.emit('change');
  }

  setDeaf(d) {
    this.deaf = !!d;
    for (const p of this.peers.values()) this.applyVolume(p);
    this.emit('change');
  }

  volumeOf(userId) {
    const v = Number(lsGet('vol:' + userId, 1));
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
  }

  setVolume(userId, v) {
    lsSet('vol:' + userId, Math.max(0, Math.min(1, Number(v) || 0)));
    for (const p of this.peers.values()) if (p.userId === userId) this.applyVolume(p);
    this.emit('change');
  }

  applyVolume(p) {
    if (!p.audioEl) return;
    const v = this.volumeOf(p.userId);
    p.audioEl.volume = v;
    p.audioEl.muted = this.deaf || v === 0;
  }

  async devices() {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      return {
        mics: list.filter((d) => d.kind === 'audioinput'),
        cams: list.filter((d) => d.kind === 'videoinput'),
        mic: lsGet('mic', ''),
        cam: lsGet('cam', ''),
      };
    } catch {
      return { mics: [], cams: [], mic: '', cam: '' };
    }
  }

  async chooseMic(deviceId) {
    lsSet('mic', deviceId || '');
    if (this.state === 'off') return;
    const old = this.local;
    this.local = null;
    const ok = await this.ensureMic();
    if (ok) {
      old?.getTracks().forEach((t) => t.stop());
      if (this.meters.has('me')) {
        this.meters.get('me').src.disconnect();
        this.meters.delete('me');
      }
      this.watchLevel('me', this.micTrack());
    } else this.local = old;
    this.emit('change');
  }

  async chooseCam(deviceId) {
    lsSet('cam', deviceId || '');
    if (this.camera) await this.setVideo(true);
  }

  // ------------------------------------------------------------------
  // Соединения с участниками
  // ------------------------------------------------------------------

  send(to, data) {
    this.net.request('rtc:signal', { to, data }).then((r) => r?.gone && this.dropPeer(to));
  }

  makePeer(info, initiator) {
    let p = this.peers.get(info.sid);
    if (p) return p;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    p = {
      sid: info.sid,
      userId: info.userId,
      pc,
      polite: String(this.sid) > String(info.sid),
      makingOffer: false,
      ignoreOffer: false,
      audioTx: null,
      videoTx: null,
      audio: null,
      video: null,
      audioEl: null,
    };
    this.peers.set(info.sid, p);
    pc.onicecandidate = ({ candidate }) => candidate && this.send(p.sid, { candidate: candidate.toJSON() });
    pc.onnegotiationneeded = async () => {
      try {
        p.makingOffer = true;
        await pc.setLocalDescription();
        this.send(p.sid, { description: pc.localDescription.toJSON() });
      } catch (e) {
        console.warn('[голос] предложение', e);
      } finally {
        p.makingOffer = false;
      }
    };
    pc.ontrack = ({ track }) => this.onTrack(p, track);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        if (!p.restarted) {
          p.restarted = true;
          pc.restartIce?.();
        } else if (!p.warned) {
          p.warned = true;
          const m = this.store.members.get(p.userId);
          this.emit('notice', `Не удаётся соединиться с «${m?.displayName || 'участником'}». Помогает свой TURN-сервер — см. README, раздел «Голосовой чат».`);
        }
      }
      if (pc.connectionState === 'connected') p.restarted = false;
      this.emit('change');
    };
    if (initiator) {
      // заранее согласуем и звук, и видео: камеру потом можно включить без пересогласования
      p.audioTx = pc.addTransceiver('audio', { direction: 'sendrecv' });
      p.videoTx = pc.addTransceiver('video', { direction: 'sendrecv' });
      this.attachLocal(p);
    }
    this.emit('change');
    return p;
  }

  attachLocal(p) {
    for (const t of p.pc.getTransceivers()) {
      const kind = t.receiver?.track?.kind;
      if (kind === 'audio' && !p.audioTx) p.audioTx = t;
      if (kind === 'video' && !p.videoTx) p.videoTx = t;
      if ((t === p.audioTx || t === p.videoTx) && t.direction !== 'sendrecv' && t.currentDirection !== 'stopped') t.direction = 'sendrecv';
    }
    p.audioTx?.sender.replaceTrack(this.micTrack()).catch(() => {});
    p.videoTx?.sender.replaceTrack(this.camera || null).catch(() => {});
  }

  async onSignal({ from, data }) {
    if (!data || (this.state !== 'on' && this.state !== 'joining')) return;
    let p = this.peers.get(from);
    if (!p) {
      const info = this.store.voiceRoster.find((r) => r.sid === from) || { sid: from, userId: null };
      p = this.makePeer(info, false);
    }
    const pc = p.pc;
    try {
      if (data.description) {
        const d = data.description;
        const collision = d.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
        p.ignoreOffer = !p.polite && collision;
        if (p.ignoreOffer) return;
        await pc.setRemoteDescription(d);
        if (d.type === 'offer') {
          this.attachLocal(p);
          await pc.setLocalDescription();
          this.send(from, { description: pc.localDescription.toJSON() });
        }
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (e) {
          if (!p.ignoreOffer) console.warn('[голос] кандидат', e);
        }
      }
    } catch (e) {
      console.warn('[голос] сигнал', e);
    }
  }

  onTrack(p, track) {
    if (track.kind === 'audio') {
      p.audio = track;
      if (!p.audioEl) {
        if (!this.audioBox) {
          this.audioBox = document.createElement('div');
          this.audioBox.hidden = true;
          document.body.appendChild(this.audioBox);
        }
        p.audioEl = document.createElement('audio');
        p.audioEl.autoplay = true;
        p.audioEl.playsInline = true;
        this.audioBox.appendChild(p.audioEl);
      }
      p.audioEl.srcObject = new MediaStream([track]);
      this.applyVolume(p);
      p.audioEl.play().catch(() => this.emit('notice', 'Браузер заблокировал звук — щёлкните по странице'));
      this.watchLevel(p.sid, track);
    } else if (track.kind === 'video') {
      p.video = track;
      track.onmute = track.onunmute = () => this.emit('change');
    }
    this.emit('change');
  }

  dropPeer(sid) {
    const p = this.peers.get(sid);
    if (!p) return;
    this.peers.delete(sid);
    try {
      p.pc.close();
    } catch {
      /* уже закрыто */
    }
    if (p.audioEl) {
      p.audioEl.srcObject = null;
      p.audioEl.remove();
    }
    const m = this.meters.get(sid);
    if (m) {
      m.src.disconnect();
      this.meters.delete(sid);
    }
    this.emit('change');
  }

  // ------------------------------------------------------------------
  // Кто говорит
  // ------------------------------------------------------------------

  ensureAudioContext() {
    try {
      if (!this.actx) this.actx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.actx.state === 'suspended') this.actx.resume().catch(() => {});
    } catch {
      this.actx = null;
    }
    return this.actx;
  }

  watchLevel(key, track) {
    const ctx = this.ensureAudioContext();
    if (!ctx || !track) return;
    try {
      const src = ctx.createMediaStreamSource(new MediaStream([track]));
      const an = ctx.createAnalyser();
      // окно ~85 мс при опросе раз в 80 мс — короткие звуки не проскакивают между замерами
      an.fftSize = 4096;
      src.connect(an);
      const old = this.meters.get(key);
      if (old) old.src.disconnect();
      this.meters.set(key, { an, src, buf: new Float32Array(an.fftSize), until: 0, speaking: false });
    } catch {
      return;
    }
    if (this.meterTimer) return;
    this.meterTimer = setInterval(() => {
      const now = performance.now();
      let changed = false;
      for (const [k, m] of this.meters) {
        m.an.getFloatTimeDomainData(m.buf);
        let sum = 0;
        for (let i = 0; i < m.buf.length; i++) sum += m.buf[i] * m.buf[i];
        if (Math.sqrt(sum / m.buf.length) > SPEAK_LEVEL) m.until = now + SPEAK_HOLD;
        const speaking = now < m.until && !(k === 'me' && this.muted);
        if (speaking !== m.speaking) {
          m.speaking = speaking;
          changed = true;
        }
      }
      if (changed) this.emit('speaking');
    }, 80);
  }

  /** Множество id пользователей, которые сейчас говорят */
  speakingUsers() {
    const out = new Set();
    for (const [k, m] of this.meters) {
      if (!m.speaking) continue;
      if (k === 'me') out.add(this.store.me.id);
      else {
        const p = this.peers.get(k);
        if (p?.userId) out.add(p.userId);
      }
    }
    return out;
  }

  /** Сводка для интерфейса: участники голосового чата с видео, громкостью и состоянием */
  participants() {
    const me = this.store.me.id;
    return this.store.voiceRoster.map((r) => {
      const p = this.peers.get(r.sid);
      const self = r.sid === this.sid;
      return {
        ...r,
        self,
        video: self ? this.camera : r.video && p?.video && !p.video.muted ? p.video : null,
        connected: self || p?.pc.connectionState === 'connected',
        state: self ? 'connected' : p?.pc.connectionState || 'new',
        isMe: r.userId === me,
      };
    });
  }
}
