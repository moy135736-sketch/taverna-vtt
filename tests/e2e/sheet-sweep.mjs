// Проверка совместимости листов Roll20: для каждого листа — отрисовка, sheet workers,
// нажатие нескольких кнопок бросков и действий, ошибки в консоли и в чате.
// Запуск (сервер уже запущен, листы загружены как встроенные, например SHEETS_DIR=папка-с-листами):
//   node tests/e2e/sheet-sweep.mjs                       — все листы сервера
//   node tests/e2e/sheet-sweep.mjs "Folder 1" "Folder 2"  — выбранные (по имени папки)
// Итог — таблица в консоли и отчёт sweep-report.json в папке скриншотов.
import { chromium } from 'playwright-core';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:3000';
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'taverna-shots', 'sweep');
const ROLLS = Number(process.env.ROLLS || 6);
const ACTIONS = Number(process.env.ACTIONS || 4);
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const page = await ctx.newPage();
let log = [];
page.on('pageerror', (e) => log.push({ kind: 'pageerror', text: e.message + '\n' + String(e.stack || '').slice(0, 500) }));
page.on('console', (m) => {
  const t = m.text();
  if (/ERR_TUNNEL|Failed to load resource|ERR_CONNECTION|favicon/.test(t)) return;
  if (m.type() === 'error' || m.type() === 'warning') log.push({ kind: m.type(), text: t.slice(0, 600) });
});

const api = (p, body) =>
  page.evaluate(
    async ([p, body]) => {
      const r = await fetch(p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Taverna': '1' }, body: body ? JSON.stringify(body) : undefined });
      return r.json();
    },
    [p, body],
  );

await page.goto(BASE);
const reg = await api('/api/auth/register', { username: 'sw' + Date.now().toString(36), password: 'secret123', displayName: 'Проверка' });
if (!reg.user) throw new Error('регистрация: ' + JSON.stringify(reg));
const all = (await api('/api/sheets')).sheets;
const want = process.argv.slice(2);
const sheets = want.length ? want.map((w) => all.find((s) => s.sourceRef === w || s.name === w) || { missing: w }) : all;

/** Ответить на открытые запросы ?{...} значениями по умолчанию */
async function answerQueries(limit = 6) {
  let n = 0;
  for (let i = 0; i < limit; i++) {
    const q = page.locator('.query-modal');
    if (!(await q.count())) break;
    await q.getByRole('button', { name: 'Бросить' }).click();
    n++;
    await page.waitForTimeout(250);
  }
  return n;
}

const report = [];
for (const s of sheets) {
  if (s.missing) {
    report.push({ sheet: s.missing, error: 'лист не найден на сервере' });
    console.log('?', s.missing, '— не найден');
    continue;
  }
  log = [];
  const r = { sheet: s.sourceRef || s.name, name: s.name };
  const t0 = Date.now();
  try {
    const game = (await api('/api/games', { name: 'Проверка: ' + s.name.slice(0, 60), sheetId: s.id })).game;
    await page.goto(`${BASE}/game/${game.id}`);
    await page.waitForSelector('.board-world', { state: 'attached', timeout: 20000 });
    await page.evaluate(() => {
      window.__sys = [];
      window.__msgs = [];
      window.__board.store.on('chat:system', (m) => window.__sys.push(String(m.text).slice(0, 300)));
      window.__board.store.on('chat', (m) => window.__msgs.push({ type: m.type, tpl: m.rolltemplate || '', len: String(m.content || '').length, inline: (m.inlinerolls || []).length }));
    });
    const charId = await page.evaluate(async () => {
      const r = await window.__board.net.create('char', { name: 'Тестовый герой', inJournals: ['all'], controlledBy: [], abilities: [], archived: false, tags: [] });
      window.__board.hooks.openCharacter(r.id);
      return r.id;
    });
    await page.locator('.sheet-frame').waitFor({ timeout: 20000 });
    const frame = page.frameLocator('.sheet-frame');
    await frame.locator('.charsheet').first().waitFor({ state: 'attached', timeout: 30000 });
    await page.waitForTimeout(3500);
    r.renderMs = Date.now() - t0;
    r.attrs = await page.evaluate((id) => window.__board.store.attrs.get(id)?.size || 0, charId);
    const fr = page.frames().find((f) => f.url() === 'about:srcdoc');
    const counts = await fr.evaluate(() => ({
      inputs: document.querySelectorAll('input,select,textarea').length,
      rolls: document.querySelectorAll('button[type=roll]').length,
      actions: document.querySelectorAll('button[type=action]').length,
      repeating: document.querySelectorAll('fieldset[class^="repeating_"],fieldset[class*=" repeating_"]').length,
      height: document.body.scrollHeight,
      text: (document.body.innerText || '').trim().length,
    }));
    Object.assign(r, counts);
    await page.screenshot({ path: path.join(SHOTS, `${(s.sourceRef || s.name).replace(/[^\p{L}\p{N}]+/gu, '_')}.png`) });

    // кнопки бросков: несколько видимых, равномерно по листу
    await page.getByRole('tab', { name: 'Чат' }).click();
    const rollBtns = frame.locator('button[type=roll]:visible');
    const nRoll = await rollBtns.count();
    const pick = (n, k) => (n <= k ? [...Array(n).keys()] : [...Array(k).keys()].map((i) => Math.floor((i * (n - 1)) / (k - 1 || 1))));
    r.clickedRolls = 0;
    r.queries = 0;
    let msgsBefore = await page.evaluate(() => window.__msgs.length);
    for (const i of pick(nRoll, ROLLS)) {
      try {
        await rollBtns.nth(i).click({ timeout: 3000 });
        r.clickedRolls++;
        await page.waitForTimeout(500);
        r.queries += await answerQueries();
        await page.waitForTimeout(700);
      } catch (e) {
        log.push({ kind: 'click', text: 'бросок #' + i + ': ' + e.message.split('\n')[0] });
      }
    }
    await page.waitForTimeout(1200);
    const afterRolls = await page.evaluate(() => window.__msgs.length);
    r.rollMsgs = afterRolls - msgsBefore;

    // кнопки действий (sheet workers по clicked:...)
    const actBtns = frame.locator('button[type=action]:visible');
    const nAct = await actBtns.count();
    r.clickedActions = 0;
    for (const i of pick(nAct, ACTIONS)) {
      try {
        await actBtns.nth(i).click({ timeout: 3000 });
        r.clickedActions++;
        await page.waitForTimeout(400);
        r.queries += await answerQueries();
      } catch (e) {
        log.push({ kind: 'click', text: 'действие #' + i + ': ' + e.message.split('\n')[0] });
      }
    }
    await page.waitForTimeout(1200);
    r.actionMsgs = (await page.evaluate(() => window.__msgs.length)) - afterRolls;
    r.templates = [...new Set(await page.evaluate(() => window.__msgs.map((m) => m.tpl).filter(Boolean)))];
    r.system = await page.evaluate(() => window.__sys);
    // шаблоны, которых нет у листа: сообщения без отрисованного шаблона
    r.missingTemplates = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('.textchatcontainer .message.rollresult-missing, .textchatcontainer .tpl-missing')) out.push(el.textContent.slice(0, 80));
      return out;
    });
  } catch (e) {
    r.error = e.message.split('\n')[0];
    await page.screenshot({ path: path.join(SHOTS, `FAIL-${(s.sourceRef || s.name).replace(/[^\p{L}\p{N}]+/gu, '_')}.png`) }).catch(() => {});
  }
  // ошибки без повторов
  const uniq = new Map();
  for (const l of log) {
    const k = l.kind + ':' + l.text.replace(/\d+/g, '#').slice(0, 160);
    if (!uniq.has(k)) uniq.set(k, { ...l, n: 0 });
    uniq.get(k).n++;
  }
  r.errors = [...uniq.values()];
  r.sec = Math.round((Date.now() - t0) / 1000);
  report.push(r);
  const bad = r.error || r.errors.some((e) => e.kind !== 'warning' || /sheetworker/.test(e.text));
  console.log(
    `${r.error ? '✗' : bad ? '!' : '✓'} ${r.sheet}: ${r.error || `поля ${r.inputs}, атрибутов ${r.attrs}, бросков ${r.clickedRolls}/${r.rolls} → сообщений ${r.rollMsgs}, действий ${r.clickedActions}/${r.actions} → ${r.actionMsgs}, запросов ${r.queries}, ошибок ${r.errors.length}, системных ${r.system?.length || 0}`} (${r.sec} с)`,
  );
  for (const e of r.errors.slice(0, 6)) console.log(`     ${e.kind}${e.n > 1 ? ' ×' + e.n : ''}: ${e.text.split('\n')[0].slice(0, 220)}`);
  for (const t of (r.system || []).slice(0, 4)) console.log('     чат:', t.slice(0, 200));
}
fs.writeFileSync(path.join(SHOTS, 'sweep-report.json'), JSON.stringify(report, null, 1));
console.log('\nОтчёт:', path.join(SHOTS, 'sweep-report.json'));
await browser.close();
