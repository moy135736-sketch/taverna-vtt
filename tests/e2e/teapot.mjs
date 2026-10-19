// e2e: «Режим чайника» и облегчённая отрисовка — кнопка в главном меню и переключатель за столом,
// сразу во всех вкладках; оформление без анимации, плоские кубики, без эффектов бросков, эффекты токенов без движения,
// лёгкая погода. В обычном режиме — искры и звёзды «Фэнтези» ступеньками по 15 смен в секунду, двери не пересоздаются.
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
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
async function step(name, fn) {
  try {
    await fn();
    console.log('✓', name);
  } catch (e) {
    console.log('✗', name, '—', e.message.split('\n').slice(0, 4).join(' | '));
    failures.push(name);
    await page.screenshot({ path: `${SHOTS}/teapot-fail-${failures.length}.png` }).catch(() => {});
  }
}
async function waitFor(fn, arg, what, timeout = 8000) {
  try {
    await page.waitForFunction(fn, arg, { timeout });
  } catch {
    throw new Error(what);
  }
}
const api = (p, body) =>
  page.evaluate(async ([p, body]) => (await fetch(p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Taverna': '1' }, body: body ? JSON.stringify(body) : undefined })).json(), [p, body]);
/** Бесконечные анимации, которые сейчас идут (оформление, эффекты) */
const running = () => page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getComputedTiming?.().iterations === Infinity).length);
const potBtn = () => page.locator('.lobby-nav .teapot-btn');

await page.goto(BASE);
// объёмные кубики и в песочнице без видеокарты, и полная анимация оформления — как на игровом ноутбуке
await page.evaluate(() => {
  localStorage.setItem('tv:dice3d', 'force');
  localStorage.setItem('tv:themeMotion', 'full');
});
await api('/api/auth/register', { username: 'tp' + Date.now().toString(36), password: 'secret123', displayName: 'Мастер' });
const demo = await api('/api/games/demo', {});
const gameId = demo.game.id;

await step('главное меню: «Режим чайника» включается кнопкой — класс на странице, запоминается на устройстве', async () => {
  await page.goto(BASE);
  await potBtn().waitFor();
  if (!/выкл/.test(await potBtn().innerText())) throw new Error('кнопка: ' + (await potBtn().innerText()));
  await potBtn().click();
  await waitFor(() => document.documentElement.classList.contains('teapot'), null, 'нет класса teapot');
  if (!/вкл/.test(await potBtn().innerText()) || (await potBtn().getAttribute('aria-pressed')) !== 'true') throw new Error('кнопка не включилась');
  await page.locator('.toast', { hasText: 'Режим чайника включён' }).waitFor();
  if ((await page.evaluate(() => localStorage.getItem('tv:teapot'))) !== '1') throw new Error('не запомнилось');
  await page.reload();
  await potBtn().waitFor();
  if (!(await page.evaluate(() => document.documentElement.classList.contains('teapot')))) throw new Error('после перезагрузки выключен');
});

await step('за столом в чайнике: оформление «Фэнтези» неподвижно — ни одной бесконечной анимации', async () => {
  await page.goto(`${BASE}/game/${gameId}`);
  await page.waitForSelector('.board');
  await page.evaluate(() => {
    for (const b of document.querySelectorAll('.gm-start button')) if (/Скрыть/.test(b.textContent)) b.click();
  });
  await waitFor(() => document.documentElement.dataset.theme === 'fantasy' && document.documentElement.classList.contains('theme-still'), null, 'нет «Фэнтези» без анимации');
  await page.waitForTimeout(800);
  const n = await running();
  if (n) throw new Error('идут анимации: ' + n);
  if (await page.locator('.fx-mote').first().isVisible()) throw new Error('искры видны');
});

await step('бросок в чайнике: кубики плоские в углу, без эффекта в чате', async () => {
  const rolls0 = await page.evaluate(() => window.__dice3d?.rolls || 0);
  await page.getByRole('tab', { name: 'Чат' }).click();
  await page.locator('.chat-text').fill('/r 2d20');
  await page.locator('.chat-text').press('Enter');
  await page.locator('.dice-anim-tray').waitFor({ timeout: 5000 });
  await page.waitForTimeout(1200);
  if ((await page.evaluate(() => window.__dice3d?.rolls || 0)) !== rolls0) throw new Error('кубики объёмные');
  if (await page.locator('.rfx').count()) throw new Error('эффект броска в чате');
});

await step('эффекты токенов в чайнике — без движения (горение и пульсация видны, но не анимированы), кольцо хода не крутится', async () => {
  const id = await page.evaluate(async () => {
    const { store, net } = window.__board;
    const o = [...store.col.obj.values()].find((x) => x.pageId === store.ui.pageId && x.type === 'image' && x.layer === 'objects');
    await net.update('obj', o.id, { effects: { burning: true, pulse: true } });
    await net.request('turn', { t: 'set', turnorder: [{ id: 't1', tokenId: o.id, pr: 12 }] });
    return o.id;
  });
  await page.waitForSelector(`[data-oid="${id}"] .fx-burning`);
  await page.waitForTimeout(500);
  const st = await page.evaluate((id) => {
    const c = document.querySelector(`[data-oid="${id}"] .obj-content`);
    const cs = getComputedStyle(c);
    return { anim: cs.animationName, filter: cs.filter };
  }, id);
  if (st.anim !== 'none' || !/drop-shadow/.test(st.filter)) throw new Error('эффект: ' + JSON.stringify(st));
  const ring = await page.evaluate(() => {
    const r = document.querySelector('.turn-ring');
    return r ? getComputedStyle(r).animationName : 'нет кольца';
  });
  if (ring !== 'none') throw new Error('кольцо: ' + ring);
  if (await running()) throw new Error('идут анимации: ' + (await running()));
});

await step('погода в чайнике: меньше капель и 20 кадров в секунду', async () => {
  await page.evaluate(async () => {
    const { store, net, fx } = window.__board;
    const orig = fx.ctx.clearRect.bind(fx.ctx);
    window.__fxDraws = 0;
    fx.ctx.clearRect = (...a) => {
      window.__fxDraws++;
      return orig(...a);
    };
    await net.update('page', store.ui.pageId, { weather: { type: 'rain', intensity: 0.6 } });
  });
  await page.waitForTimeout(800);
  const d0 = await page.evaluate(() => window.__fxDraws);
  await page.waitForTimeout(2000);
  const d1 = await page.evaluate(() => window.__fxDraws);
  const fps = (d1 - d0) / 2;
  const parts = await page.evaluate(() => window.__board.fx.weather.parts.length);
  const W = await page.evaluate(() => window.__board.fx.canvas.width * window.__board.fx.canvas.height);
  const full = Math.round(380 * 0.6 * (W / (1280 * 720)));
  if (fps > 23 || fps < 12) throw new Error('кадров в секунду: ' + fps);
  if (parts > full * 0.5) throw new Error(`капель ${parts} из ${full}`);
});

await step('за столом: переключатель «Режим чайника» в «Для меня»; выключили — «Фэнтези» снова живое, искры ступеньками по 15 смен в секунду', async () => {
  await page.getByRole('tab', { name: /Настройки/ }).first().click();
  const t = page.locator('.toggle', { hasText: 'Режим чайника' });
  await t.waitFor();
  if (!(await t.locator('input').isChecked())) throw new Error('переключатель выключен');
  if (!(await page.locator('.toggle', { hasText: 'Анимация оформления' }).locator('input').isDisabled())) throw new Error('«Анимация оформления» доступна в чайнике');
  await t.click();
  await waitFor(() => !document.documentElement.classList.contains('teapot') && !document.documentElement.classList.contains('theme-still'), null, 'чайник не выключился');
  await page.locator('.toast', { hasText: 'Режим чайника выключен' }).waitFor();
  await page.waitForTimeout(600);
  const info = await page.evaluate(() => {
    const anims = document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.target?.classList?.contains('fx-mote'));
    const easing = anims.map((a) => a.effect.getTiming().easing);
    return { motes: anims.length, stepped: easing.every((e) => /^steps\(/.test(e)), rates: [...new Set(anims.map((a) => Math.round(Number(/steps\((\d+)/.exec(a.effect.getTiming().easing)?.[1]) / (a.effect.getTiming().duration / 1000))))] };
  });
  if (info.motes !== 22 || !info.stepped || info.rates.join() !== '15') throw new Error('искры: ' + JSON.stringify(info));
  // эффекты токенов снова двигаются (горение — ступеньками)
  const burn = await page.evaluate(() => getComputedStyle(document.querySelector('.fx-burning')).animationTimingFunction);
  if (!/steps\(9/.test(burn)) throw new Error('горение: ' + burn);
});

await step('другая вкладка: включили чайник в главном меню — стол в первой вкладке облегчается сам', async () => {
  const p2 = await ctx.newPage();
  await p2.goto(BASE);
  await p2.locator('.lobby-nav .teapot-btn').click();
  await waitFor(() => document.documentElement.classList.contains('teapot') && document.documentElement.classList.contains('theme-still'), null, 'стол не узнал о чайнике');
  await page.waitForTimeout(500);
  if (await running()) throw new Error('анимации остались: ' + (await running()));
  await p2.locator('.lobby-nav .teapot-btn').click();
  await waitFor(() => !document.documentElement.classList.contains('teapot'), null, 'стол не узнал о выключении');
  await p2.close();
});

await step('двери: кнопки не пересоздаются при движении карты и открывают дверь', async () => {
  await page.evaluate(async () => {
    const { store, net } = window.__board;
    await net.update('page', store.ui.pageId, { weather: { type: 'none' } });
  });
  const btn = page.locator('.door-btn').first();
  await btn.waitFor();
  const n = await page.locator('.door-btn').count();
  await page.evaluate(() => {
    window.__doorEl = document.querySelector('.door-btn');
  });
  // карту двигают
  await page.evaluate(async () => {
    const b = window.__board;
    for (let i = 0; i < 20; i++) {
      b.cam = { ...b.cam, x: b.cam.x + 3, y: b.cam.y + 1 };
      b.applyCamera();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  if (!(await page.evaluate(() => document.querySelector('.door-btn') === window.__doorEl))) throw new Error('кнопка пересоздана');
  if ((await page.locator('.door-btn').count()) !== n) throw new Error('число дверей изменилось');
  // кнопка там, где дверь: середина двери на экране
  const off = await page.evaluate(() => {
    const b = window.__board;
    const el = window.__doorEl;
    const r = el.getBoundingClientRect();
    const root = b.root.getBoundingClientRect();
    const doors = b.pageObjects().filter((o) => o.type === 'wall' && o.wallType === 'door');
    const best = Math.min(
      ...doors.map((d) => {
        const p = d.pts;
        const s = b.worldToScreen((p[0] + p[p.length - 2]) / 2, (p[1] + p[p.length - 1]) / 2);
        return Math.hypot(root.left + s.x - (r.left + r.width / 2), root.top + s.y - (r.top + r.height / 2));
      }),
    );
    return best;
  });
  if (off > 2) throw new Error('кнопка смещена на ' + off.toFixed(1) + ' px');
  const before = await btn.getAttribute('class');
  await btn.click();
  await waitFor((b) => document.querySelector('.door-btn')?.getAttribute('class') !== b, before, 'дверь не открылась');
  await btn.click();
  await waitFor((b) => document.querySelector('.door-btn')?.getAttribute('class') === b, before, 'дверь не закрылась');
});

console.log('ошибки:', errors.length ? '\n' + errors.join('\n') : 'нет');
await browser.close();
if (failures.length || errors.length) process.exit(1);
