// e2e: урон и лечение из чата — щелчок по числу броска меняет хиты выделенных токенов, с отменой
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
  await api('/api/auth/register', { username: 'dm' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), password: 'secret123', displayName: name });
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
const bars = (page, id) => page.evaluate((id) => window.__board.store.col.obj.get(id)?.bars.map((b) => b.value), id);
async function waitBars(page, id, want, what) {
  try {
    await page.waitForFunction(([id, want]) => JSON.stringify(window.__board.store.col.obj.get(id)?.bars.map((b) => String(b.value))) === JSON.stringify(want), [id, want], { timeout: 5000 });
  } catch {
    throw new Error(`${what}: ${JSON.stringify(await bars(page, id))}, ожидалось ${JSON.stringify(want)}`);
  }
}
/** Сообщение в чат и щелчок по числу в нём; возвращает пункты меню */
async function rollAndOpen(page, text, sel) {
  const before = await page.locator('.textchatcontainer .message').count();
  await page.locator('.chat-text').fill(text);
  await page.locator('.chat-text').press('Enter');
  await page.waitForFunction((n) => document.querySelectorAll('.textchatcontainer .message').length > n, before, { timeout: 8000 });
  await page.locator('.textchatcontainer .message').last().locator(sel).first().click();
  await page.locator('.ctx-menu').waitFor({ timeout: 3000 });
  return page.locator('.ctx-menu .ctx-item').allTextContents();
}
const menuClick = (page, re) => page.locator('.ctx-menu .ctx-item', { hasText: re }).first().click();

const gm = await newUser('Мастер');
const game = (await gm.api('/api/games', { name: 'Урон из чата' })).game;
await gm.page.goto(`${BASE}/game/${game.id}`);
await gm.page.waitForSelector('.board');
await gm.page.getByRole('tab', { name: 'Чат' }).click();

let ids;
await step('токены: гоблин (хиты в первой полосе, как в листе 5E) и огр с временными хитами', async () => {
  ids = await gm.page.evaluate(async () => {
    const { net, store } = window.__board;
    const pageId = store.ui.pageId;
    const mk = (name, x, bars) => net.create('obj', { type: 'shape', shape: 'circle', fill: '#7a2e2e', pageId, layer: 'objects', x, y: 140, w: 70, h: 70, name, showName: true, bars, controlledBy: [] });
    const gob = await mk('Гоблин', 140, [
      { id: 'g1', name: '', value: '7', max: '7', color: '#3eaa49', link: '' },
      { id: 'g2', name: '', value: '15', max: '', color: '#3b7bd8', link: 'npc_ac' },
    ]);
    const ogre = await mk('Огр', 280, [
      { id: 'o1', name: 'HP', value: '20', max: '30', color: '#d63a3a', link: '' },
      { id: 'o2', name: 'Врем. хиты', value: '5', max: '', color: '#e0a020', link: '' },
    ]);
    store.setSelection([gob.id, ogre.id]);
    return { gob: gob.id, ogre: ogre.id };
  });
});

await step('/r 9 → «Урон −9»: гоблин 7 → 0, у огра сначала уходят временные хиты', async () => {
  const items = await rollAndOpen(gm.page, '/r 9', '.rolled');
  if (!items.some((t) => /Кому: Гоблин, Огр/.test(t))) throw new Error('меню: ' + items.join(' | '));
  if (!items.some((t) => /Половина урона −4/.test(t)) || !items.some((t) => /Двойной урон −18/.test(t)) || !items.some((t) => /Лечение \+9/.test(t))) throw new Error('меню: ' + items.join(' | '));
  await gm.page.screenshot({ path: `${SHOTS}/damage-menu.png` });
  await menuClick(gm.page, /^Урон −9/);
  await waitBars(gm.page, ids.gob, ['0', '15'], 'гоблин');
  await waitBars(gm.page, ids.ogre, ['16', '0'], 'огр');
  const t = await gm.page.locator('.toast', { hasText: 'Урон 9' }).last().textContent();
  if (!/Гоблин: 7 → 0/.test(t) || !/Огр: 20 → 16 \(временные 5 → 0\)/.test(t)) throw new Error('уведомление: ' + t);
  const floats = await gm.page.evaluate(() => window.__board.fx.texts.map((x) => x.text));
  if (!floats.includes('−9')) throw new Error('нет числа над токенами: ' + floats);
  await gm.page.waitForTimeout(250);
  await gm.page.screenshot({ path: `${SHOTS}/damage-applied.png` });
});

await step('«Отменить» возвращает хиты и временные хиты', async () => {
  await gm.page.locator('.toast', { hasText: 'Урон 9' }).last().getByRole('button', { name: 'Отменить' }).click();
  await waitBars(gm.page, ids.gob, ['7', '15'], 'гоблин после отмены');
  await waitBars(gm.page, ids.ogre, ['20', '5'], 'огр после отмены');
});

await step('число в шаблоне броска: половина урона и лечение до максимума', async () => {
  await gm.page.evaluate((id) => window.__board.store.setSelection([id]), ids.gob);
  await rollAndOpen(gm.page, '&{template:default} {{name=Огненный шар}} {{Урон=[[9]]}}', '.inlinerollresult');
  await menuClick(gm.page, /Половина урона −4/);
  await waitBars(gm.page, ids.gob, ['3', '15'], 'гоблин после половины');
  await rollAndOpen(gm.page, '&{template:default} {{name=Лечение ран}} {{Хиты=[[9]]}}', '.inlinerollresult');
  await menuClick(gm.page, /Лечение \+9/);
  await waitBars(gm.page, ids.gob, ['7', '15'], 'гоблин после лечения (не выше максимума)');
});

await step('ничего не выделено — меню подсказывает выделить токены', async () => {
  await gm.page.evaluate(() => window.__board.store.setSelection([]));
  const items = await rollAndOpen(gm.page, '/r 5', '.rolled');
  if (items.length !== 1 || !/Выделите токены/.test(items[0])) throw new Error('меню: ' + items.join(' | '));
  await gm.page.keyboard.press('Escape');
});

let heroChar;
await step('персонаж со связанной полосой: урон меняет атрибут hp', async () => {
  const r = await gm.page.evaluate(async () => {
    const { net, store } = window.__board;
    const ch = await net.create('char', { name: 'Тарен', inJournals: ['all'], controlledBy: ['all'] });
    await net.request('attrs:set', { charId: ch.id, set: [{ name: 'hp', current: 12, max: 20 }, { name: 'hp_temp', current: 3 }] });
    const tok = await net.create('obj', {
      type: 'shape', shape: 'circle', fill: '#2e5a7a', pageId: store.ui.pageId, layer: 'objects', x: 420, y: 140, w: 70, h: 70, name: 'Тарен', showName: true, represents: ch.id,
      bars: [{ id: 'h1', name: '', value: '12', max: '20', color: '#3eaa49', link: 'hp' }],
    });
    store.setSelection([tok.id]);
    return { ch: ch.id, tok: tok.id };
  });
  heroChar = r;
  await rollAndOpen(gm.page, '/r 8', '.rolled');
  await menuClick(gm.page, /^Урон −8/);
  // 3 временных уходят первыми: 12 − 5 = 7
  await waitBars(gm.page, r.tok, ['7'], 'полоса Тарена');
  const attrs = await gm.page.evaluate(async (id) => {
    const { net, store } = window.__board;
    store.attrs.delete(id);
    await net.ensureAttrs(id);
    return { hp: store.getAttr(id, 'hp')?.current, temp: store.getAttr(id, 'hp_temp')?.current };
  }, r.ch);
  if (String(attrs.hp) !== '7' || String(attrs.temp) !== '0') throw new Error('атрибуты: ' + JSON.stringify(attrs));
});

await step('игрок не может снять хиты чужому токену, но видит всплывающее число', async () => {
  const pl = await newUser('Игрок');
  await pl.api('/api/games/join', { code: game.inviteCode });
  await pl.page.goto(`${BASE}/game/${game.id}`);
  await pl.page.waitForSelector('.board');
  await pl.page.getByRole('tab', { name: 'Чат' }).click();
  // мастер бьёт гоблина — у игрока всплывает число
  await gm.page.evaluate((id) => window.__board.store.setSelection([id]), ids.gob);
  await rollAndOpen(gm.page, '/r 2', '.rolled');
  await menuClick(gm.page, /^Урон −2/);
  await pl.page.waitForFunction(() => window.__board.fx.texts.some((t) => t.text === '−2'), null, { timeout: 4000 });
  await waitBars(pl.page, ids.gob, ['5', '15'], 'гоблин у игрока');
  // игрок пробует сам
  await pl.page.evaluate((id) => window.__board.store.setSelection([id]), ids.gob);
  await rollAndOpen(pl.page, '/r 4', '.rolled');
  await menuClick(pl.page, /^Урон −4/);
  const t = await pl.page.locator('.toast-error', { hasText: 'не применён' }).last().textContent();
  if (!/Гоблин: нет прав/.test(t)) throw new Error('уведомление: ' + t);
  await gm.page.waitForTimeout(500);
  const v = await bars(gm.page, ids.gob);
  if (v[0] !== '5') throw new Error('хиты гоблина изменились: ' + v);
  // свой персонаж — можно (Тарен доступен всем)
  await pl.page.evaluate((id) => window.__board.store.setSelection([id]), heroChar.tok);
  await rollAndOpen(pl.page, '/r 4', '.rolled');
  await menuClick(pl.page, /Лечение \+4/);
  await waitBars(gm.page, heroChar.tok, ['11'], 'Тарен после лечения игроком');
});

await step('настройка «Полоса хитов» и «ниже нуля»', async () => {
  await gm.page.evaluate(() => window.__board.net.request('settings', { hpBar: '2', hpNegative: true }));
  await gm.page.waitForFunction(() => window.__board.store.settings.hpBar === '2');
  await gm.page.evaluate((id) => window.__board.store.setSelection([id]), ids.gob);
  await rollAndOpen(gm.page, '/r 20', '.rolled');
  await menuClick(gm.page, /^Урон −20/);
  // вторая полоса (15) → −5, первая не тронута
  await waitBars(gm.page, ids.gob, ['5', '-5'], 'гоблин по второй полосе');
  await gm.page.evaluate(() => window.__board.net.request('settings', { hpBar: 'auto', hpNegative: false }));
});

console.log('ошибки:', errors.length ? '\n' + errors.join('\n') : 'нет');
await browser.close();
if (failures.length) process.exit(1);
