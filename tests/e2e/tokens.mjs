// e2e: токены — сцепка (пассажир едет с транспортом, отцепляется, если взять его самого), макросы токена,
// «Отдать игроку» из меню, своё положение баров у токена
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

async function newUser(name) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
  await page.goto(BASE);
  const api = (p, body) =>
    page.evaluate(
      async ([p, body]) => (await fetch(p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Taverna': '1' }, body: body ? JSON.stringify(body) : undefined })).json(),
      [p, body],
    );
  const r = await api('/api/auth/register', { username: 'tk' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), password: 'secret123', displayName: name });
  return { page, api, user: r.user };
}
async function step(name, fn) {
  try {
    await fn();
    console.log('✓', name);
  } catch (e) {
    console.log('✗', name, '—', e.message.split('\n')[0]);
    failures.push(name);
  }
}
const obj = (page, id) => page.evaluate((id) => window.__board.store.col.obj.get(id) || null, id);
async function waitObj(page, id, test, what, timeout = 5000) {
  try {
    await page.waitForFunction(([id, src]) => new Function('o', 'return ' + src)(window.__board.store.col.obj.get(id)), [id, test], { timeout });
  } catch {
    throw new Error(`${what}: ${JSON.stringify(await obj(page, id))}`);
  }
}
/** Экранная точка объекта (по умолчанию центр; fx, fy — доли ширины и высоты); проверяем, что там именно он */
async function center(page, id, fx = 0.5, fy = 0.5) {
  const box = await page.locator('.board').boundingBox();
  const p = await page.evaluate(
    ([id, fx, fy]) => {
      const b = window.__board;
      const o = b.store.col.obj.get(id);
      return b.worldToScreen(o.x + o.w * fx, o.y + o.h * fy);
    },
    [id, fx, fy],
  );
  const at = { x: box.x + p.x, y: box.y + p.y };
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-oid]')?.dataset.oid, [at.x, at.y]);
  if (hit !== id) throw new Error(`в точке ${Math.round(at.x)},${Math.round(at.y)} не тот объект: ${hit}`);
  return at;
}
/** Перетащить объект мышью на dx, dy в координатах карты (с учётом масштаба камеры) */
async function drag(page, id, wdx, wdy, fx, fy) {
  const c = await center(page, id, fx, fy);
  const z = await page.evaluate(() => window.__board.cam.z);
  const dx = wdx * z,
    dy = wdy * z;
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + dx / 2, c.y + dy / 2, { steps: 6 });
  await page.mouse.move(c.x + dx, c.y + dy, { steps: 6 });
  await page.mouse.up();
}
// пункт меню верхнего уровня и пункт открытого подменю (подменю вложено в пункт — искать раздельно)
const menu = (page, re) => page.locator('.ctx-menu > .ctx-item', { hasText: re }).first().click();
const sub = (page, re) => page.locator('.ctx-sub .ctx-item', { hasText: re }).first().click();

const gm = await newUser('Мастер');
const pl = await newUser('Игрок');
const game = (await gm.api('/api/games', { name: 'Токены' })).game;
await pl.api('/api/games/join', { code: game.inviteCode });
await gm.page.goto(`${BASE}/game/${game.id}`);
await pl.page.goto(`${BASE}/game/${game.id}`);
await gm.page.waitForSelector('.board');
await pl.page.waitForSelector('.board');
await gm.page.evaluate(() => window.__board.store.setTool('select'));

const ids = await gm.page.evaluate(async (plId) => {
  const { net, store } = window.__board;
  const pageId = store.ui.pageId;
  const mk = (d) => net.create('obj', { pageId, layer: 'objects', ...d });
  // повозка 3×1 клетки, пассажир — на её правом краю (за левый край повозку можно взять)
  const car = await mk({ type: 'shape', shape: 'rect', fill: '#9b2d20', x: 560, y: 280, w: 210, h: 70, name: 'Повозка' });
  const p = await mk({ type: 'shape', shape: 'ellipse', fill: '#2d4e9b', x: 700, y: 280, w: 70, h: 70, name: 'Пассажир', controlledBy: [plId] });
  const t = await mk({ type: 'shape', shape: 'ellipse', fill: '#2d9b4e', x: 420, y: 560, w: 70, h: 70, name: 'Страж', bars: [{ id: 'b1', name: 'HP', value: '9', max: '12', color: '#d63a3a', link: '', visibility: 'all', editable: 'owners', showText: 'always' }] });
  const t2 = await mk({ type: 'shape', shape: 'ellipse', fill: '#9b9b2d', x: 630, y: 560, w: 70, h: 70, name: 'Другой', bars: [{ id: 'b1', name: 'HP', value: '5', max: '5', color: '#d63a3a', link: '', visibility: 'all', editable: 'owners', showText: 'always' }] });
  return { car: car.id, p: p.id, t: t.id, t2: t2.id };
}, pl.user.id);
await pl.page.waitForFunction((id) => window.__board.store.col.obj.has(id), ids.p);

await step('«Сцепка → Прицепить к токену…»: пассажир едет на повозке', async () => {
  const c = await center(gm.page, ids.p);
  await gm.page.mouse.click(c.x, c.y, { button: 'right' });
  await menu(gm.page, 'Сцепка');
  await sub(gm.page, 'Прицепить к токену');
  await gm.page.locator('.board-banner, .targeting').first().waitFor({ timeout: 3000 }).catch(() => {});
  const cc = await center(gm.page, ids.car, 0.15);
  await gm.page.mouse.click(cc.x, cc.y);
  await waitObj(gm.page, ids.p, `o.attachedTo === '${ids.car}'`, 'не прицепился');
  await waitObj(pl.page, ids.p, `o.attachedTo === '${ids.car}'`, 'у игрока не видно сцепки');
});

await step('повозку тянут — пассажир едет следом и у мастера, и у игрока', async () => {
  await gm.page.evaluate((id) => window.__board.store.setSelection([id]), ids.car);
  await drag(gm.page, ids.car, 140, 70, 0.15);
  await waitObj(gm.page, ids.car, 'o.x === 700 && o.y === 350', 'повозка не на месте');
  await waitObj(gm.page, ids.p, 'o.x === 840 && o.y === 350', 'пассажир у мастера');
  await waitObj(pl.page, ids.p, 'o.x === 840 && o.y === 350', 'пассажир у игрока');
  await gm.page.evaluate((ids) => window.__board.store.setSelection([ids.car]), ids);
  await gm.page.screenshot({ path: `${SHOTS}/tokens-attach.png` });
});

await step('повозка повернулась на 90° — пассажир обошёл её центр и повернулся', async () => {
  await gm.page.evaluate((id) => window.__board.net.update('obj', id, { rot: 90 }), ids.car);
  // центр повозки (805, 385), центр пассажира (875, 385) → после поворота по часовой (805, 455)
  await waitObj(pl.page, ids.p, 'Math.abs(o.x - 770) < 0.1 && Math.abs(o.y - 420) < 0.1 && o.rot === 90', 'после поворота');
  await gm.page.evaluate((id) => window.__board.net.update('obj', id, { rot: 0 }), ids.car);
  await waitObj(gm.page, ids.p, 'o.x === 840 && o.y === 350 && o.rot === 0', 'поворот назад');
});

await step('по кругу сцепить нельзя', async () => {
  const r = await gm.page.evaluate((ids) => window.__board.net.update('obj', ids.car, { attachedTo: ids.p }), ids);
  if (!/по кругу/.test(r?.error || '')) throw new Error('ответ: ' + JSON.stringify(r));
  await waitObj(gm.page, ids.car, "!o.attachedTo", 'повозка осталась прицепленной');
});

await step('копия повозки с пассажиром — у копий своя сцепка', async () => {
  await gm.page.evaluate((ids) => window.__board.store.setSelection([ids.car, ids.p]), ids);
  await gm.page.locator('.board').focus();
  await gm.page.keyboard.press('Control+d');
  await gm.page.waitForFunction(() => window.__board.store.ui.selected.size === 2 && [...window.__board.store.ui.selected].every((id) => window.__board.store.col.obj.has(id)));
  const [nc, np] = await gm.page.evaluate((ids) => {
    const s = window.__board.store;
    const sel = [...s.ui.selected].map((id) => s.col.obj.get(id));
    return [sel.find((o) => o.name === 'Повозка')?.id, sel.find((o) => o.name === 'Пассажир')?.id];
  }, ids);
  if (!nc || !np || nc === ids.car || np === ids.p) throw new Error('копии не выделены');
  await waitObj(gm.page, np, `o.attachedTo === '${nc}'`, 'копия пассажира не на копии повозки');
  // удалили копию повозки — копия пассажира осталась, отцепленной
  await gm.page.evaluate((id) => window.__board.net.remove('obj', id), nc);
  await waitObj(gm.page, np, "!o.attachedTo", 'копия пассажира осталась прицепленной');
  await gm.page.evaluate((id) => window.__board.net.remove('obj', id), np);
});

await step('игрок сам двигает пассажира — тот отцепляется и дальше не едет', async () => {
  await pl.page.evaluate(() => window.__board.store.setTool('select'));
  await drag(pl.page, ids.p, 0, 140);
  await waitObj(pl.page, ids.p, "!o.attachedTo && o.y === 490", 'не отцепился');
  await waitObj(gm.page, ids.p, "!o.attachedTo", 'у мастера не отцепился');
  await gm.page.evaluate((id) => window.__board.net.update('obj', id, { x: 630 }), ids.car);
  await gm.page.waitForTimeout(400);
  const p = await obj(pl.page, ids.p);
  if (p.x !== 840) throw new Error('отцепленный пассажир поехал: x=' + p.x);
});

await step('макросы токена: вкладка «Макросы», кнопка внизу стола, бросок в чат', async () => {
  const c = await center(gm.page, ids.t);
  await gm.page.mouse.click(c.x, c.y, { button: 'right' });
  await menu(gm.page, 'Макросы токена');
  await gm.page.getByRole('button', { name: 'Новый макрос' }).click();
  const name = gm.page.locator('.tok-action input').first();
  await name.fill('Удар алебардой');
  await name.press('Enter');
  const area = gm.page.locator('.tok-action textarea').first();
  await area.fill('/em бьёт алебардой: [[1d20+4]]');
  await gm.page.locator('.tok-action input').first().click(); // уход фокуса сохраняет текст
  await waitObj(gm.page, ids.t, "o.actions?.length === 1 && o.actions[0].action.includes('алебардой') && o.actions[0].name === 'Удар алебардой'", 'макрос не сохранился');
  await gm.page.locator('.fwin .icon-btn[title="Закрыть"]').first().click();
  await gm.page.evaluate((id) => window.__board.store.setSelection([id]), ids.t);
  const btn = gm.page.locator('.token-actions .mbtn.own', { hasText: 'Удар алебардой' });
  await btn.waitFor({ timeout: 3000 });
  await gm.page.getByRole('tab', { name: 'Чат' }).click();
  const before = await gm.page.locator('.textchatcontainer .message').count();
  await btn.click();
  await gm.page.waitForFunction((n) => document.querySelectorAll('.textchatcontainer .message').length > n, before, { timeout: 5000 });
  const last = await gm.page.locator('.textchatcontainer .message').last().textContent();
  if (!/бьёт алебардой/.test(last)) throw new Error('в чате: ' + last);
  await gm.page.screenshot({ path: `${SHOTS}/tokens-actions.png` });
  // игрок, который токеном не управляет, макросов не получает вовсе
  const pa = await pl.page.evaluate((id) => window.__board.store.col.obj.get(id)?.actions, ids.t);
  if (pa !== undefined) throw new Error('игроку пришли макросы чужого токена');
});

await step('макрос из коллекции перетащили на токен — стал его кнопкой', async () => {
  const mid = await gm.page.evaluate(async () => (await window.__board.net.create('macro', { name: 'Осмотреться', action: '/em осматривается', visibleTo: [] })).id);
  await gm.page.waitForTimeout(200);
  const c = await center(gm.page, ids.t);
  await gm.page.evaluate(
    ([mid, x, y]) => {
      const el = document.elementFromPoint(x, y);
      const dt = new DataTransfer();
      dt.setData('application/x-taverna', JSON.stringify({ kind: 'macro', id: mid }));
      el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
    },
    [mid, c.x, c.y],
  );
  await waitObj(gm.page, ids.t, "o.actions?.some((a) => a.action === '#Осмотреться')", 'макрос не добавился');
  await gm.page.locator('.token-actions .mbtn.own', { hasText: 'Осмотреться' }).waitFor({ timeout: 3000 });
});

await step('«Отдать игроку»: игрок двигает токен и видит его макросы', async () => {
  const c = await center(gm.page, ids.t);
  await gm.page.mouse.click(c.x, c.y, { button: 'right' });
  await menu(gm.page, 'Отдать игроку');
  await gm.page.locator('.ctx-sub .ctx-item', { hasText: /^Игрок/ }).first().click();
  await waitObj(gm.page, ids.t, `(o.controlledBy || []).includes('${pl.user.id}')`, 'не отдан');
  await waitObj(pl.page, ids.t, 'o.actions?.length === 2', 'игрок не получил макросы своего токена');
  await pl.page.evaluate((id) => window.__board.store.setSelection([id]), ids.t);
  await pl.page.locator('.token-actions .mbtn.own', { hasText: 'Удар алебардой' }).waitFor({ timeout: 3000 });
  await drag(pl.page, ids.t, 70, 0);
  await waitObj(gm.page, ids.t, 'o.x === 490', 'игрок не смог подвинуть отданный токен');
  // в меню у мастера отмечен этот игрок
  const c2 = await center(gm.page, ids.t);
  await gm.page.mouse.click(c2.x, c2.y, { button: 'right' });
  await menu(gm.page, 'Отдать игроку');
  const checked = await gm.page.locator('.ctx-sub .ctx-item.checked').allTextContents();
  await gm.page.keyboard.press('Escape');
  if (!checked.some((t) => /^Игрок/.test(t))) throw new Error('в меню не отмечен: ' + checked);
});

await step('положение баров — своё у токена', async () => {
  const c = await center(gm.page, ids.t2);
  await gm.page.mouse.click(c.x, c.y, { button: 'right' });
  await menu(gm.page, 'Положение баров');
  await sub(gm.page, 'Под токеном');
  await waitObj(gm.page, ids.t2, "o.barPosition === 'below'", 'не сохранилось');
  const cls = await gm.page.evaluate((ids) => [ids.t2, ids.t].map((id) => document.querySelector(`.obj[data-oid="${id}"] .tok-ui`)?.className), ids);
  if (!/bars-below/.test(cls[0]) || !/bars-top/.test(cls[1])) throw new Error('классы: ' + cls);
  const pc = await pl.page.evaluate((id) => document.querySelector(`.obj[data-oid="${id}"] .tok-ui`)?.className, ids.t2);
  if (!/bars-below/.test(pc)) throw new Error('у игрока: ' + pc);
  await gm.page.screenshot({ path: `${SHOTS}/tokens-bars.png` });
});

console.log('ошибки:', errors.length ? '\n' + errors.join('\n') : 'нет');
await browser.close();
if (failures.length || errors.length) process.exit(1);
