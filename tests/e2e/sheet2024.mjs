// e2e: лист D&D 2024 Таверны — расчёты (модификаторы, БМ, навыки, истощение), бросок атаки с мастерством
// и уроном (крит удваивает кости), заклинание со спасброском, кость хитов (бросок меняет хиты), долгий отдых
import { chromium } from 'playwright-core';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:3000';
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'taverna-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
const page = await ctx.newPage();
const errors = [];
const failures = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !/ERR_TUNNEL|Failed to load resource|ERR_CONNECTION/.test(t)) errors.push('console: ' + t.slice(0, 300));
});
async function step(name, fn) {
  try {
    await fn();
    console.log('✓', name);
  } catch (e) {
    console.log('✗', name, '—', e.message.split('\n')[0]);
    failures.push(name);
    await page.screenshot({ path: `${SHOTS}/sheet2024-fail-${failures.length}.png` }).catch(() => {});
  }
}
await page.goto(BASE);
const api = (p, body) =>
  page.evaluate(
    async ([p, body]) => (await fetch(p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Taverna': '1' }, body: body ? JSON.stringify(body) : undefined })).json(),
    [p, body],
  );
await api('/api/auth/register', { username: 'd24' + Date.now().toString(36), password: 'secret123', displayName: 'Мастер' });
const sheet = (await api('/api/sheets')).sheets.find((s) => s.sourceRef === 'DnD2024');
if (!sheet) throw new Error('нет листа DnD2024');
const game = (await api('/api/games', { name: 'D&D 2024', sheetId: sheet.id })).game;
await page.goto(`${BASE}/game/${game.id}`);
await page.waitForSelector('.board');
const charId = await page.evaluate(async () => (await window.__board.net.create('char', { name: 'Ильва' })).id);
await page.getByRole('tab', { name: 'Журнал: персонажи и материалы' }).click();
await page.locator('.j-item', { hasText: 'Ильва' }).click();
await page.frameLocator('.sheet-frame').locator('.sheet').waitFor({ timeout: 30000 });
await page.waitForTimeout(1200);
const fr = page.frames().find((f) => f.url() === 'about:srcdoc');
const text = (name) => fr.evaluate((n) => document.querySelector(`[name="attr_${n}"]`)?.textContent?.trim(), name);
// «x_max» в Roll20 — это максимум атрибута x
const attr = (name) =>
  page.evaluate(
    ([c, n]) => {
      const max = /_max$/i.test(n);
      const a = window.__board.store.getAttr(c, max ? n.slice(0, -4) : n);
      return (max ? a?.max : a?.current) ?? null;
    },
    [charId, name],
  );
/** Формулы бросков последнего сообщения в чате */
const formulas = () => page.evaluate(() => (window.__board.store.messages.at(-1)?.inlinerolls || []).map((r) => r.expression));
async function waitAttr(name, want, what) {
  for (let i = 0; i < 40; i++) {
    if (String(await attr(name)) === String(want)) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`${what}: ${name} = ${await attr(name)}, ожидалось ${want}`);
}
async function fill(name, value) {
  const el = page.frameLocator('.sheet-frame').locator(`[name="attr_${name}"]`).first();
  await el.fill(String(value));
  await el.press('Tab');
}
const click = (sel) => fr.evaluate((s) => document.querySelector(s).click(), sel);
const lastMsg = () => page.locator('.textchatcontainer .message').last();
async function rollAndRead(sel) {
  const before = await page.locator('.textchatcontainer .message').count();
  await click(sel);
  await page.waitForFunction((n) => document.querySelectorAll('.textchatcontainer .message').length > n, before, { timeout: 8000 });
  await page.waitForTimeout(300);
  return lastMsg();
}

await step('характеристики: модификаторы, бонус мастерства по уровню, спасброски и навыки', async () => {
  await fill('strength', 16);
  await fill('dexterity', 14);
  await fill('wisdom', 13);
  await fill('level', 5);
  await waitAttr('pb', 3, 'БМ на 5 уровне');
  if ((await text('strength_mod_txt')) !== '+3') throw new Error('мод. Силы: ' + (await text('strength_mod_txt')));
  await click('input[name="attr_strength_save_prof"]');
  await waitAttr('strength_save', 6, 'спасбросок Силы с владением');
  // Атлетика: нет → владение → компетентность
  await click('button[name="act_prof_athletics"]');
  await waitAttr('athletics_bonus', 6, 'Атлетика с владением');
  await click('button[name="act_prof_athletics"]');
  await waitAttr('athletics_bonus', 9, 'Атлетика с компетентностью');
  await click('button[name="act_prof_perception"]');
  await waitAttr('passive_perception', 14, 'пассивная внимательность');
  if ((await text('initiative_txt')) !== '+2') throw new Error('инициатива: ' + (await text('initiative_txt')));
  // за пятый уровень — пять костей хитов
  await waitAttr('hit_dice_max', 5, 'костей хитов на 5 уровне');
});

await step('истощение 2: к20 −4, скорость 20 фт', async () => {
  await fr.evaluate(() => {
    const s = document.querySelector('select[name="attr_exhaustion"]');
    s.value = '2';
    s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await waitAttr('exh_pen', 4, 'штраф истощения');
  if (!/20/.test(await text('speed_eff'))) throw new Error('скорость: ' + (await text('speed_eff')));
  if (!/−4/.test(await text('exh_note'))) throw new Error('подсказка: ' + (await text('exh_note')));
});

await step('проверка Атлетики в чат: шаблон листа, бонус и штраф истощения в формуле', async () => {
  await page.getByRole('tab', { name: 'Чат' }).click();
  const m = await rollAndRead('button[name="roll_athletics"]');
  const html = await m.innerHTML();
  if (!/sheet-rolltemplate-dnd2024/.test(html)) throw new Error('нет шаблона листа');
  if (!/Атлетика/.test(await m.textContent())) throw new Error('нет названия навыка');
  const [formula] = await formulas();
  if (!/\+ ?9/.test(formula || '') || !/- ?4/.test(formula || '')) throw new Error('формула: ' + formula);
});

await step('атака оружием: +6 к попаданию, урон 1к8+3, мастерство «Опрокидывание» в карточке', async () => {
  await click('button[name="act_tab_core"]');
  await page.frameLocator('.sheet-frame').locator('.attacks .repcontrol_add').click();
  await page.waitForTimeout(400);
  await click('.repcontainer[data-groupname="repeating_attacks"] .repitem button[name="act_toggle"]');
  await page.waitForTimeout(300);
  const row = page.frameLocator('.sheet-frame').locator('.repcontainer[data-groupname="repeating_attacks"] .repitem').first();
  await row.locator('input[name="attr_name"]').fill('Боевой молот');
  await row.locator('input[name="attr_name"]').press('Tab');
  await row.locator('input[name="attr_dmg"]').fill('1d8');
  await row.locator('input[name="attr_dmg"]').press('Tab');
  await row.locator('input[name="attr_dmg_type"]').fill('дробящий');
  await row.locator('input[name="attr_dmg_type"]').press('Tab');
  await row.locator('select[name="attr_mastery"]').selectOption('topple');
  await page.waitForTimeout(600);
  const atk = await row.locator('[name="attr_atk_txt"]').textContent();
  if (atk.trim() !== '+6') throw new Error('бонус атаки: ' + atk);
  const m = await rollAndRead('.repcontainer[data-groupname="repeating_attacks"] .repitem button[name="roll_attack"]');
  const t = await m.textContent();
  if (!/Боевой молот/.test(t) || !/Опрокидывание/.test(t) || !/дробящий/.test(t)) throw new Error('карточка: ' + t.slice(0, 200));
  const rolls = await formulas();
  if (!rolls.some((r) => /^1d8 ?\+ ?3/.test(r))) throw new Error('урон: ' + rolls.join(' | '));
  if (!rolls.some((r) => /^2d8/.test(r))) throw new Error('урон при крите: ' + rolls.join(' | '));
  // урон при крите — кости вдвое: 2к8
  const crit = await attr(`repeating_attacks_${await fr.evaluate(() => document.querySelector('.repcontainer[data-groupname="repeating_attacks"] .repitem').dataset.reprowid)}_dmg_crit`);
  if (!/^2d8/.test(String(crit))) throw new Error('крит: ' + crit);
  await page.screenshot({ path: `${SHOTS}/sheet2024-attack.png` });
});

await step('заклинание со спасброском: Сл 8 + БМ + Мудрость в карточке, кнопка по виду заклинания', async () => {
  await click('button[name="act_tab_spells"]');
  await fr.evaluate(() => {
    const s = document.querySelector('select[name="attr_spell_ability"]');
    s.value = 'wis';
    s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await waitAttr('spell_dc', 12, 'Сл заклинаний (8 + 3 + 1)');
  await page.frameLocator('.sheet-frame').locator('.spells .repcontrol_add').click();
  await page.waitForTimeout(400);
  await click('.repcontainer[data-groupname="repeating_spells"] .repitem button[name="act_toggle"]');
  await page.waitForTimeout(300);
  const row = page.frameLocator('.sheet-frame').locator('.repcontainer[data-groupname="repeating_spells"] .repitem').first();
  await row.locator('input[name="attr_name"]').fill('Священное пламя');
  await row.locator('input[name="attr_name"]').press('Tab');
  await row.locator('select[name="attr_effect"]').selectOption('save');
  await row.locator('input[name="attr_dmg"]').fill('2d8');
  await row.locator('input[name="attr_dmg"]').press('Tab');
  await page.waitForTimeout(500);
  const vis = await fr.evaluate(() => [...document.querySelectorAll('.repcontainer[data-groupname="repeating_spells"] .repitem .sp-roll')].map((b) => getComputedStyle(b).display !== 'none'));
  if (JSON.stringify(vis) !== JSON.stringify([false, false, true])) throw new Error('видимые кнопки: ' + vis);
  await rollAndRead('.repcontainer[data-groupname="repeating_spells"] .repitem button[name="roll_spell_save"]');
  const t = await page.locator('.textchatcontainer .message', { hasText: 'Священное пламя' }).last().textContent();
  if (!/Священное пламя/.test(t) || !/12/.test(t) || !/Ловкость/.test(t)) throw new Error('карточка: ' + t.slice(0, 200));
  await page.screenshot({ path: `${SHOTS}/sheet2024-spells.png` });
});

await step('кость хитов: бросок к8 + Тел восстанавливает хиты, костей меньше', async () => {
  await click('button[name="act_tab_core"]');
  await fill('hp_max', 40);
  await fill('hp', 10);
  await page.waitForTimeout(300);
  const before = await page.locator('.textchatcontainer .message').count();
  await click('button[name="act_spend_hd"]');
  await page.waitForFunction((n) => document.querySelectorAll('.textchatcontainer .message').length > n, before, { timeout: 8000 });
  await waitAttr('hit_dice', 4, 'костей хитов осталось');
  const hp = Number(await attr('hp'));
  if (!(hp >= 11 && hp <= 18)) throw new Error('хиты после кости: ' + hp);
});

await step('долгий отдых: хиты и кости полностью, ячейки, истощение −1', async () => {
  await click('button[name="act_tab_spells"]');
  await fill('slot1', 4);
  await fill('slot1_used', 3);
  await click('button[name="act_tab_core"]');
  await click('button[name="act_long_rest"]');
  await waitAttr('hp', 40, 'хиты');
  await waitAttr('hit_dice', 5, 'кости хитов');
  await waitAttr('slot1_used', 0, 'ячейки');
  await waitAttr('exhaustion', 1, 'истощение');
  await page.screenshot({ path: `${SHOTS}/sheet2024-core.png` });
});

await step('преимущество: бросок 2к20 с отметкой в карточке', async () => {
  await click('button[name="act_mode_adv"]');
  await waitAttr('d20', '2d20kh1', 'режим к20');
  const m = await rollAndRead('button[name="roll_dex_check"]');
  const t = await m.textContent();
  if (!/Преимущество/.test(t)) throw new Error('нет отметки преимущества: ' + t.slice(0, 120));
  const [f] = await formulas();
  if (!/2d20kh1/.test(f || '')) throw new Error('формула: ' + f);
  await click('button[name="act_mode_normal"]');
});

await step('английский язык листа: подписи по-английски', async () => {
  await page.evaluate(() => window.__board.net.request('settings', { sheetLanguage: 'en' }));
  await page.waitForTimeout(2500);
  const fr2 = page.frames().find((f) => f.url() === 'about:srcdoc');
  const label = await fr2.evaluate(() => document.querySelector('button[name="roll_str_check"] span')?.textContent);
  if (label !== 'Strength') throw new Error('подпись: ' + label);
  await page.evaluate(() => window.__board.net.request('settings', { sheetLanguage: 'ru' }));
});

console.log('ошибки:', errors.length ? '\n' + errors.join('\n') : 'нет');
await browser.close();
if (failures.length || errors.length) process.exit(1);
