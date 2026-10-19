// Дымовой e2e-тест: регистрация, стол, доска, лист 5e, бросок из листа.
// Запуск: node tests/e2e/smoke.mjs (сервер на http://localhost:3000)
import { chromium } from 'playwright-core';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:3000';
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'taverna-shots');
import fs from 'node:fs';
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`console.${m.type()}: ${m.text()}`);
});

const step = async (name, fn) => {
  try {
    await fn();
    console.log('✓', name);
  } catch (e) {
    console.log('✗', name, e.message);
    await page.screenshot({ path: `${SHOTS}/fail-${name.replace(/\W+/g, '_')}.png` });
    throw e;
  }
};

const uname = 'gm' + Date.now().toString(36);
await step('регистрация', async () => {
  await page.goto(BASE);
  await page.getByRole('tab', { name: 'Регистрация' }).click();
  await page.getByLabel('Логин').fill(uname);
  await page.getByLabel('Имя за столом').fill('Мастер');
  await page.getByLabel('Пароль', { exact: true }).fill('secret123');
  await page.getByLabel('Пароль ещё раз').fill('secret123');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByRole('heading', { name: 'Ваши столы' }).waitFor();
  await page.screenshot({ path: `${SHOTS}/01-lobby.png` });
});

await step('создание стола с листом 5e', async () => {
  await page.getByLabel('Название').fill('Тестовый стол');
  await page.getByLabel('Лист персонажа').selectOption({ label: 'D&D 5E by Roll20 (2014, OGL)' });
  await page.getByRole('button', { name: 'Создать стол' }).click();
  await page.waitForSelector('.board', { timeout: 15000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/02-game.png` });
});

await step('мастер видит «С чего начать»', async () => {
  const card = page.locator('.gm-start');
  await card.waitFor({ timeout: 5000 });
  const done = await card.locator('li.done').count();
  if (done !== 0) throw new Error('за пустым столом уже отмечено пунктов: ' + done);
  // «Положите карту» открывает библиотеку картинок
  await card.getByRole('button', { name: /Положите карту/ }).click();
  const sel = await page.getByRole('tab', { name: 'Библиотека картинок' }).getAttribute('aria-selected');
  if (sel !== 'true') throw new Error('библиотека картинок не открылась');
  await page.getByRole('tab', { name: 'Чат' }).click();
});

await step('чат: бросок', async () => {
  await page.getByLabel('Сообщение в чат').fill('/r 2d20kh1+5');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.message.rollresult');
  await page.getByLabel('Сообщение в чат').fill('&{template:default} {{name=Атака}} {{Бросок=[[1d20+7]]}} {{Урон=[[2d6+4]]}}');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.sheet-rolltemplate-default');
});

await step('персонаж и лист', async () => {
  await page.getByRole('tab', { name: 'Журнал: персонажи и материалы' }).click();
  await page.getByRole('button', { name: 'Персонаж', exact: true }).click();
  await page.waitForSelector('.sheet-frame', { timeout: 20000 });
  const frame = page.frameLocator('.sheet-frame');
  await frame.locator('.charsheet').waitFor({ timeout: 20000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOTS}/03-sheet.png` });
  // пункт «Создайте персонажа» отмечается сам
  await page.locator('.gm-start li.done', { hasText: 'Создайте персонажа' }).waitFor({ timeout: 5000 });
});

await step('игрок по ссылке-приглашению: регистрация и сразу за стол', async () => {
  const code = await page.evaluate(async () => {
    const id = location.pathname.split('/').pop();
    const r = await fetch('/api/games/' + id);
    return (await r.json()).game.inviteCode;
  });
  const ctx2 = await browser.newContext({ viewport: { width: 1300, height: 850 } });
  const p2 = await ctx2.newPage();
  await p2.goto(`${BASE}/join/${code}`);
  await p2.locator('.auth-invite').waitFor();
  await p2.getByLabel('Логин').fill('pl' + Date.now().toString(36));
  await p2.getByLabel('Имя за столом').fill('Игрок');
  await p2.getByLabel('Пароль', { exact: true }).fill('secret123');
  await p2.getByLabel('Пароль ещё раз').fill('secret123');
  await p2.getByRole('button', { name: 'Создать аккаунт' }).click();
  await p2.waitForSelector('.board', { timeout: 15000 });
  if (!/\/game\//.test(p2.url())) throw new Error('адрес: ' + p2.url());
  await p2.waitForTimeout(500);
  if (await p2.locator('.gm-start').count()) throw new Error('игрок видит подсказку мастера');
  await ctx2.close();
  // игрок за столом — отмечено у мастера
  await page.locator('.gm-start li.done', { hasText: 'Позовите игроков' }).waitFor({ timeout: 5000 });
});

await step('«Скрыть» убирает подсказку насовсем', async () => {
  await page.locator('.char-win').getByRole('button', { name: 'Закрыть' }).click();
  await page.locator('.gm-start').getByRole('button', { name: 'Скрыть' }).click();
  await page.reload();
  await page.waitForSelector('.board', { timeout: 15000 });
  await page.waitForTimeout(800);
  if (await page.locator('.gm-start').count()) throw new Error('подсказка вернулась после перезагрузки');
});

console.log('ошибки страницы:', errors.length ? '\n' + errors.slice(0, 30).join('\n') : 'нет');
await browser.close();
