// Клиентское состояние стола
import { lc } from '@shared/attrs.js';

export class Emitter {
  constructor() {
    this._l = new Map();
  }
  on(ev, fn) {
    if (!this._l.has(ev)) this._l.set(ev, new Set());
    this._l.get(ev).add(fn);
    return () => this._l.get(ev)?.delete(fn);
  }
  emit(ev, ...args) {
    const s = this._l.get(ev);
    if (s) for (const fn of [...s]) {
      try {
        fn(...args);
      } catch (e) {
        console.error('[emit]', ev, e);
      }
    }
  }
}

export const COLLECTIONS = ['page', 'obj', 'char', 'handout', 'macro', 'rtable', 'track'];
const LAYER_ORDER = { map: 0, objects: 1, foreground: 2, gm: 3, walls: 4 };

export class GameStore extends Emitter {
  constructor(gameId, user) {
    super();
    this.gameId = gameId;
    this.user = user;
    this.me = { id: user.id, isGM: false };
    this.game = null;
    this.members = new Map();
    this.online = new Set();
    this.voiceRoster = []; // [{sid, userId, muted, video}] — кто в голосовом чате
    this.features = {};
    this.col = {};
    for (const c of COLLECTIONS) this.col[c] = new Map();
    this.attrs = new Map();
    this.messages = [];
    this.movePaths = new Map(); // id объекта → путь (центры) его последнего перемещения — для анимации
    this.ready = false;
    this.ui = {
      pageId: null,
      selected: new Set(),
      tool: 'select',
      layer: 'objects',
      speakingAs: { type: 'player' },
      gmViewAsPlayer: false,
    };
  }

  get isGM() {
    return !!this.me.isGM;
  }

  get settings() {
    return this.game?.settings || {};
  }

  get state() {
    return this.game?.state || {};
  }

  // ---------------------------------------------------------------------
  applySnapshot(snap) {
    this.game = snap.game;
    this.me = snap.me;
    for (const c of COLLECTIONS) {
      this.col[c] = new Map((snap.collections[c] || []).map((e) => [e.id, e]));
    }
    this.members = new Map(snap.members.map((m) => [m.id, m]));
    this.online = new Set(snap.online);
    this.voiceRoster = snap.voice || [];
    this.features = snap.features || {};
    this.messages = snap.messages || [];
    // атрибуты могли устареть — перезагрузим по требованию
    this.attrs = new Map();
    this.ready = true;
    if (!this.ui.pageId || !this.col.page.has(this.ui.pageId) || !this.isGM) this.ui.pageId = this.playerPageFor(this.me.id);
    if (!this.isGM && this.ui.layer !== 'objects') this.ui.layer = 'objects';
    this.emit('snapshot');
    this.emit('voice');
  }

  applyGame(g) {
    const prevPage = this.playerPageFor(this.me.id);
    this.game = g;
    if (!this.isGM) {
      const np = this.playerPageFor(this.me.id);
      if (np !== prevPage || !this.col.page.has(this.ui.pageId)) this.setPage(np);
    }
    this.emit('game', g);
  }

  playerPageFor(userId) {
    const st = this.game?.state || {};
    const p = (st.playerPages && st.playerPages[userId]) || st.playerPageId;
    if (p && this.col.page.has(p)) return p;
    return [...this.col.page.keys()][0] || null;
  }

  setPage(pageId) {
    if (this.ui.pageId === pageId) return;
    this.ui.pageId = pageId;
    this.ui.selected = new Set();
    this.emit('page', pageId);
    this.emit('selection');
  }

  get page() {
    return this.col.page.get(this.ui.pageId) || null;
  }

  applyOp({ c, t, d, id, mv }) {
    const map = this.col[c];
    if (!map) return;
    if (mv && c === 'obj' && d?.id) this.movePaths.set(d.id, mv);
    if (t === 'delete') {
      const old = map.get(id);
      if (!old) return;
      map.delete(id);
      if (c === 'obj' && this.ui.selected.delete(id)) this.emit('selection');
      this.emit('col:' + c, null, id, old);
      if (c === 'page' && this.ui.pageId === id) this.setPage(this.isGM ? [...map.keys()][0] : this.playerPageFor(this.me.id));
    } else {
      const old = map.get(d.id);
      map.set(d.id, d);
      this.emit('col:' + c, d, d.id, old);
    }
  }

  // локальное (оптимистичное) изменение
  localUpsert(c, e) {
    const old = this.col[c].get(e.id);
    this.col[c].set(e.id, e);
    this.emit('col:' + c, e, e.id, old);
  }

  // ---------------------------------------------------------------------
  // Атрибуты
  attrMap(charId) {
    return this.attrs.get(charId) || null;
  }

  setAttrList(charId, list) {
    const m = new Map();
    for (const a of list) m.set(lc(a.name), a);
    this.attrs.set(charId, m);
    this.emit('attrs', charId, { loaded: true });
  }

  /** Применить изменения атрибутов. set: [{id?, name, current?, max?}] */
  applyAttrs(charId, set = [], del = [], meta = {}) {
    const m = this.attrs.get(charId);
    if (!m) return;
    const changed = [];
    for (const s of set) {
      const key = lc(s.name);
      let a = m.get(key);
      if (!a) {
        a = { id: s.id || '', name: s.name, current: '', max: '' };
        m.set(key, a);
      } else if (s.id && !a.id) a.id = s.id;
      const prev = { current: a.current, max: a.max };
      if ('current' in s) a.current = s.current;
      if ('max' in s) a.max = s.max;
      changed.push({ name: a.name, prev, attr: a });
    }
    const removed = [];
    for (const name of del) {
      const key = lc(name);
      const a = m.get(key);
      if (a) {
        m.delete(key);
        removed.push(a);
      }
    }
    if (changed.length || removed.length) this.emit('attrs', charId, { changed, removed, ...meta });
  }

  getAttr(charId, name) {
    return this.attrs.get(charId)?.get(lc(name)) || null;
  }

  // ---------------------------------------------------------------------
  // Права
  canControlChar(ch) {
    if (!ch) return false;
    if (this.isGM) return true;
    const c = ch.controlledBy || [];
    return c.includes('all') || c.includes(this.me.id);
  }

  canControlObj(o) {
    if (!o) return false;
    if (this.isGM) return true;
    if (o.ownerId === this.me.id) return true;
    const c = o.controlledBy || [];
    if (c.includes('all') || c.includes(this.me.id)) return true;
    if (o.represents) return this.canControlChar(this.col.char.get(o.represents));
    return false;
  }

  objsOnPage(pageId = this.ui.pageId) {
    const out = [];
    for (const o of this.col.obj.values()) if (o.pageId === pageId) out.push(o);
    out.sort((a, b) => (LAYER_ORDER[a.layer] ?? 1) - (LAYER_ORDER[b.layer] ?? 1) || (a.z || 0) - (b.z || 0));
    return out;
  }

  memberName(id) {
    return this.members.get(id)?.displayName || '?';
  }

  charByName(name) {
    const n = lc(name);
    for (const c of this.col.char.values()) if (lc(c.name) === n) return c;
    return null;
  }

  selectedObjs() {
    return [...this.ui.selected].map((id) => this.col.obj.get(id)).filter(Boolean);
  }

  setSelection(ids) {
    this.ui.selected = new Set(ids);
    this.emit('selection');
  }

  setTool(tool) {
    this.ui.tool = tool;
    this.emit('tool', tool);
  }

  setLayer(layer) {
    this.ui.layer = layer;
    this.ui.selected = new Set();
    this.emit('layer', layer);
    this.emit('selection');
  }
}
