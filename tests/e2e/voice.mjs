// e2e: голосовой и видеочат — два участника, соединение WebRTC, звук, камера, громкость, выход, переподключение.
// Браузер с поддельными микрофоном и камерой (флаги Chromium).
import { chromium } from 'playwright-core';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:3000';
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'taverna-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME || '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'],
});
const errors = [];
const failures = [];

async function newUser(name) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone', 'camera'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${name}] pageerror: ${e.message}`));
  page.on('console', (m) => {
    const t = m.text();
    if ((m.type() === 'error' || m.type() === 'warning') && !/ERR_TUNNEL|Failed to load resource|ERR_CONNECTION/.test(t)) errors.push(`[${name}] ${m.type()}: ${t.slice(0, 300)}`);
  });
  await page.goto(BASE);
  const api = (p, body) =>
    page.evaluate(
      async ([p, body]) => {
        const r = await fetch(p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Taverna': '1' }, body: body ? JSON.stringify(body) : undefined });
        return r.json();
      },
      [p, body],
    );
  const r = await api('/api/auth/register', { username: 'v' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), password: 'secret123', displayName: name });
  if (!r.user) throw new Error('регистрация: ' + JSON.stringify(r));
  return { ctx, page, api, user: r.user, name };
}

async function step(name, fn) {
  try {
    await fn();
    console.log('✓', name);
  } catch (e) {
    console.log('✗', name, '—', e.message.split('\n')[0]);
    failures.push(name);
    const safe = name.replace(/[^\p{L}\p{N}]+/gu, '_');
    await gm.page.screenshot({ path: `${SHOTS}/voice-fail-${safe}-gm.png` }).catch(() => {});
    await pl.page.screenshot({ path: `${SHOTS}/voice-fail-${safe}-pl.png` }).catch(() => {});
  }
}

/** Состояние голосового чата на странице */
const vstate = (u) =>
  u.page.evaluate(async () => {
    const v = window.__voice;
    const peers = [];
    for (const p of v.peers.values()) {
      let bytesIn = 0,
        videoIn = 0;
      try {
        const st = await p.pc.getStats();
        st.forEach((r) => {
          if (r.type === 'inbound-rtp' && r.kind === 'audio') bytesIn += r.bytesReceived || 0;
          if (r.type === 'inbound-rtp' && r.kind === 'video') videoIn += r.bytesReceived || 0;
        });
      } catch {
        /* нет статистики */
      }
      peers.push({ userId: p.userId, state: p.pc.connectionState, bytesIn, videoIn });
    }
    return { state: v.state, peers, roster: window.__board.store.voiceRoster.length };
  });

async function waitFor(u, pred, what, timeout = 15000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await vstate(u);
    if (pred(last)) return last;
    await u.page.waitForTimeout(300);
  }
  throw new Error(`${what}: ${JSON.stringify(last)}`);
}

const gm = await newUser('Мастер');
const pl = await newUser('Аня');
let game;

await step('подготовка: стол и игрок', async () => {
  game = (await gm.api('/api/games', { name: 'Голосовой чат' })).game;
  const j = await pl.api('/api/games/join', { code: game.inviteCode });
  if (!j.game) throw new Error(JSON.stringify(j));
  for (const u of [gm, pl]) {
    await u.page.goto(`${BASE}/game/${game.id}`);
    await u.page.waitForSelector('.board-world', { state: 'attached' });
  }
});

await step('мастер входит в голосовой чат, игрок видит счётчик', async () => {
  await gm.page.locator('.voice-join').click();
  await gm.page.waitForSelector('.voice-ctl');
  await waitFor(gm, (s) => s.state === 'on', 'мастер не подключился');
  await pl.page.waitForSelector('.voice-count', { timeout: 5000 });
  const n = await pl.page.locator('.voice-count').textContent();
  if (n.trim() !== '1') throw new Error('счётчик: ' + n);
});

await step('игрок подключается — WebRTC-соединение и звук в обе стороны', async () => {
  await pl.page.locator('.voice-join').click();
  const a = await waitFor(pl, (s) => s.peers.length === 1 && s.peers[0].state === 'connected' && s.peers[0].bytesIn > 2000, 'у игрока нет звука мастера');
  const b = await waitFor(gm, (s) => s.peers.length === 1 && s.peers[0].state === 'connected' && s.peers[0].bytesIn > 2000, 'у мастера нет звука игрока');
  console.log('   байт звука: игрок получил', a.peers[0].bytesIn, ', мастер получил', b.peers[0].bytesIn);
});

await step('индикатор речи у собеседника', async () => {
  // поддельный микрофон Chromium пищит раз в секунду
  await gm.page.waitForSelector(`.g-player.speaking`, { timeout: 8000 });
});

await step('настройки устройств: микрофоны и камеры в списке', async () => {
  await gm.page.getByRole('button', { name: 'Микрофон и камера' }).click();
  const dlg = gm.page.getByRole('dialog', { name: 'Микрофон и камера' });
  await dlg.waitFor({ timeout: 4000 });
  await dlg.locator('select').first().waitFor();
  const mics = await dlg.locator('select').first().locator('option').count();
  if (mics < 2) throw new Error('микрофонов в списке: ' + (mics - 1));
  await gm.page.keyboard.press('Escape');
});

await step('игрок включает камеру — у мастера появляется видео', async () => {
  await pl.page.getByRole('button', { name: 'Включить камеру' }).click();
  await gm.page.waitForSelector('.video-tile:not(.self) video', { timeout: 10000 });
  await gm.page.waitForFunction(() => {
    const v = document.querySelector('.video-tile:not(.self) video');
    return v && v.videoWidth > 0;
  }, null, { timeout: 10000 });
  const self = await pl.page.locator('.video-tile.self').count();
  if (!self) throw new Error('у игрока нет своего превью');
  await gm.page.screenshot({ path: `${SHOTS}/voice-video.png` });
});

await step('игрок выключает микрофон — мастер видит значок', async () => {
  await pl.page.getByRole('button', { name: /Выключить микрофон/ }).click();
  await gm.page.waitForSelector('.g-player .voice-badge', { timeout: 5000 });
  const t = await pl.page.evaluate(() => window.__voice.micTrack()?.enabled);
  if (t !== false) throw new Error('дорожка микрофона не выключена');
});

await step('громкость собеседника: ползунок и «заглушить у себя»', async () => {
  await gm.page.locator('.g-player.as-btn').first().click();
  await gm.page.waitForSelector('.voice-pop input[type=range]');
  await gm.page.getByRole('button', { name: 'Заглушить у себя' }).click();
  const muted = await gm.page.evaluate(() => [...window.__voice.peers.values()][0].audioEl.muted);
  if (!muted) throw new Error('звук не заглушён');
  await gm.page.getByRole('button', { name: 'Вернуть звук' }).click();
  await gm.page.keyboard.press('Escape');
});

await step('переподключение мастера — голосовой чат восстанавливается сам', async () => {
  await gm.page.evaluate(() => window.__board.net.socket.io.engine.close());
  await waitFor(gm, (s) => s.state === 'on' && s.peers.length === 1 && s.peers[0].state === 'connected', 'мастер не вернулся в голосовой чат', 25000);
  await waitFor(pl, (s) => s.peers.length === 1 && s.peers[0].state === 'connected', 'игрок не переподключился к мастеру', 15000);
});

await step('тот же игрок во второй вкладке — чат переезжает, без эха', async () => {
  const tab2 = await pl.ctx.newPage();
  tab2.on('pageerror', (e) => errors.push('[вкладка 2] ' + e.message));
  await tab2.goto(`${BASE}/game/${game.id}`);
  await tab2.waitForSelector('.board-world', { state: 'attached' });
  await tab2.locator('.voice-join').click();
  await tab2.waitForSelector('.voice-ctl');
  // первая вкладка вышла из чата сама
  await pl.page.waitForSelector('.voice-join', { timeout: 8000 });
  await waitFor(gm, (s) => s.peers.length === 1 && s.peers[0].state === 'connected' && s.roster === 2, 'у мастера не один собеседник', 15000);
  await tab2.locator('[aria-label="Выйти из голосового чата"]').click();
  await waitFor(gm, (s) => s.peers.length === 0 && s.roster === 1, 'у мастера остался собеседник после выхода второй вкладки');
  await tab2.close();
  // снова входим из первой вкладки — для следующего шага
  await pl.page.locator('.voice-join').click();
  await waitFor(gm, (s) => s.peers.length === 1 && s.peers[0].state === 'connected', 'игрок не вернулся в чат');
});

await step('игрок выходит — у мастера пусто', async () => {
  await pl.page.getByRole('button', { name: 'Выйти из голосового чата' }).click();
  await waitFor(gm, (s) => s.peers.length === 0 && s.roster === 1, 'у мастера остался собеседник');
  const camOff = await pl.page.evaluate(() => !window.__voice.camera && !window.__voice.local);
  if (!camOff) throw new Error('камера или микрофон игрока не освобождены');
});

console.log('ошибки:', errors.length ? '\n' + errors.slice(0, 30).join('\n') : 'нет');
await browser.close();
if (failures.length) {
  console.log('Провалено:', failures.join('; '));
  process.exit(1);
}
