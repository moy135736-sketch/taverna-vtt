// e2e: у каждого игрока своё поле зрения — только глазами своих токенов; управление «всем игрокам»
// обзора не дает; «общий обзор» токена и «общий обзор отряда» сцены; мастер смотрит глазами выбранного игрока
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
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 860 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
  await page.goto(BASE);
  const api = (p, body) =>
    page.evaluate(
      async ([p, body]) => (await fetch(p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Taverna': '1' }, body: body ? JSON.stringify(body) : undefined })).json(),
      [p, body],
    );
  const r = await api('/api/auth/register', { username: 'vs' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), password: 'secret123', displayName: name });
  return { page, api, user: r.user, name };
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
const hidden = (u, id, cls = 'unseen') => u.page.evaluate(([id, cls]) => !!document.querySelector(`.obj[data-oid="${id}"]`)?.classList.contains(cls), [id, cls]);
async function expectHidden(u, id, want, what, cls = 'unseen') {
  try {
    await u.page.waitForFunction(([id, want, cls]) => !!document.querySelector(`.obj[data-oid="${id}"]`)?.classList.contains(cls) === want, [id, want, cls], { timeout: 5000 });
  } catch {
    throw new Error(`${what}: у «${u.name}» ${want ? 'видно' : 'не видно'}`);
  }
}

const gm = await newUser('Мастер');
const a = await newUser('Аня');
const b = await newUser('Борис');
const game = (await gm.api('/api/games', { name: 'Обзор' })).game;
await a.api('/api/games/join', { code: game.inviteCode });
await b.api('/api/games/join', { code: game.inviteCode });
for (const u of [gm, a, b]) {
  await u.page.goto(`${BASE}/game/${game.id}`);
  await u.page.waitForSelector('.board');
}

// две комнаты, разделённые сплошной стеной по x = 700; день — видно всё в пределах обзора
const CS = 70;
const ids = await gm.page.evaluate(
  async ([aId, bId, CS]) => {
    const { net, store } = window.__board;
    const pageId = store.ui.pageId;
    await net.update('page', pageId, { lighting: { enabled: true, daylight: true, daylightLevel: 1, restrictMovement: true, darkness: 1 } });
    await net.create('obj', { type: 'wall', wallType: 'wall', pageId, layer: 'walls', pts: [10 * CS, 0, 10 * CS, 20 * CS] });
    const eye = { enabled: true, range: 0, darkvision: 0, angle: 360 };
    const mk = (d) => net.create('obj', { type: 'shape', shape: 'ellipse', pageId, layer: 'objects', w: CS, h: CS, ...d });
    const chA = await net.create('char', { name: 'Аня-персонаж', controlledBy: [aId], inJournals: [aId] });
    const chB = await net.create('char', { name: 'Борис-персонаж', controlledBy: [bId], inJournals: [bId] });
    const chAll = await net.create('char', { name: 'Общий пёс', controlledBy: ['all'], inJournals: ['all'] });
    const ta = await mk({ name: 'Аня', fill: '#c33', x: 3 * CS, y: 5 * CS, represents: chA.id, vision: eye });
    const tb = await mk({ name: 'Борис', fill: '#33c', x: 15 * CS, y: 5 * CS, represents: chB.id, vision: eye });
    const dog = await mk({ name: 'Пёс', fill: '#963', x: 15 * CS, y: 8 * CS, represents: chAll.id, vision: eye });
    const orc = await mk({ name: 'Орк', fill: '#3a3', x: 17 * CS, y: 6 * CS });
    return { a: ta.id, b: tb.id, dog: dog.id, orc: orc.id };
  },
  [a.user.id, b.user.id, CS],
);
await a.page.waitForTimeout(1200);

await step('Аня (другая комната) орка не видит, Борис — видит', async () => {
  await expectHidden(a, ids.orc, true, 'орк за стеной');
  await expectHidden(b, ids.orc, false, 'орк рядом с Борисом');
  // и Бориса Аня не видит: его токен — не её
  await expectHidden(a, ids.b, true, 'Борис за стеной');
  await a.page.screenshot({ path: `${SHOTS}/vision-anya.png` });
  await b.page.screenshot({ path: `${SHOTS}/vision-boris.png` });
});

await step('пёс под управлением «всех игроков» не дает Ане обзор за стеной', async () => {
  // раньше обзор шёл через любой токен, которым игрок может управлять, — и все видели одно и то же
  if (!(await hidden(a, ids.orc))) throw new Error('Аня видит орка глазами общего пса');
});

await step('«Общий обзор» у пса — его глазами смотрят все', async () => {
  await gm.page.evaluate((id) => window.__board.net.update('obj', id, { vision: { shared: true } }), ids.dog);
  await expectHidden(a, ids.orc, false, 'Аня глазами пса');
  await gm.page.evaluate((id) => window.__board.net.update('obj', id, { vision: { shared: false } }), ids.dog);
  await expectHidden(a, ids.orc, true, 'общий обзор выключен');
});

await step('«Общий обзор отряда» на сцене — все видят глазами всех токенов игроков', async () => {
  await gm.page.evaluate(() => {
    const { net, store } = window.__board;
    return net.update('page', store.ui.pageId, { lighting: { ...store.page.lighting, sharedVision: true } });
  });
  await expectHidden(a, ids.orc, false, 'отряд видит вместе');
  await expectHidden(a, ids.b, false, 'Бориса видно отрядом');
  await gm.page.evaluate(() => {
    const { net, store } = window.__board;
    return net.update('page', store.ui.pageId, { lighting: { ...store.page.lighting, sharedVision: false } });
  });
  await expectHidden(a, ids.orc, true, 'каждый снова сам');
});

await step('мастер «глазами: Аня» — орк полупрозрачный, «глазами: Борис» — нет', async () => {
  await gm.page.getByRole('tab', { name: 'Настройки' }).click();
  const sel = gm.page.locator('.settings-panel select').first();
  await sel.selectOption({ label: 'Глазами: Аня' });
  await expectHidden(gm, ids.orc, true, 'мастер глазами Ани', 'unseen-gm');
  await gm.page.screenshot({ path: `${SHOTS}/vision-gm-as-anya.png` });
  await sel.selectOption({ label: 'Глазами: Борис' });
  await expectHidden(gm, ids.orc, false, 'мастер глазами Бориса', 'unseen-gm');
  await sel.selectOption({ label: 'Как мастер — видно всё' });
  await gm.page.waitForFunction(() => !document.querySelector('.obj.unseen-gm'), null, { timeout: 3000 }).catch(() => {
    throw new Error('после выхода остались полупрозрачные');
  });
});

console.log('ошибки:', errors.length ? '\n' + errors.join('\n') : 'нет');
await browser.close();
if (failures.length || errors.length) process.exit(1);
