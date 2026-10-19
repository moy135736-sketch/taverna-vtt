// e2e: вёрстка листов как в Roll20 (rem = 10px, правила листа ограничены .charsheet)
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
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
  await page.goto(BASE);
  const api = (p, body) =>
    page.evaluate(
      async ([p, body]) => (await fetch(p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Taverna': '1' }, body: body ? JSON.stringify(body) : undefined })).json(),
      [p, body],
    );
  await api('/api/auth/register', { username: 'sl' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), password: 'secret123', displayName: name });
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
const sheetFrame = (page) => page.frames().find((f) => f.url() === 'about:srcdoc');
async function openNewChar(page) {
  await page.getByRole('tab', { name: 'Журнал: персонажи и материалы' }).click();
  await page.getByRole('button', { name: 'Персонаж', exact: true }).click();
  await page.frameLocator('.sheet-frame').locator('.charsheet').waitFor({ timeout: 20000 });
  await page.waitForTimeout(1200);
}

const gm = await newUser('Мастер');
const sheets = (await gm.api('/api/sheets')).sheets;

await step('D&D 5E: монеты узкие, спасброски от смерти в одну строку', async () => {
  const game = (await gm.api('/api/games', { name: 'Вёрстка 5E', sheetId: sheets.find((s) => s.sourceRef === 'DD5thEditionLegacy').id })).game;
  await gm.page.goto(`${BASE}/game/${game.id}`);
  await gm.page.waitForSelector('.board');
  await openNewChar(gm.page);
  await gm.page.frameLocator('.sheet-frame').locator('input[name="attr_mancer_cancel"]').click({ force: true });
  await gm.page.waitForTimeout(600);
  const r = await sheetFrame(gm.page).evaluate(() => {
    const cp = document.querySelector('input[name="attr_cp"]').getBoundingClientRect().width;
    const tops = ['attr_deathsave_succ1', 'attr_deathsave_succ2', 'attr_deathsave_succ3'].map((n) => Math.round(document.querySelector(`input[name="${n}"]`).getBoundingClientRect().top));
    return { cp, tops, rem: getComputedStyle(document.documentElement).fontSize };
  });
  if (r.rem !== '10px') throw new Error('корневой шрифт ' + r.rem);
  if (Math.abs(r.cp - 40) > 2) throw new Error('ширина поля монет ' + r.cp);
  if (new Set(r.tops).size !== 1) throw new Error('флажки спасбросков на разных строках: ' + r.tops);
  await gm.page.screenshot({ path: `${SHOTS}/sheetlook-5e.png` });
});

await step('Cyberpunk RED с вкладками: надписи вкладок не обрезаны, характеристики в один ряд', async () => {
  const cpGame = (await gm.api('/api/games', { name: 'Вёрстка Cyberpunk', sheetId: sheets.find((s) => s.sourceRef === 'Cyberpunk Red Tabbed').id })).game;
  await gm.page.goto(`${BASE}/game/${cpGame.id}`);
  await gm.page.waitForSelector('.board');
  await openNewChar(gm.page);
  const r = await sheetFrame(gm.page).evaluate(() => {
    const tabs = [...document.querySelectorAll('span.sheet-tab')].filter((s) => s.offsetParent);
    const clipped = tabs.filter((s) => s.scrollWidth > s.clientWidth + 1).map((s) => s.textContent.trim());
    const attrs = [...document.querySelectorAll('.sheet-section-attributes .sheet-column')].filter((c) => c.offsetParent);
    const rows = new Set(attrs.map((c) => Math.round(c.getBoundingClientRect().top)));
    return { clipped, tabs: tabs.length, attrs: attrs.length, rows: rows.size };
  });
  if (!r.tabs || r.clipped.length) throw new Error('обрезаны вкладки: ' + r.clipped.join(', '));
  if (r.attrs < 10 || r.rows !== 1) throw new Error(`характеристик ${r.attrs}, рядов ${r.rows}`);
});

console.log('ошибки:', errors.length ? '\n' + errors.join('\n') : 'нет');
await browser.close();
if (failures.length) process.exit(1);
