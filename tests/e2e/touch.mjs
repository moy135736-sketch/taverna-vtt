// e2e: сенсорные жесты на доске — щипок (масштаб) и сдвиг одним пальцем (синтетические PointerEvent)
import { chromium } from 'playwright-core';
const BASE = process.env.BASE || 'http://localhost:3000';
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 }, hasTouch: true })).newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(BASE);
const api = (p, b) => page.evaluate(async ([p, b]) => (await fetch(p, { method: b ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Taverna': '1' }, body: b ? JSON.stringify(b) : undefined })).json(), [p, b]);
const l = await api('/api/auth/login', { username: 'tester', password: 'secret123' });
if (!l.user) await api('/api/auth/register', { username: 'tester', password: 'secret123', displayName: 'Тестер' });
const game = (await api('/api/games', { name: 'Жесты' })).game;
await page.goto(`${BASE}/game/${game.id}`);
await page.waitForSelector('.board-world', { state: 'attached' });
await page.waitForTimeout(500);
const res = await page.evaluate(async () => {
  const el = document.querySelector('.board');
  const r = el.getBoundingClientRect();
  const fire = (type, id, x, y) => el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: r.left + x, clientY: r.top + y, bubbles: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, isPrimary: id === 1 }));
  const b = window.__board;
  const z0 = b.cam.z;
  // щипок: пальцы расходятся вдвое
  fire('pointerdown', 1, 400, 300);
  fire('pointerdown', 2, 500, 300);
  for (let i = 1; i <= 5; i++) {
    fire('pointermove', 1, 400 - i * 10, 300);
    fire('pointermove', 2, 500 + i * 10, 300);
  }
  fire('pointerup', 1, 350, 300);
  fire('pointerup', 2, 550, 300);
  const z1 = b.cam.z;
  // сдвиг одним пальцем
  const x0 = b.cam.x;
  fire('pointerdown', 3, 300, 300);
  for (let i = 1; i <= 5; i++) fire('pointermove', 3, 300 + i * 20, 300);
  fire('pointerup', 3, 400, 300);
  return { z0, z1, dx: b.cam.x - x0, selected: b.store.ui.selected.size };
});
console.log(JSON.stringify(res));
const ok = res.z1 / res.z0 > 1.9 && res.z1 / res.z0 < 2.1 && Math.abs(res.dx - 100) < 2;
console.log(ok ? '✓ щипок и сдвиг работают' : '✗ жесты не сработали', errs.length ? errs : '');
await browser.close();
process.exit(ok ? 0 : 1);
