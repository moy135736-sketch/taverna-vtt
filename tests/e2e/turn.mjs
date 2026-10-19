// e2e: порядок ходов — карты инициативы (Savage Worlds) и свои записи с формулой (+1, как кубик эскалации)
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
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
  await page.goto(BASE);
  const api = (p, body) =>
    page.evaluate(
      async ([p, body]) => {
        const r = await fetch(p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Taverna': '1' }, body: body ? JSON.stringify(body) : undefined });
        return r.json();
      },
      [p, body],
    );
  const r = await api('/api/auth/register', { username: 'tt' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), password: 'secret123', displayName: name });
  return { page, api, user: r.user };
}
async function step(name, fn) {
  try {
    await fn();
    console.log('✓', name);
  } catch (e) {
    console.log('✗', name, '—', e.message.split('\n')[0]);
    failures.push(name);
    await gm.page.screenshot({ path: `${SHOTS}/turn-fail.png` }).catch(() => {});
  }
}
const turn = (u) => u.page.evaluate(() => JSON.parse(JSON.stringify(window.__board.store.state)));

const gm = await newUser('Мастер');
const pl = await newUser('Игрок');
const game = (await gm.api('/api/games', { name: 'Дикий Запад' })).game;
await pl.api('/api/games/join', { code: game.inviteCode });
for (const u of [gm, pl]) {
  await u.page.goto(`${BASE}/game/${game.id}`);
  await u.page.waitForSelector('.board-world', { state: 'attached' });
}

await step('токены в порядке ходов, раздача карт', async () => {
  await gm.page.evaluate(async () => {
    const b = window.__board;
    for (const [i, name] of ['Ковбой', 'Шериф', 'Бандит'].entries()) {
      const o = b.createObj({ type: 'shape', shape: 'ellipse', name, x: 70 * (i + 1), y: 70, w: 70, h: 70, fill: '#888' }, { select: false });
      await b.net.request('turn', { t: 'add', tokenId: o.id, pr: 0 });
    }
  });
  await gm.page.getByRole('button', { name: 'Порядок ходов' }).click();
  await gm.page.locator('[title^="Раздать карты инициативы"]').click();
  await gm.page.waitForSelector('.turn-card');
  const st = await turn(gm);
  const cards = st.turnorder.map((e) => e.card);
  if (cards.some((c) => !c)) throw new Error('не всем розданы карты: ' + JSON.stringify(cards));
  const pr = st.turnorder.map((e) => Number(e.pr));
  if (pr.some((v, i) => i && v > pr[i - 1])) throw new Error('не по старшинству: ' + JSON.stringify(st.turnorder));
  console.log('   карты:', cards.join(' '));
  await gm.page.screenshot({ path: `${SHOTS}/turn-cards.png` });
});

await step('колода не видна игроку', async () => {
  const st = await turn(pl);
  if (st.deck) throw new Error('игрок получил колоду');
  if (!st.turnorder.every((e) => e.card)) throw new Error('игрок не видит карты');
});

await step('своя запись с формулой +1 растёт, когда до неё доходит ход', async () => {
  await gm.page.locator('[title^="Своя запись"]').click();
  const dlg = gm.page.getByRole('dialog', { name: 'Своя запись в порядке ходов' });
  await dlg.locator('input').nth(0).fill('Кубик эскалации');
  await dlg.locator('input').nth(1).fill('0');
  await dlg.locator('input').nth(2).fill('+1');
  await dlg.getByRole('button', { name: 'Добавить' }).click();
  await gm.page.waitForFunction(() => window.__board.store.state.turnorder.some((e) => e.name === 'Кубик эскалации'));
  // три хода токенов — и очередь доходит до записи
  for (let i = 0; i < 3; i++) await gm.page.evaluate(() => window.__board.net.request('turn', { t: 'next' }));
  await gm.page.waitForTimeout(400);
  const st = await turn(gm);
  const first = st.turnorder[0];
  if (first.name !== 'Кубик эскалации' || Number(first.pr) !== 1) throw new Error('первая запись: ' + JSON.stringify(first));
});

console.log('ошибки:', errors.length ? '\n' + errors.join('\n') : 'нет');
await browser.close();
if (failures.length) process.exit(1);
