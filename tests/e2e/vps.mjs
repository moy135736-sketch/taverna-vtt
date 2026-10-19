// e2e: режим сервера в интернете (serve --domain) с тестовым центром сертификации Pebble:
// получение сертификата по http-01, перенаправления на https, сайт и Socket.IO по https.
// Нужны pebble и pebble-challtestsrv (apt install pebble); без них тест пропускается.
//   TAVERNA_BIN=release/taverna-linux-x64 node tests/e2e/vps.mjs
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import tls from 'node:tls';
import path from 'node:path';
import { selfSigned } from '../../server/x509.js';

if (spawnSync('sh', ['-c', 'command -v pebble && command -v pebble-challtestsrv'], { stdio: 'ignore' }).status !== 0) {
  console.log('— pebble не установлен, тест пропущен');
  process.exit(0);
}
const BIN = process.env.TAVERNA_BIN ? path.resolve(process.env.TAVERNA_BIN) : null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'taverna-vps-'));
const DOMAIN = 'taverna.test';
const HTTPS_PORT = 5443;
const HTTP_PORT = 5002; // на этот порт Pebble ходит проверять http-01
const failures = [];
const procs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(cmd, args, env = {}) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.out = '';
  p.stdout.on('data', (d) => (p.out += d));
  p.stderr.on('data', (d) => (p.out += d));
  p.done = new Promise((r) => p.on('exit', r));
  procs.push(p);
  return p;
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
async function json(url) {
  try {
    return await (await fetch(url, { redirect: 'manual' })).json();
  } catch {
    return null;
  }
}

// тестовый центр сертификации
const ca = selfSigned({ dnsNames: ['localhost'], ips: ['127.0.0.1'] });
fs.writeFileSync(path.join(tmp, 'pebble.crt'), ca.cert);
fs.writeFileSync(path.join(tmp, 'pebble.key'), ca.key);
fs.writeFileSync(
  path.join(tmp, 'pebble.json'),
  JSON.stringify({
    pebble: {
      listenAddress: '127.0.0.1:14000',
      managementListenAddress: '127.0.0.1:15000',
      certificate: path.join(tmp, 'pebble.crt'),
      privateKey: path.join(tmp, 'pebble.key'),
      httpPort: HTTP_PORT,
      tlsPort: 5001,
      ocspResponderURL: '',
      externalAccountBindingRequired: false,
    },
  }),
);
start('pebble-challtestsrv', ['-defaultIPv4', '127.0.0.1', '-defaultIPv6', '', '-dns01', '127.0.0.1:8053', '-http01', '', '-https01', '', '-tlsalpn01', '', '-management', '127.0.0.1:8055']);
start('pebble', ['-config', path.join(tmp, 'pebble.json'), '-dnsserver', '127.0.0.1:8053'], { PEBBLE_VA_NOSLEEP: '1' });
await sleep(1500);

const args = ['serve', '--domain', DOMAIN, '--email', 'gm@example.com', '--port', String(HTTPS_PORT), '--http-port', String(HTTP_PORT), '--data', path.join(tmp, 'data'), '--acme-directory', 'https://localhost:14000/dir'];
const env = { NODE_EXTRA_CA_CERTS: path.join(tmp, 'pebble.crt'), REGISTER_RATE_LIMIT: '1000' };
const srv = BIN ? start(BIN, args, env) : start(process.execPath, ['desktop/launcher.js', ...args], env);

await step('сертификат получен по http-01 и подставлен без перезапуска', async () => {
  let st = null;
  for (let i = 0; i < 60 && !['ok', 'error'].includes(st?.state); i++) {
    await sleep(500);
    st = (await json(`http://127.0.0.1:${HTTP_PORT}/api/health`))?.https;
  }
  if (st?.state !== 'ok') throw new Error(JSON.stringify(st) + '\n' + srv.out);
  const issuer = await new Promise((resolve, reject) => {
    const s = tls.connect({ host: '127.0.0.1', port: HTTPS_PORT, servername: DOMAIN, rejectUnauthorized: false }, () => {
      resolve(s.getPeerCertificate().issuer?.CN || '');
      s.end();
    });
    s.on('error', reject);
  });
  if (!/Pebble/.test(issuer)) throw new Error('выдал: ' + issuer);
});

await step('http:// перенаправляется на https://', async () => {
  const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/game/x?y=1`, { redirect: 'manual', headers: { Host: DOMAIN } });
  if (r.status !== 301 || r.headers.get('location') !== `https://${DOMAIN}:${HTTPS_PORT}/game/x?y=1`) throw new Error(r.status + ' ' + r.headers.get('location'));
  const r2 = await fetch(`http://127.0.0.1:${HTTPS_PORT}/lobby`, { redirect: 'manual', headers: { Host: `${DOMAIN}:${HTTPS_PORT}` } });
  if (r2.status !== 301 || !r2.headers.get('location')?.startsWith('https://')) throw new Error('на https-порту: ' + r2.status);
});

await step('сайт и стол по https: вход, стол, бросок в чате', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME || '/opt/pw-browsers/chromium',
    args: ['--no-sandbox', '--no-proxy-server', `--host-resolver-rules=MAP ${DOMAIN} 127.0.0.1`],
  });
  try {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    const base = `https://${DOMAIN}:${HTTPS_PORT}`;
    await page.goto(base);
    const game = await page.evaluate(async () => {
      const api = async (p, b) => (await fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Taverna': '1' }, body: JSON.stringify(b) })).json();
      await api('/api/auth/register', { username: 'gm' + Date.now().toString(36), password: 'secret123', displayName: 'Мастер' });
      return (await api('/api/games', { name: 'Стол в интернете' })).game;
    });
    await page.goto(`${base}/game/${game.id}`);
    await page.waitForSelector('.board-world', { state: 'attached' });
    await page.getByLabel('Сообщение в чат').fill('/r 1d20');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.message.rollresult', { timeout: 8000 });
    const session = (await ctx.cookies()).find((c) => c.name === 'tv_session');
    if (!session?.secure) throw new Error('кука входа без Secure: ' + JSON.stringify(session));
  } finally {
    await browser.close();
  }
});

srv.kill('SIGTERM');
await Promise.race([srv.done, sleep(5000)]);
for (const p of procs) if (p.exitCode === null) p.kill('SIGKILL');
fs.rmSync(tmp, { recursive: true, force: true });
if (failures.length) process.exit(1);
