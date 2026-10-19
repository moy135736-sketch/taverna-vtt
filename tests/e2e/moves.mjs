// e2e: способы перемещения токена — сразу (видно, как тянут), плавно, по клеткам, телепорт и сквозь огонь.
// С анимацией токен тянут призраком, а после отпускания он идёт — у всех, и у того, кто тянул;
// путь с поворотами (пробел) анимация повторяет; Esc во время перетаскивания возвращает токен
import { chromium } from 'playwright-core';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:3000';
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'taverna-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const errors = [];
const failures = [];

async function newUser(name, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 860 }, ...opts });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
  await page.goto(BASE);
  const api = (p, body) =>
    page.evaluate(
      async ([p, body]) => (await fetch(p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Taverna': '1' }, body: body ? JSON.stringify(body) : undefined })).json(),
      [p, body],
    );
  const r = await api('/api/auth/register', { username: 'mv' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), password: 'secret123', displayName: name });
  return { page, api, user: r.user };
}
async function step(name, fn) {
  try {
    await fn();
    console.log('✓', name);
  } catch (e) {
    console.log('✗', name, '—', e.message.split('\n')[0]);
    failures.push(name);
    await gm?.page.screenshot({ path: `${SHOTS}/moves-fail-${failures.length}.png` }).catch(() => {});
  }
}
const pos = (page, id) => page.evaluate((id) => {
  const o = window.__board.store.col.obj.get(id);
  return o ? { x: o.x, y: o.y } : null;
}, id);
/** Анимации токена у этого зрителя: число кадров и есть ли прозрачность */
const anims = (page, id) =>
  page.evaluate((id) => {
    const el = document.querySelector(`.obj[data-oid="${id}"]`);
    // только анимации перемещения (свои CSS-переходы элемента не считаем)
    return (el?.getAnimations() || []).filter((a) => !(a instanceof CSSTransition) && !(a instanceof CSSAnimation)).map((a) => {
      const k = a.effect.getKeyframes();
      return { frames: k.length, fades: k.some((f) => f.opacity === '0' || f.opacity === 0), dur: a.effect.getTiming().duration };
    });
  }, id);
async function center(page, id) {
  const box = await page.locator('.board').boundingBox();
  const p = await page.evaluate((id) => {
    const b = window.__board;
    const o = b.store.col.obj.get(id);
    return b.worldToScreen(o.x + o.w / 2, o.y + o.h / 2);
  }, id);
  return { x: box.x + p.x, y: box.y + p.y };
}
/** Начать тянуть токен на wdx, wdy клеток карты; возвращает функцию «отпустить» */
async function startDrag(page, id, wdx, wdy) {
  const c = await center(page, id);
  const z = await page.evaluate(() => window.__board.cam.z);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + (wdx * z) / 2, c.y + (wdy * z) / 2, { steps: 5 });
  await page.mouse.move(c.x + wdx * z, c.y + wdy * z, { steps: 5 });
  return () => page.mouse.up();
}

let gm, pl;
gm = await newUser('Мастер');
pl = await newUser('Игрок');
const game = (await gm.api('/api/games', { name: 'Перемещение' })).game;
await pl.api('/api/games/join', { code: game.inviteCode });
for (const u of [gm, pl]) {
  await u.page.goto(`${BASE}/game/${game.id}`);
  await u.page.waitForSelector('.board');
}
await gm.page.evaluate(() => window.__board.store.setTool('select'));
const CS = 70;
const tok = await gm.page.evaluate(async (CS) => {
  const { net, store } = window.__board;
  const pageId = store.ui.pageId;
  const t = await net.create('obj', { type: 'shape', shape: 'ellipse', fill: '#b23a48', pageId, layer: 'objects', x: 5 * CS, y: 4 * CS, w: CS, h: CS, name: 'Маг', auras: [{ radius: 5, color: '#9a5cff', opacity: 0.25 }] });
  return t.id;
}, CS);
await pl.page.waitForFunction((id) => window.__board.store.col.obj.has(id), tok);

await step('по умолчанию «сразу»: игрок видит, как токен тянут, без анимаций', async () => {
  const up = await startDrag(gm.page, tok, 2 * CS, 0);
  await pl.page.waitForFunction(([id, x0]) => window.__board.store.col.obj.get(id).x > x0, [tok, 5 * CS], { timeout: 3000 }).catch(() => {
    throw new Error('промежуточные положения не дошли');
  });
  await up();
  await pl.page.waitForFunction((id) => window.__board.store.col.obj.get(id).x === 7 * 70, tok, { timeout: 3000 });
  const a = await anims(pl.page, tok);
  if (a.length) throw new Error('лишняя анимация: ' + JSON.stringify(a));
});

await step('«Телепорт» из меню: тянут призрак, токен ждёт; после — исчез и появился у всех', async () => {
  const c = await center(gm.page, tok);
  await gm.page.mouse.click(c.x, c.y, { button: 'right' });
  await gm.page.locator('.ctx-menu > .ctx-item', { hasText: 'Перемещение' }).click();
  await gm.page.locator('.ctx-sub .ctx-item', { hasText: 'Телепорт' }).click();
  await pl.page.waitForFunction((id) => window.__board.store.col.obj.get(id).moveStyle === 'teleport', tok, { timeout: 3000 });
  const up = await startDrag(gm.page, tok, 3 * CS, 2 * CS);
  await gm.page.waitForTimeout(500);
  const mid = await pos(pl.page, tok);
  if (mid.x !== 7 * CS || mid.y !== 4 * CS) throw new Error('игрок видел путь: ' + JSON.stringify(mid));
  // у мастера токен стоит, под курсором — призрак
  const own = await pos(gm.page, tok);
  if (own.x !== 7 * CS || own.y !== 4 * CS) throw new Error('у мастера токен уехал до отпускания: ' + JSON.stringify(own));
  const ghost = await gm.page.evaluate(() => {
    const g = document.querySelector('.obj.move-ghost');
    return g ? g.style.transform : null;
  });
  if (!ghost || !ghost.includes(`${10 * CS}px`)) throw new Error('нет призрака под курсором: ' + ghost);
  await gm.page.screenshot({ path: `${SHOTS}/moves-ghost.png` });
  await up();
  await pl.page.waitForFunction((id) => window.__board.store.col.obj.get(id).x === 10 * 70, tok, { timeout: 3000 });
  const a = await anims(pl.page, tok);
  if (!a.some((x) => x.fades)) throw new Error('нет исчезновения: ' + JSON.stringify(a));
  // и сам мастер видит, как токен перенёсся
  const mine = await anims(gm.page, tok);
  if (!mine.some((x) => x.fades)) throw new Error('у перетаскивавшего нет анимации: ' + JSON.stringify(mine));
  await pl.page.waitForTimeout(350);
  await pl.page.screenshot({ path: `${SHOTS}/moves-teleport.png` });
  await gm.page.waitForFunction(() => !document.querySelector('.obj.move-ghost'), null, { timeout: 2000 }).catch(() => {
    throw new Error('призрак не исчез');
  });
});

await step('«Плавно» с поворотом (пробел): токен идёт по пути, а не напрямик', async () => {
  await gm.page.evaluate((id) => window.__board.net.update('obj', id, { moveStyle: 'smooth' }), tok);
  await gm.page.waitForTimeout(1000);
  const c = await center(gm.page, tok);
  const z = await gm.page.evaluate(() => window.__board.cam.z);
  await gm.page.mouse.move(c.x, c.y);
  await gm.page.mouse.down();
  await gm.page.mouse.move(c.x - 2 * CS * z, c.y, { steps: 8 });
  await gm.page.keyboard.press('Space');
  await gm.page.mouse.move(c.x - 2 * CS * z, c.y + 2 * CS * z, { steps: 8 });
  await gm.page.mouse.up();
  await pl.page.waitForFunction((id) => window.__board.store.col.obj.get(id).y === 8 * 70, tok, { timeout: 3000 });
  for (const [who, u] of [['игрок', pl], ['мастер', gm]]) {
    const a = await anims(u.page, tok);
    if (!a.length || a[0].fades || a[0].frames !== 3) throw new Error(`${who}: анимация не по пути: ` + JSON.stringify(a));
  }
  await gm.page.waitForTimeout(1500);
});

await step('«Плавно» — стрелкой: токен едет у игрока и у мастера', async () => {
  await gm.page.evaluate((id) => window.__board.store.setSelection([id]), tok);
  await gm.page.locator('.board').focus();
  await gm.page.keyboard.press('ArrowLeft');
  await pl.page.waitForFunction((id) => window.__board.store.col.obj.get(id).x === 7 * 70, tok, { timeout: 3000 });
  for (const u of [pl, gm]) {
    const a = await anims(u.page, tok);
    if (!a.length || a[0].fades || a[0].frames !== 2) throw new Error('анимация: ' + JSON.stringify(a));
  }
});

await step('«По клеткам» — шагами с подскоком', async () => {
  await gm.page.evaluate((id) => window.__board.net.update('obj', id, { moveStyle: 'steps' }), tok);
  await gm.page.evaluate((id) => window.__board.net.update('obj', id, { x: 5 * 70, y: 4 * 70 }), tok);
  await pl.page.waitForFunction((id) => window.__board.store.col.obj.get(id).x === 5 * 70, tok, { timeout: 3000 });
  const a = await anims(pl.page, tok);
  // 4 клетки по горизонтали: по два кадра на шаг и последний
  if (!a.length || a[0].frames !== 9) throw new Error('анимация: ' + JSON.stringify(a));
  await pl.page.waitForTimeout(300);
  await pl.page.screenshot({ path: `${SHOTS}/moves-steps.png` });
});

await step('«Сквозь огонь» — сгорает и появляется, аура едет вместе', async () => {
  await gm.page.evaluate((id) => window.__board.net.update('obj', id, { moveStyle: 'fire' }), tok);
  await gm.page.evaluate((id) => window.__board.net.update('obj', id, { x: 9 * 70, y: 7 * 70 }), tok);
  await pl.page.waitForFunction((id) => window.__board.store.col.obj.get(id).y === 7 * 70, tok, { timeout: 3000 });
  const a = await anims(pl.page, tok);
  if (!a.some((x) => x.fades && x.dur >= 1000)) throw new Error('анимация: ' + JSON.stringify(a));
  const aura = await pl.page.evaluate(() => [...document.querySelectorAll('.aura-group')].some((g) => g.getAnimations().length > 0));
  if (!aura) throw new Error('аура не едет вместе с токеном');
  await pl.page.waitForTimeout(500);
  await pl.page.screenshot({ path: `${SHOTS}/moves-fire.png` });
});

await step('Esc во время перетаскивания — токен вернулся, игрок ничего не заметил', async () => {
  await gm.page.waitForTimeout(1600);
  const up = await startDrag(gm.page, tok, -3 * CS, 0);
  await gm.page.keyboard.press('Escape');
  await up();
  await gm.page.waitForTimeout(400);
  const g = await pos(gm.page, tok);
  const p = await pos(pl.page, tok);
  if (g.x !== 9 * CS || p.x !== 9 * CS) throw new Error(`мастер ${g.x}, игрок ${p.x}`);
});

await step('если в системе «уменьшить движение» — без анимаций', async () => {
  const calm = await newUser('Спокойный', { reducedMotion: 'reduce' });
  await calm.api('/api/games/join', { code: game.inviteCode });
  await calm.page.goto(`${BASE}/game/${game.id}`);
  await calm.page.waitForSelector('.board');
  await calm.page.waitForFunction((id) => window.__board.store.col.obj.has(id), tok);
  await gm.page.evaluate((id) => window.__board.net.update('obj', id, { x: 6 * 70 }), tok);
  await calm.page.waitForFunction((id) => window.__board.store.col.obj.get(id).x === 6 * 70, tok, { timeout: 3000 });
  const a = await anims(calm.page, tok);
  if (a.length) throw new Error('анимация при «уменьшить движение»: ' + JSON.stringify(a));
});

console.log('ошибки:', errors.length ? '\n' + errors.join('\n') : 'нет');
await browser.close();
if (failures.length || errors.length) process.exit(1);
