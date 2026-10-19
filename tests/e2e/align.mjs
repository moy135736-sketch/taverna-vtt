// e2e: подгонка карты под сетку сцены (клетки карты 50 px со сдвигом 13 px → клетки сцены 70 px)
import { chromium } from 'playwright-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3000';
const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets');
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(BASE);
const api = (p, b) => page.evaluate(async ([p, b]) => (await fetch(p, { method: b ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Taverna': '1' }, body: b ? JSON.stringify(b) : undefined })).json(), [p, b]);
const l = await api('/api/auth/login', { username: 'tester', password: 'secret123' });
if (!l.user) await api('/api/auth/register', { username: 'tester', password: 'secret123', displayName: 'Тестер' });
const game = (await api('/api/games', { name: 'Подгонка карты' })).game;
await page.goto(`${BASE}/game/${game.id}`);
await page.waitForSelector('.board-world', { state: 'attached' });
await page.waitForTimeout(500);

// загружаем карту и ставим её 1:1 в (0,0)
await page.evaluate(() => {
  const i = document.createElement('input');
  i.type = 'file';
  i.id = 'tmpfile';
  document.body.appendChild(i);
});
await page.setInputFiles('#tmpfile', path.join(ASSETS, 'gridmap.png'));
const id = await page.evaluate(async (gameId) => {
  const fd = new FormData();
  fd.append('files', document.getElementById('tmpfile').files[0]);
  fd.append('gameId', gameId);
  const a = (await (await fetch('/api/assets', { method: 'POST', headers: { 'X-Taverna': '1' }, body: fd })).json()).assets[0];
  const b = window.__board;
  b.store.setLayer('map');
  const o = b.createObj({ type: 'image', src: a.url, x: 0, y: 0, w: 520, h: 420, layer: 'map' });
  return o.id;
}, game.id);
await page.waitForTimeout(500);

// обводим 3×3 клетки карты: от (13,13) до (163,163) в мировых координатах
await page.evaluate((id) => window.__board.startGridAlign(id), id);
const box = await page.locator('.board').boundingBox();
const p = (x, y) => page.evaluate(([x, y]) => window.__board.worldToScreen(x, y), [x, y]);
const a = await p(63, 63),
  b = await p(213, 213);
await page.mouse.move(box.x + a.x, box.y + a.y);
await page.mouse.down();
await page.mouse.move(box.x + b.x, box.y + b.y, { steps: 6 });
await page.mouse.up();
const dlg = page.locator('.modal', { hasText: 'Подогнать карту под сетку' });
await dlg.waitFor();
await dlg.locator('input').fill('3');
await dlg.locator('input').press('Enter');
await page.waitForTimeout(600);
const o = await page.evaluate((id) => window.__board.store.col.obj.get(id), id);
const cell = 50 * (o.w / 520);
const lineX = (o.x + 63 * (o.w / 520)) % 70;
console.log('карта:', JSON.stringify({ x: o.x, y: o.y, w: o.w, h: o.h }), 'клетка карты теперь', cell.toFixed(2), 'px, линия сетки по x mod 70 =', lineX.toFixed(2));
const ok = Math.abs(cell - 70) < 0.01 && (Math.abs(lineX) < 0.01 || Math.abs(lineX - 70) < 0.01);
console.log(ok ? '✓ сетка карты совпала с сеткой сцены' : '✗ не совпало', errs.length ? errs : '');
await browser.close();
process.exit(ok ? 0 : 1);
