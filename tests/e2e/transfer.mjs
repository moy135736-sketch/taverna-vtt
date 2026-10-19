// e2e: копирование персонажа и материала в другой стол мастера (с атрибутами), в том числе в открытый стол
import { chromium } from 'playwright-core';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:3000';
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'taverna-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
const failures = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const api = (p, body, pg = page) =>
  pg.evaluate(
    async ([p, body]) => {
      const r = await fetch(p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Taverna': '1' }, body: body ? JSON.stringify(body) : undefined });
      return r.json();
    },
    [p, body],
  );
async function step(name, fn) {
  try {
    await fn();
    console.log('✓', name);
  } catch (e) {
    console.log('✗', name, '—', e.message.split('\n')[0]);
    failures.push(name);
    await page.screenshot({ path: `${SHOTS}/transfer-fail.png` }).catch(() => {});
  }
}

await page.goto(BASE);
await api('/api/auth/register', { username: 't' + Date.now().toString(36), password: 'secret123', displayName: 'Мастер' });
const a = (await api('/api/games', { name: 'Кампания А' })).game;
const b = (await api('/api/games', { name: 'Кампания Б' })).game;
let charId, handoutId;

await step('в столе А — персонаж с атрибутами и материал', async () => {
  await page.goto(`${BASE}/game/${a.id}`);
  await page.waitForSelector('.board-world', { state: 'attached' });
  [charId, handoutId] = await page.evaluate(async () => {
    const net = window.__board.net;
    const ch = await net.create('char', { name: 'Странник', bio: 'Следопыт с севера', inJournals: ['all'], controlledBy: [], abilities: [{ id: 'ab1', name: 'Выстрел', action: '/r 1d20+@{dex}', istokenaction: true }] });
    await net.request('attrs:set', { charId: ch.id, set: [{ name: 'dex', current: 4, max: '' }, { name: 'hp', current: 12, max: 20 }] });
    const h = await net.create('handout', { name: 'Карта севера', notes: 'Тропы и броды', inJournals: ['all'] });
    return [ch.id, h.id];
  });
  await page.waitForTimeout(800);
});

// второй стол открыт в другой вкладке — копия должна появиться там сразу
const pageB = await ctx.newPage();
await pageB.goto(`${BASE}/game/${b.id}`);
await pageB.waitForSelector('.board-world', { state: 'attached' });

await step('копирование в открытый стол Б: появляется сразу, атрибуты на месте', async () => {
  const r = await api(`/api/games/${a.id}/transfer`, { targetGameId: b.id, chars: [charId], handouts: [handoutId] });
  if (r.copied !== 2) throw new Error(JSON.stringify(r));
  await pageB.waitForFunction(() => [...window.__board.store.col.char.values()].some((c) => c.name === 'Странник'), null, { timeout: 5000 });
  const info = await pageB.evaluate(async () => {
    const s = window.__board.store;
    const ch = [...s.col.char.values()].find((c) => c.name === 'Странник');
    const attrs = await window.__board.net.ensureAttrs(ch.id);
    return { abilities: ch.abilities.length, hp: attrs.get('hp')?.max, handout: [...s.col.handout.values()].some((h) => h.name === 'Карта севера') };
  });
  if (info.abilities !== 1 || String(info.hp) !== '20' || !info.handout) throw new Error(JSON.stringify(info));
});

await step('копирование в закрытый стол: после открытия всё на месте', async () => {
  const c = (await api('/api/games', { name: 'Кампания В' })).game;
  const r = await api(`/api/games/${a.id}/transfer`, { targetGameId: c.id, chars: [charId] });
  if (r.copied !== 1) throw new Error(JSON.stringify(r));
  await page.goto(`${BASE}/game/${c.id}`);
  await page.waitForSelector('.board-world', { state: 'attached' });
  const ok = await page.evaluate(async () => {
    const ch = [...window.__board.store.col.char.values()].find((x) => x.name === 'Странник');
    if (!ch) return 'нет персонажа';
    const attrs = await window.__board.net.ensureAttrs(ch.id);
    return attrs.get('dex')?.current === 4 || attrs.get('dex')?.current === '4' ? 'ok' : 'dex=' + attrs.get('dex')?.current;
  });
  if (ok !== 'ok') throw new Error(ok);
});

await step('нельзя копировать в чужой стол', async () => {
  const other = await ctx.browser().newContext();
  const p2 = await other.newPage();
  await p2.goto(BASE);
  await api('/api/auth/register', { username: 'o' + Date.now().toString(36), password: 'secret123', displayName: 'Другой' }, p2);
  const foreign = (await api('/api/games', { name: 'Чужой стол' }, p2)).game;
  const r = await api(`/api/games/${a.id}/transfer`, { targetGameId: foreign.id, chars: [charId] });
  if (!r.error) throw new Error('копирование в чужой стол прошло');
  await other.close();
});

await step('дата следующей игры видна в лобби, файл для календаря', async () => {
  const when = Date.now() + 2 * 86400000;
  const r = await page.evaluate(
    async ([id, when]) => (await fetch('/api/games/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Taverna': '1' }, body: JSON.stringify({ nextSession: when }) })).json(),
    [b.id, when],
  );
  if (r.game?.nextSession !== when) throw new Error(JSON.stringify(r));
  await page.goto(BASE);
  const row = page.locator('.game-row', { hasText: 'Кампания Б' });
  await row.locator('.next-session').waitFor({ timeout: 5000 });
  const t = await row.locator('.next-session').textContent();
  if (!/послезавтра/.test(t)) throw new Error('подпись: ' + t);
  const [dl] = await Promise.all([page.waitForEvent('download'), row.locator('.next-session button').click()]);
  const ics = fs.readFileSync(await dl.path(), 'utf8');
  if (!/BEGIN:VEVENT[\s\S]*SUMMARY:Кампания Б/.test(ics)) throw new Error('ics: ' + ics.slice(0, 200));
});

console.log('ошибки:', errors.length ? '\n' + errors.join('\n') : 'нет');
await browser.close();
if (failures.length) process.exit(1);
