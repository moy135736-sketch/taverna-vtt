// e2e: правки по замечаниям тестера — экран не «съезжает», панель инструментов прокручивается,
// библиотека картинок только у мастера, рамкой выделяются источники света, загрузки без квоты
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

async function newUser(name, viewport = { width: 1400, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
  await page.goto(BASE);
  const api = (p, body) =>
    page.evaluate(
      async ([p, body]) => {
        const r = await fetch(p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Taverna': '1' }, body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, ...(await r.json().catch(() => ({}))) };
      },
      [p, body],
    );
  await api('/api/auth/register', { username: 'fx' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), password: 'secret123', displayName: name });
  return { page, api, ctx };
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
const png = fs.readFileSync(new URL('./assets/map.png', import.meta.url)).toString('base64');
const upload = (page, gameId) =>
  page.evaluate(
    async ([b64, gameId]) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const fd = new FormData();
      fd.append('files', new Blob([bin], { type: 'image/png' }), 'секретная-карта.png');
      fd.append('gameId', gameId);
      const r = await fetch('/api/assets', { method: 'POST', headers: { 'X-Taverna': '1' }, body: fd });
      return r.json();
    },
    [png, gameId],
  );

// низкое окно, как при большом масштабе страницы
const gm = await newUser('Мастер', { width: 1100, height: 430 });
const game = (await gm.api('/api/games', { name: 'Правки тестера' })).game;
await gm.page.goto(`${BASE}/game/${game.id}`);
await gm.page.waitForSelector('.board');

await step('переключатель внизу настроек не сдвигает экран', async () => {
  await gm.page.locator('.side-tabs [role=tab]').last().click(); // «Настройки»
  // до исправления щелчок по переключателю ниже середины панели прокручивал весь стол (.game) вверх
  const n = await gm.page.locator('.settings-panel .toggle').count();
  for (const i of [n - 1, Math.max(0, n - 3)]) {
    const t = gm.page.locator('.settings-panel .toggle').nth(i);
    await t.scrollIntoViewIfNeeded();
    await t.click();
    await gm.page.waitForTimeout(250);
    const moved = await gm.page.evaluate(() => [...document.querySelectorAll('*')].filter((e) => e.scrollTop > 0 && !e.classList.contains('panel-scroll')).map((e) => e.className + '=' + e.scrollTop));
    if (moved.length) throw new Error('экран сдвинулся: ' + moved.join(', '));
    await t.click();
  }
});

await step('панель инструментов прокручивается, нижние кнопки достижимы', async () => {
  const r = await gm.page.evaluate(() => {
    const el = document.querySelector('.g-tools-scroll');
    return { sh: el.scrollHeight, ch: el.clientHeight, ov: getComputedStyle(el).overflowY };
  });
  if (!(r.sh > r.ch) || r.ov !== 'auto') throw new Error('не прокручивается: ' + JSON.stringify(r));
  const last = gm.page.locator('.g-tools-scroll .layer-btn').last();
  await last.scrollIntoViewIfNeeded();
  await last.click();
  const layer = await gm.page.evaluate(() => window.__board.store.ui.layer);
  if (layer !== 'walls') throw new Error('последняя кнопка не нажалась: слой ' + layer);
  await gm.page.screenshot({ path: `${SHOTS}/fixes-toolbar.png` });
});

await step('рамка на слое стен выделяет и стены, и источники света; Delete удаляет всё', async () => {
  await gm.page.setViewportSize({ width: 1400, height: 900 });
  const ids = await gm.page.evaluate(async () => {
    const { net, store } = window.__board;
    const pageId = store.ui.pageId;
    const mk = (x) => net.create('obj', { type: 'image', src: '', pageId, layer: 'walls', x, y: 70, w: 35, h: 35, name: 'Источник света', light: { enabled: true, bright: 20, dim: 20 } });
    const a = await mk(70);
    const b = await mk(210);
    const w = await net.create('obj', { type: 'wall', wallType: 'wall', pageId, layer: 'walls', pts: [70, 210, 280, 210] });
    return [a.id, b.id, w.id];
  });
  await gm.page.evaluate(() => {
    const b = window.__board;
    b.store.setTool('select');
    b.store.setLayer('walls');
  });
  const box = await gm.page.locator('.board').boundingBox();
  const p = await gm.page.evaluate(() => {
    const b = window.__board;
    return { a: b.worldToScreen(20, 20), c: b.worldToScreen(320, 260) };
  });
  await gm.page.mouse.move(box.x + p.a.x, box.y + p.a.y);
  await gm.page.mouse.down();
  await gm.page.mouse.move(box.x + p.c.x, box.y + p.c.y, { steps: 8 });
  await gm.page.mouse.up();
  const sel = await gm.page.evaluate(() => [...window.__board.store.ui.selected]);
  for (const id of ids) if (!sel.includes(id)) throw new Error('не выделено: ' + id + ' из ' + sel);
  await gm.page.locator('.board').focus().catch(() => {});
  await gm.page.keyboard.press('Delete');
  await gm.page.waitForTimeout(500);
  const left = await gm.page.evaluate((ids) => ids.filter((id) => window.__board.store.col.obj.has(id)), ids);
  if (left.length) throw new Error('не удалились: ' + left);
});

let pl;
await step('игроку не видна библиотека картинок мастера (ни вкладка, ни список файлов)', async () => {
  const up = await upload(gm.page, game.id);
  if (!up.assets?.length) throw new Error('загрузка мастера: ' + JSON.stringify(up));
  pl = await newUser('Игрок');
  await pl.api('/api/games/join', { code: game.inviteCode });
  await pl.page.goto(`${BASE}/game/${game.id}`);
  await pl.page.waitForSelector('.board');
  if (await pl.page.getByRole('tab', { name: 'Библиотека картинок' }).count()) throw new Error('вкладка видна игроку');
  if (!(await gm.page.getByRole('tab', { name: 'Библиотека картинок' }).count())) throw new Error('у мастера нет вкладки');
  const list = await pl.api(`/api/assets?gameId=${game.id}`);
  if (list.assets.some((a) => a.name === 'секретная-карта')) throw new Error('игрок получил файлы мастера');
  const gmList = await gm.api(`/api/assets?gameId=${game.id}`);
  if (!gmList.assets.some((a) => a.name === 'секретная-карта')) throw new Error('мастер не видит свой файл');
});

await step('без квоты на пользователя: сервер сообщает «без ограничения»', async () => {
  const r = await gm.api(`/api/assets?gameId=${game.id}`);
  if (r.quota !== 0) throw new Error('quota = ' + r.quota);
});

console.log('ошибки:', errors.length ? '\n' + errors.join('\n') : 'нет');
await browser.close();
if (failures.length) process.exit(1);
