// e2e: после обрыва связи открытый лист продолжает получать изменения атрибутов
import { chromium } from 'playwright-core';

const BASE = process.env.BASE || 'http://localhost:3000';
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const a = await ctx.newPage();
const errs = [];
a.on('pageerror', (e) => errs.push(e.message));
await a.goto(BASE);
const api = (p, b) => a.evaluate(async ([p, b]) => (await fetch(p, { method: b ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Taverna': '1' }, body: b ? JSON.stringify(b) : undefined })).json(), [p, b]);
const l = await api('/api/auth/login', { username: 'tester', password: 'secret123' });
if (!l.user) await api('/api/auth/register', { username: 'tester', password: 'secret123', displayName: 'Тестер' });
const sheets = (await api('/api/sheets')).sheets;
const game = (await api('/api/games', { name: 'Обрыв связи', sheetId: sheets.find((s) => s.sourceRef === 'DD5thEditionLegacy').id })).game;
await a.goto(`${BASE}/game/${game.id}`);
await a.waitForSelector('.board-world', { state: 'attached' });
const charId = await a.evaluate(async () => (await window.__board.net.create('char', { name: 'Связной' })).id);
await a.getByRole('tab', { name: 'Журнал: персонажи и материалы' }).click();
await a.locator('.j-item', { hasText: 'Связной' }).click();
const frame = a.frameLocator('.sheet-frame');
await frame.locator('.charsheet').waitFor({ timeout: 30000 });
await a.waitForTimeout(1500);

// вторая вкладка того же пользователя будет менять атрибут
const b = await ctx.newPage();
await b.goto(`${BASE}/game/${game.id}`);
await b.waitForSelector('.board-world', { state: 'attached' });

// обрыв и восстановление связи в первой вкладке
await a.evaluate(() => {
  const s = window.__board.net.socket;
  s.disconnect();
  setTimeout(() => s.connect(), 300);
});
await a.waitForTimeout(2500);
await b.evaluate((id) => window.__board.net.request('attrs:set', { charId: id, set: [{ name: 'strength_base', current: 18 }] }), charId);
await a.waitForTimeout(1500);
const v = await frame.locator('.sheet-pc input[name="attr_strength_base"]').first().inputValue();
const ok = v === '18';
console.log(ok ? '✓ после переподключения лист обновился (strength_base = 18)' : '✗ лист не обновился: ' + v, errs.length ? errs : '');
await browser.close();
process.exit(ok ? 0 : 1);
