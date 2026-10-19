// e2e: подключение с телефона — окно «Телефон» в лобби и «С телефона…» за столом: адрес компьютера в сети,
// QR-код (проверяем, что он читается и ведёт куда надо), ссылка-приглашение с адресом в сети, вход по ссылке с телефона
import { chromium, devices } from 'playwright-core';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BASE = process.env.BASE || 'http://localhost:3000';
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'taverna-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const errors = [];
const failures = [];

async function newUser(name, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, ...opts });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
  await page.goto(BASE);
  const api = (p, body) =>
    page.evaluate(
      async ([p, body]) => (await fetch(p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Taverna': '1' }, body: body ? JSON.stringify(body) : undefined })).json(),
      [p, body],
    );
  const r = await api('/api/auth/register', { username: 'ph' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), password: 'secret123', displayName: name });
  return { ctx, page, api, user: r.user };
}
async function step(name, fn) {
  try {
    await fn();
    console.log('✓', name);
  } catch (e) {
    console.log('✗', name, '—', e.message.split('\n').slice(0, 4).join(' | '));
    failures.push(name);
  }
}
/** Прочитать QR-код с картинки (OpenCV) */
function readQr(file) {
  const py = `import cv2,sys\nimg=cv2.imread(sys.argv[1])\nd=cv2.QRCodeDetector()\nv,p,_=d.detectAndDecode(img)\nprint(v)`;
  try {
    return execFileSync('python3', ['-c', py, file], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}
async function qrTexts(page, prefix) {
  const out = [];
  const qrs = page.locator('.phone-connect svg.qr');
  const n = await qrs.count();
  for (let i = 0; i < n; i++) {
    const f = `${SHOTS}/${prefix}-qr${i}.png`;
    await qrs.nth(i).screenshot({ path: f });
    out.push(readQr(f));
  }
  return out;
}

const gm = await newUser('Мастер');
await gm.ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
let lan;
await step('/api/lan: адреса компьютера в сети и порт', async () => {
  lan = await gm.api('/api/lan');
  if (!lan.addresses?.length || !lan.port || 'apk' in lan) throw new Error(JSON.stringify(lan));
  const anon = await gm.page.evaluate(async () => (await fetch('/api/lan', { credentials: 'omit' })).status);
  if (anon !== 401) throw new Error('без входа отвечает: ' + anon);
});
const ip = lan?.addresses?.[0]?.address;
const phoneBase = `http://${ip}:${lan?.port}`;

await step('лобби → «Телефон»: адрес компьютера и QR-код для браузера телефона', async () => {
  await gm.page.goto(BASE);
  await gm.page.getByRole('button', { name: 'Телефон', exact: true }).click();
  const dlg = gm.page.locator('.phone-connect');
  await dlg.waitFor();
  await dlg.locator('svg.qr').first().waitFor();
  const addr = await dlg.locator('.pc-addr code').textContent();
  if (addr !== `${ip}:${lan.port}`) throw new Error('адрес: ' + addr);
  const texts = await qrTexts(gm.page, 'phone-lobby');
  if (texts.length !== 1 || texts[0] !== `${phoneBase}/`) throw new Error('QR: ' + JSON.stringify(texts));
  await gm.page.screenshot({ path: `${SHOTS}/phone-modal.png` });
  await gm.page.keyboard.press('Escape');
});

let game;
await step('за столом → «С телефона…»: QR сразу ведёт к этому столу (/join/код)', async () => {
  game = (await gm.api('/api/games', { name: 'С телефона' })).game;
  await gm.page.goto(`${BASE}/game/${game.id}`);
  await gm.page.waitForSelector('.board');
  await gm.page.getByRole('tab', { name: 'Настройки' }).click();
  await gm.page.getByRole('button', { name: 'С телефона…' }).click();
  await gm.page.locator('.phone-connect svg.qr').first().waitFor();
  const texts = await qrTexts(gm.page, 'phone-game');
  if (texts[0] !== `${phoneBase}/join/${game.inviteCode}`) throw new Error('QR: ' + JSON.stringify(texts));
  await gm.page.keyboard.press('Escape');
});

await step('«копировать ссылку» с localhost — ссылка с адресом компьютера в сети', async () => {
  await gm.page.getByRole('button', { name: 'копировать ссылку', exact: true }).click();
  await gm.page.waitForTimeout(400);
  const clip = await gm.page.evaluate(() => navigator.clipboard.readText());
  if (clip !== `${phoneBase}/join/${game.inviteCode}`) throw new Error('в буфере: ' + clip);
});

await step('игрок с телефона открывает стол по ссылке из QR', async () => {
  const pl = await newUser('Игрок с телефона', { ...devices['Pixel 7'] });
  await pl.page.goto(`${BASE}/join/${game.inviteCode}`);
  await pl.page.waitForSelector('.board', { timeout: 15000 });
  await pl.page.screenshot({ path: `${SHOTS}/phone-game.png` });
  await pl.ctx.close();
});

console.log('ошибки:', errors.length ? '\n' + errors.join('\n') : 'нет');
await browser.close();
if (failures.length || errors.length) process.exit(1);
