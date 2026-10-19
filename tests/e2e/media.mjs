// e2e: сжатие загрузок (переключатель в главном меню; картинки → WebP, анимации/видео/звук → WebM,
// оригинал — если браузер не справился) и чёткость доски после приближения.
// Тестовые файлы делаются здесь же через ffmpeg и Python (Pillow).
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:3000';
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'taverna-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const FIX = fs.mkdtempSync(path.join(os.tmpdir(), 'taverna-media-'));
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const errors = [];
const failures = [];

// ---------------- тестовые файлы ----------------
const ff = (...args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe' });
const F = (n) => path.join(FIX, n);
ff('-f', 'lavfi', '-i', 'testsrc2=size=1600x1000:rate=1', '-frames:v', '1', F('карта.png'));
ff('-f', 'lavfi', '-i', 'testsrc2=size=48x40:rate=1', '-frames:v', '1', F('значок.bmp'));
ff('-f', 'lavfi', '-i', 'sine=frequency=330:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-filter_complex', 'amerge=inputs=2', '-ar', '44100', F('дождь.wav'));
ff('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=3', '-t', '3', '-c:v', 'libvpx', '-b:v', '6M', '-c:a', 'libvorbis', '-b:a', '192k', F('ролик.mkv'));
ff('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-b:v', '3M', F('h264.mp4'));
// анимация с прозрачностью: пёстрая картинка в круге (такие GIF тяжёлые, видео — нет)
ff('-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=12', '-t', '2', F('кадр-%02d.png'));
execFileSync('python3', [
  '-c',
  `
import glob
from PIL import Image, ImageDraw
frames = []
for p in sorted(glob.glob(r'${F('кадр-')}*.png')):
    im = Image.open(p).convert('RGBA')
    mask = Image.new('L', im.size, 0)
    ImageDraw.Draw(mask).ellipse((40, 10, 280, 230), fill=255)
    im.putalpha(mask)
    frames.append(im)
frames[0].save(r'${F('огонёк.gif')}', save_all=True, append_images=frames[1:], duration=83, loop=0, disposal=2)
`,
]);
for (const n of fs.readdirSync(FIX)) if (n.startsWith('кадр-')) fs.rmSync(F(n));
const sizes = Object.fromEntries(fs.readdirSync(FIX).map((n) => [n, fs.statSync(F(n)).size]));
console.log('файлы:', JSON.stringify(sizes));

// ---------------- помощники ----------------
// файл передаём содержимым: путь с кириллицей браузер в контейнере не открывает, а имя должно дойти как есть
const MIME = { png: 'image/png', bmp: 'image/bmp', gif: 'image/gif', wav: 'audio/wav', mkv: 'video/x-matroska', mp4: 'video/mp4' };
const payload = (n) => ({ name: n, mimeType: MIME[n.split('.').pop()], buffer: fs.readFileSync(F(n)) });
async function newUser(name) {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 860 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
  page.on('console', (m) => /сжатие/.test(m.text()) && console.log('   [браузер]', m.text().slice(0, 300)));
  await page.goto(BASE);
  const api = (p, body, method) =>
    page.evaluate(
      async ([p, body, method]) => (await fetch(p, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', 'X-Taverna': '1' }, body: body ? JSON.stringify(body) : undefined })).json(),
      [p, body, method],
    );
  const r = await api('/api/auth/register', { username: 'md' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), password: 'secret123', displayName: name });
  return { page, api, user: r.user };
}
async function step(name, fn) {
  try {
    await fn();
    console.log('✓', name);
  } catch (e) {
    console.log('✗', name, '—', e.message.split('\n')[0]);
    failures.push(name);
    await gm?.page.screenshot({ path: `${SHOTS}/media-fail-${failures.length}.png` }).catch(() => {});
  }
}
/** Загрузить файлы в библиотеку картинок и дождаться, пока появятся новые; вернуть их описания */
async function uploadArt(page, api, gameId, names, timeout = 60000) {
  const before = new Set(((await api(`/api/assets?gameId=${gameId}`)).assets || []).map((a) => a.id));
  await page.locator('input[type=file][accept="image/*,video/*"]').first().setInputFiles(names.map(payload));
  const t0 = Date.now();
  for (;;) {
    const now = (await api(`/api/assets?gameId=${gameId}`)).assets || [];
    const fresh = now.filter((a) => !before.has(a.id));
    if (fresh.length >= names.length) return fresh;
    if (Date.now() - t0 > timeout) throw new Error(`загрузилось ${fresh.length} из ${names.length}`);
    await page.waitForTimeout(400);
  }
}

let gm;
gm = await newUser('Мастер');

await step('в главном меню — «Сжатие файлов: вкл» по умолчанию, переключается и запоминается', async () => {
  await gm.page.goto(BASE);
  const btn = gm.page.locator('.compress-btn');
  await btn.waitFor();
  if ((await btn.getAttribute('aria-pressed')) !== 'true') throw new Error('по умолчанию выключено');
  await btn.click();
  await gm.page.waitForFunction(() => document.querySelector('.compress-btn')?.getAttribute('aria-pressed') === 'false', null, { timeout: 4000 });
  await gm.page.reload();
  await btn.waitFor();
  if ((await btn.getAttribute('aria-pressed')) !== 'false') throw new Error('выбор не сохранился');
  const me = (await gm.api('/api/auth/me')).user;
  if (me.settings?.compressUploads !== false) throw new Error('в аккаунте: ' + JSON.stringify(me.settings));
  await gm.page.screenshot({ path: `${SHOTS}/media-lobby.png` });
});

const game = (await gm.api('/api/games', { name: 'Медиа' })).game;
const openArt = async () => {
  await gm.page.goto(`${BASE}/game/${game.id}`);
  await gm.page.waitForSelector('.board');
  await gm.page.getByRole('tab', { name: 'Библиотека картинок' }).click();
};

await step('сжатие выключено — PNG загружается как есть', async () => {
  await openArt();
  const [a] = await uploadArt(gm.page, gm.api, game.id, ['карта.png']);
  if (a.mime !== 'image/png' || a.size !== sizes['карта.png']) throw new Error(`${a.mime} ${a.size}`);
});

await step('сжатие включено — PNG стал WebP, размеры те же, вес меньше', async () => {
  await gm.api('/api/auth/me', { settings: { compressUploads: true } }, 'PATCH');
  await openArt();
  const [a] = await uploadArt(gm.page, gm.api, game.id, ['карта.png']);
  if (a.mime !== 'image/webp') throw new Error('тип ' + a.mime);
  if (!(a.size < sizes['карта.png'] * 0.9)) throw new Error(`не сжалось: ${a.size} из ${sizes['карта.png']}`);
  if (a.width !== 1600 || a.height !== 1000) throw new Error(`размеры ${a.width}×${a.height}`);
  if (!/\.webp$/.test(a.url)) throw new Error(a.url);
  if (a.name !== 'карта') throw new Error('имя: ' + a.name);
});

await step('BMP (сервер такой не принимает) — уходит как WebP, даже маленький', async () => {
  const [a] = await uploadArt(gm.page, gm.api, game.id, ['значок.bmp']);
  if (a.mime !== 'image/webp' || a.width !== 48) throw new Error(`${a.mime} ${a.width}`);
});

await step('анимированный GIF с прозрачностью → WebM, играет на доске', async () => {
  const [a] = await uploadArt(gm.page, gm.api, game.id, ['огонёк.gif']);
  if (a.mime !== 'video/webm' || a.kind !== 'video') throw new Error(`${a.mime} ${a.kind}`);
  if (!(a.size < sizes['огонёк.gif'])) throw new Error(`не легче: ${a.size} из ${sizes['огонёк.gif']}`);
  const id = await gm.page.evaluate(async (url) => {
    const { net, store } = window.__board;
    const t = await net.create('obj', { pageId: store.ui.pageId, layer: 'objects', type: 'image', src: url, x: 140, y: 140, w: 140, h: 140, name: 'Огонёк' });
    return t.id;
  }, a.url);
  await gm.page.waitForFunction((id) => {
    const v = document.querySelector(`.obj[data-oid="${id}"] video`);
    return v && v.readyState >= 2 && v.videoWidth === 320;
  }, id, { timeout: 8000 });
  // углы за кругом прозрачные, середина — нет
  const alpha = await gm.page.evaluate((id) => {
    const v = document.querySelector(`.obj[data-oid="${id}"] video`);
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(v, 0, 0);
    return { corner: ctx.getImageData(3, 3, 1, 1).data[3], middle: ctx.getImageData(160, 120, 1, 1).data[3] };
  }, id);
  if (alpha.corner > 10 || alpha.middle < 245) throw new Error('прозрачность: ' + JSON.stringify(alpha));
  await gm.page.waitForTimeout(500);
  await gm.page.screenshot({ path: `${SHOTS}/media-gif.png` });
});

await step('звук WAV в музыке → WebM (Opus), трек — звук', async () => {
  const before = new Set(((await gm.api(`/api/assets?gameId=${game.id}`)).assets || []).map((a) => a.id));
  await gm.page.getByRole('tab', { name: 'Музыка и звуки' }).click();
  await gm.page.locator('input[type=file][accept^="audio/*"]').setInputFiles(payload('дождь.wav'));
  await gm.page.waitForFunction(() => [...window.__board.store.col.track.values()].some((t) => /дождь/.test(t.name)), null, { timeout: 30000 });
  const a = ((await gm.api(`/api/assets?gameId=${game.id}`)).assets || []).find((x) => !before.has(x.id));
  if (!a || a.mime !== 'audio/webm' || a.kind !== 'audio') throw new Error(JSON.stringify(a));
  if (!(a.size < sizes['дождь.wav'] / 5)) throw new Error(`мало сжалось: ${a.size} из ${sizes['дождь.wav']}`);
  const dur = await gm.page.evaluate(
    (url) =>
      new Promise((res) => {
        const au = new Audio(url);
        au.onloadedmetadata = () => res(au.duration);
        au.onerror = () => res(-1);
      }),
    a.url,
  );
  if (!(dur > 7 && dur < 9)) throw new Error('длительность ' + dur);
});

await step('видео MKV (VP8 + Vorbis) → WebM (VP9 + Opus), со звуком', async () => {
  await gm.page.getByRole('tab', { name: 'Библиотека картинок' }).click();
  const [a] = await uploadArt(gm.page, gm.api, game.id, ['ролик.mkv'], 120000);
  if (a.mime !== 'video/webm') throw new Error(a.mime);
  if (!(a.size < sizes['ролик.mkv'] * 0.9)) throw new Error(`не сжалось: ${a.size} из ${sizes['ролик.mkv']}`);
  const info = await gm.page.evaluate(
    (url) =>
      new Promise((res) => {
        const v = document.createElement('video');
        v.muted = true;
        v.src = url;
        v.onloadeddata = () => res({ w: v.videoWidth, d: v.duration });
        v.onerror = () => res(null);
      }),
    a.url,
  );
  if (!info || info.w !== 640 || !(info.d > 2.5)) throw new Error(JSON.stringify(info));
});

await step('H.264, который браузер не умеет разобрать, — загружен как есть', async () => {
  const [a] = await uploadArt(gm.page, gm.api, game.id, ['h264.mp4'], 60000);
  if (a.mime !== 'video/mp4' || a.size !== sizes['h264.mp4']) throw new Error(`${a.mime} ${a.size}`);
});

await step('пока камера движется — доска отдельным слоем, замерла — рисуется в своём масштабе', async () => {
  await gm.page.evaluate(() => window.__board.centerOn(200, 200, 6));
  await gm.page.waitForFunction(() => window.__board._rasterZ === 6 && window.__board.world.style.willChange === 'auto', null, { timeout: 3000 });
  const seen = await gm.page.evaluate(async () => {
    const b = window.__board;
    const out = [];
    const obs = new MutationObserver(() => out.push(b.world.style.willChange));
    obs.observe(b.world, { attributes: true, attributeFilter: ['style'] });
    b.zoomBy(1.2);
    b.zoomBy(1.2);
    await new Promise((r) => setTimeout(r, 700));
    obs.disconnect();
    return [...new Set(out)];
  });
  if (seen.join() !== 'transform,auto') throw new Error('слой: ' + JSON.stringify(seen));
  const z = await gm.page.evaluate(() => [window.__board._rasterZ, window.__board.cam.z]);
  if (Math.abs(z[0] - z[1]) > 1e-9) throw new Error('масштаб рисования ' + z);
});

console.log('ошибки:', errors.length ? '\n' + errors.join('\n') : 'нет');
await browser.close();
fs.rmSync(FIX, { recursive: true, force: true });
if (failures.length || errors.length) process.exit(1);
