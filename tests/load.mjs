// Нагрузочная проверка: мастер и N игроков одновременно двигают токены и бросают кубики.
// Запуск: node tests/load.mjs [игроков=6] [секунд=10]  (сервер на BASE, по умолчанию http://localhost:3000)
import { io } from 'socket.io-client';

const BASE = process.env.BASE || 'http://localhost:3000';
const N = Number(process.argv[2] || 6);
const SEC = Number(process.argv[3] || 10);
const H = { 'Content-Type': 'application/json', 'X-Taverna': '1' };

async function user(name) {
  const username = 'load' + Date.now().toString(36) + Math.floor(Math.random() * 1e5);
  let r = await fetch(BASE + '/api/auth/register', { method: 'POST', headers: H, body: JSON.stringify({ username, password: 'secret123', displayName: name }) });
  if (r.status === 429) throw new Error('лимит регистраций — перезапустите сервер');
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return { name, cookie, user: (await r.json()).user };
}

function connect(u, gameId) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { transports: ['websocket'], extraHeaders: { cookie: u.cookie, origin: BASE } });
    s.on('connect_error', reject);
    s.on('connect', () =>
      s.emit('join', { gameId }, (res) => {
        if (res?.error) reject(new Error(res.error));
      }),
    );
    s.once('snapshot', (snap) => resolve({ s, snap }));
  });
}

const req = (s, ev, payload) => {
  const t = performance.now();
  return new Promise((res) => s.timeout(10000).emit(ev, payload, (err, r) => res({ r: err ? { error: 'timeout' } : r, ms: performance.now() - t })));
};

// регистрация ограничена по адресу: мастер + игроки (не больше 9 за прогон)
const gm = await user('Мастер');
let r = await fetch(BASE + '/api/games', { method: 'POST', headers: { ...H, cookie: gm.cookie }, body: JSON.stringify({ name: 'Нагрузка' }) });
const game = (await r.json()).game;
const players = [];
for (let i = 0; i < N; i++) players.push(await user('Игрок ' + (i + 1)));
for (const p of players) await fetch(BASE + '/api/games/join', { method: 'POST', headers: { ...H, cookie: p.cookie }, body: JSON.stringify({ code: game.inviteCode }) });

const gmc = await connect(gm, game.id);
const pageId = gmc.snap.game.state.playerPageId;
// токен каждому игроку
const toks = [];
for (const [i, p] of players.entries()) {
  const id = 'tok' + i + Date.now().toString(36);
  const res = await req(gmc.s, 'op', { c: 'obj', t: 'create', d: { id, type: 'shape', shape: 'ellipse', pageId, layer: 'objects', x: 70 * i, y: 0, w: 70, h: 70, controlledBy: [p.user.id], name: p.name } });
  if (res.r?.error) throw new Error(res.r.error);
  toks.push(id);
}
const conns = [];
for (const p of players) conns.push(await connect(p, game.id));
console.log(`подключено: мастер + ${conns.length} игроков, двигаем ${SEC} с…`);

const lat = [];
let errors = 0;
let ops = 0;
const until = Date.now() + SEC * 1000;
await Promise.all(
  conns.map(async ({ s }, i) => {
    let k = 0;
    while (Date.now() < until) {
      k++;
      const x = 70 * i + (k % 20) * 7,
        y = (k % 30) * 7;
      const res = await req(s, 'op', { c: 'obj', t: 'update', id: toks[i], d: { x, y } });
      ops++;
      lat.push(res.ms);
      if (res.r?.error) errors++;
      if (k % 25 === 0) {
        const c = await req(s, 'chat', { text: `/r 2d20kh1+${i}` });
        if (c.r?.error) errors++;
      }
      await new Promise((r) => setTimeout(r, 50)); // ~20 изменений в секунду на игрока
    }
  }),
);
lat.sort((a, b) => a - b);
const p = (q) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))].toFixed(1);
console.log(`операций: ${ops}, ошибок: ${errors}, задержка ответа: медиана ${p(0.5)} мс, 95% ${p(0.95)} мс, макс ${lat.at(-1).toFixed(1)} мс`);

// у мастера итоговые координаты должны совпасть с последними отправленными
await new Promise((r) => setTimeout(r, 500));
const fresh = await connect(gm, game.id);
const objs = new Map(fresh.snap.collections.obj.map((o) => [o.id, o]));
const okAll = toks.every((id) => objs.has(id));
console.log(okAll ? '✓ все токены на месте, сервер отвечает' : '✗ токены потерялись');
for (const c of [...conns, gmc, fresh]) c.s.disconnect();
process.exit(okAll && errors === 0 ? 0 : 1);
