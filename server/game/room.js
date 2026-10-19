import crypto from 'node:crypto';
import { db, now, parseJSON } from '../db.js';
import { newId } from '../../shared/ids.js';
import { PAGE_DEFAULTS, GAME_SETTINGS_DEFAULTS, GAME_STATE_DEFAULTS, TOKEN_DEFAULTS, TABLE_THEMES, deepMerge } from '../../shared/defaults.js';
import { FILTERS, canControlChar, canSeeChar, canControlObj, filterObj, messageVisible } from './permissions.js';
import { isReaction } from '../../shared/reactions.js';
import { cleanDiceStyle } from '../../shared/diceStyle.js';
import { buildMessage, crpResults, sanitizeComputed, rng } from './chat.js';
import { computeSummary, sessionStart } from './summary.js';
import { cleanTrap, pathEntry, isTrapVictim } from '../../shared/traps.js';
import { processInlineRolls } from '../../shared/dice.js';
import { lc } from '../../shared/attrs.js';
import { ridersOf, carryTransform, placementChanged } from '../../shared/attach.js';
import { applyTokenChange, revertTokenChange, cleanTokenApplied, isTokenKey } from '../../shared/effects.js';
import { config } from '../config.js';

export const COLLECTIONS = ['page', 'obj', 'char', 'handout', 'macro', 'rtable', 'track'];

const SIZE_LIMITS = {
  page: 4_000_000,
  obj: 512_000,
  char: 2_000_000,
  handout: 2_000_000,
  macro: 100_000,
  rtable: 500_000,
  track: 20_000,
};

const PLAYER_OBJ_FIELDS = new Set([
  'x', 'y', 'w', 'h', 'rot', 'flipH', 'flipV', 'name', 'showName', 'markers', 'auras', 'tint', 'effects', 'notes', 'side', 'bars', 'opacity', 'text', 'fontSize', 'color',
  'attachedTo', 'actions', 'barPosition', 'barStyle', 'moveStyle',
]);
const BAR_POSITIONS = ['', 'above', 'top', 'bottom', 'below'];
const BAR_STYLES = ['', 'standard', 'compact'];
const MOVE_STYLE_IDS = ['', 'instant', 'smooth', 'steps', 'teleport', 'fire'];

/** Путь перемещения от клиента: 3…64 точки-центра, от старого места к новому */
function movePath(mv, before, next) {
  if (!Array.isArray(mv) || mv.length < 3 || mv.length > 64) return null;
  const pts = [];
  for (const p of mv) {
    const x = Number(p?.x),
      y = Number(p?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e6 || Math.abs(y) > 1e6) return null;
    pts.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
  }
  const near = (a, x, y) => Math.abs(a.x - x) < 2 && Math.abs(a.y - y) < 2;
  if (!near(pts[0], before.x + before.w / 2, before.y + before.h / 2) || !near(pts[pts.length - 1], next.x + next.w / 2, next.y + next.h / 2)) return null;
  return pts;
}

/** Путь центра токена от начала перетаскивания (присылает клиент): проверяем, что он ведёт из начала в конец */
function cleanRoute(rt, from, to) {
  if (!Array.isArray(rt) || rt.length < 2 || rt.length > 64) return null;
  const pts = [];
  for (const p of rt) {
    const x = Number(p?.x),
      y = Number(p?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e6 || Math.abs(y) > 1e6) return null;
    pts.push({ x, y });
  }
  const near = (a, o) => Math.abs(a.x - (o.x + o.w / 2)) < 2 && Math.abs(a.y - (o.y + o.h / 2)) < 2;
  return near(pts[0], from) && near(pts[pts.length - 1], to) ? pts : null;
}

const numOr = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/**
 * Маркер на токене: {id, n?, until?, applied?}. n — число на маркере (уровень, стопки),
 * until — номер раунда (state.tick), с которого эффект заканчивается,
 * applied — что эффект поменял: [{charId, key, mode, delta|value|prev}] в листе или [{bar, mode, …}] в полосе токена.
 */
function cleanMarkerEntry(e) {
  const out = { id: String(e.id).slice(0, 40) };
  if (e.n !== undefined && e.n !== null && e.n !== '') out.n = typeof e.n === 'number' && Number.isFinite(e.n) ? e.n : String(e.n).slice(0, 8);
  if (e.until !== undefined && e.until !== null && Number.isFinite(Number(e.until))) out.until = Math.round(Number(e.until));
  // кто наложил (токен) и держит ли он концентрацию на этом эффекте
  if (typeof e.src === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(e.src)) out.src = e.src;
  if (e.conc === true) out.conc = true;
  // «до начала/конца следующего хода цели»: номер хода, когда наложили
  if (e.ends && (e.ends.when === 'start' || e.ends.when === 'end') && Number.isFinite(Number(e.ends.seq))) out.ends = { when: e.ends.when, seq: Math.round(Number(e.ends.seq)) };
  if (Array.isArray(e.tokApplied) && e.tokApplied.length) {
    const t = e.tokApplied.slice(0, 12).map(cleanTokenApplied).filter(Boolean);
    if (t.length) out.tokApplied = t;
  }
  if (Array.isArray(e.applied) && e.applied.length) {
    out.applied = e.applied.slice(0, 24).map((a) => {
      // append — кусок, дописанный к текстовому полю листа (+1d4 к «К атакам»); у полос его не бывает
      const it = { mode: a.mode === 'set' || a.mode === 'append' ? a.mode : 'add' };
      if (Number.isInteger(a.bar) && a.bar >= 0 && a.bar < 30 && it.mode !== 'append') it.bar = a.bar;
      else {
        it.charId = String(a.charId || '').slice(0, 40);
        it.key = String(a.key || '').slice(0, 80);
      }
      if (it.mode === 'add') it.delta = numOr(a.delta, 0);
      else {
        it.value = String(a.value ?? '').slice(0, 200);
        if (it.mode === 'set' && a.prev !== undefined) it.prev = String(a.prev ?? '').slice(0, 200);
      }
      return it;
    });
  }
  return out;
}

/** Применить (sign = 1) или откатить (−1) изменения непривязанных полос токена */
function applyBarEffects(bars, applied, sign) {
  for (const a of applied || []) {
    if (a.bar === undefined || a.mode === 'append') continue;
    const b = bars[a.bar];
    if (!b || b.link) continue;
    if (a.mode === 'add') {
      const v = numOr(b.value, null);
      if (v === null) continue;
      b.value = String(Math.round((v + sign * a.delta) * 1000) / 1000);
    } else if (sign > 0) {
      a.prev = String(b.value ?? '');
      b.value = a.value;
    } else if (String(b.value ?? '') === a.value && a.prev !== undefined) b.value = a.prev; // если значение не меняли вручную
  }
}

/** Макросы токена: [{id, name, action}] — показываются кнопками, когда токен выделен */
function cleanActions(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((a) => a && typeof a === 'object')
    .slice(0, 50)
    .map((a, i) => ({
      id: typeof a.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(a.id) ? a.id : 'a' + i + Math.random().toString(36).slice(2, 8),
      name: String(a.name ?? '').slice(0, 60) || 'действие',
      action: String(a.action ?? '').slice(0, 20000),
    }));
}
const OWNER_EXTRA_FIELDS = new Set(['pts', 'stroke', 'strokeWidth', 'fill', 'shape', 'src', 'fontFamily', 'closed', 'smooth', 'z', 'locked', 'sides']);
const PLAYER_CHAR_FIELDS = new Set(['name', 'avatar', 'bio', 'abilities', 'defaultToken', 'tags']);

const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

function jsonSize(o) {
  try {
    return JSON.stringify(o).length;
  } catch {
    return Infinity;
  }
}

// ---- порядок ходов: формулы своих записей и колода карт ----

/** «+1», «-2» и т. п. — как формула записи в порядке ходов Roll20 */
function cleanFormula(f) {
  if (f === undefined || f === null || f === '') return undefined;
  const m = /^\s*([+-])\s*(\d{1,4}(?:\.\d+)?)\s*$/.exec(String(f));
  return m ? m[1] + m[2] : undefined;
}

function applyFormula(e) {
  if (!e || !e.formula) return;
  const v = Number(e.pr) || 0;
  const d = Number(e.formula.slice(1)) * (e.formula[0] === '-' ? -1 : 1);
  e.pr = Math.round((v + d) * 1000) / 1000;
}

const CARD_RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const CARD_SUITS = ['♣', '♦', '♥', '♠']; // по старшинству: трефы < бубны < червы < пики

/** Ценность карты для порядка ходов: джокеры выше всех, затем по рангу и масти */
export function cardValue(c) {
  if (c === 'JR') return 100;
  if (c === 'JB') return 99;
  const suit = CARD_SUITS.indexOf(c.slice(-1));
  const rank = CARD_RANKS.indexOf(c.slice(0, -1));
  return (rank + 2) * 4 + suit;
}

function shuffledDeck() {
  const deck = ['JR', 'JB'];
  for (const r of CARD_RANKS) for (const su of CARD_SUITS) deck.push(r + su);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export class GameRoom {
  constructor(gameId, io) {
    this.id = gameId;
    this.io = io;
    this.sockets = new Set();
    this.voice = new Map(); // socket.id -> {sid, userId, muted, video} — участники голосового чата
    this.dirty = new Map(); // key -> {c, id}
    this.gameDirty = false;
    this.pendingRolls = new Map();
    this.dragStarts = new Map(); // tokenId -> {dg, x, y, t}: откуда начали тянуть токен (ловушки — по всему пути, когда отпустили)
    this.trapHints = new Map(); // «ловушка не сработала, потому что…» — мастеру не чаще раза в 15 секунд
    this.attrs = new Map(); // charId -> Map(lcName -> attr)
    this.lastActive = now();
    this.load();
    this.flushTimer = setInterval(() => this.flush(), 1500);
    this.flushTimer.unref?.();
  }

  // ---------------------------------------------------------------------
  // Загрузка
  // ---------------------------------------------------------------------

  load() {
    this.reloadGameRow();
    this.reloadMembers(false);
    this.entities = {};
    for (const c of COLLECTIONS) this.entities[c] = new Map();
    const rows = db.prepare(`SELECT id, type, parent_id, data FROM entities WHERE game_id=?`).all(this.id);
    for (const r of rows) {
      if (!this.entities[r.type]) continue;
      const d = parseJSON(r.data, {});
      d.id = r.id;
      this.entities[r.type].set(r.id, d);
    }
    // Гарантируем хотя бы одну страницу
    if (!this.entities.page.size) {
      const id = newId();
      const page = { ...clone(PAGE_DEFAULTS), id, name: 'Первая сцена' };
      this.entities.page.set(id, page);
      this.markDirty('page', id);
      this.state.playerPageId = id;
      this.gameDirty = true;
    }
    if (!this.state.playerPageId || !this.entities.page.has(this.state.playerPageId)) {
      this.state.playerPageId = [...this.entities.page.keys()][0];
      this.gameDirty = true;
    }
  }

  reloadGameRow() {
    this.game = db.prepare(`SELECT * FROM games WHERE id=?`).get(this.id);
    if (!this.game) throw new Error('Стол не найден');
    // какой лист у стола — по нему клиент выбирает оформление (киберпанк, фэнтези)
    this.sheetInfo = this.game.sheet_id ? db.prepare(`SELECT name, source_ref FROM sheets WHERE id=?`).get(this.game.sheet_id) || null : null;
    this.settings = deepMerge(clone(GAME_SETTINGS_DEFAULTS), parseJSON(this.game.settings, {}));
    if (!this.state) this.state = deepMerge(clone(GAME_STATE_DEFAULTS), parseJSON(this.game.state, {}));
    if (this.sockets) {
      for (const s of this.sockets) s.emit('game', this.gamePayload(this.viewer(s)));
    }
  }

  reloadMembers(resync = false) {
    const rows = db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.color, u.avatar, u.settings AS user_settings, m.role, m.settings FROM members m JOIN users u ON u.id=m.user_id WHERE m.game_id=?`,
      )
      .all(this.id);
    const old = this.members;
    this.members = new Map(
      rows.map((r) => [
        r.id,
        {
          id: r.id,
          username: r.username,
          displayName: r.display_name,
          color: r.color,
          avatar: r.avatar,
          role: r.role,
          settings: parseJSON(r.settings, {}),
          // свои кубики и эффект броска — их видят все за столом
          dice: cleanDiceStyle(parseJSON(r.user_settings, {}).dice),
        },
      ]),
    );
    if (resync && this.sockets) {
      for (const s of [...this.sockets]) {
        const m = this.members.get(s.data.user.id);
        if (!m) {
          s.emit('kicked', { reason: 'Вас исключили из стола' });
          s.leave(this.id);
          this.removeSocket(s);
          continue;
        }
        const was = old && old.get(s.data.user.id);
        if (!was || was.role !== m.role) this.sendSnapshot(s);
      }
      this.broadcastMembers();
    }
  }

  isGM(userId) {
    return this.members.get(userId)?.role === 'gm';
  }

  viewer(socket) {
    const userId = socket.data.user.id;
    return { userId, isGM: this.isGM(userId) };
  }

  /** Сцена, на которой сейчас находится игрок */
  playerPageOf(userId) {
    const st = this.state || {};
    const p = (st.playerPages && st.playerPages[userId]) || st.playerPageId;
    if (p && this.entities?.page.has(p)) return p;
    return this.entities ? [...this.entities.page.keys()][0] : null;
  }

  canSeePage(viewer, pageId) {
    return viewer.isGM || (!!pageId && pageId === this.playerPageOf(viewer.userId));
  }

  /** Снимок «кто на какой сцене» — чтобы после перестановки игроков переслать им новую сцену */
  playerPagesSnapshot() {
    const m = new Map();
    for (const s of this.sockets) m.set(s, this.playerPageOf(s.data.user.id));
    return m;
  }

  resyncMovedPlayers(before) {
    for (const s of this.sockets) {
      if (this.isGM(s.data.user.id)) continue;
      if (before.get(s) !== this.playerPageOf(s.data.user.id)) this.sendSnapshot(s);
    }
  }

  canControlChar(viewer, ch) {
    return canControlChar(this, viewer, ch);
  }

  // ---------------------------------------------------------------------
  // Сохранение
  // ---------------------------------------------------------------------

  markDirty(c, id) {
    this.dirty.set(c + ':' + id, { c, id });
  }

  flush() {
    if (!this.dirty.size && !this.gameDirty) return;
    const t = now();
    const upsert = db.prepare(
      `INSERT INTO entities(id, game_id, type, parent_id, data, updated_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET data=excluded.data, parent_id=excluded.parent_id, updated_at=excluded.updated_at`,
    );
    const del = db.prepare(`DELETE FROM entities WHERE id=? AND game_id=?`);
    const items = [...this.dirty.values()];
    this.dirty.clear();
    const gameDirty = this.gameDirty;
    this.gameDirty = false;
    db.transaction(() => {
      for (const { c, id } of items) {
        const e = this.entities[c].get(id);
        if (!e) del.run(id, this.id);
        else upsert.run(id, this.id, c, e.pageId || e.charId || null, JSON.stringify(e), t);
      }
      // обложка стола в лобби — самая большая картинка слоя карты на сцене игроков
      const thumb = this.computeThumbnail();
      if (thumb !== null && thumb !== this.game.thumbnail) {
        db.prepare(`UPDATE games SET thumbnail=? WHERE id=?`).run(thumb, this.id);
        this.game.thumbnail = thumb;
      }
      if (gameDirty) {
        db.prepare(`UPDATE games SET settings=?, state=?, updated_at=?, last_played=? WHERE id=?`).run(
          JSON.stringify(this.settings),
          JSON.stringify(this.state),
          t,
          t,
          this.id,
        );
      }
    })();
  }

  computeThumbnail() {
    const pageId = this.state?.playerPageId;
    if (!pageId) return null;
    let best = null;
    for (const o of this.entities.obj.values()) {
      if (o.pageId !== pageId || o.layer !== 'map' || o.type !== 'image' || typeof o.src !== 'string') continue;
      if (!o.src.startsWith('/uploads/') || /\.(webm|mp4)$/i.test(o.src)) continue;
      const area = (o.w || 0) * (o.h || 0);
      if (!best || area > best.area) best = { src: o.src, area };
    }
    return best ? best.src : '';
  }

  // ---------------------------------------------------------------------
  // Сокеты и снимок состояния
  // ---------------------------------------------------------------------

  addSocket(socket) {
    this.sockets.add(socket);
    socket.join(this.id);
    this.lastActive = now();
    this.sendSnapshot(socket);
    this.broadcastMembers();
  }

  removeSocket(socket) {
    this.sockets.delete(socket);
    this.voiceLeave(socket);
    this.lastActive = now();
    this.broadcastMembers();
  }

  // ---------------------------------------------------------------------
  // Голосовой и видеочат: кто подключён и пересылка сигналов WebRTC.
  // Звук и видео идут напрямую между браузерами, сервер видит только служебные сообщения.
  // ---------------------------------------------------------------------

  voiceRoster() {
    return [...this.voice.values()].map((v) => ({ ...v }));
  }

  broadcastVoice() {
    this.io.to(this.id).emit('rtc:roster', this.voiceRoster());
  }

  voiceJoin(socket, { muted, video } = {}) {
    if (!this.voice.has(socket.id) && this.voice.size >= config.voiceMax)
      throw new Error(`Сейчас нельзя: в голосовом чате уже ${config.voiceMax} участников`);
    const me = { sid: socket.id, userId: socket.data.user.id, muted: !!muted, video: !!video };
    // тот же человек в другой вкладке — переносим голосовой чат сюда, иначе он услышит сам себя
    for (const p of [...this.voice.values()]) {
      if (p.userId !== me.userId || p.sid === socket.id) continue;
      const old = [...this.sockets].find((s) => s.id === p.sid);
      if (old) {
        old.emit('rtc:replaced');
        this.voiceLeave(old);
      } else this.voice.delete(p.sid);
    }
    const peers = this.voiceRoster().filter((p) => p.sid !== socket.id);
    this.voice.set(socket.id, me);
    // уже подключённые узнают о новичке раньше, чем получат от него предложение соединения
    for (const p of peers) this.io.to(p.sid).emit('rtc:joined', { ...me });
    this.broadcastVoice();
    return peers;
  }

  voiceLeave(socket) {
    if (!this.voice.delete(socket.id)) return;
    for (const p of this.voice.values()) this.io.to(p.sid).emit('rtc:left', { sid: socket.id });
    this.broadcastVoice();
  }

  voiceSignal(socket, to, data) {
    const target = String(to || '');
    if (!this.voice.has(socket.id)) throw new Error('Сначала подключитесь к голосовому чату');
    if (!this.voice.has(target)) return { gone: true };
    const json = JSON.stringify(data ?? null);
    if (json.length > 100_000) throw new Error('Слишком большое служебное сообщение');
    this.io.to(target).emit('rtc:signal', { from: socket.id, data: JSON.parse(json) });
  }

  voiceState(socket, { muted, video } = {}) {
    const me = this.voice.get(socket.id);
    if (!me) return;
    if (muted !== undefined) me.muted = !!muted;
    if (video !== undefined) me.video = !!video;
    this.broadcastVoice();
  }

  onlineUserIds() {
    return [...new Set([...this.sockets].map((s) => s.data.user.id))];
  }

  /** Участник для клиентов: без логина и личных настроек */
  publicMembers() {
    return [...this.members.values()].map((m) => ({ id: m.id, displayName: m.displayName, color: m.color, avatar: m.avatar, role: m.role, dice: m.dice }));
  }

  /** Игрок поменял профиль (имя, цвет, аватар, кубики) — обновить у всех за столом */
  memberProfileChanged(userId) {
    if (!this.members.has(userId)) return;
    this.reloadMembers(false);
    this.broadcastMembers();
  }

  broadcastMembers() {
    const payload = {
      members: this.publicMembers(),
      online: this.onlineUserIds(),
    };
    this.io.to(this.id).emit('members', payload);
  }

  filterState(viewer) {
    const st = clone(this.state);
    delete st.deck;
    if (!viewer.isGM) {
      st.turnorder = (st.turnorder || []).filter((e) => {
        if (!e.tokenId) return !e.hidden;
        const o = this.entities.obj.get(e.tokenId);
        return o && o.layer !== 'gm' && this.canSeePage(viewer, o.pageId);
      });
    }
    return st;
  }

  gamePayload(viewer) {
    const settings = clone(this.settings);
    if (!viewer.isGM) delete settings.banned;
    return {
      id: this.id,
      name: this.game.name,
      ownerId: this.game.owner_id,
      sheetId: this.game.sheet_id,
      sheetName: this.sheetInfo?.name || '',
      sheetRef: this.sheetInfo?.source_ref || '',
      settings,
      state: this.filterState(viewer),
      inviteCode: viewer.isGM ? this.game.invite_code : undefined,
    };
  }

  sendSnapshot(socket) {
    const viewer = this.viewer(socket);
    const snap = { game: this.gamePayload(viewer), me: { id: viewer.userId, isGM: viewer.isGM }, collections: {} };
    for (const c of COLLECTIONS) {
      const list = [];
      for (const e of this.entities[c].values()) {
        const f = FILTERS[c](this, viewer, e);
        if (f) list.push(f);
      }
      snap.collections[c] = list;
    }
    snap.members = this.publicMembers();
    snap.online = this.onlineUserIds();
    snap.voice = this.voiceRoster();
    snap.features = { voice: config.voiceEnabled, secureSamePort: config.httpsSamePort };
    snap.messages = this.loadMessages(viewer, null, 150);
    socket.emit('snapshot', snap);
  }

  broadcastGame() {
    for (const s of this.sockets) s.emit('game', this.gamePayload(this.viewer(s)));
  }

  broadcastSheetChanged() {
    this.reloadGameRow();
    this.io.to(this.id).emit('sheetChanged', { sheetId: this.game.sheet_id });
  }

  shutdown(reason) {
    this.io.to(this.id).emit('kicked', { reason });
    for (const s of this.sockets) s.leave(this.id);
    this.sockets.clear();
    this.voice.clear();
    clearInterval(this.flushTimer);
  }

  // ---------------------------------------------------------------------
  // Рассылка изменений с учётом прав
  // ---------------------------------------------------------------------

  emitEntity(c, id, before, after, origin, mv = null) {
    const filter = FILTERS[c];
    for (const s of this.sockets) {
      const v = this.viewer(s);
      const fa = after ? filter(this, v, after) : null;
      if (fa) {
        s.emit('op', mv ? { c, t: 'upsert', d: fa, o: origin, mv } : { c, t: 'upsert', d: fa, o: origin });
      } else {
        const fb = before ? filter(this, v, before) : null;
        if (fb || !after) s.emit('op', { c, t: 'delete', id, o: origin });
      }
    }
  }

  // ---------------------------------------------------------------------
  // Операции над сущностями
  // ---------------------------------------------------------------------

  handleOp(socket, op) {
    const viewer = this.viewer(socket);
    const c = op?.c;
    if (!COLLECTIONS.includes(c)) throw new Error('Неизвестная коллекция');
    this.lastActive = now();
    if (op.t === 'create') return this.create(c, op.d || {}, viewer, op.o);
    if (op.t === 'update') return this.update(c, op.id, op.d || {}, viewer, op.o, op.mv, op.dg ? { dg: String(op.dg).slice(0, 40), end: !!op.de, route: op.rt } : null);
    if (op.t === 'delete') return this.remove(c, op.id, viewer, op.o);
    throw new Error('Неизвестная операция');
  }

  create(c, data, viewer, origin) {
    const id = typeof data.id === 'string' && /^[A-Za-z0-9-]{6,40}$/.test(data.id) && !this.entities[c].has(data.id) ? data.id : newId();
    let e;
    switch (c) {
      case 'page': {
        if (!viewer.isGM) throw new Error('Только мастер создаёт сцены');
        e = deepMerge(clone(PAGE_DEFAULTS), data);
        e.order = this.entities.page.size;
        break;
      }
      case 'obj': {
        const page = this.entities.page.get(data.pageId);
        if (!page) throw new Error('Сцена не найдена');
        if (!this.canSeePage(viewer, page.id)) throw new Error('Нет доступа к этой сцене');
        e = { ...clone(TOKEN_DEFAULTS), ...data };
        if (!viewer.isGM) {
          if (!['objects', 'foreground'].includes(e.layer)) e.layer = 'objects';
          if (!['image', 'shape', 'path', 'text'].includes(e.type)) throw new Error('Нельзя создать такой объект');
          if (e.type === 'path' && !this.settings.playersCanDraw) throw new Error('Мастер запретил рисовать');
          e.ownerId = viewer.userId;
          e.controlledBy = [viewer.userId];
          e.light = clone(TOKEN_DEFAULTS.light);
          e.vision = clone(TOKEN_DEFAULTS.vision);
          if (e.represents) {
            const ch = this.entities.char.get(e.represents);
            if (!ch || !canControlChar(this, viewer, ch)) e.represents = '';
            else if (ch.defaultToken) {
              if (ch.defaultToken.light) e.light = clone(ch.defaultToken.light);
              if (ch.defaultToken.vision) e.vision = clone(ch.defaultToken.vision);
            }
          }
          delete e.gmnotes;
        }
        if (e.type === 'wall' && !viewer.isGM) throw new Error('Стены ставит только мастер');
        if (e.z === undefined || e.z === 0) e.z = this.nextZ(e.pageId, e.layer);
        this.cleanObjFields(e, e, viewer, id, true);
        break;
      }
      case 'char': {
        if (!viewer.isGM && !this.settings.playersCanCreateCharacters) throw new Error('Мастер запретил игрокам создавать персонажей');
        e = {
          name: 'Новый персонаж',
          avatar: '',
          bio: '',
          gmnotes: '',
          controlledBy: [],
          inJournals: [],
          abilities: [],
          defaultToken: null,
          folder: '',
          archived: false,
          tags: [],
          ...data,
        };
        if (!viewer.isGM) {
          e.controlledBy = [viewer.userId];
          e.inJournals = [viewer.userId];
          e.ownerId = viewer.userId;
          delete e.gmnotes;
        }
        e.createdAt = now();
        break;
      }
      case 'handout': {
        if (!viewer.isGM) throw new Error('Раздаточные материалы создаёт мастер');
        e = { name: 'Новый материал', avatar: '', notes: '', gmnotes: '', inJournals: [], controlledBy: [], folder: '', archived: false, ...data };
        break;
      }
      case 'macro': {
        e = { name: 'macro', action: '', visibleTo: [], istokenaction: false, ...data, ownerId: viewer.userId };
        e.name = String(e.name).replace(/\s+/g, '-').slice(0, 60) || 'macro';
        break;
      }
      case 'rtable': {
        if (!viewer.isGM) throw new Error('Таблицы создаёт мастер');
        e = { name: 'таблица', showPlayers: true, items: [], ...data };
        e.name = String(e.name).replace(/\s+/g, '-').slice(0, 60);
        break;
      }
      case 'track': {
        if (!viewer.isGM) throw new Error('Музыкой управляет мастер');
        e = { name: 'Трек', url: '', volume: 0.6, loop: true, playlist: '', ...data };
        break;
      }
    }
    e.id = id;
    if (jsonSize(e) > SIZE_LIMITS[c]) throw new Error('Слишком большой объект');
    this.entities[c].set(id, e);
    this.markDirty(c, id);
    if (c === 'obj') this.syncBarsFromAttrs(e);
    this.emitEntity(c, id, null, e, origin);
    return { id };
  }

  nextZ(pageId, layer) {
    let z = 0;
    for (const o of this.entities.obj.values()) if (o.pageId === pageId && o.layer === layer && (o.z || 0) > z) z = o.z || 0;
    return z + 1;
  }

  /**
   * drag — сведения о перетаскивании мышью: {dg — номер перетаскивания, end — токен отпустили, route — путь центра
   * от начала перетаскивания (с поворотами)}. Ловушки проверяются, когда ход сделан, а не пока токен тянут.
   */
  update(c, id, patch, viewer, origin, mv, drag = null) {
    const before = this.entities[c].get(id);
    if (!before) throw new Error('Объект не найден');
    delete patch.id;
    let next;
    switch (c) {
      case 'page':
        if (!viewer.isGM) throw new Error('Только мастер меняет сцены');
        next = deepMerge(before, patch);
        break;
      case 'obj': {
        if (!canControlObj(this, viewer, before)) throw new Error('Нет прав на этот объект');
        if (!viewer.isGM) {
          const owner = before.ownerId === viewer.userId;
          const clean = {};
          for (const [k, v] of Object.entries(patch)) {
            if (PLAYER_OBJ_FIELDS.has(k) || (owner && OWNER_EXTRA_FIELDS.has(k))) clean[k] = v;
          }
          if (clean.bars && Array.isArray(clean.bars) && !owner) {
            // игрок меняет только значения существующих баров
            const byId = new Map(clean.bars.map((b) => [b.id, b]));
            clean.bars = (before.bars || []).map((b) => {
              const nb = byId.get(b.id);
              if (!nb || b.editable === 'gm') return b;
              return { ...b, value: nb.value, max: nb.max };
            });
          }
          if (before.locked && !owner) {
            delete clean.x;
            delete clean.y;
          }
          patch = clean;
        }
        next = { ...before, ...patch };
        if (patch.light) next.light = { ...before.light, ...patch.light };
        if (patch.vision) next.vision = { ...before.vision, ...patch.vision };
        if (next.pageId !== before.pageId && !this.entities.page.has(next.pageId)) next.pageId = before.pageId;
        this.cleanObjFields(next, patch, viewer, id, false);
        // пассажира взяли и передвинули сами — он отцепляется
        if (before.attachedTo && patch.attachedTo === undefined && ((patch.x !== undefined && patch.x !== before.x) || (patch.y !== undefined && patch.y !== before.y))) next.attachedTo = '';
        break;
      }
      case 'char': {
        if (!canControlChar(this, viewer, before)) throw new Error('Нет прав на этого персонажа');
        if (!viewer.isGM) {
          const clean = {};
          for (const [k, v] of Object.entries(patch)) if (PLAYER_CHAR_FIELDS.has(k)) clean[k] = v;
          patch = clean;
        }
        next = { ...before, ...patch };
        break;
      }
      case 'handout': {
        const isCtl = viewer.isGM || (Array.isArray(before.controlledBy) && (before.controlledBy.includes(viewer.userId) || before.controlledBy.includes('all')));
        if (!isCtl) throw new Error('Нет прав на этот материал');
        if (!viewer.isGM) patch = { notes: patch.notes, name: patch.name, avatar: patch.avatar };
        for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
        next = { ...before, ...patch };
        break;
      }
      case 'macro':
        if (before.ownerId !== viewer.userId && !viewer.isGM) throw new Error('Это чужой макрос');
        next = { ...before, ...patch, ownerId: before.ownerId };
        if (patch.name !== undefined) next.name = String(next.name).replace(/\s+/g, '-').slice(0, 60) || 'macro';
        break;
      case 'rtable':
        if (!viewer.isGM) throw new Error('Таблицы меняет мастер');
        next = { ...before, ...patch };
        if (patch.name !== undefined) next.name = String(next.name).replace(/\s+/g, '-').slice(0, 60);
        break;
      case 'track':
        if (!viewer.isGM) throw new Error('Музыкой управляет мастер');
        next = { ...before, ...patch };
        break;
    }
    next.id = id;
    if (jsonSize(next) > SIZE_LIMITS[c]) throw new Error('Слишком большой объект');
    // путь перемещения (точки поворота) — только для анимации у зрителей, не сохраняется
    const moved = c === 'obj' && (next.x !== before.x || next.y !== before.y);
    let path = moved ? movePath(mv, before, next) : null;
    // ловушки: ход сделан — проверяем весь путь; токен наступил — может остановиться на месте срабатывания
    const trapRes = c === 'obj' ? this.trapCheckOnMove(id, before, next, path, drag, viewer) : null;
    const sprung = trapRes?.best || null;
    if (sprung?.stopAt) {
      next.x = sprung.stopAt.x;
      next.y = sprung.stopAt.y;
      // анимация — по укороченному пути, если он начинается там, где токен стоял; иначе по прямой
      const bc = { x: before.x + before.w / 2, y: before.y + before.h / 2 };
      const p0 = sprung.path?.[0];
      path = p0 && Math.abs(p0.x - bc.x) < 2 && Math.abs(p0.y - bc.y) < 2 ? sprung.path : null;
    }
    this.entities[c].set(id, next);
    this.markDirty(c, id);

    if (c === 'obj') {
      // правка связанного бара напрямую → обновляем атрибут персонажа
      this.pushBarsToAttrs(before, next, viewer);
      if (patch.represents !== undefined || patch.bars !== undefined) this.syncBarsFromAttrs(next);
    }
    // остановленный ловушкой токен — и тому, кто его вёл: без отметки «своё эхо», чтобы его клиент не пропустил
    this.emitEntity(c, id, before, next, sprung?.stopAt ? null : origin, path);
    if (c === 'obj' && next.type !== 'wall' && placementChanged(before, next)) this.carryRiders(before, next, path);
    if (sprung) this.fireTrap(sprung.trap, next, sprung.hit, viewer);
    if (trapRes?.skipped?.length) this.trapSkipHints(viewer, trapRes.skipped, next);

    if (c === 'char') {
      const permChanged = JSON.stringify(before.controlledBy) !== JSON.stringify(next.controlledBy) || JSON.stringify(before.inJournals) !== JSON.stringify(next.inJournals) || before.archived !== next.archived;
      if (permChanged) {
        // права на персонажа влияют на видимость его токенов
        for (const o of this.entities.obj.values()) if (o.represents === id) this.emitEntity('obj', o.id, o, o, null);
      }
      if (before.name !== next.name) this.attrNameChanged(id, next.name);
    }
    return { id };
  }

  // ---------------------------------------------------------------------
  // Ловушки
  // ---------------------------------------------------------------------

  /** Управляет ли токеном кто-то из игроков (не мастер) */
  isPlayerToken(o) {
    const ids = new Set(Array.isArray(o.controlledBy) ? o.controlledBy : []);
    const ch = o.represents ? this.entities.char.get(o.represents) : null;
    for (const u of Array.isArray(ch?.controlledBy) ? ch.controlledBy : []) ids.add(u);
    for (const u of ids) if (u === 'all' || (this.members.has(u) && this.members.get(u).role !== 'gm')) return true;
    return false;
  }

  /**
   * Когда проверять ловушки. Пока токен тянут (шаги перетаскивания), — нет: только запоминаем, откуда начали.
   * Отпустили — путь от начала перетаскивания до места, где отпустили (с поворотами). Прочие перемещения
   * (стрелки, отмена, перенос мастером) — сразу, от прежнего места.
   */
  trapCheckOnMove(id, before, next, path, drag, viewer) {
    const starts = this.dragStarts || (this.dragStarts = new Map());
    if (drag?.dg && !drag.end) {
      const rec = starts.get(id);
      if (!rec || rec.dg !== drag.dg) {
        starts.set(id, { dg: drag.dg, x: before.x, y: before.y, t: Date.now() });
        if (starts.size > 500) for (const [k, r] of starts) if (Date.now() - r.t > 30 * 60000) starts.delete(k);
      }
      return null;
    }
    let from = before;
    let route = path;
    if (drag?.dg) {
      const rec = starts.get(id);
      if (rec && rec.dg === drag.dg) from = { ...before, x: rec.x, y: rec.y };
      starts.delete(id);
      route = cleanRoute(drag.route, from, next);
    } else if (next.x === before.x && next.y === before.y) return null; // не ход (бар, имя…) — перетаскивание, если идёт, не трогаем
    else starts.delete(id);
    if (from.x === next.x && from.y === next.y) return null;
    return this.trapOnMove(from, next, route, viewer);
  }

  /**
   * Наступил ли токен на взведённую ловушку по пути from → to. Возвращает первую по пути:
   * { trap, hit, stopAt?, path? } — stopAt: где остановить токен (левый верхний угол), path — укороченный путь.
   */
  trapOnMove(before, next, path, viewer) {
    if (!isTrapVictim(next) || next.pageId !== before.pageId) return null;
    const traps = [];
    for (const o of this.entities.obj.values()) if (o.trap && o.trap.armed !== false && o.pageId === next.pageId && o.id !== next.id) traps.push(o);
    if (!traps.length) return null;
    const c0 = { x: before.x + before.w / 2, y: before.y + before.h / 2 };
    const c1 = { x: next.x + next.w / 2, y: next.y + next.h / 2 };
    const route = path && path.length >= 2 ? path : [c0, c1];
    // токен на слое мастера (спрятанный) — это не токен игрока: его ловят только ловушки «на всех»
    const playerTok = next.layer !== 'gm' && this.isPlayerToken(next);
    let best = null;
    const skipped = [];
    for (const t of traps) {
      const cfg = t.trap;
      const notPlayer = cfg.trigger !== 'any' && !playerTok;
      const notGm = viewer.isGM && cfg.gmMoves === false;
      const why = notPlayer && notGm ? 'both' : notPlayer ? 'players' : notGm ? 'gm' : '';
      const hit = pathEntry(t, route);
      if (!hit) continue;
      if (why) {
        // мастер провёл токен через ловушку, а она его не ловит по своим настройкам — подскажем почему
        if (viewer.isGM) skipped.push({ trap: t, why });
        continue;
      }
      if (!best || hit.dist < best.hit.dist) best = { trap: t, hit };
    }
    if (!best) return { best: null, skipped };
    if (best.trap.trap.stop) {
      // центр токена — чуть внутри ловушки; при привязке к сетке — по клетке
      const page = this.entities.page.get(next.pageId);
      const cell = Number(page?.cellSize) || 70;
      let x = best.hit.x + best.hit.dir.x * cell * 0.3 - next.w / 2;
      let y = best.hit.y + best.hit.dir.y * cell * 0.3 - next.h / 2;
      if (page?.snap !== false && page?.gridType === 'square') {
        x = Math.round(x / cell) * cell;
        y = Math.round(y / cell) * cell;
      }
      best.stopAt = { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
      // путь для анимации — до места остановки
      const stopC = { x: best.stopAt.x + next.w / 2, y: best.stopAt.y + next.h / 2 };
      const pts = [];
      let acc = 0;
      for (let i = 0; i < route.length; i++) {
        if (i) acc += Math.hypot(route[i].x - route[i - 1].x, route[i].y - route[i - 1].y);
        if (acc >= best.hit.dist) break;
        pts.push(route[i]);
      }
      pts.push(stopC);
      best.path = pts.length >= 3 ? pts : null;
    }
    return { best, skipped };
  }

  /** Всем соединениям пользователя (у него может быть открыто несколько вкладок) */
  emitToUser(userId, ev, data) {
    for (const s of this.sockets) if (s.data.user.id === userId) s.emit(ev, data);
  }

  /** Мастер провёл токен через ловушку, но она его не ловит — короткая подсказка, почему */
  trapSkipHints(viewer, skipped, token) {
    const t = Date.now();
    for (const { trap, why } of skipped) {
      const key = trap.id + '|' + viewer.userId;
      if (t - (this.trapHints.get(key) || 0) < 15000) continue;
      this.trapHints.set(key, t);
      const ch = token.represents ? this.entities.char.get(token.represents) : null;
      this.emitToUser(viewer.userId, 'trap:skip', { trapId: trap.id, name: trap.trap.name, why, token: token.name || ch?.name || 'Токен' });
    }
    if (this.trapHints.size > 500) this.trapHints.clear();
  }

  /** Ловушка сработала: счётчик, разрядка, описание и бросок в чат, эффекты, урон (через клиента мастера) */
  fireTrap(trapObj, token, hit, viewer) {
    const cfg = trapObj.trap;
    const tok = this.entities.obj.get(token.id) || token;
    const ch = tok.represents ? this.entities.char.get(tok.represents) : null;
    const who = tok.name || ch?.name || 'Токен';
    // попался спрятанный на слое мастера токен — игрокам об этом знать нельзя: всё только мастеру
    const secret = tok.layer === 'gm';
    // счётчик, разрядка, показать игрокам
    const upd = { ...trapObj, trap: { ...cfg, count: (cfg.count || 0) + 1, armed: cfg.once ? false : cfg.armed !== false } };
    if (cfg.reveal && trapObj.layer === 'gm' && !secret) upd.layer = 'map';
    this.entities.obj.set(trapObj.id, upd);
    this.markDirty('obj', trapObj.id);
    this.emitEntity('obj', trapObj.id, trapObj, upd, null);

    const gms = [...this.members.values()].filter((m) => m.role === 'gm').map((m) => m.id);
    const status = cfg.once ? 'Ловушка разряжена.' : `Сработала ${upd.trap.count}-й раз, остаётся взведённой.`;
    // описание для всех: текст, бросок, спасбросок
    const lines = [];
    const text = String(cfg.message || '').replace(/\{name\}/g, who);
    if (text) lines.push(text);
    if (cfg.roll) lines.push(`${cfg.damage ? 'Урон' : 'Бросок'}: [[${cfg.roll}]]`);
    if (cfg.save) lines.push(`Спасбросок: ${cfg.save}`);
    let damage = null;
    if (lines.length) {
      let content = lines.join('\n');
      let rolls = [];
      try {
        const r = processInlineRolls(content, { rng, tables: (name) => this.tableItems(name) });
        content = r.text;
        rolls = r.rolls;
      } catch (e) {
        content = content.replace(/\[\[[^\]]*\]\]/g, '?') + ` (ошибка в броске: ${e.message})`;
      }
      const last = cfg.roll && rolls.length ? rolls[rolls.length - 1] : null;
      if (cfg.damage && last && typeof last.total === 'number' && last.total > 0) damage = Math.floor(last.total);
      const msg = { id: newId(), ts: now(), type: 'trap', who: cfg.name, playerId: '', color: '#b23a48', avatar: '', charId: null, content, inlinerolls: rolls, trap: { name: cfg.name, token: who } };
      if (secret) msg.to = gms;
      this.postMessage(msg);
    }
    // мастеру — что случилось с ловушкой: в чат и всплывающим уведомлением (если урона нет — о нём скажет своё)
    if (gms.length) this.systemMessage(`Ловушка «${cfg.name}»: попался ${who}. ${status}`, gms);
    if (!damage) for (const g of gms) this.emitToUser(g, 'trap:fired', { name: cfg.name, token: who, status });
    // эффекты у всех, кто видит эту сцену (спрятанный токен — только у мастера)
    const pageId = tok.pageId;
    const [fxType, fxColor] = cfg.fx ? cfg.fx.split('-') : [];
    for (const s of this.sockets) {
      const v = this.viewer(s);
      if (!this.canSeePage(v, pageId) || (secret && !v.isGM)) continue;
      if (fxType) s.emit('fx', { pageId, type: fxType, color: fxColor, x: hit.x, y: hit.y, by: '' });
      if (cfg.shake) s.emit('cine', { kind: 'shake', strength: 'strong', id: newId(), by: '' });
      if (cfg.flash) s.emit('cine', { kind: 'flash', color: cfg.flash, id: newId(), by: '' });
    }
    // урон: хиты меняет клиент мастера (связанные атрибуты, временные хиты, отмена); мастера нет — клиент того, кто шёл
    if (damage) {
      const sockets = [...this.sockets];
      const target = sockets.find((s) => this.viewer(s).isGM) || sockets.find((s) => s.data.user.id === viewer.userId);
      target?.emit('trap:apply', { tokenId: tok.id, amount: damage, trap: cfg.name });
    }
  }

  /** Проверка и приведение полей токена: сцепка, макросы токена, положение баров */
  cleanObjFields(next, patch, viewer, id, creating) {
    // ловушку ставит и настраивает только мастер
    if (patch.trap !== undefined) next.trap = viewer.isGM ? cleanTrap(patch.trap) : null;
    if (next.trap === null) delete next.trap;
    if (patch.actions !== undefined) next.actions = cleanActions(patch.actions);
    if (patch.barPosition !== undefined && !BAR_POSITIONS.includes(next.barPosition)) next.barPosition = '';
    if (patch.barStyle !== undefined && !BAR_STYLES.includes(next.barStyle)) next.barStyle = '';
    if (patch.moveStyle !== undefined && !MOVE_STYLE_IDS.includes(next.moveStyle)) next.moveStyle = '';
    if (patch.attachedTo === undefined) return;
    const pid = typeof patch.attachedTo === 'string' ? patch.attachedTo : '';
    next.attachedTo = '';
    if (!pid || next.type === 'wall') return;
    const p = this.entities.obj.get(pid);
    const bad = !p || p.id === id || p.type === 'wall' || p.pageId !== next.pageId || (!viewer.isGM && p.layer === 'gm');
    if (bad) {
      if (creating) return; // копия без своего транспорта — просто без сцепки
      throw new Error('Сцепить можно только с объектом на этой же сцене');
    }
    // не по кругу: транспорт не должен сам ехать на этом объекте
    const seen = new Set();
    for (let q = p; q && q.attachedTo && !seen.has(q.id); q = this.entities.obj.get(q.attachedTo)) {
      if (q.attachedTo === id) {
        if (creating) return;
        throw new Error('Нельзя сцепить по кругу: этот объект уже везёт выбранный');
      }
      seen.add(q.id);
    }
    next.attachedTo = pid;
  }

  /** Транспорт сдвинулся, повернулся или изменил размер — пассажиры едут вместе с ним */
  carryRiders(before, next, path = null) {
    const riders = ridersOf(this.entities.obj.values(), next.id).filter((r) => r.pageId === next.pageId && r.type !== 'wall');
    if (!riders.length) return;
    const t = carryTransform(before, next);
    if (!t) return;
    // при простом переносе пассажир идёт тем же путём, что и транспорт
    const rigid = path && (before.rot || 0) === (next.rot || 0) && before.w === next.w && before.h === next.h;
    const bx = before.x + before.w / 2,
      by = before.y + before.h / 2;
    for (const r of riders) {
      const nr = { ...r, ...t(r) };
      this.entities.obj.set(r.id, nr);
      this.markDirty('obj', r.id);
      const rp = rigid ? path.map((p) => ({ x: p.x + r.x + r.w / 2 - bx, y: p.y + r.y + r.h / 2 - by })) : null;
      this.emitEntity('obj', r.id, r, nr, null, rp);
    }
  }

  remove(c, id, viewer, origin) {
    const before = this.entities[c].get(id);
    if (!before) return { id };
    const pagesBefore = c === 'page' ? this.playerPagesSnapshot() : null;
    switch (c) {
      case 'page':
        if (!viewer.isGM) throw new Error('Только мастер удаляет сцены');
        if (this.entities.page.size <= 1) throw new Error('Нельзя удалить последнюю сцену');
        for (const o of [...this.entities.obj.values()]) if (o.pageId === id) this.remove('obj', o.id, viewer, origin);
        break;
      case 'obj':
        if (!viewer.isGM && before.ownerId !== viewer.userId) throw new Error('Удалить можно только свой объект');
        break;
      case 'char':
        if (!viewer.isGM && !(before.ownerId === viewer.userId && canControlChar(this, viewer, before))) throw new Error('Удалить персонажа может мастер');
        break;
      case 'macro':
        if (before.ownerId !== viewer.userId && !viewer.isGM) throw new Error('Это чужой макрос');
        break;
      default:
        if (!viewer.isGM) throw new Error('Недостаточно прав');
    }
    this.entities[c].delete(id);
    this.markDirty(c, id);
    this.emitEntity(c, id, before, null, origin);
    if (c === 'char') {
      db.prepare(`DELETE FROM attributes WHERE char_id=? AND game_id=?`).run(id, this.id);
      this.attrs.delete(id);
      for (const o of this.entities.obj.values()) {
        if (o.represents === id) {
          const nb = { ...o, represents: '', bars: (o.bars || []).map((b) => ({ ...b, link: '' })) };
          this.entities.obj.set(o.id, nb);
          this.markDirty('obj', o.id);
          this.emitEntity('obj', o.id, o, nb, null);
        }
      }
    }
    if (c === 'page') {
      if (this.state.playerPageId === id) this.state.playerPageId = [...this.entities.page.keys()][0];
      if (this.state.playerPages) for (const [u, pid] of Object.entries(this.state.playerPages)) if (pid === id) delete this.state.playerPages[u];
      this.gameDirty = true;
      this.broadcastGame();
      this.resyncMovedPlayers(pagesBefore);
    }
    if (c === 'obj') {
      // пассажиры удалённого транспорта остаются на месте, отцепленными
      for (const o of this.entities.obj.values()) {
        if (o.attachedTo !== id) continue;
        const nb = { ...o, attachedTo: '' };
        this.entities.obj.set(o.id, nb);
        this.markDirty('obj', o.id);
        this.emitEntity('obj', o.id, o, nb, null);
      }
      const before2 = this.state.turnorder.length;
      this.state.turnorder = this.state.turnorder.filter((t) => t.tokenId !== id);
      if (this.state.turnorder.length !== before2) {
        this.gameDirty = true;
        this.broadcastGame();
      }
    }
    return { id };
  }

  /** Принять готовую сущность (перенос из другого стола): в память, в базу и всем, кто её видит */
  adoptEntity(c, id, data) {
    const e = { ...data, id };
    this.entities[c].set(id, e);
    this.markDirty(c, id);
    this.emitEntity(c, id, null, e, null);
  }

  // ---------------------------------------------------------------------
  // Атрибуты
  // ---------------------------------------------------------------------

  loadAttrs(charId) {
    let m = this.attrs.get(charId);
    if (m) return m;
    m = new Map();
    const rows = db.prepare(`SELECT id, name, current, max FROM attributes WHERE char_id=? AND game_id=?`).all(charId, this.id);
    for (const r of rows) m.set(lc(r.name), { id: r.id, name: r.name, current: parseJSON(r.current, ''), max: parseJSON(r.max, '') });
    this.attrs.set(charId, m);
    return m;
  }

  getAttrs(viewer, charId) {
    const ch = this.entities.char.get(charId);
    if (!ch || !canSeeChar(this, viewer, ch)) throw new Error('Нет доступа к персонажу');
    return [...this.loadAttrs(charId).values()];
  }

  /**
   * Изменить атрибуты.
   * sets: [{name, current?, max?}], dels: [name], delPrefixes: [prefix]
   */
  setAttrs(viewer, charId, sets = [], dels = [], delPrefixes = [], origin = null, opts = {}) {
    const ch = this.entities.char.get(charId);
    if (!ch) throw new Error('Персонаж не найден');
    if (!opts.system && !canControlChar(this, viewer, ch)) throw new Error('Нет прав на этого персонажа');
    const m = this.loadAttrs(charId);
    if (m.size + sets.length > 50000) throw new Error('Слишком много атрибутов');
    const changed = [];
    const removed = [];
    const upsert = db.prepare(
      `INSERT INTO attributes(id, game_id, char_id, name, current, max) VALUES (?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, current=excluded.current, max=excluded.max`,
    );
    const del = db.prepare(`DELETE FROM attributes WHERE id=?`);
    db.transaction(() => {
      for (const s of sets) {
        if (!s || typeof s.name !== 'string' || !s.name || s.name.length > 300) continue;
        const key = lc(s.name);
        let a = m.get(key);
        if (!a) {
          a = { id: newId(), name: s.name, current: '', max: '' };
          m.set(key, a);
        }
        if ('current' in s) a.current = normalizeValue(s.current);
        if ('max' in s) a.max = normalizeValue(s.max);
        upsert.run(a.id, this.id, charId, a.name, JSON.stringify(a.current), JSON.stringify(a.max));
        changed.push(a);
      }
      for (const name of dels || []) {
        const key = lc(name);
        const a = m.get(key);
        if (!a) continue;
        m.delete(key);
        del.run(a.id);
        removed.push(a.name);
      }
      for (const prefix of delPrefixes || []) {
        const p = lc(prefix);
        if (!p.startsWith('repeating_') || p.length < 15) continue;
        for (const [key, a] of [...m]) {
          if (key.startsWith(p)) {
            m.delete(key);
            del.run(a.id);
            removed.push(a.name);
          }
        }
      }
    })();
    if (!changed.length && !removed.length) return { changed: 0 };
    for (const s of this.sockets) {
      const v = this.viewer(s);
      if (canSeeChar(this, v, ch)) s.emit('attrs', { charId, set: changed, del: removed, o: origin });
    }
    this.syncBarsFromChangedAttrs(charId, changed, removed);
    return { changed: changed.length, removed: removed.length };
  }

  /** Прочитать атрибуты персонажа, которого представляет видимый токен (для @{target|...}) */
  peekAttrs(viewer, tokenId, names) {
    const t = this.entities.obj.get(tokenId);
    if (!t || (!viewer.isGM && (t.layer === 'gm' || !this.canSeePage(viewer, t.pageId)))) throw new Error('Токен не найден');
    if (!t.represents || !this.entities.char.has(t.represents)) throw new Error('Токен не связан с персонажем');
    const m = this.loadAttrs(t.represents);
    const values = {};
    for (const n of names.slice(0, 50)) {
      const s = String(n);
      const isMax = /_max$/i.test(s);
      const base = isMax ? s.slice(0, -4) : s;
      const a = m.get(lc(base));
      if (a) values[s] = isMax ? a.max : a.current;
      else if (lc(s) === 'character_name') values[s] = this.entities.char.get(t.represents).name;
    }
    return { values };
  }

  attrNameChanged(charId, name) {
    // character_name — специальный атрибут; храним его отдельно не нужно
  }

  // Связанные бары: атрибут → токены
  syncBarsFromChangedAttrs(charId, changed) {
    if (!changed.length) return;
    const byName = new Map(changed.map((a) => [lc(a.name), a]));
    for (const o of this.entities.obj.values()) {
      if (o.represents !== charId || !Array.isArray(o.bars)) continue;
      let touched = false;
      const bars = o.bars.map((b) => {
        if (!b.link) return b;
        const a = byName.get(lc(b.link));
        if (!a) return b;
        if (String(b.value) === String(a.current) && String(b.max) === String(a.max)) return b;
        touched = true;
        return { ...b, value: a.current, max: a.max };
      });
      if (touched) {
        const nb = { ...o, bars };
        this.entities.obj.set(o.id, nb);
        this.markDirty('obj', o.id);
        this.emitEntity('obj', o.id, o, nb, null);
      }
    }
  }

  syncBarsFromAttrs(obj) {
    if (!obj.represents || !Array.isArray(obj.bars) || !obj.bars.some((b) => b.link)) return;
    if (!this.entities.char.has(obj.represents)) return;
    const m = this.loadAttrs(obj.represents);
    let touched = false;
    const bars = obj.bars.map((b) => {
      if (!b.link) return b;
      const a = m.get(lc(b.link));
      if (!a) return b;
      touched = true;
      return { ...b, value: a.current, max: a.max };
    });
    if (touched) obj.bars = bars;
  }

  // Правка бара на токене → атрибут
  pushBarsToAttrs(before, next, viewer) {
    if (!next.represents || !Array.isArray(next.bars)) return;
    const ch = this.entities.char.get(next.represents);
    if (!ch) return;
    const prev = new Map((before.bars || []).map((b) => [b.id, b]));
    const sets = [];
    for (const b of next.bars) {
      if (!b.link) continue;
      const p = prev.get(b.id);
      if (!p || p.link !== b.link) continue; // новая связь — тянем значение из атрибута
      const s = { name: b.link };
      if (String(p.value) !== String(b.value)) s.current = b.value;
      if (String(p.max) !== String(b.max)) s.max = b.max;
      if ('current' in s || 'max' in s) sets.push(s);
    }
    if (sets.length) this.setAttrs(viewer, ch.id, sets, [], [], null, { system: true });
  }

  // ---------------------------------------------------------------------
  // Чат
  // ---------------------------------------------------------------------

  tableItems(name) {
    const n = lc(String(name).trim());
    for (const t of this.entities.rtable.values()) if (lc(t.name) === n) return t.items || [];
    return null;
  }

  resolveWhisperTarget(name) {
    const n = lc(name.trim());
    if (n === 'gm') {
      return { ids: [...this.members.values()].filter((m) => m.role === 'gm').map((m) => m.id), gm: true, name: 'GM' };
    }
    const members = [...this.members.values()];
    let m = members.find((x) => lc(x.displayName) === n || lc(x.username) === n);
    if (m) return { ids: [m.id], name: m.displayName };
    const ch = [...this.entities.char.values()].find((c) => lc(c.name) === n);
    if (ch) return this.charRecipients(ch);
    const pref = members.filter((x) => lc(x.displayName).startsWith(n));
    if (pref.length === 1) return { ids: [pref[0].id], name: pref[0].displayName };
    const chp = [...this.entities.char.values()].filter((c) => lc(c.name).startsWith(n));
    if (chp.length === 1) return this.charRecipients(chp[0]);
    return null;
  }

  charRecipients(ch) {
    let ids = Array.isArray(ch.controlledBy) ? ch.controlledBy.filter((x) => x !== 'all') : [];
    if (Array.isArray(ch.controlledBy) && ch.controlledBy.includes('all')) ids = [...this.members.keys()];
    if (!ids.length) return { ids: [...this.members.values()].filter((m) => m.role === 'gm').map((m) => m.id), gm: true, name: ch.name };
    return { ids, name: ch.name };
  }

  chat(socket, payload) {
    const viewer = this.viewer(socket);
    const user = { ...socket.data.user, ...(this.members.get(viewer.userId) || {}) };
    this.lastActive = now();
    const res = buildMessage(this, user, payload, { isGM: viewer.isGM });
    if (res.error) {
      socket.emit('chat:system', { text: res.error, info: !!res.info, ts: now() });
      return { error: res.info ? undefined : res.error };
    }
    if (res.fx) {
      this.fxFromCommand(socket, res.fx, payload);
      return { ok: true };
    }
    if (res.summary) return this.postSummary(viewer, res.summary.arg);
    if (res.cine) return this.cine(viewer, res.cine);
    if (!res.msg) return { ok: true };
    if (payload.defer) {
      // Custom Roll Parsing: держим сообщение до finishRoll (или 5 секунд)
      const rollId = newId();
      const timer = setTimeout(() => this.finishRoll(socket, rollId, null), 5000);
      this.pendingRolls.set(rollId, { msg: res.msg, tracker: res.tracker, selected: payload.selected, userId: viewer.userId, timer });
      return { rollId, results: crpResults(res.msg) };
    }
    this.postMessage(res.msg);
    if (res.tracker && res.tracker.length) this.applyTracker(viewer, res.tracker, payload.selected);
    return { ok: true, id: res.msg.id };
  }

  finishRoll(socket, rollId, computed) {
    const p = this.pendingRolls.get(rollId);
    if (!p) return { error: 'Бросок не найден' };
    if (socket && p.userId !== socket.data.user.id && computed !== null) return { error: 'Чужой бросок' };
    clearTimeout(p.timer);
    this.pendingRolls.delete(rollId);
    if (computed) p.msg.computed = sanitizeComputed(computed);
    this.postMessage(p.msg);
    if (p.tracker && p.tracker.length) {
      const viewer = { userId: p.userId, isGM: this.isGM(p.userId) };
      this.applyTracker(viewer, p.tracker, p.selected);
    }
    return { ok: true };
  }

  postMessage(msg) {
    db.prepare(`INSERT INTO messages(id, game_id, ts, data) VALUES (?,?,?,?)`).run(msg.id, this.id, msg.ts, JSON.stringify(msg));
    for (const s of this.sockets) {
      if (messageVisible(msg, this.viewer(s))) s.emit('chat', msg);
    }
  }

  /**
   * Итоги вечера (/итоги): статистика и награды за последний игровой вечер (перерыв больше 4 часов — новый вечер),
   * «/итоги всё» — за всю кампанию. Мастер публикует для всех, игрок видит итоги только сам.
   */
  postSummary(viewer, arg = '') {
    const all = /^(вс[её]|кампания|all|campaign)$/i.test(String(arg).trim());
    let since = 0;
    if (!all) {
      const tsDesc = db
        .prepare(`SELECT ts FROM messages WHERE game_id=? ORDER BY ts DESC`)
        .all(this.id)
        .map((r) => r.ts);
      since = sessionStart(tsDesc) ?? 0;
    }
    const rows = db.prepare(`SELECT data FROM messages WHERE game_id=? AND ts>=? ORDER BY ts ASC`).all(this.id, since);
    const summary = computeSummary(
      rows.map((r) => parseJSON(r.data, null)),
      this.members,
      { scope: all ? 'all' : 'session' },
    );
    if (!summary.total.rolls && !summary.total.messages) return { error: 'Подводить пока нечего: за вечер в чате нет ни бросков, ни сообщений' };
    const me = this.members.get(viewer.userId);
    const msg = { id: newId(), ts: now(), type: 'summary', who: all ? 'Итоги кампании' : 'Итоги вечера', playerId: viewer.userId, color: me?.color || '', avatar: '', charId: null, content: '', summary };
    if (!viewer.isGM) msg.to = [viewer.userId];
    this.postMessage(msg);
    return { ok: true, id: msg.id };
  }

  /**
   * Кинотрюки мастера. Титры, голос рассказчика, тряска, вспышка и камера приходят всем сразу;
   * затемнение и кинополосы — состояние стола (их увидит и тот, кто зайдёт позже).
   */
  cine(viewer, p = {}) {
    if (!viewer.isGM) throw new Error('Кинотрюки — у мастера');
    const kind = String(p.kind || '');
    const str = (v, n) =>
      String(v ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, n);
    let ev;
    switch (kind) {
      case 'title': {
        const title = str(p.title, 80);
        const subtitle = str(p.subtitle, 160);
        if (!title && !subtitle) throw new Error('Напишите заголовок титров');
        const image = typeof p.image === 'string' && /^(\/(?!\/)|https?:\/\/)/i.test(p.image.trim()) ? p.image.trim().slice(0, 1000) : '';
        // 0 — висят, пока мастер не уберёт
        const duration = p.duration === 0 ? 0 : Math.max(2, Math.min(60, Number(p.duration) || 6));
        ev = { kind, title, subtitle, image, duration };
        break;
      }
      case 'narrate': {
        const text = str(p.text, 400);
        if (!text) throw new Error('Что скажет рассказчик?');
        ev = { kind, text, duration: Math.max(4, Math.min(40, Number(p.duration) || Math.round(3 + text.length / 14))) };
        break;
      }
      case 'clear':
        ev = { kind };
        break;
      case 'shake':
        ev = { kind, strength: p.strength === 'strong' ? 'strong' : 'light' };
        break;
      case 'flash':
        ev = { kind, color: ['white', 'red', 'gold', 'black'].includes(p.color) ? p.color : 'white' };
        break;
      case 'camera': {
        const page = this.entities.page.get(p.pageId);
        if (!page) throw new Error('Сцена не найдена');
        const n = (v) => (Number.isFinite(Number(v)) ? Math.max(-1e6, Math.min(1e6, Number(v))) : 0);
        ev = { kind, pageId: page.id, x: n(p.x), y: n(p.y), zoom: Math.max(0.05, Math.min(8, Number(p.zoom) || 1)) };
        break;
      }
      case 'fade':
      case 'bars': {
        const cur = { fade: false, bars: false, ...(this.state.cine || {}) };
        const on = p.on === undefined || p.on === null ? !cur[kind] : !!p.on;
        this.state.cine = { ...cur, [kind]: on };
        this.gameDirty = true;
        this.broadcastGame();
        return { ok: true, on };
      }
      default:
        throw new Error('Такого трюка нет');
    }
    ev.id = newId();
    ev.by = viewer.userId;
    this.io.to(this.id).emit('cine', ev);
    return { ok: true };
  }

  systemMessage(text, toUserIds = null) {
    const msg = { id: newId(), ts: now(), type: 'system', who: '', playerId: '', content: text };
    if (toUserIds) msg.to = toUserIds;
    this.postMessage(msg);
  }

  loadMessages(viewer, before, limit = 100) {
    // чужие шёпоты пропускаем, поэтому читаем порциями, пока не наберём нужное число видимых
    const out = [];
    let cursor = before || Number.MAX_SAFE_INTEGER;
    const stmt = db.prepare(`SELECT ts, data FROM messages WHERE game_id=? AND ts<? ORDER BY ts DESC LIMIT ?`);
    for (let pass = 0; pass < 20 && out.length < limit; pass++) {
      const rows = stmt.all(this.id, cursor, limit * 3);
      if (!rows.length) break;
      for (const r of rows) {
        const m = parseJSON(r.data, null);
        if (m && messageVisible(m, viewer)) out.push(m);
        if (out.length >= limit) break;
      }
      cursor = rows[rows.length - 1].ts;
      if (rows.length < limit * 3) break;
    }
    return out.reverse();
  }

  clearChat(viewer) {
    if (!viewer.isGM) throw new Error('Только мастер очищает чат');
    db.prepare(`DELETE FROM messages WHERE game_id=?`).run(this.id);
    this.io.to(this.id).emit('chat:cleared');
  }

  // ---------------------------------------------------------------------
  // Реакции: под сообщениями (хранятся в самом сообщении) и всплывающие над токеном
  // ---------------------------------------------------------------------

  /** Поставить или убрать свою реакцию под сообщением */
  reactMessage(viewer, id, emoji) {
    if (!isReaction(emoji)) throw new Error('Такой реакции нет');
    const row = db.prepare(`SELECT data FROM messages WHERE id=? AND game_id=?`).get(String(id || '').slice(0, 40), this.id);
    const msg = row ? parseJSON(row.data, null) : null;
    if (!msg || msg.type === 'system' || !messageVisible(msg, viewer)) throw new Error('Нет такого сообщения');
    const r = msg.reactions && typeof msg.reactions === 'object' && !Array.isArray(msg.reactions) ? msg.reactions : {};
    const list = Array.isArray(r[emoji]) ? r[emoji].filter((u) => typeof u === 'string') : [];
    const i = list.indexOf(viewer.userId);
    if (i >= 0) list.splice(i, 1);
    else list.push(viewer.userId);
    if (list.length) r[emoji] = list.slice(0, 200);
    else delete r[emoji];
    msg.reactions = r;
    db.prepare(`UPDATE messages SET data=? WHERE id=? AND game_id=?`).run(JSON.stringify(msg), msg.id, this.id);
    for (const s of this.sockets) if (messageVisible(msg, this.viewer(s))) s.emit('chat:update', { id: msg.id, reactions: msg.reactions });
    return { ok: true, reactions: msg.reactions };
  }

  /** Реакция всплывает над токеном игрока; кто токена не видит — увидит её у аватара игрока */
  floatReaction(socket, emoji, tokenId) {
    const viewer = this.viewer(socket);
    if (!isReaction(emoji)) throw new Error('Такой реакции нет');
    const o = typeof tokenId === 'string' ? this.entities.obj.get(tokenId) : null;
    const token = o && o.type !== 'wall' && canControlObj(this, viewer, o) ? o : null;
    for (const s of this.sockets) {
      const v = this.viewer(s);
      const seen = token && filterObj(this, v, token);
      s.emit('react:float', seen ? { userId: viewer.userId, emoji, tokenId: token.id, pageId: token.pageId } : { userId: viewer.userId, emoji });
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------------
  // Инициатива
  // ---------------------------------------------------------------------

  applyTracker(viewer, updates, selected) {
    const tokens = (selected || []).map((id) => this.entities.obj.get(id)).filter(Boolean);
    if (!tokens.length) return;
    const last = updates[updates.length - 1];
    for (const tok of tokens) {
      if (!canControlObj(this, viewer, tok)) continue;
      let e = this.state.turnorder.find((t) => t.tokenId === tok.id);
      if (!e) {
        e = { id: newId(), tokenId: tok.id, pr: 0 };
        this.state.turnorder.push(e);
      }
      const v = Number(last.value) || 0;
      if (last.mode === '+') e.pr = (Number(e.pr) || 0) + v;
      else if (last.mode === '-') e.pr = (Number(e.pr) || 0) - v;
      else e.pr = v;
    }
    this.gameDirty = true;
    this.broadcastGame();
  }

  turnOp(viewer, op) {
    const st = this.state;
    const prValue = (v) => (typeof v === 'number' ? (Number.isFinite(v) ? v : 0) : String(v ?? '').slice(0, 24));
    if (op.pr !== undefined) op.pr = prValue(op.pr);
    if (op.t === 'set') {
      if (!viewer.isGM) throw new Error('Только мастер управляет порядком ходов');
      if (Array.isArray(op.turnorder))
        st.turnorder = op.turnorder.slice(0, 500).map((e) => ({
          id: typeof e.id === 'string' ? e.id.slice(0, 40) : newId(),
          tokenId: typeof e.tokenId === 'string' ? e.tokenId : undefined,
          name: e.name !== undefined ? String(e.name).slice(0, 60) : undefined,
          pr: prValue(e.pr),
          custom: !!e.custom,
          hidden: !!e.hidden,
          formula: cleanFormula(e.formula),
          card: typeof e.card === 'string' ? e.card.slice(0, 4) : undefined,
        }));
      if (op.round !== undefined) st.round = Math.max(1, Number(op.round) || 1);
      if (op.visible !== undefined) st.turnVisible = !!op.visible;
    } else if (op.t === 'add') {
      const tok = op.tokenId ? this.entities.obj.get(op.tokenId) : null;
      if (!viewer.isGM && (!tok || !canControlObj(this, viewer, tok))) throw new Error('Можно добавлять только свои токены');
      if (tok && st.turnorder.some((e) => e.tokenId === tok.id)) {
        if (op.pr !== undefined) st.turnorder.find((e) => e.tokenId === tok.id).pr = op.pr;
      } else
        st.turnorder.push({
          id: newId(),
          tokenId: tok ? tok.id : undefined,
          name: tok ? undefined : String(op.name || '?').slice(0, 60),
          pr: op.pr ?? 0,
          custom: !tok,
          formula: tok ? undefined : cleanFormula(op.formula),
        });
    } else if (op.t === 'update') {
      const e = st.turnorder.find((x) => x.id === op.id);
      if (!e) return;
      const tok = e.tokenId ? this.entities.obj.get(e.tokenId) : null;
      if (!viewer.isGM && (!tok || !canControlObj(this, viewer, tok))) throw new Error('Можно менять только свои записи');
      if (op.pr !== undefined) {
        e.pr = op.pr;
        delete e.card;
      }
      if (viewer.isGM && op.name !== undefined) e.name = String(op.name).slice(0, 60);
      if (viewer.isGM && op.formula !== undefined) e.formula = cleanFormula(op.formula);
    } else if (op.t === 'remove') {
      const e = st.turnorder.find((x) => x.id === op.id);
      if (!e) return;
      const tok = e.tokenId ? this.entities.obj.get(e.tokenId) : null;
      if (!viewer.isGM && (!tok || !canControlObj(this, viewer, tok))) throw new Error('Можно убирать только свои записи');
      st.turnorder = st.turnorder.filter((x) => x.id !== op.id);
    } else if (op.t === 'next') {
      // следующий ход: первый уходит в конец (как в Roll20); игрок может завершить свой ход
      const first = st.turnorder[0];
      if (!first) return;
      const tok = first.tokenId ? this.entities.obj.get(first.tokenId) : null;
      if (!viewer.isGM && (!tok || !canControlObj(this, viewer, tok))) throw new Error('Сейчас не ваш ход');
      st.turnorder.push(st.turnorder.shift());
      if (st.turnorder[0] && st.turnorder[0].id === st.firstId) {
        st.round = (st.round || 1) + 1;
        st.tick = (st.tick || 0) + 1; // счётчик прошедших раундов для длительности эффектов (не сбрасывается)
      }
      applyFormula(st.turnorder[0]);
      // номер хода: эффекты «в начале/конце хода» и сроки «до следующего хода» считает мастер по нему
      st.turnSeq = (st.turnSeq || 0) + 1;
      st.lastTurn = { seq: st.turnSeq, ended: first.tokenId || null, started: st.turnorder[0]?.tokenId || null };
    } else if (op.t === 'prev') {
      if (!viewer.isGM) throw new Error('Только мастер');
      if (st.turnorder.length) {
        if (st.turnorder[0].id === st.firstId && (st.round || 1) > 1) {
          st.round = (st.round || 1) - 1;
          st.tick = Math.max(0, (st.tick || 0) - 1);
        }
        st.turnorder.unshift(st.turnorder.pop());
      }
    } else if (op.t === 'sort') {
      if (!viewer.isGM) throw new Error('Только мастер');
      st.turnorder.sort((a, b) => (op.asc ? 1 : -1) * ((Number(a.pr) || 0) - (Number(b.pr) || 0)));
      st.firstId = st.turnorder[0]?.id;
      st.round = 1;
    } else if (op.t === 'clear') {
      if (!viewer.isGM) throw new Error('Только мастер');
      st.turnorder = [];
      st.round = 1;
      st.firstId = null;
    } else if (op.t === 'deal') {
      // инициатива картами: каждому токену — карта из колоды на 54 карты, ходят от старшей
      if (!viewer.isGM) throw new Error('Только мастер раздаёт карты');
      if (!st.turnorder.some((e) => e.tokenId)) throw new Error('Сначала добавьте токены в порядок ходов');
      if (!Array.isArray(st.deck) || st.deck.length < st.turnorder.length || st.reshuffle) {
        st.deck = shuffledDeck();
        st.reshuffle = false;
      }
      for (const e of st.turnorder) {
        if (!e.tokenId) continue;
        const c = st.deck.pop();
        e.card = c;
        e.pr = cardValue(c);
        if (c === 'JR' || c === 'JB') st.reshuffle = true; // джокер: перед следующей раздачей колоду тасуют
      }
      st.turnorder.sort((a, b) => (Number(b.pr) || 0) - (Number(a.pr) || 0));
      st.firstId = st.turnorder[0]?.id;
      if (op.newRound === true) {
        st.round = (st.round || 1) + 1;
        st.tick = (st.tick || 0) + 1;
      }
    }
    if (!st.firstId || !st.turnorder.some((e) => e.id === st.firstId)) st.firstId = st.turnorder[0]?.id || null;
    this.gameDirty = true;
    this.broadcastGame();
  }

  // ---------------------------------------------------------------------
  // Маркеры состояний и их эффекты: добавить, снять, поменять число или срок.
  // Сервер меняет список маркеров и непривязанные полосы токена за один раз, а снятое возвращает
  // тому, кто его снял, — чтобы изменения атрибутов откатил ровно один клиент.
  // ---------------------------------------------------------------------

  markerOp(viewer, op) {
    const o = this.entities.obj.get(op?.objId);
    if (!o || o.type === 'wall') throw new Error('Токен не найден');
    if (!canControlObj(this, viewer, o)) throw new Error('Нет прав на этот токен');
    const markerId = String(op.markerId || '').slice(0, 40);
    if (!markerId) throw new Error('Нет маркера');
    const list = (Array.isArray(o.markers) ? o.markers : []).map((m) => (typeof m === 'string' ? { id: m } : { ...m }));
    const i = list.findIndex((m) => m.id === markerId);
    const bars = Array.isArray(o.bars) ? o.bars.map((b) => ({ ...b })) : [];
    let result;
    const next = { ...o, bars };
    const def = this.effectDef(markerId);
    const cellSize = this.entities.page.get(o.pageId)?.cellSize || 70;
    let concEnd = null; // концентрация наложившего кончилась — его эффекты на других тоже
    if (op.t === 'add') {
      if (i >= 0) return { exists: true, entry: list[i] };
      if (list.length >= 60) throw new Error('Слишком много маркеров');
      const e = cleanMarkerEntry({ ...(op.entry || {}), id: markerId, tokApplied: null });
      applyBarEffects(bars, e.applied, 1);
      const tok = this.applyTokenEffects(next, def, op.entry?.tokVals, e.n, cellSize);
      if (tok.length) e.tokApplied = tok;
      list.push(e);
      result = { entry: e };
      // одна концентрация на наложившего: прежние его эффекты с концентрацией заканчиваются
      if (e.conc && e.src) concEnd = { src: e.src, except: markerId };
    } else if (op.t === 'remove' || op.t === 'expire') {
      if (i < 0) return { removed: null };
      if (op.t === 'expire' && (!viewer.isGM || list[i].until !== op.until)) return { removed: null };
      const e = list[i];
      list.splice(i, 1);
      applyBarEffects(bars, e.applied, -1);
      for (const a of [...(e.tokApplied || [])].reverse()) revertTokenChange(next, a);
      result = { removed: e };
      if (markerId === 'concentration') concEnd = { src: o.id, except: null };
    } else if (op.t === 'update') {
      if (i < 0) return { missing: true };
      const prev = list[i];
      const patch = op.patch && typeof op.patch === 'object' ? op.patch : {};
      const merged = { ...prev };
      for (const k of ['n', 'until', 'applied']) if (k in patch) merged[k] = patch[k];
      const e = cleanMarkerEntry(merged);
      if ('applied' in patch) {
        applyBarEffects(bars, prev.applied, -1);
        applyBarEffects(bars, e.applied, 1);
      }
      // число на маркере поменялось — изменения токена «× уровень» пересчитываются
      if ('n' in patch && def && (def.changes || []).some((c) => c && c.perLevel && isTokenKey(c.key))) {
        for (const a of [...(prev.tokApplied || [])].reverse()) revertTokenChange(next, a);
        const tok = this.applyTokenEffects(next, def, patch.tokVals, e.n, cellSize);
        if (tok.length) e.tokApplied = tok;
        else delete e.tokApplied;
      }
      list[i] = e;
      result = { prev, entry: e };
    } else throw new Error('Неизвестная операция');
    next.markers = list;
    if (jsonSize(next) > SIZE_LIMITS.obj) throw new Error('Слишком большой объект');
    this.entities.obj.set(o.id, next);
    this.markDirty('obj', o.id);
    this.emitEntity('obj', o.id, o, next, null);
    if (concEnd) this.endConcentration(concEnd.src, concEnd.except);
    return result;
  }

  /** Описание своего маркера (эффекта) стола */
  effectDef(id) {
    return (Array.isArray(this.settings.markers) ? this.settings.markers : []).find((m) => m && m.id === id) || null;
  }

  /**
   * Изменения самого токена по описанию эффекта (свет, зрение, размер…). Число из описания берётся как есть,
   * формулу считает браузер наложившего (tokVals[номер изменения]).
   */
  applyTokenEffects(next, def, tokVals, level, cellSize) {
    const out = [];
    const changes = Array.isArray(def?.changes) ? def.changes.slice(0, 12) : [];
    changes.forEach((c, idx) => {
      if (!c || !isTokenKey(c.key)) return;
      const raw = String(c.value ?? '').trim();
      const plain = /^-?\d+(?:[.,]\d+)?$/.test(raw) ? Number(raw.replace(',', '.')) : null;
      let v = plain !== null ? plain : tokVals && typeof tokVals === 'object' ? tokVals[idx] : undefined;
      if (/^#[0-9a-f]{3,8}$/i.test(raw)) v = raw;
      if (v === undefined || v === null || v === '') return;
      if (typeof v === 'number' && c.perLevel) {
        const k = Number(level);
        v = v * (Number.isFinite(k) && k > 0 ? k : 1);
      }
      const a = applyTokenChange(next, c, v, cellSize);
      if (a) out.push(a);
    });
    return out;
  }

  /** Концентрация наложившего кончилась: его эффекты с концентрацией истекают (мастер снимет и откатит) */
  endConcentration(srcId, exceptId) {
    const tick = this.state.tick || 0;
    for (const o of [...this.entities.obj.values()]) {
      const list = Array.isArray(o.markers) ? o.markers : [];
      let changed = false;
      const ml = list.map((m) => {
        if (!m || typeof m !== 'object' || m.src !== srcId || !m.conc || m.id === exceptId) return m;
        if (m.until !== undefined && m.until <= tick) return m;
        changed = true;
        return { ...m, until: tick };
      });
      if (!changed) continue;
      const next = { ...o, markers: ml };
      this.entities.obj.set(o.id, next);
      this.markDirty('obj', o.id);
      this.emitEntity('obj', o.id, o, next, null);
    }
  }

  /** Мастер берёт на себя эффекты «каждый ход» для этого хода — ровно один раз, даже если мастеров двое */
  claimTurnFx(viewer, seq) {
    if (!viewer.isGM) throw new Error('Только мастер');
    const st = this.state;
    if (!st.lastTurn || st.lastTurn.seq !== Number(seq) || st.turnFxDone === st.lastTurn.seq) return { ok: false };
    st.turnFxDone = st.lastTurn.seq;
    this.gameDirty = true;
    return { ok: true, lastTurn: st.lastTurn };
  }

  /** Игрок просит наложить эффект на токены, которыми не управляет: передаём мастеру за столом */
  relayEffect(socket, req) {
    const viewer = this.viewer(socket);
    if (!this.settings.playersApplyEffects && !viewer.isGM) throw new Error('Мастер не разрешил игрокам накладывать эффекты на чужие токены');
    const effectId = String(req?.effectId || '').slice(0, 40);
    if (!this.effectDef(effectId)) throw new Error('Такого эффекта нет за этим столом');
    const targets = (Array.isArray(req?.targets) ? req.targets : []).filter((id) => typeof id === 'string' && this.entities.obj.has(id)).slice(0, 40);
    if (!targets.length) throw new Error('Нет целей');
    const gm = [...this.sockets].find((s) => this.viewer(s).isGM);
    if (!gm) throw new Error('Мастера нет за столом — на чужие токены эффект наложит только он');
    const src = typeof req?.src === 'string' && this.entities.obj.has(req.src) ? req.src : undefined;
    gm.emit('effect:ask', { from: viewer.userId, effectId, targets, src, remove: !!req?.remove });
    return { ok: true };
  }

  // ---------------------------------------------------------------------
  // Настройки и состояние стола
  // ---------------------------------------------------------------------

  updateSettings(viewer, patch) {
    if (!viewer.isGM) throw new Error('Только мастер меняет настройки');
    delete patch.banned;
    const next = deepMerge(clone(this.settings), patch);
    if (!TABLE_THEMES.includes(next.theme)) next.theme = 'auto';
    if (jsonSize(next) > 1_000_000) throw new Error('Слишком большие настройки');
    this.settings = next;
    this.gameDirty = true;
    this.broadcastGame();
  }

  updateState(viewer, patch) {
    if (!viewer.isGM) throw new Error('Только мастер');
    const allowed = ['playerPageId', 'playerPages', 'folders', 'turnVisible', 'round'];
    const pagesBefore = this.playerPagesSnapshot();
    for (const k of Object.keys(patch)) {
      if (!allowed.includes(k)) continue;
      if (k === 'playerPageId' && !this.entities.page.has(patch[k])) continue;
      if (k === 'playerPages') {
        const pp = {};
        for (const [u, pid] of Object.entries(patch[k] && typeof patch[k] === 'object' ? patch[k] : {})) if (this.entities.page.has(pid)) pp[u] = pid;
        this.state.playerPages = pp;
        continue;
      }
      if (jsonSize(patch[k]) > 200_000) continue;
      this.state[k] = patch[k];
    }
    this.gameDirty = true;
    this.broadcastGame();
    // игрокам, перешедшим на другую сцену, — её содержимое
    this.resyncMovedPlayers(pagesBefore);
  }

  // Туман войны: операции хранятся в странице
  fogOp(viewer, { pageId, op, reset, removeId, setOps }) {
    if (!viewer.isGM) throw new Error('Туманом управляет мастер');
    const page = this.entities.page.get(pageId);
    if (!page) throw new Error('Сцена не найдена');
    const before = page;
    const next = { ...page, fogOps: [...(page.fogOps || [])] };
    if (reset) next.fogOps = reset === 'revealAll' ? [{ id: newId(), mode: 'reveal', shape: 'all' }] : [];
    // отмена: убрать операцию или вернуть прежний список целиком
    if (removeId) next.fogOps = next.fogOps.filter((o) => o.id !== removeId);
    if (Array.isArray(setOps)) next.fogOps = setOps.slice(-4000);
    if (op) {
      const id = typeof op.id === 'string' && op.id.length <= 40 ? op.id : newId();
      next.fogOps = next.fogOps.filter((o) => o.id !== id);
      next.fogOps.push({ ...op, id });
      if (next.fogOps.length > 4000) next.fogOps = next.fogOps.slice(-4000);
    }
    if (jsonSize(next) > SIZE_LIMITS.page) throw new Error('Слишком много операций тумана — нажмите «Скрыть всё» или «Открыть всё»');
    this.entities.page.set(pageId, next);
    this.markDirty('page', pageId);
    this.emitEntity('page', pageId, before, next, null);
  }

  toggleDoor(viewer, id) {
    const w = this.entities.obj.get(id);
    if (!w || w.type !== 'wall' || w.wallType !== 'door') throw new Error('Дверь не найдена');
    if (w.locked && !viewer.isGM) throw new Error('Дверь заперта');
    const next = { ...w, open: !w.open };
    this.entities.obj.set(id, next);
    this.markDirty('obj', id);
    this.emitEntity('obj', id, w, next, null);
    return { open: next.open };
  }

  jukebox(viewer, op) {
    const jb = (this.state.jukebox = this.state.jukebox || { playing: {} });
    jb.playing = jb.playing || {};
    // конец трека плейлиста сообщает любой участник; срабатывает один раз (по метке startedAt)
    if (op.action === 'ended') {
      const pl = jb.playlist;
      const cur = pl && pl.queue[pl.index];
      const p = cur && jb.playing[cur];
      if (!p || cur !== op.trackId || p.startedAt !== op.startedAt) return { ok: true };
      const tr = this.entities.track.get(cur);
      const elapsed = now() - p.startedAt;
      if (!viewer.isGM && tr?.duration && elapsed < tr.duration * 1000 * 0.9) return { ok: true };
      this.playlistAdvance(jb);
      this.gameDirty = true;
      this.broadcastGame();
      return { ok: true };
    }
    if (!viewer.isGM) throw new Error('Музыкой управляет мастер');
    if (op.action === 'play' && op.trackId) {
      const tr = this.entities.track.get(op.trackId);
      if (!tr) throw new Error('Трек не найден');
      jb.playing[op.trackId] = { startedAt: now(), volume: op.volume ?? tr.volume ?? 0.6, loop: op.loop ?? tr.loop ?? true };
    } else if (op.action === 'stop' && op.trackId) {
      delete jb.playing[op.trackId];
      if (jb.playlist && jb.playlist.queue[jb.playlist.index] === op.trackId) jb.playlist = null;
    } else if (op.action === 'stopAll') {
      jb.playing = {};
      jb.playlist = null;
    } else if (op.action === 'volume' && op.trackId && jb.playing[op.trackId]) jb.playing[op.trackId].volume = Math.max(0, Math.min(1, Number(op.volume) || 0));
    else if (op.action === 'master') jb.master = Math.max(0, Math.min(1, Number(op.volume) || 0));
    else if (op.action === 'playlist') {
      // плейлист: треки группы по порядку или вперемешку, с повтором или без
      const name = String(op.playlist ?? '');
      const list = [...this.entities.track.values()].filter((t) => (t.playlist || '') === name).sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));
      if (!list.length) throw new Error('В плейлисте нет треков');
      if (jb.playlist) delete jb.playing[jb.playlist.queue[jb.playlist.index]];
      const queue = list.map((t) => t.id);
      if (op.mode === 'shuffle') shuffle(queue);
      jb.playlist = { name, mode: op.mode === 'shuffle' ? 'shuffle' : 'order', repeat: op.repeat !== false, queue, index: 0 };
      this.playlistStart(jb);
    } else if (op.action === 'next' || op.action === 'prev') {
      if (!jb.playlist) throw new Error('Плейлист не запущен');
      if (op.action === 'next') this.playlistAdvance(jb);
      else {
        delete jb.playing[jb.playlist.queue[jb.playlist.index]];
        jb.playlist.index = (jb.playlist.index - 1 + jb.playlist.queue.length) % jb.playlist.queue.length;
        this.playlistStart(jb);
      }
    } else if (op.action === 'repeat' && jb.playlist) jb.playlist.repeat = !!op.repeat;
    this.gameDirty = true;
    this.broadcastGame();
  }

  playlistStart(jb) {
    const pl = jb.playlist;
    const id = pl.queue[pl.index];
    const tr = this.entities.track.get(id);
    if (!tr) return this.playlistAdvance(jb);
    jb.playing[id] = { startedAt: now(), volume: tr.volume ?? 0.6, loop: false, playlist: pl.name };
  }

  playlistAdvance(jb) {
    const pl = jb.playlist;
    if (!pl) return;
    delete jb.playing[pl.queue[pl.index]];
    // удалённые треки выбрасываем из очереди
    pl.queue = pl.queue.filter((id) => this.entities.track.has(id));
    if (!pl.queue.length) {
      jb.playlist = null;
      return;
    }
    pl.index++;
    if (pl.index >= pl.queue.length) {
      if (!pl.repeat) {
        jb.playlist = null;
        return;
      }
      pl.index = 0;
      if (pl.mode === 'shuffle') shuffle(pl.queue);
    }
    this.playlistStart(jb);
  }

  // Эффекты из команды /fx
  fxFromCommand(socket, fx, payload) {
    const from = fx.from && this.entities.obj.get(fx.from);
    const to = fx.to && this.entities.obj.get(fx.to);
    if (!from) {
      socket.emit('chat:system', { text: 'Для /fx выберите токен', ts: now() });
      return;
    }
    const [type, color] = String(fx.spec).split('-');
    const c = (o) => ({ x: o.x + o.w / 2, y: o.y + o.h / 2 });
    const a = c(from);
    const b = to ? c(to) : null;
    this.io.to(this.id).emit('fx', { pageId: from.pageId, type: type || 'burst', color: color || 'fire', x: a.x, y: a.y, x2: b?.x, y2: b?.y, by: socket.data.user.id });
  }
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function normalizeValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? v : '';
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v).slice(0, 500000);
    } catch {
      return '';
    }
  }
  return String(v).slice(0, 500000);
}
