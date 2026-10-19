// e2e: оформление стола — само по листу (D&D → «Фэнтези», Cyberpunk → «Киберпанк»), выбор мастера для всех,
// своё оформление игрока, выключение анимации, новые сообщения чата помечаются, вне стола оформление снимается
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

async function newUser(name, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 860 }, ...opts });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
  await page.goto(BASE);
  const api = (p, body) =>
    page.evaluate(
      async ([p, body]) => (await fetch(p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Taverna': '1' }, body: body ? JSON.stringify(body) : undefined })).json(),
      [p, body],
    );
  const r = await api('/api/auth/register', { username: 'th' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), password: 'secret123', displayName: name });
  return { page, api, user: r.user };
}
async function step(name, fn) {
  try {
    await fn();
    console.log('✓', name);
  } catch (e) {
    console.log('✗', name, '—', e.message.split('\n')[0]);
    failures.push(name);
    await gm?.page.screenshot({ path: `${SHOTS}/themes-fail-${failures.length}.png` }).catch(() => {});
  }
}
const themeOf = (page) => page.evaluate(() => document.documentElement.dataset.theme || 'tavern');
const waitTheme = (page, t) => page.waitForFunction((t) => (document.documentElement.dataset.theme || 'tavern') === t, t, { timeout: 4000 });
async function open(u, gameId) {
  await u.page.goto(`${BASE}/game/${gameId}`);
  await u.page.waitForSelector('.board');
}

let gm, pl;
gm = await newUser('Мастер');
pl = await newUser('Игрок');
const sheets = (await gm.api('/api/sheets')).sheets;
const dnd = sheets.find((s) => s.sourceRef === 'DnD2024');
const cp = sheets.find((s) => /cyberpunk/i.test(s.sourceRef));
const game = (await gm.api('/api/games', { name: 'Летопись', sheetId: dnd.id })).game;
await pl.api('/api/games/join', { code: game.inviteCode });

await step('лист D&D — «Фэнтези» само, с живым слоем за картой', async () => {
  await open(gm, game.id);
  await waitTheme(gm.page, 'fantasy');
  const motes = await gm.page.locator('.fx-ambient .fx-mote').count();
  if (motes < 10) throw new Error('искр: ' + motes);
  const font = await gm.page.evaluate(() => getComputedStyle(document.querySelector('.g-title')).fontFamily);
  if (!/Cormorant Unicase/.test(font)) throw new Error('шрифт заголовка: ' + font);
});

await step('без видеокарты искры не летят (облегчённо), с «full» — летят', async () => {
  // браузер тестов рисует программно: искры и мерцание звёзд должны выключиться сами, свеча — остаться
  const st = await gm.page.evaluate(() => ({
    lite: document.documentElement.classList.contains('theme-lite'),
    rise: document.getAnimations().filter((a) => a.effect?.target?.classList?.contains('fx-mote')).length,
    candle: document.getAnimations().filter((a) => a.animationName === 'fx-candle').length,
  }));
  if (!st.lite || st.rise || !st.candle) throw new Error(JSON.stringify(st));
  await gm.page.evaluate(() => localStorage.setItem('tv:themeMotion', 'full'));
  await open(gm, game.id);
  await waitTheme(gm.page, 'fantasy');
  // искры летят из ThemeDecor (Web Animations) ступеньками по 15 смен в секунду
  const rise = await gm.page.evaluate(() =>
    document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.target?.classList?.contains('fx-mote') && /^steps\(/.test(a.effect.getTiming().easing)).length,
  );
  if (rise !== 22 || (await gm.page.evaluate(() => document.documentElement.classList.contains('theme-lite')))) throw new Error('с full искры не движутся: ' + rise);
  await gm.page.evaluate(() => localStorage.removeItem('tv:themeMotion'));
});

await step('новое сообщение в чате помечено как свежее, история — нет', async () => {
  await gm.page.locator('.chat-text').fill('/r 1d20');
  await gm.page.locator('.chat-text').press('Enter');
  await gm.page.waitForSelector('.msg-wrap.fresh .message.rollresult', { timeout: 4000 });
  await gm.page.reload();
  await gm.page.waitForSelector('.message.rollresult');
  if (await gm.page.locator('.msg-wrap.fresh').count()) throw new Error('история помечена свежей');
});

await step('мастер выбирает «Киберпанк» — у игрока тоже', async () => {
  await open(pl, game.id);
  await waitTheme(pl.page, 'fantasy');
  await gm.page.getByRole('tab', { name: 'Настройки' }).click();
  await gm.page.getByLabel('Оформление стола').selectOption('cyber');
  await waitTheme(gm.page, 'cyber');
  await waitTheme(pl.page, 'cyber');
  if (await gm.page.locator('.fx-ambient').count()) throw new Error('слой «Фэнтези» остался');
  const font = await gm.page.evaluate(() => getComputedStyle(document.querySelector('.g-title')).fontFamily);
  if (!/Tektur/.test(font)) throw new Error('шрифт заголовка: ' + font);
  await gm.page.screenshot({ path: `${SHOTS}/themes-cyber.png` });
});

await step('игрок оставляет себе «Таверну» — у мастера по-прежнему «Киберпанк»', async () => {
  await pl.page.getByRole('tab', { name: 'Настройки' }).click();
  await pl.page.getByLabel('Оформление для меня').selectOption('tavern');
  await waitTheme(pl.page, 'tavern');
  if ((await themeOf(gm.page)) !== 'cyber') throw new Error('у мастера сменилось');
  await pl.page.reload();
  await pl.page.waitForSelector('.board');
  await pl.page.waitForTimeout(300);
  if ((await themeOf(pl.page)) !== 'tavern') throw new Error('выбор игрока не сохранился');
  await pl.page.getByRole('tab', { name: 'Настройки' }).click();
  await pl.page.getByLabel('Оформление для меня').selectOption('');
  await waitTheme(pl.page, 'cyber');
});

await step('«Анимация оформления» выключается — живое замирает', async () => {
  await gm.page.getByLabel('Оформление стола').selectOption('fantasy');
  await waitTheme(gm.page, 'fantasy');
  await gm.page.locator('.toggle', { hasText: 'Анимация оформления' }).click();
  await gm.page.waitForFunction(() => document.documentElement.classList.contains('theme-still'), null, { timeout: 3000 });
  const running = await gm.page.evaluate(() => document.getAnimations().filter((a) => /^fx-/.test(a.animationName || '') || a.effect?.target?.closest?.('.fx-ambient')).length);
  if (running) throw new Error('анимаций осталось: ' + running);
  await gm.page.locator('.toggle', { hasText: 'Анимация оформления' }).click();
  await gm.page.waitForFunction(() => !document.documentElement.classList.contains('theme-still'), null, { timeout: 3000 });
});

await step('«По листу» снова — «Фэнтези»; вне стола оформление снимается', async () => {
  await gm.page.getByLabel('Оформление стола').selectOption('auto');
  await waitTheme(gm.page, 'fantasy');
  await gm.page.locator('.g-back').click();
  await gm.page.waitForSelector('.lobby');
  if ((await themeOf(gm.page)) !== 'tavern') throw new Error('в лобби осталось ' + (await themeOf(gm.page)));
});

await step('стол с листом Cyberpunk RED — «Киберпанк» само', async () => {
  const g2 = (await gm.api('/api/games', { name: 'Найт-Сити', sheetId: cp.id })).game;
  await open(gm, g2.id);
  await waitTheme(gm.page, 'cyber');
  const r = await gm.page.evaluate(() => window.__board.net.request('settings', { theme: 'нечто' }));
  if (r?.error) throw new Error(r.error);
  await gm.page.waitForTimeout(300);
  const t = await gm.page.evaluate(() => window.__board.store.settings.theme);
  if (t !== 'auto') throw new Error('сервер принял неизвестное оформление: ' + t);
});

await step('«Киберпанк» после загрузки: панели и чат на месте, анимаций входа больше нет', async () => {
  await gm.page.waitForTimeout(2800);
  const st = await gm.page.evaluate(() => {
    const vis = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return 'нет';
      const cs = getComputedStyle(el);
      return cs.opacity === '1' && cs.visibility !== 'hidden' && (cs.clipPath === 'none' || cs.clipPath === 'inset(0px)') ? 'да' : `opacity ${cs.opacity}, clip ${cs.clipPath}`;
    };
    return { tools: vis('.g-tools'), side: vis('.sidebar'), top: vis('.g-top'), boot: document.querySelector('.game').classList.contains('theme-boot'), anims: document.getAnimations().filter((a) => /^cy-/.test(a.animationName || '')).length };
  });
  if (st.tools !== 'да' || st.side !== 'да' || st.top !== 'да' || st.boot || st.anims) throw new Error(JSON.stringify(st));
});

await step('без листа и с обычным названием — «Таверна»', async () => {
  const g3 = (await gm.api('/api/games', { name: 'Вечер четверга' })).game;
  await open(gm, g3.id);
  await gm.page.waitForTimeout(300);
  if ((await themeOf(gm.page)) !== 'tavern') throw new Error(await themeOf(gm.page));
});

console.log('ошибки:', errors.length ? '\n' + errors.join('\n') : 'нет');
await browser.close();
if (failures.length || errors.length) process.exit(1);
