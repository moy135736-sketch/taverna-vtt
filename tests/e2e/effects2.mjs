// e2e: эффекты 2.0 — готовые эффекты, формулы (13 + @{dexterity_mod}, 2d4 + 4 бросает сервер), «дописать к тексту»,
// свет/размер/невидимость самого токена, сроки «до начала следующего хода», урон каждый ход и спасбросок,
// кнопка «Наложить» под заклинанием в чате, просьба игрока через мастера, концентрация, /effect
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
  const r = await api('/api/auth/register', { username: 'fx' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), password: 'secret123', displayName: name });
  return { page, api, user: r.user };
}
let gm, pl;
async function step(name, fn) {
  try {
    await fn();
    console.log('✓', name);
  } catch (e) {
    console.log('✗', name, '—', e.message.split('\n').slice(0, 4).join(' | '));
    failures.push(name);
    const n = failures.length;
    await gm?.page.screenshot({ path: `${SHOTS}/effects2-fail-${n}-gm.png` }).catch(() => {});
    await pl?.page.screenshot({ path: `${SHOTS}/effects2-fail-${n}-pl.png` }).catch(() => {});
  }
}
async function waitFor(page, fn, arg, what, timeout = 8000) {
  try {
    await page.waitForFunction(fn, arg, { timeout });
  } catch {
    throw new Error(what);
  }
}
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
  for (let i = 0; i < 50; i++) {
    if (String(await attr(page, charId, name)) === String(want)) return;
    await page.waitForTimeout(150);
  }
  throw new Error(`${what}: ${name} = ${await attr(page, charId, name)}, ожидалось ${want}`);
}
const obj = (page, id) => page.evaluate((id) => window.__board.store.col.obj.get(id), id);
const marker = (page, objId, id) => page.evaluate(([o, id]) => (window.__board.store.col.obj.get(o)?.markers || []).find((m) => (m.id || m) === id) || null, [objId, id]);
const waitMarker = (page, objId, id, on, what) => waitFor(page, ([o, id, on]) => (window.__board.store.col.obj.get(o)?.markers || []).some((m) => (m.id || m) === id) === on, [objId, id, on], what);
const select = (page, ids) => page.evaluate((ids) => window.__board.store.setSelection(ids), ids);
const lastMsg = (page, re) =>
  page.evaluate((src) => {
    const re = new RegExp(src);
    return [...window.__board.store.messages].reverse().find((m) => re.test(m.content || '')) || null;
  }, re.source);
async function waitMsg(page, re, what) {
  await waitFor(page, (src) => window.__board.store.messages.some((m) => new RegExp(src).test(m.content || '')), re.source, what);
  return lastMsg(page, re);
}
async function center(page, id) {
  const box = await page.locator('.board').boundingBox();
  const p = await page.evaluate((id) => {
    const b = window.__board;
    const o = b.store.col.obj.get(id);
    return b.worldToScreen(o.x + o.w / 2, o.y + o.h / 2);
  }, id);
  return { x: box.x + p.x, y: box.y + p.y };
}
/** Маркер через «+» у выделенного токена */
async function hudAdd(page, tokenId, name) {
  await page.evaluate(() => window.__board.store.setTool('select'));
  await select(page, [tokenId]);
  await page.locator('.mk-hud .mk-add').click();
  await page.locator('.mk-picker .mk-icon', { hasText: name }).first().click();
  await page.keyboard.press('Escape');
}
async function chat(page, text) {
  await page.getByRole('tab', { name: 'Чат' }).click();
  await page.locator('.chat-text').fill(text);
  await page.locator('.chat-text').press('Enter');
}
const turn = (op) => gm.page.evaluate((op) => window.__board.net.request('turn', op), op);

gm = await newUser('Мастер');
pl = await newUser('Игрок');
const game = (await gm.api('/api/games', { name: 'Эффекты 2' })).game;
await pl.api('/api/games/join', { code: game.inviteCode });
await gm.page.goto(`${BASE}/game/${game.id}`);
await pl.page.goto(`${BASE}/game/${game.id}`);
await gm.page.waitForSelector('.board');
await pl.page.waitForSelector('.board');
await gm.page.evaluate(() => window.__board.store.setTool('select'));

const hp = (id, v) => [{ id, name: 'HP', value: String(v), max: String(v), color: '#d63a3a', link: '', visibility: 'all', editable: 'owners', showText: 'always' }];
const ids = await gm.page.evaluate(
  async ([plId, tb, gb]) => {
    const { net, store } = window.__board;
    const pageId = store.ui.pageId;
    const ch = await net.create('char', { name: 'Тарен', controlledBy: [plId], inJournals: [plId] });
    net.setAttrs(ch.id, [
      { name: 'ac', current: '15', max: '' },
      { name: 'dexterity_mod', current: '3', max: '' },
      { name: 'constitution_save', current: '30', max: '' },
      { name: 'global_attack', current: '2', max: '' },
      { name: 'hp_temp', current: '0', max: '' },
    ]);
    const t = await net.create('obj', { type: 'shape', shape: 'ellipse', fill: '#2d4e9b', pageId, layer: 'objects', x: 560, y: 280, w: 70, h: 70, name: 'Тарен', represents: ch.id, controlledBy: [plId], bars: tb });
    const g = await net.create('obj', { type: 'shape', shape: 'ellipse', fill: '#2d9b4e', pageId, layer: 'objects', x: 420, y: 420, w: 70, h: 70, name: 'Гоблин', bars: gb });
    return { ch: ch.id, t: t.id, g: g.id };
  },
  [pl.user.id, hp('t1', 20), hp('g1', 10)],
);
await pl.page.waitForFunction((id) => window.__board.store.col.obj.has(id), ids.g);

await step('«Готовые эффекты…»: мастер отмечает девять и добавляет к столу', async () => {
  await gm.page.getByRole('tab', { name: 'Настройки' }).click();
  await gm.page.getByRole('button', { name: 'Готовые эффекты…' }).click();
  const dlg = gm.page.locator('.effect-library');
  await dlg.waitFor();
  const names = ['Благословение', 'Доспехи мага', 'Ложная жизнь', 'Щит', 'Увеличение', 'Свет', 'Невидимость', 'Горение', 'Яд (каждый ход)'];
  for (const n of names) {
    const re = new RegExp('^' + n.replace(/[()]/g, '\\$&') + '$');
    await dlg
      .locator('.fxl-item')
      .filter({ has: gm.page.locator('.fxl-title').filter({ hasText: re }) })
      .locator('input')
      .check();
  }
  await gm.page.screenshot({ path: `${SHOTS}/effects2-library.png` });
  await dlg.getByRole('button', { name: 'Добавить' }).click();
  await waitFor(gm.page, () => (window.__board.store.settings.markers || []).length === 9, null, 'добавились не все');
  const got = await gm.page.evaluate(() => window.__board.store.settings.markers.map((m) => m.id).sort());
  const want = ['lib-bless', 'lib-burning', 'lib-enlarge', 'lib-false-life', 'lib-invisibility', 'lib-light', 'lib-mage-armor', 'lib-poison', 'lib-shield'];
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(JSON.stringify(got));
  const sys = await gm.page.evaluate(() => window.__board.store.settings.markers.some((m) => 'sys' in m));
  if (sys) throw new Error('в описании осталось служебное поле sys');
  // список эффектов в настройках — с описанием
  const li = await gm.page.locator('.custom-markers li', { hasText: 'Доспехи мага' }).textContent();
  if (!/ac = 13 \+ @\{dexterity_mod\}/.test(li)) throw new Error('описание: ' + li);
});

await step('формула: «Доспехи мага» — КД = 13 + @{dexterity_mod} = 16, сняли — снова 15', async () => {
  await hudAdd(pl.page, ids.t, 'Доспехи мага');
  await waitAttr(pl.page, ids.ch, 'ac', 16, 'КД с доспехами мага');
  await waitAttr(gm.page, ids.ch, 'ac', 16, 'КД у мастера');
  await select(pl.page, [ids.t]);
  await pl.page.locator('.mk-hud .mk-chip:not(.mk-add)').first().click();
  await pl.page.locator('.mk-pop').getByRole('button', { name: 'Снять' }).click();
  await waitAttr(pl.page, ids.ch, 'ac', 15, 'КД после снятия');
});

await step('«дописать к тексту»: «Благословение» — к атакам «2» → «2+1d4», сняли — снова «2»', async () => {
  await hudAdd(pl.page, ids.t, 'Благословение');
  await waitAttr(pl.page, ids.ch, 'global_attack', '2+1d4', 'дописалось');
  await waitAttr(pl.page, ids.ch, 'global_save', '1d4', 'к пустому полю');
  const e = await marker(gm.page, ids.t, 'lib-bless');
  if (e?.applied?.[0]?.mode !== 'append') throw new Error('сервер не сохранил append: ' + JSON.stringify(e));
  if (e.conc) throw new Error('без наложившего концентрации быть не должно');
  await select(pl.page, [ids.t]);
  await pl.page.locator('.mk-hud .mk-chip:not(.mk-add)').first().click();
  await pl.page.locator('.mk-pop').getByRole('button', { name: 'Снять' }).click();
  await waitAttr(pl.page, ids.ch, 'global_attack', '2', 'после «Снять»');
  await waitAttr(pl.page, ids.ch, 'global_save', '', 'пустое поле после «Снять»');
});

await step('кубики бросает сервер: «Ложная жизнь» — временные хиты = выпавшее 2d4 + 4 из чата', async () => {
  await hudAdd(pl.page, ids.t, 'Ложная жизнь');
  const m = await waitMsg(pl.page, /name=Ложная жизнь: Тарен/, 'нет броска в чате');
  const rolled = m.inlinerolls?.[0]?.total;
  if (!(rolled >= 6 && rolled <= 12)) throw new Error('бросок: ' + JSON.stringify(m.inlinerolls));
  await waitAttr(pl.page, ids.ch, 'hp_temp', rolled, 'временные хиты');
  await waitAttr(gm.page, ids.ch, 'hp_temp', rolled, 'временные хиты у мастера');
  await select(pl.page, [ids.t]);
  await pl.page.locator('.mk-hud .mk-chip:not(.mk-add)').first().click();
  await pl.page.locator('.mk-pop').getByRole('button', { name: 'Снять' }).click();
  await waitAttr(pl.page, ids.ch, 'hp_temp', 0, 'после снятия');
});

await step('/effect: «Свет» и «Увеличение» на гоблина — свет включился, токен вдвое больше от центра', async () => {
  await select(gm.page, [ids.g]);
  await chat(gm.page, '/effect Свет');
  await waitFor(pl.page, (g) => window.__board.store.col.obj.get(g)?.light?.enabled === true, ids.g, 'свет не включился');
  const o1 = await obj(pl.page, ids.g);
  if (o1.light.bright !== 20 || o1.light.dim !== 20) throw new Error('свет: ' + JSON.stringify(o1.light));
  await select(gm.page, [ids.g]);
  await chat(gm.page, '/effect Увеличение');
  await waitFor(pl.page, (g) => window.__board.store.col.obj.get(g)?.w === 140, ids.g, 'не вырос');
  const o2 = await obj(pl.page, ids.g);
  if (o2.x !== 385 || o2.y !== 385 || o2.h !== 140) throw new Error('место: ' + JSON.stringify([o2.x, o2.y, o2.w, o2.h]));
  await gm.page.screenshot({ path: `${SHOTS}/effects2-token.png` });
  await select(gm.page, [ids.g]);
  await chat(gm.page, '/effect Свет --remove');
  await waitFor(pl.page, (g) => window.__board.store.col.obj.get(g)?.light?.enabled === false, ids.g, 'свет не выключился');
  await select(gm.page, [ids.g]);
  await chat(gm.page, '/эффект увеличение --снять');
  await waitFor(pl.page, (g) => window.__board.store.col.obj.get(g)?.w === 70, ids.g, 'размер не вернулся');
  const o3 = await obj(pl.page, ids.g);
  if (o3.x !== 420 || o3.y !== 420) throw new Error('место после: ' + JSON.stringify([o3.x, o3.y]));
});

await step('«Невидимость» на гоблине: игрок его не видит, сняли — видит', async () => {
  await select(gm.page, [ids.g]);
  await chat(gm.page, '/effect Невидимость');
  await waitFor(pl.page, (g) => getComputedStyle(document.querySelector(`.obj[data-oid="${g}"]`)).visibility === 'hidden', ids.g, 'игрок видит невидимого');
  await select(gm.page, [ids.g]);
  await chat(gm.page, '/effect Невидимость --remove');
  await waitFor(pl.page, (g) => getComputedStyle(document.querySelector(`.obj[data-oid="${g}"]`)).visibility !== 'hidden', ids.g, 'игрок не видит после снятия');
});

await step('«Щит» до начала следующего хода: держится ход гоблина, снимается в начале хода Тарена', async () => {
  await turn({ t: 'add', tokenId: ids.t, pr: 20 });
  await turn({ t: 'add', tokenId: ids.g, pr: 10 });
  await turn({ t: 'sort' });
  const first = await gm.page.evaluate(() => window.__board.store.state.turnorder[0]?.tokenId);
  if (first !== ids.t) throw new Error('первым ходит не Тарен');
  await hudAdd(pl.page, ids.t, 'Щит');
  await waitAttr(pl.page, ids.ch, 'ac', 20, 'КД со щитом');
  const e = await marker(gm.page, ids.t, 'lib-shield');
  if (e?.ends?.when !== 'start') throw new Error('срок: ' + JSON.stringify(e));
  await turn({ t: 'next' }); // ход гоблина
  await gm.page.waitForTimeout(800);
  if (!(await marker(gm.page, ids.t, 'lib-shield'))) throw new Error('снялся в ход гоблина');
  await turn({ t: 'next' }); // снова Тарен
  await waitMarker(gm.page, ids.t, 'lib-shield', false, 'не снялся в начале хода');
  await waitAttr(pl.page, ids.ch, 'ac', 15, 'КД после щита');
});

await step('«Горение» на гоблине: в начале его хода бросок урона в чат и хиты меньше', async () => {
  await select(gm.page, [ids.g]);
  await chat(gm.page, '/effect Горение');
  await waitMarker(gm.page, ids.g, 'lib-burning', true, 'не поставилось');
  await turn({ t: 'next' }); // ход гоблина начался
  const m = await waitMsg(gm.page, /name=Горение: Гоблин/, 'нет броска «Горение»');
  const dmg = m.inlinerolls?.[0]?.total;
  if (!(dmg >= 1 && dmg <= 4)) throw new Error('урон: ' + JSON.stringify(m.inlinerolls));
  await waitFor(pl.page, ([g, v]) => window.__board.store.col.obj.get(g)?.bars?.[0]?.value === String(v), [ids.g, 10 - dmg], `хиты гоблина не ${10 - dmg}`);
  // ход повторно не срабатывает (второй мастер или переподключение)
  const again = await gm.page.evaluate((seq) => window.__board.net.request('effects:turn', { seq }), await gm.page.evaluate(() => window.__board.store.state.lastTurn.seq));
  if (again?.ok) throw new Error('ход сработал дважды');
  await select(gm.page, [ids.g]);
  await chat(gm.page, '/effect Горение --remove');
  await waitMarker(gm.page, ids.g, 'lib-burning', false, 'не снялось');
});

await step('«Яд (каждый ход)»: в конце хода Тарена урон и спасбросок — удачный снимает яд', async () => {
  await hudAdd(gm.page, ids.t, 'Яд (каждый ход)');
  await waitMarker(gm.page, ids.t, 'lib-poison', true, 'не поставился');
  await turn({ t: 'next' }); // начался ход Тарена
  await gm.page.waitForTimeout(600);
  if (!(await marker(gm.page, ids.t, 'lib-poison'))) throw new Error('снялся в начале хода');
  await turn({ t: 'next' }); // ход Тарена закончился
  const m = await waitMsg(gm.page, /name=Яд \(каждый ход\): Тарен/, 'нет броска яда');
  const dmg = m.inlinerolls?.[0]?.total;
  const save = m.inlinerolls?.[1]?.total;
  if (!(dmg >= 1 && dmg <= 6) || !(save >= 31)) throw new Error('броски: ' + JSON.stringify(m.inlinerolls?.map((r) => r.total)));
  await waitFor(pl.page, ([t, v]) => window.__board.store.col.obj.get(t)?.bars?.[0]?.value === String(v), [ids.t, 20 - dmg], `хиты Тарена не ${20 - dmg}`);
  await waitMarker(gm.page, ids.t, 'lib-poison', false, 'удачный спасбросок не снял яд');
  await waitMsg(gm.page, /«Яд \(каждый ход\)» у «Тарен» закончился: спасбросок/, 'нет сообщения о конце яда');
});

let blessMsgCount = 0;
async function castBless() {
  // игрок от имени Тарена бросает заклинание — под ним кнопка «Наложить «Благословение»»
  await pl.page.getByRole('tab', { name: 'Чат' }).click();
  await pl.page.locator('.chat-input select').selectOption({ label: 'Тарен' });
  await pl.page.locator('.chat-text').fill('&{template:default} {{name=Bless}} {{Цели=до трёх существ}}');
  await pl.page.locator('.chat-text').press('Enter');
  blessMsgCount++;
  await waitFor(pl.page, (n) => document.querySelectorAll('.fx-apply-btn').length >= n, blessMsgCount, 'нет кнопки «Наложить»');
  await select(pl.page, []);
  await pl.page.locator('.fx-apply-btn', { hasText: 'Благословение' }).last().click();
  await pl.page.locator('.board.targeting, .targeting').first().waitFor({ timeout: 3000 });
  const c = await center(pl.page, ids.g);
  await pl.page.mouse.click(c.x, c.y);
}

await step('кнопка «Наложить» под заклинанием: игрок выбирает чужого гоблина — эффект ставит мастер, у Тарена концентрация', async () => {
  await castBless();
  await waitMarker(gm.page, ids.g, 'lib-bless', true, 'мастер не наложил «Благословение» на гоблина');
  const e = await marker(gm.page, ids.g, 'lib-bless');
  if (e.src !== ids.t || !e.conc) throw new Error('кто наложил: ' + JSON.stringify(e));
  await waitMarker(pl.page, ids.t, 'concentration', true, 'у Тарена нет маркера «Концентрация»');
  await waitMsg(gm.page, /Игрок накладывает «Благословение»: Гоблин/, 'мастеру не пришло сообщение');
  await pl.page.screenshot({ path: `${SHOTS}/effects2-chat-button.png` });
});

await step('урон по концентрирующемуся — напоминание о спасброске Телосложения', async () => {
  await select(gm.page, [ids.t]);
  await chat(gm.page, '/r 8');
  await gm.page.locator('.textchatcontainer .message').last().locator('.rolled').first().click();
  await gm.page.locator('.ctx-menu .ctx-item', { hasText: 'Урон −8' }).first().click();
  await waitMsg(gm.page, /name=Концентрация: Тарен.*Сл 10/, 'нет напоминания о концентрации');
});

await step('концентрацию сняли — «Благословение» кончилось и у гоблина', async () => {
  await select(pl.page, [ids.t]);
  await pl.page.locator('.mk-hud .mk-chip', { has: pl.page.locator('.mk-look', { hasText: '🧠' }) }).click();
  await pl.page.locator('.mk-pop').getByRole('button', { name: 'Снять' }).click();
  await waitMarker(gm.page, ids.g, 'lib-bless', false, 'у гоблина осталось «Благословение»');
  await waitMsg(gm.page, /Закончился эффект «Благословение» у «Гоблин» \(концентрация\)/, 'нет сообщения о конце концентрации');
});

await step('одна концентрация: Тарен накладывает «Невидимость» — прежнее «Благословение» кончается', async () => {
  await castBless();
  await waitMarker(gm.page, ids.g, 'lib-bless', true, 'второе «Благословение» не наложено');
  await select(pl.page, [ids.t]);
  await chat(pl.page, '/effect Невидимость');
  await waitMarker(gm.page, ids.t, 'lib-invisibility', true, 'невидимость не наложена');
  const e = await marker(gm.page, ids.t, 'lib-invisibility');
  if (!e.conc || e.src !== ids.t) throw new Error('невидимость: ' + JSON.stringify(e));
  await waitMarker(gm.page, ids.g, 'lib-bless', false, '«Благословение» не кончилось');
  if (!(await marker(gm.page, ids.t, 'concentration'))) throw new Error('пропал маркер «Концентрация»');
});

await step('мастер запретил — просьба игрока на чужой токен отклоняется', async () => {
  await gm.page.getByRole('tab', { name: 'Настройки' }).click();
  await gm.page.locator('.toggle', { hasText: 'Игроки накладывают эффекты на чужие токены' }).click();
  await waitFor(pl.page, () => window.__board.store.settings.playersApplyEffects === false, null, 'настройка не дошла');
  const r = await pl.page.evaluate((g) => window.__board.net.request('effect:ask', { effectId: 'lib-light', targets: [g] }), ids.g);
  if (!r?.error || !/не разрешил/.test(r.error)) throw new Error(JSON.stringify(r));
});

await step('редактор: длительность, концентрация, каждый ход — сохраняются и открываются как были', async () => {
  await gm.page.locator('.custom-markers li', { hasText: 'Горение' }).getByRole('button').click();
  const dlg = gm.page.locator('.marker-editor');
  await dlg.waitFor();
  if ((await dlg.getByLabel('Когда действует').inputValue()) !== 'start') throw new Error('«каждый ход» не открылся');
  if ((await dlg.getByLabel('Сколько хитов, формула').inputValue()) !== '1d4') throw new Error('формула урона');
  await dlg.getByLabel('Длительность').selectOption('min');
  await dlg.getByLabel('Сколько', { exact: true }).fill('1');
  await dlg.locator('.mk-check input').check();
  await dlg.getByLabel('Другие названия').fill('Burning, Огонь');
  await dlg.getByLabel('Спасбросок, формула').fill('1d20 + @{dexterity_save}');
  await dlg.getByLabel('Сложность спасброска').fill('10');
  await gm.page.screenshot({ path: `${SHOTS}/effects2-editor.png` });
  await dlg.getByRole('button', { name: 'Сохранить' }).click();
  await waitFor(gm.page, () => window.__board.store.settings.markers.find((m) => m.id === 'lib-burning')?.rounds === 10, null, 'не сохранилось');
  const d = await gm.page.evaluate(() => window.__board.store.settings.markers.find((m) => m.id === 'lib-burning'));
  if (!d.conc || d.alias !== 'Burning, Огонь' || d.turn?.hp !== '-1d4' || d.turn?.save?.dc !== 10 || d.turn?.when !== 'start' || d.icon !== 'burning') throw new Error(JSON.stringify(d));
});

console.log('ошибки:', errors.length ? '\n' + errors.join('\n') : 'нет');
await browser.close();
if (failures.length || errors.length) process.exit(1);
