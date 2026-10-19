// e2e: проверка листов из репозитория Roll20 — загрузка, sheet workers, кнопки бросков и действий
import { chromium } from 'playwright-core';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3000';
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'taverna-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const ONLY = process.argv.slice(2);
const SHEETS = ONLY.length
  ? ONLY
  : ['DD5thEditionLegacy', 'Cyberpunk Red', 'Cyberpunk Red Tabbed', 'CyberpunkRED_raycw', 'CyberpunkRED_Gerdofal', 'Warhammer Fantasy Roleplay 4e Official', 'Warhammer 4e Character Sheet', 'WFRP4CharSheet', 'Warhammer40k-WrathandGlory'];

const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const page = await ctx.newPage();
let errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  const t = m.text();
  if ((m.type() === 'error' || m.type() === 'warning') && !/ERR_TUNNEL|Failed to load resource|ERR_CONNECTION/.test(t)) errors.push(`${m.type()}: ${t.slice(0, 400)}`);
});
await page.goto(BASE);
const api = (path, body) =>
  page.evaluate(
    async ([path, body]) => {
      const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Taverna': '1' }, body: body ? JSON.stringify(body) : undefined });
      return r.json();
    },
    [path, body],
  );
{
  const l = await api('/api/auth/login', { username: 'tester', password: 'secret123' });
  if (!l.user) await api('/api/auth/register', { username: 'tester', password: 'secret123', displayName: 'Тестер' });
}
const all = (await api('/api/sheets')).sheets;

// автоответ на запросы ?{...}
let answering = true;
const answerLoop = (async () => {
  while (answering && !page.isClosed()) {
    try {
      // отвечаем на верхний вопрос, как человек: если броски нажали быстрее ответов, диалоги лежат стопкой
      const q = page.locator('.query-modal');
      if (await q.count()) await page.locator('.query-modal button[type=submit]').last().click({ timeout: 3000 });
    } catch {
      /* ignore */
    }
    await page.waitForTimeout(150).catch(() => {});
  }
})();

const report = [];
for (const ref of SHEETS) {
  errors = [];
  const sheet = all.find((s) => s.sourceRef === ref);
  if (!sheet) {
    console.log('нет листа', ref);
    continue;
  }
  const game = (await api('/api/games', { name: 'Тест ' + ref, sheetId: sheet.id })).game;
  await page.goto(`${BASE}/game/${game.id}`);
  await page.waitForSelector('.board-world', { state: 'attached' });
  const charId = await page.evaluate(async () => {
    const r = await window.__board.net.create('char', { name: 'Проверка' });
    return r.id;
  });
  await page.evaluate((id) => document.querySelector('.journal-panel') || null, charId);
  // открыть лист через журнал
  await page.getByRole('tab', { name: 'Журнал: персонажи и материалы' }).click();
  await page.locator('.j-item', { hasText: 'Проверка' }).click();
  const frame = page.frameLocator('.sheet-frame');
  const t0 = Date.now();
  await frame.locator('.charsheet').waitFor({ timeout: 30000 });
  await page.waitForTimeout(2500);
  const loadMs = Date.now() - t0;
  const fr = page.frames().find((f) => f.url() === 'about:srcdoc');
  const stats = await fr.evaluate(() => ({
    inputs: document.querySelectorAll('[name^="attr_"]').length,
    rolls: document.querySelectorAll('button[type=roll]').length,
    actions: document.querySelectorAll('button[type=action]').length,
    reps: document.querySelectorAll('.repcontainer').length,
  }));
  await page.screenshot({ path: `${SHOTS}/sheet-${ref.replace(/\W+/g, '_')}.png` });
  // нажимаем видимые кнопки бросков
  await page.getByRole('tab', { name: 'Чат' }).click();
  const before = await page.locator('.textchatcontainer .message').count();
  const rollIdx = await fr.evaluate(() =>
    [...document.querySelectorAll('button[type=roll]')]
      .map((b, i) => ({ i, vis: !!(b.offsetWidth || b.offsetHeight) && getComputedStyle(b).visibility !== 'hidden' }))
      .filter((x) => x.vis)
      .map((x) => x.i)
      .slice(0, 6),
  );
  for (const i of rollIdx) {
    await fr.evaluate((i) => document.querySelectorAll('button[type=roll]')[i].click(), i);
    await page.waitForTimeout(700);
  }
  // и кнопки действий (CRP и прочие)
  const actIdx = await fr.evaluate(() =>
    [...document.querySelectorAll('button[type=action]')]
      .map((b, i) => ({ i, vis: !!(b.offsetWidth || b.offsetHeight), name: b.getAttribute('name') }))
      .filter((x) => x.vis && !/reset|clear|delete|remove/i.test(x.name || ''))
      .map((x) => x.i)
      .slice(0, 5),
  );
  for (const i of actIdx) {
    await fr.evaluate((i) => document.querySelectorAll('button[type=action]')[i].click(), i);
    await page.waitForTimeout(900);
  }
  await page.waitForTimeout(1500);
  const after = await page.locator('.textchatcontainer .message').count();
  const sysErr = await page.locator('.textchatcontainer .message.system.error').allTextContents();
  const templates = await page.evaluate(() => [...new Set([...document.querySelectorAll('.textchatcontainer [class^="sheet-rolltemplate-"]')].map((e) => e.className))]);
  const attrCount = await page.evaluate((id) => window.__board.store.attrMap(id)?.size || 0, charId);
  await page.screenshot({ path: `${SHOTS}/sheet-${ref.replace(/\W+/g, '_')}-chat.png` });
  const r = { ref, loadMs, ...stats, clickedRolls: rollIdx.length, clickedActions: actIdx.length, newMsgs: after - before, attrCount, templates: templates.join(' '), sysErr: sysErr.slice(0, 3), errors: errors.slice(0, 6) };
  report.push(r);
  console.log(JSON.stringify(r, null, 1));
  // закрыть окно листа
  await page.locator('.fwin .icon-btn[title="Закрыть"]').first().click();
}
answering = false;
await answerLoop;
fs.writeFileSync(`${SHOTS}/sheets-report.json`, JSON.stringify(report, null, 1));
await browser.close();
// провал: лист не открылся, кнопки не дали сообщений или упала страница
const bad = report.filter((r) => r.inputs === 0 || (r.clickedRolls > 0 && r.newMsgs === 0) || r.errors.some((e) => e.startsWith('pageerror')));
console.log(bad.length ? `✗ проблемы с листами: ${bad.map((r) => r.ref).join(', ')}` : `✓ все листы (${report.length}) открываются и бросают`);
process.exit(bad.length ? 1 : 0);
