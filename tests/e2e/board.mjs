// e2e: доска, токены, бары, туман, динамический свет, два пользователя
import { chromium } from 'playwright-core';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3000';
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'taverna-shots');
const ASSETS = process.env.ASSETS || path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets');
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const errors = [];
async function newUser(name) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${name}] pageerror: ${e.message}`));
  page.on('console', (m) => {
    const t = m.text();
    if ((m.type() === 'error' || m.type() === 'warning') && !/ERR_TUNNEL|Failed to load resource/.test(t)) errors.push(`[${name}] ${m.type()}: ${t}`);
  });
  await page.goto(BASE);
  const api = (path, body, method) =>
    page.evaluate(
      async ([path, body, method]) => {
        const r = await fetch(path, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', 'X-Taverna': '1' }, body: body ? JSON.stringify(body) : undefined });
        return r.json();
      },
      [path, body, method],
    );
  const r = await api('/api/auth/register', { username: name + Date.now().toString(36), password: 'secret123', displayName: name });
  return { ctx, page, api, user: r.user };
}

const step = async (name, fn) => {
  try {
    await fn();
    console.log('✓', name);
  } catch (e) {
    console.log('✗', name, e.message.split('\n')[0]);
    console.log(errors.slice(0, 20).join('\n'));
    await browser.close();
    process.exit(1);
  }
};

const gm = await newUser('Мастер');
const pl = await newUser('Аня');
let game, assets, heroId, goblinCharId;

await step('мастер: стол и загрузка картинок', async () => {
  const sheets = (await gm.api('/api/sheets')).sheets;
  game = (await gm.api('/api/games', { name: 'Подземелье', sheetId: sheets.find((s) => s.sourceRef === 'DD5thEditionLegacy').id })).game;
  const fileInput = await gm.page.evaluateHandle(() => {
    const i = document.createElement('input');
    i.type = 'file';
    i.multiple = true;
    i.id = 'tmpfile';
    document.body.appendChild(i);
    return i;
  });
  await gm.page.setInputFiles('#tmpfile', [`${ASSETS}/map.png`, `${ASSETS}/hero.png`, `${ASSETS}/goblin.png`, `${ASSETS}/fire.gif`]);
  assets = await gm.page.evaluate(async (gameId) => {
    const fd = new FormData();
    for (const f of document.getElementById('tmpfile').files) fd.append('files', f, f.name);
    fd.append('gameId', gameId);
    const r = await fetch('/api/assets', { method: 'POST', headers: { 'X-Taverna': '1' }, body: fd });
    return (await r.json()).assets;
  }, game.id);
  if (assets.length !== 4) throw new Error('загружено ' + assets.length);
});

await step('игрок входит по коду', async () => {
  const r = await pl.api('/api/games/join', { code: game.inviteCode });
  if (!r.game) throw new Error(JSON.stringify(r));
});

await gm.page.goto(`${BASE}/game/${game.id}`);
await gm.page.waitForSelector('.board-world', { state: 'attached' });
await gm.page.waitForTimeout(500);

const byName = (n) => assets.find((a) => a.name === n);

await step('карта на слое карты + GIF', async () => {
  await gm.page.evaluate(
    ([map, fire]) => {
      const b = window.__board;
      b.store.setLayer('map');
      b.createObj({ type: 'image', src: map.url, x: 0, y: 0, w: 1400, h: 1050, layer: 'map', locked: true });
      b.store.setLayer('objects');
      b.createObj({ type: 'image', src: fire.url, x: 420, y: 280, w: 70, h: 70, layer: 'objects', name: 'Костёр', light: { enabled: true, bright: 15, dim: 15, color: '#ffb060', angle: 360, intensity: 1 } });
    },
    [byName('map'), byName('fire')],
  );
  await gm.page.waitForTimeout(400);
});

await step('персонажи и токены', async () => {
  const ids = await gm.page.evaluate(
    async ([hero, gob]) => {
      const b = window.__board;
      const net = b.net;
      const h = await net.create('char', { name: 'Тарен', avatar: hero.url, inJournals: [], controlledBy: [] });
      const g = await net.create('char', { name: 'Гоблин', avatar: gob.url });
      await net.request('attrs:set', { charId: h.id, set: [{ name: 'hp', current: 27, max: 31 }] });
      await net.request('attrs:set', { charId: g.id, set: [{ name: 'hp', current: 7, max: 7 }] });
      return { hero: h.id, gob: g.id };
    },
    [byName('hero'), byName('goblin')],
  );
  heroId = ids.hero;
  goblinCharId = ids.gob;
  await gm.page.evaluate(async ([h, g]) => {
    const b = window.__board;
    await b.tokenFromCharacter(h, 245, 315);
    await b.tokenFromCharacter(g, 875, 245);
    await b.tokenFromCharacter(g, 1015, 315);
  }, [heroId, goblinCharId]);
  await gm.page.waitForTimeout(800);
  const names = await gm.page.evaluate(() => [...window.__board.store.col.obj.values()].map((o) => o.name).filter(Boolean));
  console.log('   токены:', names.join(', '));
  if (!names.includes('Гоблин 2')) throw new Error('нет нумерации NPC');
});

await step('фигура-токен инструментом мышью', async () => {
  await gm.page.evaluate(() => window.__board.store.setTool('shape'));
  const box = await gm.page.locator('.board').boundingBox();
  const p = await gm.page.evaluate(() => {
    const b = window.__board;
    return { a: b.worldToScreen(770, 630), c: b.worldToScreen(980, 770) };
  });
  await gm.page.mouse.move(box.x + p.a.x, box.y + p.a.y);
  await gm.page.mouse.down();
  await gm.page.mouse.move(box.x + p.c.x, box.y + p.c.y, { steps: 6 });
  await gm.page.mouse.up();
  await gm.page.evaluate(() => window.__board.store.setTool('select'));
  const shapes = await gm.page.evaluate(() => [...window.__board.store.col.obj.values()].filter((o) => o.type === 'shape').length);
  if (shapes !== 1) throw new Error('фигур: ' + shapes);
});

await step('права: игрок управляет героем', async () => {
  await gm.page.evaluate(async ([h, uid]) => {
    await window.__board.net.update('char', h, { controlledBy: [uid], inJournals: [uid] });
  }, [heroId, pl.user.id]);
});

await step('туман и динамический свет', async () => {
  await gm.page.evaluate(async (heroId) => {
    const b = window.__board;
    const page = b.store.page;
    await b.net.update('page', page.id, { width: 20, height: 15, fog: { enabled: true, gmOpacity: 0.45 }, lighting: { enabled: true, daylight: false, explorer: false, restrictMovement: true, darkness: 1 } });
    await b.net.request('fog', { pageId: page.id, op: { mode: 'reveal', shape: 'rect', x: 140, y: 140, w: 840, h: 400 } });
    // стены комнаты 1 (с проёмом справа)
    const W = (pts, type = 'wall') => b.createObj({ type: 'wall', layer: 'walls', wallType: type, pts, x: 0, y: 0, w: 0, h: 0 }, { select: false });
    W([140, 140, 560, 140, 560, 280]);
    W([560, 350, 560, 490, 140, 490, 140, 140]);
    W([560, 280, 560, 350], 'door');
    W([700, 140, 1260, 140, 1260, 420, 700, 420, 700, 350]);
    W([700, 280, 700, 140]);
    const hero = [...b.store.col.obj.values()].find((o) => o.represents === heroId);
    await b.net.update('obj', hero.id, { vision: { enabled: true, range: 0, darkvision: 60, angle: 360 }, light: { enabled: true, bright: 10, dim: 10, color: '#fff', angle: 360, intensity: 0.9 } });
  }, heroId);
  await gm.page.waitForTimeout(800);
  await gm.page.screenshot({ path: `${SHOTS}/board-gm.png` });
});

await step('игрок видит свою сцену', async () => {
  await pl.page.goto(`${BASE}/game/${game.id}`);
  await pl.page.waitForSelector('.board-world', { state: 'attached' });
  await pl.page.waitForTimeout(1500);
  await pl.page.screenshot({ path: `${SHOTS}/board-player.png` });
  const n = await pl.page.evaluate(() => document.querySelectorAll('.layer-objects .obj').length);
  console.log('   объектов у игрока:', n);
});

await step('игрок двигает героя мышью', async () => {
  const pos = await pl.page.evaluate((heroId) => {
    const b = window.__board;
    const hero = [...b.store.col.obj.values()].find((o) => o.represents === heroId);
    return { from: b.worldToScreen(hero.x + hero.w / 2, hero.y + hero.h / 2), to: b.worldToScreen(hero.x + hero.w / 2 + 140, hero.y + hero.h / 2 + 70), id: hero.id, x: hero.x };
  }, heroId);
  const box = await pl.page.locator('.board').boundingBox();
  await pl.page.mouse.move(box.x + pos.from.x, box.y + pos.from.y);
  await pl.page.mouse.down();
  await pl.page.mouse.move(box.x + pos.to.x, box.y + pos.to.y, { steps: 8 });
  await pl.page.mouse.up();
  await pl.page.waitForTimeout(800);
  const gx = await gm.page.evaluate((id) => window.__board.store.col.obj.get(id).x, pos.id);
  console.log('   x был', pos.x, 'стал у мастера', gx);
  if (gx === pos.x) throw new Error('токен не сдвинулся');
  await pl.page.screenshot({ path: `${SHOTS}/board-player-moved.png` });
});

await step('стена не пускает игрока', async () => {
  const res = await pl.page.evaluate((heroId) => {
    const b = window.__board;
    const hero = [...b.store.col.obj.values()].find((o) => o.represents === heroId);
    return { from: b.worldToScreen(hero.x + hero.w / 2, hero.y + hero.h / 2), to: b.worldToScreen(hero.x + hero.w / 2, 60), id: hero.id, y: hero.y };
  }, heroId);
  const box = await pl.page.locator('.board').boundingBox();
  await pl.page.mouse.move(box.x + res.from.x, box.y + res.from.y);
  await pl.page.mouse.down();
  await pl.page.mouse.move(box.x + res.to.x, box.y + res.to.y, { steps: 8 });
  await pl.page.mouse.up();
  await pl.page.waitForTimeout(500);
  const y = await gm.page.evaluate((id) => window.__board.store.col.obj.get(id).y, res.id);
  console.log('   y был', res.y, 'стал', y);
  if (y < 140) throw new Error('прошёл сквозь стену');
});

await step('бар HP связан с анкетой', async () => {
  const bars = await gm.page.evaluate((heroId) => {
    const hero = [...window.__board.store.col.obj.values()].find((o) => o.represents === heroId);
    return hero.bars;
  }, heroId);
  console.log('   бары героя:', JSON.stringify(bars.map((b) => [b.name, b.value, b.max, b.link])));
  // мастер связывает бар с атрибутом hp (как в настройках токена)
  await gm.page.evaluate(async (heroId) => {
    const b = window.__board;
    const hero = [...b.store.col.obj.values()].find((o) => o.represents === heroId);
    await b.net.update('obj', hero.id, { bars: hero.bars.map((x) => ({ ...x, link: 'hp' })) });
  }, heroId);
  // меняем атрибут — бар должен обновиться у игрока
  await gm.page.evaluate(async (heroId) => {
    await window.__board.net.request('attrs:set', { charId: heroId, set: [{ name: 'hp', current: 12 }] });
  }, heroId);
  await pl.page.waitForTimeout(500);
  const v = await pl.page.evaluate((heroId) => [...window.__board.store.col.obj.values()].find((o) => o.represents === heroId).bars[0].value, heroId);
  if (String(v) !== '12') throw new Error('бар не обновился: ' + v);
});

console.log('ошибки:', errors.length ? '\n' + errors.slice(0, 30).join('\n') : 'нет');
await browser.close();
