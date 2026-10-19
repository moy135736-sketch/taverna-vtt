// e2e: объёмные кубики — катятся у всех за столом, сверху выпадает ровно то, что в чате
import { chromium } from 'playwright-core';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:3000';
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'taverna-shots');
fs.mkdirSync(SHOTS, { recursive: true });
// WebGL в headless-браузере — программный (SwiftShader)
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
const errors = [];
const failures = [];

async function newUser(name) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  // в браузере для тестов WebGL программный — без этого Таверна сама выбрала бы плоские кубики
  await ctx.addInitScript(() => localStorage.setItem('tv:dice3d', 'force'));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
  page.on('console', (m) => m.type() === 'warning' && /кубики/.test(m.text()) && errors.push(`[${name}] ${m.text()}`));
  await page.goto(BASE);
  const api = (p, body) =>
    page.evaluate(
      async ([p, body]) => (await fetch(p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Taverna': '1' }, body: body ? JSON.stringify(body) : undefined })).json(),
      [p, body],
    );
  await api('/api/auth/register', { username: 'd3' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), password: 'secret123', displayName: name });
  return { page, api };
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

/** Бросок из чата и ожидание, пока кубики лягут; возвращает показанные на верхних гранях надписи */
async function roll(page, text) {
  const n0 = await page.evaluate(() => window.__dice3d?.rolls || 0);
  await page.locator('.chat-text').fill(text);
  await page.locator('.chat-text').press('Enter');
  await page.waitForFunction((n) => (window.__dice3d?.rolls || 0) > n && window.__dice3d.last.done, n0, { timeout: 20000 });
  return page.evaluate(() => window.__dice3d.last.results);
}
/** Кубики броска из последнего сообщения: ожидаемые надписи для d4…d100 */
async function lastMessageDice(page) {
  return page.evaluate(() => {
    const m = window.__board.store.messages.at(-1);
    const out = [];
    const walk = (parts) => {
      for (const p of parts || []) {
        if (p.t === 'dice') for (const d of p.dice) out.push({ sides: p.sides, v: d.v });
        else if (p.t === 'group') for (const it of p.items || []) walk(it.parts);
      }
    };
    walk(m.roll?.parts);
    for (const r of m.inlinerolls || []) walk(r.parts);
    return out;
  });
}
const expected = (dice) =>
  dice.flatMap((d) => (d.sides === 100 ? [String(Math.floor((d.v % 100) / 10) * 10).padStart(2, '0'), String(d.v % 10)] : d.sides === 'F' ? [d.v > 0 ? '+' : d.v < 0 ? '−' : ' '] : [String(d.v)]));

const gm = await newUser('Мастер');
const game = (await gm.api('/api/games', { name: 'Кубики' })).game;
await gm.page.goto(`${BASE}/game/${game.id}`);
await gm.page.waitForSelector('.board');
await gm.page.getByRole('tab', { name: 'Чат' }).click();

const pl = await newUser('Игрок');
await pl.api('/api/games/join', { code: game.inviteCode });
await pl.page.goto(`${BASE}/game/${game.id}`);
await pl.page.waitForSelector('.board');
await pl.page.getByRole('tab', { name: 'Чат' }).click();

await step('WebGL есть, модуль кубиков грузится только при первом броске', async () => {
  const gl = await gm.page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));
  if (!gl) throw new Error('нет WebGL в браузере для тестов');
  if (await gm.page.locator('canvas.dice3d').count()) throw new Error('холст кубиков создан заранее');
});

for (const expr of ['1d20', '1d4', '1d6', '1d8', '1d10', '1d12', '1d100', '4d6', '2d20kh1', '3dF', '1d30', '8d6']) {
  await step(`/r ${expr}: сверху выпало то же, что в чате`, async () => {
    const res = await roll(gm.page, '/r ' + expr);
    const want = expected(await lastMessageDice(gm.page)).slice(0, 12);
    const shown = res.map((r) => r.shown);
    if (JSON.stringify(shown) !== JSON.stringify(want)) throw new Error(`показано ${JSON.stringify(shown)}, в чате ${JSON.stringify(want)}`);
    if (expr === '8d6' || expr === '1d20' || process.env.SHOTALL) await gm.page.screenshot({ path: `${SHOTS}/dice3d-${expr}.png`, clip: { x: 46, y: 46, width: 994, height: 854 } });
  });
}

await step('игрок видит бросок мастера', async () => {
  const n0 = await pl.page.evaluate(() => window.__dice3d?.rolls || 0);
  await roll(gm.page, '/r 2d10');
  await pl.page.waitForFunction((n) => (window.__dice3d?.rolls || 0) > n && window.__dice3d.last.done, n0, { timeout: 20000 });
  const a = await gm.page.evaluate(() => window.__dice3d.last.results.map((r) => r.shown));
  const b = await pl.page.evaluate(() => window.__dice3d.last.results.map((r) => r.shown));
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`у мастера ${a}, у игрока ${b}`);
});

await step('кубики тают и холст не мешает щелчкам по доске', async () => {
  const pe = await gm.page.evaluate(() => getComputedStyle(document.querySelector('canvas.dice3d')).pointerEvents);
  if (pe !== 'none') throw new Error('pointer-events: ' + pe);
  await gm.page.waitForFunction(() => document.querySelector('canvas.dice3d').classList.contains('idle'), null, { timeout: 8000 });
});

await step('настройка «Плоские в углу» и «Не показывать»', async () => {
  await gm.page.evaluate(() => localStorage.setItem('tv:diceanim', '2d'));
  const n0 = await gm.page.evaluate(() => window.__dice3d.rolls);
  await gm.page.locator('.chat-text').fill('/r 1d20');
  await gm.page.locator('.chat-text').press('Enter');
  await gm.page.locator('.dice-anim-tray .die').first().waitFor({ timeout: 5000 });
  if ((await gm.page.evaluate(() => window.__dice3d.rolls)) !== n0) throw new Error('объёмные кубики при плоском режиме');
  await gm.page.evaluate(() => {
    localStorage.setItem('tv:diceanim', '0');
    document.querySelector('.dice-anim-tray')?.remove();
  });
  await gm.page.locator('.chat-text').fill('/r 1d20');
  await gm.page.locator('.chat-text').press('Enter');
  await gm.page.waitForTimeout(1500);
  if (await gm.page.locator('.dice-anim-tray .die').count()) throw new Error('кубики показаны, хотя выключены');
  await gm.page.evaluate(() => localStorage.setItem('tv:diceanim', '3d'));
});

console.log('ошибки:', errors.length ? '\n' + errors.join('\n') : 'нет');
await browser.close();
if (failures.length) process.exit(1);
