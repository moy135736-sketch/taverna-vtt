// Сетевой слой: Socket.IO, оптимистичные изменения, троттлинг перетаскивания
import { io } from 'socket.io-client';
import { newId } from '@shared/ids.js';
import { Emitter } from './store.js';

export class Net extends Emitter {
  constructor(store) {
    super();
    this.store = store;
    this.origin = newId();
    this.pending = new Map(); // "c:id" -> количество неподтверждённых изменений
    this.throttled = new Map(); // "c:id" -> {patch, timer}
    this.held = new Map(); // "c:id" -> последнее отложенное изменение (пассажиры, пока их транспорт тянут)
    this.attrQueue = new Map(); // charId -> {set: Map, del: Set, delPrefix: Set}
    this.attrTimer = null;
    this.connected = false;
  }

  connect() {
    const s = (this.socket = io({ transports: ['websocket', 'polling'], reconnectionDelayMax: 5000 }));
    s.on('connect', async () => {
      this.connected = true;
      this.emit('status', 'connected');
      const r = await this.request('join', { gameId: this.store.gameId });
      if (r?.error) this.emit('fatal', r.error);
    });
    s.on('disconnect', () => {
      this.connected = false;
      this.emit('status', 'disconnected');
    });
    s.on('connect_error', (e) => {
      this.emit('status', 'error');
      if (String(e?.message).includes('unauthorized')) this.emit('fatal', 'Сессия истекла — войдите снова');
    });
    s.on('snapshot', (snap) => {
      // после переподключения атрибуты открытых листов перечитываем, иначе листы перестанут обновляться
      const loaded = [...this.store.attrs.keys()];
      for (const k of this.held.keys()) this.held.set(k, null); // отложенное старше снимка
      this.store.applySnapshot(snap);
      for (const id of loaded) if (this.store.col.char.has(id)) this.ensureAttrs(id).catch(() => {});
    });
    s.on('game', (g) => this.store.applyGame(g));
    s.on('members', ({ members, online }) => {
      this.store.members = new Map(members.map((m) => [m.id, m]));
      this.store.online = new Set(online);
      this.store.emit('members');
    });
    s.on('op', (op) => this.onOp(op));
    s.on('attrs', ({ charId, set, del, o }) => {
      if (o && o === this.origin) return;
      this.store.applyAttrs(charId, set, del, { remote: true });
    });
    s.on('chat', (msg) => {
      this.store.messages.push(msg);
      if (this.store.messages.length > 1500) this.store.messages.splice(0, 300);
      this.store.emit('chat', msg);
    });
    s.on('chat:system', (m) => this.store.emit('chat:system', m));
    // реакции под сообщением поменялись
    s.on('chat:update', ({ id, reactions }) => {
      const i = this.store.messages.findIndex((m) => m.id === id);
      if (i >= 0) this.store.messages[i] = { ...this.store.messages[i], reactions };
      this.store.emit('chat:update', { id, reactions });
    });
    s.on('chat:cleared', () => {
      this.store.messages = [];
      this.store.emit('chat:reset');
    });
    s.on('kicked', ({ reason }) => this.emit('fatal', reason || 'Вы отключены от стола'));
    s.on('rtc:roster', (list) => {
      this.store.voiceRoster = Array.isArray(list) ? list : [];
      this.store.emit('voice');
    });
    for (const ev of ['rtc:joined', 'rtc:left', 'rtc:signal', 'rtc:replaced']) s.on(ev, (d) => this.emit(ev, d));
    for (const ev of ['fx', 'ping:map', 'ruler', 'sfx', 'handout:show', 'sheetChanged', 'effect:ask', 'react:float', 'cine', 'trap:apply', 'trap:skip', 'trap:fired']) s.on(ev, (d) => this.emit(ev, d));
  }

  disconnect() {
    this.socket?.disconnect();
  }

  request(event, payload) {
    return new Promise((resolve) => {
      if (!this.socket) return resolve({ error: 'Нет соединения' });
      this.socket.timeout(20000).emit(event, payload, (err, res) => {
        if (err) resolve({ error: 'Сервер не ответил' });
        else resolve(res);
      });
    });
  }

  onOp(op) {
    const key = op.c + ':' + (op.d?.id || op.id);
    if (this.held.has(key)) {
      // положение пассажира сейчас рассчитывается здесь же; ответ сервера применим, когда транспорт отпустят
      this.held.set(key, op);
      return;
    }
    if (op.o === this.origin) {
      // своё эхо: если следом уже ушли новые изменения — игнорируем, чтобы не дёргалось
      if ((this.pending.get(key) || 0) > 1 || this.throttled.has(key)) return;
    }
    this.store.applyOp(op);
  }

  /** Отложить изменения этих объектов от сервера (их положение предсказывается локально) */
  hold(c, ids) {
    for (const id of ids) if (!this.held.has(c + ':' + id)) this.held.set(c + ':' + id, null);
  }

  /** Применить отложенное и снова принимать изменения как обычно */
  release(c, ids) {
    for (const id of ids) {
      const key = c + ':' + id;
      const op = this.held.get(key);
      this.held.delete(key);
      if (op) this.store.applyOp(op);
    }
  }

  _send(op) {
    const key = op.c + ':' + (op.id || op.d?.id);
    this.pending.set(key, (this.pending.get(key) || 0) + 1);
    return this.request('op', { ...op, o: this.origin }).then((r) => {
      const n = (this.pending.get(key) || 1) - 1;
      if (n <= 0) this.pending.delete(key);
      else this.pending.set(key, n);
      if (r?.error) {
        this.emit('error', r.error);
        // откатываемся к серверной версии
        this.request('join', { gameId: this.store.gameId });
      }
      return r;
    });
  }

  create(c, data) {
    const id = data.id || newId();
    const e = { ...data, id };
    this.store.localUpsert(c, e);
    return this._send({ c, t: 'create', d: e }).then((r) => ({ ...r, id: r?.id || id }));
  }

  /**
   * Изменить сущность. opts.throttle — мс (для перетаскивания); opts.mv — путь перемещения для анимации;
   * opts.drag — номер перетаскивания мышью, opts.dragEnd — токен отпустили, opts.route — путь центра от начала
   * перетаскивания (по ним сервер проверяет ловушки, когда ход сделан)
   */
  update(c, id, patch, opts = {}) {
    const cur = this.store.col[c].get(id);
    if (!cur) return Promise.resolve({ error: 'нет объекта' });
    if (opts.mv && c === 'obj') this.store.movePaths.set(id, opts.mv);
    const next = { ...cur, ...patch };
    if (patch.light && cur.light) next.light = { ...cur.light, ...patch.light };
    if (patch.vision && cur.vision) next.vision = { ...cur.vision, ...patch.vision };
    this.store.localUpsert(c, next);
    const key = c + ':' + id;
    if (opts.throttle) {
      let t = this.throttled.get(key);
      if (t) {
        Object.assign(t.patch, patch);
        if (opts.drag) t.dg = opts.drag;
        return Promise.resolve({ queued: true });
      }
      t = { patch: { ...patch }, dg: opts.drag };
      this.throttled.set(key, t);
      t.timer = setTimeout(() => {
        this.throttled.delete(key);
        this._send(t.dg ? { c, t: 'update', id, d: t.patch, dg: t.dg } : { c, t: 'update', id, d: t.patch });
      }, opts.throttle);
      return Promise.resolve({ queued: true });
    }
    const t = this.throttled.get(key);
    if (t) {
      clearTimeout(t.timer);
      this.throttled.delete(key);
      patch = { ...t.patch, ...patch };
    }
    const op = { c, t: 'update', id, d: patch };
    if (opts.mv && c === 'obj') op.mv = opts.mv;
    if (opts.drag && c === 'obj') {
      op.dg = opts.drag;
      if (opts.dragEnd) op.de = 1;
      if (Array.isArray(opts.route) && opts.route.length >= 2) op.rt = opts.route.slice(0, 64).map((p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }));
    }
    return this._send(op);
  }

  remove(c, id) {
    const old = this.store.col[c].get(id);
    if (old) this.store.applyOp({ c, t: 'delete', id });
    return this._send({ c, t: 'delete', id });
  }

  // ---------------------------------------------------------------------
  // Атрибуты: пакетная отправка
  async ensureAttrs(charId) {
    if (this.store.attrs.has(charId)) return this.store.attrs.get(charId);
    if (!this._attrLoads) this._attrLoads = new Map();
    if (this._attrLoads.has(charId)) return this._attrLoads.get(charId);
    const p = this.request('attrs:get', { charId }).then((r) => {
      this._attrLoads.delete(charId);
      if (r?.error) throw new Error(r.error);
      if (!this.store.attrs.has(charId)) this.store.setAttrList(charId, r.attrs || []);
      return this.store.attrs.get(charId);
    });
    this._attrLoads.set(charId, p);
    return p;
  }

  /**
   * Изменить атрибуты (локально сразу, на сервер — пачкой).
   * sets: [{name, current?, max?}]
   */
  setAttrs(charId, sets = [], dels = [], delPrefixes = [], meta = {}) {
    if (this.store.attrs.has(charId)) {
      let delNames = [...dels];
      if (delPrefixes.length) {
        const m = this.store.attrs.get(charId);
        for (const p of delPrefixes) {
          const lp = p.toLowerCase();
          for (const [k, a] of m) if (k.startsWith(lp)) delNames.push(a.name);
        }
      }
      this.store.applyAttrs(charId, sets, delNames, { local: true, ...meta });
    }
    let q = this.attrQueue.get(charId);
    if (!q) {
      q = { set: new Map(), del: new Set(), delPrefix: new Set() };
      this.attrQueue.set(charId, q);
    }
    for (const s of sets) {
      const k = s.name.toLowerCase();
      q.del.delete(k);
      const prev = q.set.get(k);
      q.set.set(k, prev ? { ...prev, ...s } : { ...s });
    }
    for (const d of dels) {
      const k = d.toLowerCase();
      q.set.delete(k);
      q.del.add(d);
    }
    for (const p of delPrefixes) {
      q.delPrefix.add(p);
      for (const k of [...q.set.keys()]) if (k.startsWith(p.toLowerCase())) q.set.delete(k);
    }
    if (!this.attrTimer) this.attrTimer = setTimeout(() => this.flushAttrs(), 30);
  }

  flushAttrs() {
    this.attrTimer = null;
    const queue = this.attrQueue;
    this.attrQueue = new Map();
    for (const [charId, q] of queue) {
      this.request('attrs:set', { charId, set: [...q.set.values()], del: [...q.del], delPrefix: [...q.delPrefix], o: this.origin }).then((r) => {
        if (r?.error) this.emit('error', r.error);
      });
    }
  }

  // ---------------------------------------------------------------------
  chat(payload) {
    return this.request('chat', payload);
  }
}
