// Проигрыватель музыки: синхронизирует воспроизведение с состоянием стола
import { toast } from '../ui/components.jsx';

export function getUserVolume() {
  try {
    const v = Number(localStorage.getItem('tv:vol'));
    return Number.isFinite(v) && localStorage.getItem('tv:vol') !== null ? v : 0.8;
  } catch {
    return 0.8;
  }
}

export class Jukebox {
  constructor(store, net) {
    this.store = store;
    this.net = net;
    this.audios = new Map(); // trackId -> Audio
    this.blocked = false;
    this.offs = [store.on('game', () => this.sync()), store.on('snapshot', () => this.sync()), store.on('col:track', () => this.sync()), store.on('volume', () => this.applyVolume()), net.on('sfx', (s) => this.sfx(s))];
    this.unlock = () => {
      if (!this.blocked) return;
      this.blocked = false;
      this.sync(true);
    };
    window.addEventListener('pointerdown', this.unlock);
    this.sync();
  }

  destroy() {
    this.offs.forEach((o) => o());
    window.removeEventListener('pointerdown', this.unlock);
    for (const a of this.audios.values()) a.pause();
    this.audios.clear();
  }

  master() {
    const jb = this.store.state.jukebox || {};
    return (jb.master ?? 1) * getUserVolume();
  }

  sync(force = false) {
    const st = this.store.state.jukebox || {};
    const playing = st.playing || {};
    for (const [id, a] of [...this.audios]) {
      if (!playing[id]) {
        a.pause();
        this.audios.delete(id);
      }
    }
    for (const [id, p] of Object.entries(playing)) {
      const tr = this.store.col.track.get(id);
      if (!tr?.url) continue;
      let a = this.audios.get(id);
      const isNew = !a;
      if (!a) {
        a = new Audio(tr.url);
        a.preload = 'auto';
        this.audios.set(id, a);
        a.addEventListener('ended', () => {
          // трек плейлиста закончился — просим сервер включить следующий
          const cur = (this.store.state.jukebox?.playing || {})[id];
          if (cur?.playlist) this.net.request('jukebox', { action: 'ended', trackId: id, startedAt: cur.startedAt });
        });
        a.addEventListener('loadedmetadata', () => {
          const t = this.store.col.track.get(id);
          if (this.store.isGM && t && !t.duration && Number.isFinite(a.duration) && a.duration > 0) this.net.update('track', id, { duration: Math.round(a.duration) });
        });
      }
      a.loop = !!p.loop;
      a._vol = p.volume ?? 0.6;
      a.volume = Math.max(0, Math.min(1, a._vol * this.master()));
      if (isNew || force || a._startedAt !== p.startedAt) {
        a._startedAt = p.startedAt;
        const seek = () => {
          const el = (Date.now() - p.startedAt) / 1000;
          if (a.duration && Number.isFinite(a.duration)) {
            if (p.loop) a.currentTime = el % a.duration;
            else if (el < a.duration) a.currentTime = el;
            else return false;
          }
          return true;
        };
        const play = () => {
          if (seek() === false) return;
          a.play().catch(() => {
            if (!this.blocked) {
              this.blocked = true;
              toast('Браузер заблокировал звук — щёлкните где-нибудь на странице, чтобы включить музыку');
            }
          });
        };
        if (a.readyState >= 1) play();
        else a.addEventListener('loadedmetadata', play, { once: true });
      }
    }
  }

  applyVolume() {
    for (const a of this.audios.values()) a.volume = Math.max(0, Math.min(1, (a._vol ?? 0.6) * this.master()));
  }

  sfx({ trackId, url, volume }) {
    const tr = trackId ? this.store.col.track.get(trackId) : null;
    const src = url || tr?.url;
    if (!src) return;
    const a = new Audio(src);
    a.volume = Math.max(0, Math.min(1, (volume ?? tr?.volume ?? 0.8) * this.master()));
    a.play().catch(() => {});
  }
}
