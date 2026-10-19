// e2e: лист D&D 5E — заполнение, sheet workers, кнопка броска → шаблон в чате
import { chromium } from 'playwright-core';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3000';
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'taverna-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  const t = m.text();
  if ((m.type() === 'error' || m.type() === 'warning') && !t.includes('ERR_TUNNEL') && !t.includes('Failed to load resource')) errors.push(`console.${m.type()}: ${t}`);
});

const step = async (name, fn) => {
  try {
    await fn();
    console.log('✓', name);
  } catch (e) {
    console.log('✗', name, e.message.split('\n')[0]);
    await page.screenshot({ path: `${SHOTS}/fail-${name.replace(/\W+/g, '_')}.png` });
    console.log(errors.slice(0, 20).join('\n'));
    await browser.close();
    process.exit(1);
  }
};

const api = (path, body) =>
  page.evaluate(
    async ([path, body]) => {
      const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Taverna': '1' }, body: body ? JSON.stringify(body) : undefined });
      return r.json();
    },
    [path, body],
  );

await page.goto(BASE);
const uname = 'gm' + Date.now().toString(36);
await api('/api/auth/register', { username: uname, password: 'secret123', displayName: 'Мастер' });
const sheets = (await api('/api/sheets')).sheets;
const sheet = sheets.find((s) => s.sourceRef === 'DD5thEditionLegacy');
const game = (await api('/api/games', { name: '5e тест', sheetId: sheet.id })).game;
await page.goto(`${BASE}/game/${game.id}`);
await page.waitForSelector('.board');

const frame = page.frameLocator('.sheet-frame');

await step('создать персонажа и открыть лист', async () => {
  await page.getByRole('tab', { name: 'Журнал: персонажи и материалы' }).click();
  await page.getByRole('button', { name: 'Персонаж', exact: true }).click();
  await frame.locator('.charsheet').waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);
});

await step('диалог создания: «редактировать вручную»', async () => {
  const cancel = frame.locator('input[name="attr_mancer_cancel"]');
  await cancel.click({ force: true });
  await page.waitForTimeout(1200);
  const flag = await frame.locator('input[name="attr_mancer_confirm_flag"]').getAttribute('value');
  if (flag && flag !== '') throw new Error('mancer_confirm_flag = ' + flag);
});

await step('сила 16 → модификатор +3 (sheet workers)', async () => {
  const inp = frame.locator('.sheet-pc input[name="attr_strength_base"]').first();
  // как в Roll20: поле значения появляется, когда наводишь мышь на овал характеристики
  await frame.locator('.sheet-pc .sheet-attr-mod:has(input[name="attr_strength_base"])').first().hover();
  await inp.fill('16');
  await inp.press('Tab');
  await page.waitForTimeout(1500);
  const mod = await frame.locator('span.sheet-attr[name="attr_strength_mod"]').first().textContent();
  const fin = await frame.locator('span.sheet-finalattr[name="attr_strength"]').first().textContent();
  console.log('   strength =', fin, ' mod =', mod);
  if (String(mod).trim() !== '+3' && String(mod).trim() !== '3') throw new Error('mod=' + mod);
});

await step('кнопка броска «Сила» → шаблон simple в чате', async () => {
  await page.getByRole('tab', { name: 'Чат' }).click();
  await frame.locator('button[name="roll_strength"]').first().click();
  await page.waitForSelector('.sheet-rolltemplate-simple', { timeout: 10000 });
  await page.waitForTimeout(500);
  const html = await page.locator('.sheet-rolltemplate-simple').last().innerHTML();
  console.log('   ', html.replace(/\s+/g, ' ').slice(0, 300));
  await page.screenshot({ path: `${SHOTS}/5e-roll.png` });
});

await step('кнопка броска из листа перетаскивается на панель макросов', async () => {
  const fr = page.frames().find((f) => f.url() === 'about:srcdoc');
  const payload = await fr.evaluate(() => {
    const btn = document.querySelector('button[name="roll_strength"]');
    const dt = new DataTransfer();
    btn.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return dt.getData('application/x-taverna');
  });
  if (!payload.includes('"sheetroll"')) throw new Error('нет данных перетаскивания: ' + payload);
  // панель показывается, пока идут события dragover, и прячется через 0,4 с после последнего —
  // поэтому «навести» и «бросить» делаем подряд, без пауз между вызовами из теста
  await page.evaluate(async (payload) => {
    const mk = () => {
      const dt = new DataTransfer();
      dt.setData('application/x-taverna', payload);
      return dt;
    };
    window.dispatchEvent(new DragEvent('dragover', { dataTransfer: mk(), bubbles: true, cancelable: true }));
    for (let i = 0; i < 30 && !document.querySelector('.macro-bar.drop-ready'); i++) await new Promise((r) => setTimeout(r, 10));
    const bar = document.querySelector('.macro-bar.drop-ready');
    if (!bar) throw new Error('панель макросов не показалась при перетаскивании');
    bar.dispatchEvent(new DragEvent('drop', { dataTransfer: mk(), bubbles: true, cancelable: true }));
  }, payload);
  const btn = page.locator('.macro-bar .mbtn').first();
  await btn.waitFor({ timeout: 3000 });
  console.log('   кнопка на панели:', await btn.textContent());
  const before = await page.locator('.sheet-rolltemplate-simple').count();
  await btn.click();
  await page.waitForFunction((n) => document.querySelectorAll('.sheet-rolltemplate-simple').length > n, before, { timeout: 8000 });
});

await step('масштаб листа', async () => {
  await page.getByRole('button', { name: 'Крупнее' }).click();
  await page.waitForTimeout(200);
  const fr = page.frames().find((f) => f.url() === 'about:srcdoc');
  const z = await fr.evaluate(() => document.body.style.zoom);
  if (z !== '1.1') throw new Error('zoom = ' + z);
  await page.locator('.sheet-zoom .zoom-val').click();
});

await step('печать листа: копия с текущими значениями', async () => {
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'Печать или PDF' }).click()]);
  await popup.waitForLoadState();
  const v = await popup.locator('input[name="attr_strength_base"]').first().getAttribute('value');
  if (v !== '16') throw new Error('сила в печатной копии: ' + v);
  await popup.close();
});

await step('атрибуты через вкладку A&A', async () => {
  await page.getByRole('tab', { name: 'Атрибуты и способности' }).click();
  await page.waitForTimeout(500);
  const n = await page.locator('.attr-table tbody tr').count();
  console.log('   атрибутов:', n);
  await page.getByRole('tab', { name: 'Лист' }).click();
});

console.log('ошибки:', errors.length ? '\n' + errors.slice(0, 30).join('\n') : 'нет');
await page.screenshot({ path: `${SHOTS}/5e-final.png` });
await browser.close();
