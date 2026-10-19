// e2e: шаблоны областей линейки (круг, конус, куб, луч) и сохранение их на карте
import { chromium } from 'playwright-core';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const BASE = process.env.BASE || 'http://localhost:3000';
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'taverna-shots');
import fs from 'node:fs';
fs.mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(BASE);
const api = (p, b) => page.evaluate(async ([p, b]) => (await fetch(p, { method: b ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Taverna': '1' }, body: b ? JSON.stringify(b) : undefined })).json(), [p, b]);
let l = await api('/api/auth/login', { username: 'tester', password: 'secret123' });
if (!l.user) await api('/api/auth/register', { username: 'tester', password: 'secret123', displayName: 'Тестер' });
const game = (await api('/api/games', { name: 'Шаблоны' })).game;
await page.goto(`${BASE}/game/${game.id}`);
await page.waitForSelector('.board-world', { state: 'attached' });
await page.waitForTimeout(500);
await page.locator('.tool-btn[aria-label^="Линейка"]').click();
const box = await page.locator('.board').boundingBox();
const shots = [];
for (const [shape, keep] of [['circle', true], ['cone', true], ['square', false], ['beam', true]]) {
  await page.getByRole('radio', { name: { circle: 'Круг', cone: 'Конус', square: 'Куб', beam: 'Луч' }[shape] }).click();
  if (keep) {
    const cb = page.locator('.check-row input');
    if (!(await cb.isChecked())) await cb.check();
  } else {
    const cb = page.locator('.check-row input');
    if (await cb.isChecked()) await cb.uncheck();
  }
  const a = await page.evaluate(() => window.__board.worldToScreen(420, 420));
  const off = { circle: [150, 60], cone: [180, -120], square: [-140, 140], beam: [-300, -100] }[shape];
  await page.mouse.move(box.x + a.x, box.y + a.y);
  await page.mouse.down();
  await page.mouse.move(box.x + a.x + off[0], box.y + a.y + off[1], { steps: 6 });
  await page.waitForTimeout(150);
  if (shape === 'cone') await page.screenshot({ path: path.join(SHOTS, 'tpl-cone-drag.png') });
  const label = await page.locator('.board svg text').allTextContents();
  const cells = await page.locator('.board .tpl-cell').count();
  await page.mouse.up();
  console.log(shape, label.join(' | '), 'клеток:', cells);
}
await page.waitForTimeout(500);
const objs = await page.evaluate(() => [...window.__board.store.col.obj.values()].map((o) => `${o.type}/${o.shape} ${o.name} rot=${Math.round(o.rot || 0)}`));
console.log(objs);
const ok = objs.length === 3 && objs.some((x) => x.startsWith('shape/ellipse Круг')) && objs.some((x) => x.startsWith('shape/cone Конус')) && objs.some((x) => x.startsWith('shape/rect Луч'));
await page.locator('.tool-btn[aria-label^="Выбор"]').click();
await page.screenshot({ path: path.join(SHOTS, 'tpl-kept.png') });
console.log(ok && !errs.length ? '✓ шаблоны областей работают' : '✗ шаблоны: ' + JSON.stringify(errs));
await browser.close();
process.exit(ok && !errs.length ? 0 : 1);
