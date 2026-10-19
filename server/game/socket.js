import { Server } from 'socket.io';
import { db } from '../db.js';
import { config } from '../config.js';
import { parseCookies, userFromToken, SESSION_COOKIE, userEvents } from '../auth.js';
import { maintenance } from '../maintenance.js';
import { rooms } from './rooms.js';
import { iceServersFor } from '../rtc.js';

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // не браузер
  try {
    const o = new URL(origin);
    if (config.publicUrl) {
      const p = new URL(config.publicUrl);
      if (o.host === p.host) return true;
    }
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return o.host === host;
  } catch {
    return false;
  }
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const str = (v, n = 40) => String(v ?? '').slice(0, n);

/** Мгновенные события пересылаются другим игрокам — оставляем только известные поля */
function cleanFx(fx) {
  const out = { pageId: str(fx.pageId), type: str(fx.type, 30), color: str(fx.color, 30), x: num(fx.x), y: num(fx.y) };
  if (fx.x2 !== undefined) {
    out.x2 = num(fx.x2);
    out.y2 = num(fx.y2);
  }
  if (fx.custom && typeof fx.custom === 'object') {
    try {
      const c = JSON.stringify(fx.custom);
      if (c.length < 4000) out.custom = JSON.parse(c);
    } catch {
      /* пропускаем */
    }
  }
  return out;
}

function cleanRuler(r) {
  if (r.clear) return { pageId: str(r.pageId), clear: true };
  const pts = (Array.isArray(r.pts) ? r.pts : []).slice(0, 64).map((p) => ({ x: num(p?.x), y: num(p?.y) }));
  const out = { pageId: str(r.pageId), pts };
  if (r.shape) Object.assign(out, { shape: str(r.shape, 12), angle: num(r.angle), width: num(r.width), snap: !!r.snap });
  if (r.label) out.label = str(r.label, 60);
  return out;
}

// Простое ограничение частоты событий на сокет
function limiter(perSecond, burst) {
  let tokens = burst;
  let last = Date.now();
  return () => {
    const t = Date.now();
    tokens = Math.min(burst, tokens + ((t - last) / 1000) * perSecond);
    last = t;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

export function setupSockets(httpServer) {
  const io = new Server(httpServer, {
    serveClient: false, // клиент Socket.IO входит в сборку сайта
    maxHttpBufferSize: 10 * 1024 * 1024,
    pingInterval: 20000,
    pingTimeout: 25000,
    allowRequest: (req, cb) => cb(null, originAllowed(req)),
  });
  rooms.setIO(io);
  // игрок сменил имя, цвет, аватар или кубики — за открытыми столами это видно сразу
  userEvents.on('changed', (userId) => {
    for (const r of rooms.all()) {
      try {
        r.memberProfileChanged(userId);
      } catch (e) {
        console.error('[rooms] профиль', e.message);
      }
    }
  });

  io.use((socket, next) => {
    if (maintenance.active) return next(new Error('maintenance'));
    const cookies = parseCookies(socket.handshake.headers.cookie);
    const user = userFromToken(cookies[SESSION_COOKIE]);
    if (!user) return next(new Error('unauthorized'));
    socket.data.user = user;
    next();
  });

  io.on('connection', (socket) => {
    const allow = limiter(60, 200);
    const allowChat = limiter(8, 30);
    let room = null;

    const guard = (handler, { chat = false } = {}) => async (payload, ack) => {
      const cb = typeof ack === 'function' ? ack : () => {};
      if (!(chat ? allowChat() : allow())) return cb({ error: 'Слишком много запросов, помедленнее' });
      if (!room && handler !== joinHandler) return cb({ error: 'Сначала войдите в стол' });
      // исключённый игрок не может действовать через старое соединение
      if (room && handler !== joinHandler && !room.members.has(socket.data.user.id)) return cb({ error: 'Нет доступа к этому столу' });
      try {
        const res = await handler(payload || {});
        cb(res === undefined ? { ok: true } : res);
      } catch (e) {
        if (!/^(Нет|Только|Нельзя|Слишком|Удалить|Сцена|Объект|Персонаж|Мастер|Это|Стены|Раздаточные|Таблицы|Музыкой|Туманом|Можно|Сейчас|Неизвестн|Недостаточно|Бросок|Чужой|Сначала|Голосовой|Токен|Сцепить|Такого|Нет целей)/.test(e.message)) console.error('[socket]', e);
        cb({ error: e.message || 'Ошибка' });
      }
    };

    const joinHandler = ({ gameId }) => {
      const m = db.prepare(`SELECT role FROM members WHERE game_id=? AND user_id=?`).get(String(gameId || ''), socket.data.user.id);
      if (!m) throw new Error('Нет доступа к этому столу');
      if (room) {
        room.removeSocket(socket);
        socket.leave(room.id);
      }
      room = rooms.get(gameId);
      socket.data.gameId = gameId;
      room.addSocket(socket);
      return { ok: true };
    };

    socket.on('join', guard(joinHandler));
    socket.on('op', guard((op) => room.handleOp(socket, op)));
    socket.on(
      'ops',
      guard((ops) => {
        const results = [];
        for (const op of Array.isArray(ops) ? ops.slice(0, 500) : []) {
          try {
            results.push(room.handleOp(socket, op));
          } catch (e) {
            results.push({ error: e.message });
          }
        }
        return { results };
      }),
    );
    socket.on('attrs:get', guard(({ charId }) => ({ attrs: room.getAttrs(room.viewer(socket), charId) })));
    socket.on(
      'attrs:set',
      guard(({ charId, set, del, delPrefix, o }) =>
        room.setAttrs(room.viewer(socket), charId, Array.isArray(set) ? set.slice(0, 20000) : [], Array.isArray(del) ? del : [], Array.isArray(delPrefix) ? delPrefix : [], o),
      ),
    );
    socket.on('attrs:peek', guard(({ tokenId, names }) => room.peekAttrs(room.viewer(socket), tokenId, Array.isArray(names) ? names : [])));
    socket.on('chat', guard((payload) => room.chat(socket, payload), { chat: true }));
    socket.on('chat:history', guard(({ before }) => ({ messages: room.loadMessages(room.viewer(socket), Number(before) || null, 100) })));
    socket.on('chat:clear', guard(() => room.clearChat(room.viewer(socket))));
    // реакции: под сообщением — не чаще 3 в секунду, всплывающие над токеном — не чаще 1,5 в секунду
    const allowCine = limiter(4, 12);
    socket.on(
      'cine',
      guard((p) => {
        if (!allowCine()) throw new Error('Слишком часто, помедленнее');
        return room.cine(room.viewer(socket), p);
      }),
    );
    const allowReact = limiter(3, 20);
    const allowFloat = limiter(1.5, 4);
    socket.on(
      'chat:react',
      guard(({ id, emoji }) => {
        if (!allowReact()) throw new Error('Слишком много реакций, помедленнее');
        return room.reactMessage(room.viewer(socket), id, emoji);
      }),
    );
    socket.on('react:float', guard(({ emoji, tokenId }) => (allowFloat() ? room.floatReaction(socket, emoji, tokenId) : { ok: false })));
    socket.on('roll:finish', guard(({ rollId, computed }) => room.finishRoll(socket, rollId, computed || {})));
    socket.on('turn', guard((op) => room.turnOp(room.viewer(socket), op)));
    socket.on('settings', guard((patch) => room.updateSettings(room.viewer(socket), patch)));
    socket.on('state', guard((patch) => room.updateState(room.viewer(socket), patch)));
    socket.on('fog', guard((payload) => room.fogOp(room.viewer(socket), payload)));
    socket.on('jukebox', guard((op) => room.jukebox(room.viewer(socket), op)));
    socket.on('door', guard(({ id }) => room.toggleDoor(room.viewer(socket), id)));
    socket.on('marker', guard((op) => room.markerOp(room.viewer(socket), op || {})));
    socket.on('effects:turn', guard(({ seq }) => room.claimTurnFx(room.viewer(socket), seq)));
    socket.on('effect:ask', guard((req) => room.relayEffect(socket, req || {})));

    // Голосовой и видеочат (WebRTC): сервер пересылает только служебные сигналы участникам стола
    socket.on(
      'rtc:join',
      guard((p) => {
        if (!config.voiceEnabled) throw new Error('Голосовой чат отключён администратором');
        const peers = room.voiceJoin(socket, { muted: p.muted, video: p.video });
        return { sid: socket.id, peers, iceServers: iceServersFor(socket.data.user.id) };
      }),
    );
    socket.on('rtc:signal', guard(({ to, data }) => room.voiceSignal(socket, to, data)));
    socket.on('rtc:state', guard((p) => room.voiceState(socket, p)));
    socket.on('rtc:leave', guard(() => room.voiceLeave(socket)));

    // Мгновенные события без сохранения
    socket.on(
      'ping:map',
      guard(({ pageId, x, y, pull }) => {
        const v = room.viewer(socket);
        socket.to(room.id).emit('ping:map', { pageId: str(pageId), x: num(x), y: num(y), pull: !!pull && v.isGM, by: v.userId, color: room.members.get(v.userId)?.color });
      }),
    );
    socket.on(
      'fx',
      guard((fx) => {
        const v = room.viewer(socket);
        if (!v.isGM && !room.settings.playersCanUseFx) throw new Error('Мастер запретил эффекты');
        socket.to(room.id).emit('fx', { ...cleanFx(fx), by: v.userId });
      }),
    );
    socket.on(
      'ruler',
      guard((r) => {
        const v = room.viewer(socket);
        socket.to(room.id).emit('ruler', { ...cleanRuler(r), by: v.userId, color: room.members.get(v.userId)?.color });
      }),
    );
    socket.on(
      'sfx',
      guard((p) => {
        const v = room.viewer(socket);
        if (!v.isGM) throw new Error('Звуками управляет мастер');
        io.to(room.id).emit('sfx', { trackId: str(p.trackId), url: p.url ? str(p.url, 1000) : undefined, volume: p.volume === undefined ? undefined : Math.max(0, Math.min(1, num(p.volume))) });
      }),
    );
    socket.on(
      'handout:show',
      guard(({ handoutId }) => {
        const v = room.viewer(socket);
        if (!v.isGM) throw new Error('Только мастер');
        socket.to(room.id).emit('handout:show', { handoutId: str(handoutId) });
      }),
    );

    socket.on('disconnect', () => {
      if (room) room.removeSocket(socket);
    });
  });

  return io;
}
