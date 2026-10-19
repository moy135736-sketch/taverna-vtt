// e2e: маркеры и эффекты — свой маркер с картинкой и изменениями атрибутов, «+» у выделенного токена,
// число (уровень) и срок в раундах, снятие по сроку с откатом, эффекты на полосах токена
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
  const r = await api('/api/auth/register', { username: 'ef' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), password: 'secret123', displayName: name });
  return { page, api, user: r.user };
}
async function step(name, fn) {
  try {
    await fn();
    console.log('✓', name);
  } catch (e) {
    console.log('✗', name, '—', e.message.split('\n').slice(0, 4).join(' | '));
    failures.push(name);
    const n = failures.length;
    await gm?.page.screenshot({ path: `${SHOTS}/effects-fail-${n}-gm.png` }).catch(() => {});
    await pl?.page.screenshot({ path: `${SHOTS}/effects-fail-${n}-pl.png` }).catch(() => {});
  }
}
async function waitFor(page, fn, arg, what, timeout = 6000) {
  try {
    await page.waitForFunction(fn, arg, { timeout });
  } catch {
    throw new Error(what);
  }
}
/** Значение атрибута у этого клиента (атрибуты подгружаются) */
const attr = (page, charId, name) =>
  page.evaluate(
    async ([charId, name]) => {
      const { net, store } = window.__board;
      await net.ensureAttrs(charId);
      return store.getAttr(charId, name)?.current ?? null;
    },
    [charId, name],
  );
async function waitAttr(page, charId, name, want, what) {
  for (let i = 0; i < 40; i++) {
    if (String(await attr(page, charId, name)) === String(want)) return;
    await page.waitForTimeout(150);
  }
  throw new Error(`${what}: ${name} = ${await attr(page, charId, name)}, ожидалось ${want}`);
}
const marker = (page, objId, id) => page.evaluate(([o, id]) => (window.__board.store.col.obj.get(o)?.markers || []).find((m) => (m.id || m) === id) || null, [objId, id]);
const select = (page, id) => page.evaluate((id) => window.__board.store.setSelection([id]), id);

let gm, pl;
gm = await newUser('Мастер');
pl = await newUser('Игрок');
const game = (await gm.api('/api/games', { name: 'Эффекты' })).game;
await pl.api('/api/games/join', { code: game.inviteCode });
await gm.page.goto(`${BASE}/game/${game.id}`);
await pl.page.goto(`${BASE}/game/${game.id}`);
await gm.page.waitForSelector('.board');
await pl.page.waitForSelector('.board');
await gm.page.evaluate(() => window.__board.store.setTool('select'));

const ids = await gm.page.evaluate(async (plId) => {
  const { net, store } = window.__board;
  const pageId = store.ui.pageId;
  const ch = await net.create('char', { name: 'Тарен', controlledBy: [plId], inJournals: [plId] });
  net.setAttrs(ch.id, [
    { name: 'ac', current: '15', max: '' },
    { name: 'speed', current: '30', max: '' },
  ]);
  const t = await net.create('obj', { type: 'shape', shape: 'ellipse', fill: '#2d4e9b', pageId, layer: 'objects', x: 560, y: 280, w: 70, h: 70, name: 'Тарен', represents: ch.id });
  const g = await net.create('obj', {
    type: 'shape',
    shape: 'ellipse',
    fill: '#2d9b4e',
    pageId,
    layer: 'objects',
    x: 420,
    y: 420,
    w: 70,
    h: 70,
    name: 'Гоблин',
    bars: [{ id: 'b1', name: 'HP', value: '10', max: '10', color: '#d63a3a', link: '', visibility: 'all', editable: 'owners', showText: 'always' }],
  });
  return { ch: ch.id, t: t.id, g: g.id };
}, pl.user.id);
await gm.page.waitForTimeout(500);

let shield;
await step('свой маркер с картинкой и эффектом: «Щит веры» — КД +2 на 2 раунда', async () => {
  await gm.page.getByRole('tab', { name: 'Настройки' }).click();
  await gm.page.getByRole('button', { name: 'Свой маркер' }).click();
  const dlg = gm.page.locator('.marker-editor');
  await dlg.waitFor();
  await dlg.getByLabel('Название', { exact: true }).fill('Щит веры');
  await dlg.locator('input[type=file]').setInputFiles(new URL('./assets/map.png', import.meta.url).pathname);
  await waitFor(gm.page, () => !!document.querySelector('.marker-editor .mk-head .mk-look img'), null, 'картинка не загрузилась');
  await dlg.getByLabel('Длительность').selectOption('r');
  await dlg.getByLabel('Сколько', { exact: true }).fill('2');
  await dlg.getByRole('button', { name: 'Изменение' }).click();
  await dlg.getByLabel('Что менять').fill('ac');
  await dlg.getByLabel('Значение или формула').fill('2');
  await gm.page.screenshot({ path: `${SHOTS}/effects-editor.png` });
  await dlg.getByRole('button', { name: 'Сохранить' }).click();
  await waitFor(gm.page, () => (window.__board.store.settings.markers || []).some((m) => m.name === 'Щит веры'), null, 'маркер не сохранён');
  shield = await gm.page.evaluate(() => window.__board.store.settings.markers.find((m) => m.name === 'Щит веры'));
  if (!shield.image || shield.rounds !== 2 || shield.changes?.[0]?.key !== 'ac' || shield.changes[0].mode !== 'add' || shield.changes[0].value !== '2') throw new Error(JSON.stringify(shield));
});

await step('«+» у выделенного токена → «Щит веры»: КД 15 → 17, на значке 2 раунда', async () => {
  await select(gm.page, ids.t);
  await gm.page.locator('.mk-hud .mk-add').click();
  await gm.page.locator('.mk-picker .mk-icon', { hasText: 'Щит веры' }).click();
  await waitFor(gm.page, ([o, id]) => (window.__board.store.col.obj.get(o)?.markers || []).some((m) => m.id === id), [ids.t, shield.id], 'маркер не поставлен');
  await waitAttr(gm.page, ids.ch, 'ac', 17, 'КД у мастера');
  await waitAttr(pl.page, ids.ch, 'ac', 17, 'КД у игрока');
  await gm.page.keyboard.press('Escape');
  const r = await pl.page.evaluate(([o, id]) => document.querySelector(`.obj[data-oid="${o}"] .tok-marker[data-marker="${id}"] .tok-marker-rounds`)?.textContent, [ids.t, shield.id]);
  if (r !== '2') throw new Error('на значке у игрока: ' + r);
  const img = await pl.page.evaluate(([o, id]) => !!document.querySelector(`.obj[data-oid="${o}"] .tok-marker[data-marker="${id}"] img`), [ids.t, shield.id]);
  if (!img) throw new Error('у игрока нет картинки маркера');
  await select(gm.page, ids.t);
  await gm.page.screenshot({ path: `${SHOTS}/effects-hud.png` });
});

await step('два раунда по порядку ходов — эффект снялся сам, КД снова 15', async () => {
  await gm.page.evaluate((t) => window.__board.net.request('turn', { t: 'add', tokenId: t, pr: 10 }), ids.t);
  await gm.page.evaluate(() => window.__board.net.request('turn', { t: 'next' }));
  await gm.page.waitForTimeout(300);
  if (!(await marker(gm.page, ids.t, shield.id))) throw new Error('снялся раньше срока');
  await waitAttr(gm.page, ids.ch, 'ac', 17, 'после первого раунда');
  await gm.page.evaluate(() => window.__board.net.request('turn', { t: 'next' }));
  await waitFor(gm.page, ([o, id]) => !(window.__board.store.col.obj.get(o)?.markers || []).some((m) => m.id === id), [ids.t, shield.id], 'не снялся по сроку');
  await waitAttr(pl.page, ids.ch, 'ac', 15, 'КД не вернулся');
  await gm.page.getByRole('tab', { name: 'Чат' }).click();
  await waitFor(gm.page, () => [...document.querySelectorAll('.textchatcontainer .message')].some((m) => m.textContent.includes('Закончился эффект «Щит веры»')), null, 'нет сообщения о конце эффекта');
});

let tired;
await step('уровень на маркере: «Усталость» скорость −5 × уровень', async () => {
  tired = await gm.page.evaluate(async () => {
    const s = window.__board.store.settings;
    const def = { id: 'm-tired', name: 'Усталость', icon: 'exhaustion', changes: [{ key: 'speed', mode: 'add', value: '-5', perLevel: true }] };
    await window.__board.net.request('settings', { markers: [...(s.markers || []), def] });
    return def;
  });
  // игрок ставит на своего персонажа и меняет число в окошке маркера
  await pl.page.evaluate(() => window.__board.store.setTool('select'));
  await select(pl.page, ids.t);
  await pl.page.locator('.mk-hud .mk-add').click();
  await pl.page.locator('.mk-picker .mk-icon', { hasText: 'Усталость' }).click();
  await waitAttr(pl.page, ids.ch, 'speed', 25, 'уровень 1 (пусто)');
  await pl.page.keyboard.press('Escape');
  await pl.page.locator('.mk-hud .mk-chip:not(.mk-add)').first().click();
  await pl.page.locator('.mk-pop').waitFor();
  const n = pl.page.getByLabel('Число на маркере');
  await n.waitFor();
  await n.fill('3');
  await n.press('Enter');
  await waitAttr(pl.page, ids.ch, 'speed', 15, 'уровень 3');
  await pl.page.locator('.mk-pop').getByRole('button', { name: 'Меньше', exact: true }).click();
  await waitAttr(gm.page, ids.ch, 'speed', 20, 'уровень 2');
  const m = await marker(gm.page, ids.t, 'm-tired');
  if (String(m?.n) !== '2') throw new Error('число на маркере: ' + JSON.stringify(m));
  await pl.page.screenshot({ path: `${SHOTS}/effects-level.png` });
  await pl.page.locator('.mk-pop').getByRole('button', { name: 'Снять' }).click();
  await waitAttr(gm.page, ids.ch, 'speed', 30, 'после снятия');
});

await step('эффект на полосе токена без анкеты: «Яд» bar1 −3', async () => {
  await gm.page.evaluate(async () => {
    const s = window.__board.store.settings;
    await window.__board.net.request('settings', { markers: [...(s.markers || []), { id: 'm-poison', name: 'Яд', icon: 'poisoned', changes: [{ key: 'bar1', mode: 'add', value: '-3' }] }] });
  });
  await select(gm.page, ids.g);
  await gm.page.locator('.mk-hud .mk-add').click();
  await gm.page.locator('.mk-picker .mk-icon', { hasText: 'Яд' }).click();
  await waitFor(pl.page, (g) => window.__board.store.col.obj.get(g)?.bars[0].value === '7', ids.g, 'полоса не уменьшилась');
  // в контекстном меню маркер отмечен; снимаем оттуда
  await gm.page.keyboard.press('Escape');
  const box = await gm.page.locator('.board').boundingBox();
  const c = await gm.page.evaluate((g) => {
    const b = window.__board;
    const o = b.store.col.obj.get(g);
    return b.worldToScreen(o.x + o.w / 2, o.y + o.h / 2);
  }, ids.g);
  await gm.page.mouse.click(box.x + c.x, box.y + c.y, { button: 'right' });
  await gm.page.locator('.ctx-menu > .ctx-item', { hasText: 'Маркеры состояния' }).click();
  const item = gm.page.locator('.ctx-sub .ctx-item', { hasText: 'Яд' });
  if (!(await item.evaluate((e) => e.classList.contains('checked')))) throw new Error('в меню не отмечен');
  await item.click();
  await waitFor(pl.page, (g) => window.__board.store.col.obj.get(g)?.bars[0].value === '10', ids.g, 'полоса не вернулась');
});

await step('снять маркер может только один: двойное снятие не откатывает дважды', async () => {
  await gm.page.evaluate(async (t) => {
    const s = window.__board.store.settings;
    await window.__board.net.request('settings', { markers: [...(s.markers || []), { id: 'm-ac', name: 'Броня', icon: 'shield', changes: [{ key: 'ac', mode: 'add', value: '1' }] }] });
  }, ids.t);
  await select(gm.page, ids.t);
  await gm.page.locator('.mk-hud .mk-add').click();
  await gm.page.locator('.mk-picker .mk-icon', { hasText: 'Броня' }).click();
  await waitAttr(gm.page, ids.ch, 'ac', 16, 'не поставилась');
  await gm.page.keyboard.press('Escape');
  // одновременно снимают мастер и игрок
  await Promise.all([
    gm.page.evaluate((t) => window.__board.net.request('marker', { t: 'remove', objId: t, markerId: 'm-ac' }), ids.t),
    pl.page.evaluate((t) => window.__board.net.request('marker', { t: 'remove', objId: t, markerId: 'm-ac' }), ids.t),
  ]).then(async ([a, b]) => {
    const got = [a, b].filter((r) => r.removed);
    if (got.length !== 1) throw new Error('сняли оба: ' + JSON.stringify([a, b]));
  });
});

console.log('ошибки:', errors.length ? '\n' + errors.join('\n') : 'нет');
await browser.close();
if (failures.length || errors.length) process.exit(1);
