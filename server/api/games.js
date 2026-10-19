import express from 'express';
import { db, now, parseJSON } from '../db.js';
import { requireUser } from '../auth.js';
import { newId, randomCode } from '../../shared/ids.js';
import { PAGE_DEFAULTS, GAME_SETTINGS_DEFAULTS, GAME_STATE_DEFAULTS } from '../../shared/defaults.js';
import { rooms } from '../game/rooms.js';

export const gamesRouter = express.Router();
gamesRouter.use(requireUser);

function memberRow(gameId, userId) {
  return db.prepare(`SELECT * FROM members WHERE game_id=? AND user_id=?`).get(gameId, userId);
}

function uniqueInviteCode() {
  for (let i = 0; i < 20; i++) {
    const code = randomCode(8);
    if (!db.prepare(`SELECT 1 FROM games WHERE invite_code=?`).get(code)) return code;
  }
  throw new Error('Не удалось создать код');
}

function gameSummary(g, role, userId) {
  const members = db
    .prepare(
      `SELECT u.id, u.display_name, u.color, u.avatar, m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.game_id=? ORDER BY m.joined_at`,
    )
    .all(g.id);
  const sheet = g.sheet_id ? db.prepare(`SELECT id, name FROM sheets WHERE id=?`).get(g.sheet_id) : null;
  const room = rooms.peek(g.id);
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    ownerId: g.owner_id,
    role,
    inviteCode: role === 'gm' ? g.invite_code : undefined,
    sheet: sheet ? { id: sheet.id, name: sheet.name } : null,
    thumbnail: g.thumbnail,
    createdAt: g.created_at,
    lastPlayed: g.last_played,
    nextSession: g.next_session || null,
    online: room ? room.onlineUserIds() : [],
    members: members.map((m) => ({
      id: m.id,
      displayName: m.display_name,
      color: m.color,
      avatar: m.avatar,
      role: m.role,
      isOwner: m.id === g.owner_id,
    })),
    isOwner: g.owner_id === userId,
  };
}

gamesRouter.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT g.*, m.role FROM games g JOIN members m ON m.game_id=g.id WHERE m.user_id=? ORDER BY COALESCE(g.last_played, g.created_at) DESC`,
    )
    .all(req.user.id);
  res.json({ games: rows.map((g) => gameSummary(g, g.role, req.user.id)) });
});

export function createGame({ name, ownerId, sheetId = null, description = '' }) {
  const id = newId();
  const t = now();
  const pageId = newId();
  const state = { ...GAME_STATE_DEFAULTS, playerPageId: pageId };
  db.transaction(() => {
    db.prepare(
      `INSERT INTO games(id, name, description, owner_id, invite_code, sheet_id, settings, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, name, description, ownerId, uniqueInviteCode(), sheetId, JSON.stringify(GAME_SETTINGS_DEFAULTS), JSON.stringify(state), t, t);
    db.prepare(`INSERT INTO members(game_id, user_id, role, joined_at) VALUES (?,?,?,?)`).run(id, ownerId, 'gm', t);
    const page = { ...PAGE_DEFAULTS, name: 'Первая сцена', order: 0 };
    db.prepare(`INSERT INTO entities(id, game_id, type, parent_id, data, updated_at) VALUES (?,?,?,?,?,?)`).run(
      pageId,
      id,
      'page',
      null,
      JSON.stringify(page),
      t,
    );
  })();
  return id;
}

gamesRouter.post('/', (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Укажите название стола' });
  let sheetId = req.body?.sheetId || null;
  if (sheetId && !db.prepare(`SELECT 1 FROM sheets WHERE id=?`).get(sheetId)) sheetId = null;
  const id = createGame({ name, ownerId: req.user.id, sheetId, description: String(req.body?.description || '').slice(0, 2000) });
  const g = db.prepare(`SELECT * FROM games WHERE id=?`).get(id);
  res.json({ game: gameSummary(g, 'gm', req.user.id) });
});

// Пример стола для знакомства с возможностями
gamesRouter.post('/demo', async (req, res) => {
  try {
    const { createDemoGame } = await import('../demo.js');
    const id = createDemoGame(req.user.id);
    const g = db.prepare(`SELECT * FROM games WHERE id=?`).get(id);
    res.json({ game: gameSummary(g, 'gm', req.user.id) });
  } catch (e) {
    console.error('[demo]', e);
    res.status(500).json({ error: 'Не удалось создать пример: ' + e.message });
  }
});

gamesRouter.post('/join', (req, res) => {
  const code = String(req.body?.code || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  const g = db.prepare(`SELECT * FROM games WHERE invite_code=?`).get(code);
  if (!g) return res.status(404).json({ error: 'Стол с таким кодом не найден' });
  const settings = parseJSON(g.settings, {});
  const banned = settings.banned || [];
  if (banned.includes(req.user.id)) return res.status(403).json({ error: 'Мастер запретил вам вход в этот стол' });
  let m = memberRow(g.id, req.user.id);
  if (!m) {
    db.prepare(`INSERT INTO members(game_id, user_id, role, joined_at) VALUES (?,?,?,?)`).run(g.id, req.user.id, 'player', now());
    m = memberRow(g.id, req.user.id);
    rooms.peek(g.id)?.reloadMembers();
  }
  res.json({ game: gameSummary(g, m.role, req.user.id) });
});

gamesRouter.get('/:id', (req, res) => {
  const g = db.prepare(`SELECT * FROM games WHERE id=?`).get(req.params.id);
  const m = g && memberRow(g.id, req.user.id);
  if (!m) return res.status(404).json({ error: 'Стол не найден' });
  res.json({ game: { ...gameSummary(g, m.role, req.user.id), settings: m.role === 'gm' ? parseJSON(g.settings, {}) : undefined } });
});

function requireGM(req, res) {
  const g = db.prepare(`SELECT * FROM games WHERE id=?`).get(req.params.id);
  const m = g && memberRow(g.id, req.user.id);
  if (!m) {
    res.status(404).json({ error: 'Стол не найден' });
    return null;
  }
  if (m.role !== 'gm') {
    res.status(403).json({ error: 'Только мастер может это делать' });
    return null;
  }
  return g;
}

gamesRouter.patch('/:id', (req, res) => {
  const g = requireGM(req, res);
  if (!g) return;
  const { name, description, sheetId, thumbnail, nextSession } = req.body || {};
  if (nextSession !== undefined) {
    const t = nextSession === null || nextSession === '' ? null : Number(nextSession);
    if (t !== null && !(Number.isFinite(t) && t > Date.UTC(2000, 0, 1) && t < Date.UTC(2200, 0, 1))) return res.status(400).json({ error: 'Неверная дата следующей игры' });
    db.prepare(`UPDATE games SET next_session=? WHERE id=?`).run(t, g.id);
  }
  if (name !== undefined) {
    const n = String(name).trim().slice(0, 80);
    if (n) db.prepare(`UPDATE games SET name=? WHERE id=?`).run(n, g.id);
  }
  if (description !== undefined) db.prepare(`UPDATE games SET description=? WHERE id=?`).run(String(description).slice(0, 2000), g.id);
  if (thumbnail !== undefined) db.prepare(`UPDATE games SET thumbnail=? WHERE id=?`).run(String(thumbnail).slice(0, 1000), g.id);
  if (sheetId !== undefined) {
    const sid = sheetId && db.prepare(`SELECT 1 FROM sheets WHERE id=?`).get(sheetId) ? sheetId : null;
    db.prepare(`UPDATE games SET sheet_id=? WHERE id=?`).run(sid, g.id);
  }
  db.prepare(`UPDATE games SET updated_at=? WHERE id=?`).run(now(), g.id);
  rooms.peek(g.id)?.reloadGameRow();
  const fresh = db.prepare(`SELECT * FROM games WHERE id=?`).get(g.id);
  res.json({ game: gameSummary(fresh, 'gm', req.user.id) });
});

gamesRouter.post('/:id/invite', (req, res) => {
  const g = requireGM(req, res);
  if (!g) return;
  const code = uniqueInviteCode();
  db.prepare(`UPDATE games SET invite_code=? WHERE id=?`).run(code, g.id);
  res.json({ inviteCode: code });
});

gamesRouter.patch('/:id/members/:userId', (req, res) => {
  const g = requireGM(req, res);
  if (!g) return;
  const role = req.body?.role === 'gm' ? 'gm' : 'player';
  if (req.params.userId === g.owner_id && role !== 'gm') return res.status(400).json({ error: 'Создатель стола всегда мастер' });
  db.prepare(`UPDATE members SET role=? WHERE game_id=? AND user_id=?`).run(role, g.id, req.params.userId);
  rooms.peek(g.id)?.reloadMembers(true);
  res.json({ ok: true });
});

gamesRouter.delete('/:id/members/:userId', (req, res) => {
  const g = db.prepare(`SELECT * FROM games WHERE id=?`).get(req.params.id);
  const me = g && memberRow(g.id, req.user.id);
  if (!me) return res.status(404).json({ error: 'Стол не найден' });
  const target = req.params.userId;
  const self = target === req.user.id;
  if (!self && me.role !== 'gm') return res.status(403).json({ error: 'Только мастер может исключать игроков' });
  if (target === g.owner_id) return res.status(400).json({ error: 'Создателя стола нельзя исключить' });
  db.prepare(`DELETE FROM members WHERE game_id=? AND user_id=?`).run(g.id, target);
  if (!self && req.body?.ban) {
    const settings = parseJSON(g.settings, {});
    settings.banned = [...new Set([...(settings.banned || []), target])];
    db.prepare(`UPDATE games SET settings=? WHERE id=?`).run(JSON.stringify(settings), g.id);
  }
  rooms.peek(g.id)?.reloadMembers(true);
  res.json({ ok: true });
});

gamesRouter.delete('/:id', (req, res) => {
  const g = db.prepare(`SELECT * FROM games WHERE id=?`).get(req.params.id);
  if (!g || g.owner_id !== req.user.id) return res.status(403).json({ error: 'Удалить стол может только его создатель' });
  rooms.peek(g.id)?.shutdown('Стол удалён');
  db.prepare(`DELETE FROM games WHERE id=?`).run(g.id);
  res.json({ ok: true });
});

// Копирование персонажей и материалов в другой свой стол (как Transmogrifier в Roll20)
gamesRouter.post('/:id/transfer', (req, res) => {
  const g = requireGM(req, res);
  if (!g) return;
  const targetId = String(req.body?.targetGameId || '');
  const target = db.prepare(`SELECT g.* FROM games g JOIN members m ON m.game_id=g.id WHERE g.id=? AND m.user_id=? AND m.role='gm'`).get(targetId, req.user.id);
  if (!target) return res.status(403).json({ error: 'Копировать можно только в стол, где вы мастер' });
  if (target.id === g.id) return res.status(400).json({ error: 'Это тот же самый стол' });
  const list = (v) => new Set((Array.isArray(v) ? v : []).slice(0, 500).map(String));
  const want = { char: list(req.body?.chars), handout: list(req.body?.handouts) };
  rooms.peek(g.id)?.flush();
  const rows = db
    .prepare(`SELECT id, type, data FROM entities WHERE game_id=? AND type IN ('char','handout')`)
    .all(g.id)
    .filter((r) => want[r.type]?.has(r.id));
  if (!rows.length) return res.status(400).json({ error: 'Нечего копировать' });
  // в другом столе другие игроки: права оставляем только «для всех»
  const onlyAll = (v) => (Array.isArray(v) && v.includes('all') ? ['all'] : []);
  const dst = rooms.peek(target.id);
  const t = now();
  const adopted = [];
  const insE = db.prepare(`INSERT INTO entities(id, game_id, type, parent_id, data, updated_at) VALUES (?,?,?,?,?,?)`);
  const insA = db.prepare(`INSERT INTO attributes(id, game_id, char_id, name, current, max) VALUES (?,?,?,?,?,?)`);
  const selA = db.prepare(`SELECT name, current, max FROM attributes WHERE game_id=? AND char_id=?`);
  db.transaction(() => {
    for (const r of rows) {
      const d = parseJSON(r.data, {});
      const nid = newId();
      delete d.id;
      delete d.ownerId;
      d.controlledBy = onlyAll(d.controlledBy);
      d.inJournals = onlyAll(d.inJournals);
      if (r.type === 'char') {
        if (d.defaultToken && typeof d.defaultToken === 'object') d.defaultToken = { ...d.defaultToken, represents: nid, controlledBy: [] };
        for (const a of selA.all(g.id, r.id)) insA.run(newId(), target.id, nid, a.name, a.current, a.max);
      }
      if (dst) adopted.push([r.type, nid, d]);
      else insE.run(nid, target.id, r.type, null, JSON.stringify(d), t);
    }
  })();
  for (const [c, id, d] of adopted) dst.adoptEntity(c, id, d);
  res.json({ copied: rows.length, target: { id: target.id, name: target.name } });
});

// Экспорт стола целиком (резервная копия / перенос)
gamesRouter.get('/:id/export', (req, res) => {
  const g = requireGM(req, res);
  if (!g) return;
  rooms.peek(g.id)?.flush?.();
  const entities = db.prepare(`SELECT id, type, parent_id, data FROM entities WHERE game_id=?`).all(g.id);
  const attributes = db.prepare(`SELECT id, char_id, name, current, max FROM attributes WHERE game_id=?`).all(g.id);
  const out = {
    format: 'taverna-game',
    version: 1,
    exportedAt: new Date().toISOString(),
    game: { name: g.name, description: g.description, settings: parseJSON(g.settings, {}), state: parseJSON(g.state, {}), sheetId: g.sheet_id },
    entities: entities.map((e) => ({ id: e.id, type: e.type, parent: e.parent_id, data: parseJSON(e.data, {}) })),
    attributes: attributes.map((a) => ({ id: a.id, c: a.char_id, n: a.name, v: parseJSON(a.current, ''), m: parseJSON(a.max, '') })),
  };
  res.setHeader('Content-Disposition', `attachment; filename="game-${g.id}.json"`);
  res.json(out);
});

// Импорт стола из файла экспорта (создаётся новый стол)
gamesRouter.post('/import', express.json({ limit: '200mb' }), (req, res) => {
  const data = req.body;
  if (!data || data.format !== 'taverna-game') return res.status(400).json({ error: 'Неверный формат файла' });
  const gameId = createGame({ name: String(data.game?.name || 'Импорт').slice(0, 80), ownerId: req.user.id, sheetId: null });
  const idMap = new Map();
  const mapId = (old) => {
    if (!old) return old;
    if (!idMap.has(old)) idMap.set(old, newId());
    return idMap.get(old);
  };
  const t = now();
  db.transaction(() => {
    db.prepare(`DELETE FROM entities WHERE game_id=?`).run(gameId);
    const ins = db.prepare(`INSERT INTO entities(id, game_id, type, parent_id, data, updated_at) VALUES (?,?,?,?,?,?)`);
    const TYPES = new Set(['page', 'obj', 'char', 'handout', 'macro', 'rtable', 'track']);
    for (const e of data.entities || []) {
      if (!e || !TYPES.has(e.type) || !e.id) continue;
      const d = e.data && typeof e.data === 'object' ? e.data : {};
      delete d.id;
      if (d.represents) d.represents = mapId(d.represents);
      if (d.pageId) d.pageId = mapId(d.pageId);
      if (d.charId) d.charId = mapId(d.charId);
      ins.run(mapId(e.id), gameId, e.type, e.parent ? mapId(e.parent) : null, JSON.stringify(d), t);
    }
    const insA = db.prepare(`INSERT OR IGNORE INTO attributes(id, game_id, char_id, name, current, max) VALUES (?,?,?,?,?,?)`);
    for (const a of data.attributes || []) if (a && a.c && a.n) insA.run(newId(), gameId, mapId(a.c), String(a.n).slice(0, 300), JSON.stringify(a.v ?? ''), JSON.stringify(a.m ?? ''));
    const state = data.game?.state || {};
    if (state.playerPageId) state.playerPageId = mapId(state.playerPageId);
    state.playerPages = {};
    state.turnorder = (state.turnorder || []).map((t) => ({ ...t, tokenId: t.tokenId ? mapId(t.tokenId) : t.tokenId }));
    const sheetId = data.game?.sheetId && db.prepare(`SELECT 1 FROM sheets WHERE id=?`).get(data.game.sheetId) ? data.game.sheetId : null;
    db.prepare(`UPDATE games SET settings=?, state=?, sheet_id=?, description=? WHERE id=?`).run(
      JSON.stringify({ ...GAME_SETTINGS_DEFAULTS, ...(data.game?.settings || {}), banned: [] }),
      JSON.stringify({ ...GAME_STATE_DEFAULTS, ...state }),
      sheetId,
      String(data.game?.description || ''),
      gameId,
    );
  })();
  const g = db.prepare(`SELECT * FROM games WHERE id=?`).get(gameId);
  res.json({ game: gameSummary(g, 'gm', req.user.id) });
});
