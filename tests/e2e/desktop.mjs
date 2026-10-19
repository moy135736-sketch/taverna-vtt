// e2e: программа одним файлом (или desktop/launcher.js из исходников):
// заставка, настройки, https на том же порту, второй запуск, занятый порт, голосовой чат по http → https, admin.
//   TAVERNA_BIN=release/taverna-linux-x64 node tests/e2e/desktop.mjs
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';

const BIN = process.env.TAVERNA_BIN ? path.resolve(process.env.TAVERNA_BIN) : null;
const cmd = (args) => (BIN ? [BIN, args] : [process.execPath, ['desktop/launcher.js', ...args]]);
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'taverna-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'taverna-desktop-'));
const PORT = Number(process.env.DESKTOP_PORT || 3550);
const failures = [];
const procs = [];

function start(args, env = {}) {
  const [c, a] = cmd(args);
  const p = spawn(c, a, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.out = '';
  p.stdout.on('data', (d) => (p.out += d));
  p.stderr.on('data', (d) => (p.out += d));
  p.done = new Promise((r) => p.on('exit', (code) => r(code)));
  procs.push(p);
  return p;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000, what = 'условие') {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await fn()) return;
    await sleep(200);
  }
  throw new Error('не дождались: ' + what);
}
async function health(port, proto = 'http') {
  if (proto === 'https') {
    return new Promise((resolve) => {
      https
        .get({ host: '127.0.0.1', port, path: '/api/health', rejectUnauthorized: false }, (res) => {
          let s = '';
          res.on('data', (d) => (s += d));
          res.on('end', () => resolve(JSON.parse(s)));
        })
        .on('error', () => resolve(null));
    });
  }
  try {
    return await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  } catch {
    return null;
  }
}
async function step(name, fn) {
  try {
    await fn();
    console.log('✓', name);
  } catch (e) {
    console.log('✗', name, '—', e.message.split('\n')[0]);
    failures.push(name);
  }
}

const data = path.join(tmp, 'data');
const env = { REGISTER_RATE_LIMIT: '1000' };
const main = start(['--port', String(PORT), '--no-browser', '--data', data], env);

await step('запуск: заставка с адресами, настройки и сертификат созданы', async () => {
  await waitFor(async () => (await health(PORT))?.app === 'taverna', 30000, 'сервер');
  await waitFor(() => /стол запущен/.test(main.out), 5000, 'заставка');
  if (!main.out.includes(`http://localhost:${PORT}`)) throw new Error('нет адреса в заставке:\n' + main.out);
  for (const f of ['config.env', 'tls/local.crt', 'taverna.lock', 'logs/taverna.log']) if (!fs.existsSync(path.join(data, f))) throw new Error('нет ' + f);
  if (/\[sheets\]/.test(main.out)) throw new Error('в окне служебные сообщения');
});

await step('https:// на том же порту', async () => {
  const h = await health(PORT, 'https');
  if (h?.app !== 'taverna') throw new Error('https не отвечает');
});

await step('заставка подсказывает, как открыть стол с телефона', async () => {
  // подсказка пишется, только если у компьютера есть адрес в сети
  if (/Адрес для игроков в сети/.test(main.out) && !/С телефона в этой же сети/.test(main.out)) throw new Error('нет подсказки про телефон:\n' + main.out);
  if (/taverna\.apk/.test(main.out)) throw new Error('в заставке осталось приложение');
});

await step('второй запуск с той же папкой — «уже запущена», без второго сервера', async () => {
  const second = start(['--port', String(PORT + 1), '--no-browser', '--data', data], env);
  const code = await Promise.race([second.done, sleep(15000).then(() => 'timeout')]);
  if (code !== 0) throw new Error('код выхода ' + code + '\n' + second.out);
  if (!/уже запущена/.test(second.out)) throw new Error(second.out);
  if (await health(PORT + 1)) throw new Error('поднялся второй сервер');
});

await step('порт занят другой программой — берётся следующий', async () => {
  const other = start(['--port', String(PORT), '--no-browser', '--data', path.join(tmp, 'data2')], env);
  await waitFor(async () => (await health(PORT + 1))?.app === 'taverna', 30000, 'сервер на следующем порту');
  if (!/был занят/.test(other.out)) throw new Error(other.out);
  other.kill('SIGTERM');
  await other.done;
});

const lan = Object.values(os.networkInterfaces())
  .flat()
  .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;

await step('по http с адреса в сети голос предлагает защищённый адрес, после перехода вход сохраняется', async () => {
  if (!lan) return console.log('   (нет сетевого адреса — пропуск)');
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--no-proxy-server'] });
  try {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    const base = `http://${lan}:${PORT}`;
    await page.goto(base);
    const game = await page.evaluate(async () => {
      const api = async (p, b) => (await fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Taverna': '1' }, body: JSON.stringify(b) })).json();
      await api('/api/auth/register', { username: 'host' + Date.now().toString(36), password: 'secret123', displayName: 'Хозяин' });
      return (await api('/api/games', { name: 'Домашний стол' })).game;
    });
    await page.goto(`${base}/game/${game.id}`);
    await page.waitForSelector('.board-world', { state: 'attached' });
    if (await page.evaluate(() => window.isSecureContext)) throw new Error('адрес в сети считается защищённым — проверка не имеет смысла');
    await page.locator('.voice-join').click();
    const dlg = page.getByRole('dialog', { name: 'Микрофон — только по защищённому адресу' });
    await dlg.waitFor();
    await page.screenshot({ path: `${SHOTS}/desktop-voice-https.png` });
    await dlg.getByRole('link', { name: 'Открыть защищённый адрес' }).click();
    await page.waitForURL(/^https:/);
    await page.waitForSelector('.board-world', { state: 'attached' });
    if (!(await page.evaluate(() => window.isSecureContext))) throw new Error('https-страница не защищённая');
    // по https кнопка голоса сразу входит в чат, без объяснений
    await page.locator('.voice-join').click();
    await page.locator('.voice-ctl').waitFor({ timeout: 8000 });
    if (await page.getByRole('dialog').count()) throw new Error('по https снова показано объяснение');
  } finally {
    await browser.close();
  }
});

await step('остановка: данные сохранены, метка запуска убрана', async () => {
  main.kill('SIGTERM');
  const code = await Promise.race([main.done, sleep(10000).then(() => 'timeout')]);
  if (code !== 0) throw new Error('код выхода ' + code);
  if (fs.existsSync(path.join(data, 'taverna.lock'))) throw new Error('осталась метка запуска');
});

await step('admin list-users видит пользователя', async () => {
  const [c, a] = cmd(['admin', '--data', data, 'list-users']);
  const r = spawnSync(c, a, { encoding: 'utf8' });
  if (r.status !== 0 || !/Хозяин/.test(r.stdout)) throw new Error(r.stdout + r.stderr);
});

for (const p of procs) if (p.exitCode === null) p.kill('SIGKILL');
fs.rmSync(tmp, { recursive: true, force: true });
if (failures.length) process.exit(1);
