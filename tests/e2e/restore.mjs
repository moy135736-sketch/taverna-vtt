// e2e: полная копия одним файлом и восстановление из администрирования; возврат прежнего состояния; копия базы.
// Запускает свой сервер с отдельной папкой данных (восстановление заменяет все данные).
// Или проверяет уже запущенный: RESTORE_BASE=http://… RESTORE_DATA=<папка данных> RESTORE_ADMIN=<логин администратора>
// (так проверяется Windows-версия под wine; пароль администратора — secret123).
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openZip } from '../../server/zip.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.RESTORE_PORT || 3570);
const EXT = process.env.RESTORE_BASE || '';
const BASE = EXT || `http://localhost:${PORT}`;
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'taverna-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const DATA = EXT ? process.env.RESTORE_DATA : fs.mkdtempSync(path.join(os.tmpdir(), 'taverna-restore-'));
if (!DATA || !fs.existsSync(DATA)) throw new Error('нет папки данных: ' + DATA);
const failures = [];
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = EXT
  ? null
  : spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, REGISTER_RATE_LIMIT: '1000', BACKUP_INTERVAL_HOURS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
srv?.stdout.on('data', (d) => (log += d));
srv?.stderr.on('data', (d) => (log += d));
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(BASE + '/api/health')).ok) break;
  } catch {
    /* ещё не запустился */
  }
  await sleep(100);
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

const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
async function user(name, username) {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
  await page.goto(BASE);
  const api = (p, body, method) =>
    page.evaluate(
      async ([p, body, method]) => {
        const r = await fetch(p, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', 'X-Taverna': '1' }, body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, ...(await r.json().catch(() => ({}))) };
      },
      [p, body, method],
    );
  const r = await api('/api/auth/register', { username, password: 'secret123', displayName: name });
  if (r.status !== 200) await api('/api/auth/login', { username, password: 'secret123' });
  return { ctx, page, api };
}
async function uploadAsset(page, file) {
  return page.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const fd = new FormData();
    fd.append('files', new Blob([bin], { type: 'image/png' }), 'карта.png');
    const r = await fetch('/api/assets', { method: 'POST', headers: { 'X-Taverna': '1' }, body: fd });
    return (await r.json()).assets[0];
  }, fs.readFileSync(file).toString('base64'));
}
// столы, что уже были у администратора внешнего сервера, в сравнениях не участвуют
let before = new Set();
const games = async (api) => (await api('/api/games')).games.map((g) => g.name).filter((n) => !before.has(n)).sort();
const status = async (url) => (await fetch(BASE + url)).status;

const gm = await user('Мастер', process.env.RESTORE_ADMIN || 'admin' + Date.now().toString(36));
before = new Set((await gm.api('/api/games')).games.map((g) => g.name));
let game;
let map1;
let backupFile;

await step('исходные данные: стол, персонаж, картинка', async () => {
  game = (await gm.api('/api/games', { name: 'Кампания' })).game;
  map1 = await uploadAsset(gm.page, path.join(ROOT, 'tests/e2e/assets/map.png'));
  if (!map1?.url) throw new Error('картинка не загрузилась');
  await gm.page.goto(`${BASE}/game/${game.id}`);
  await gm.page.waitForSelector('.board');
  await gm.page.evaluate(() => window.__board.net.create('char', { name: 'Тарен', inJournals: ['all'] }));
  await gm.page.waitForTimeout(2000); // стол сохраняется раз в 1,5 с
});

await step('«Скачать полную копию» — ZIP с базой и картинками', async () => {
  await gm.page.goto(BASE);
  await gm.page.getByRole('button', { name: 'Администрирование' }).click();
  const dl = gm.page.waitForEvent('download');
  await gm.page.getByRole('link', { name: 'Скачать полную копию' }).click();
  const d = await dl;
  backupFile = path.join(os.tmpdir(), `taverna-restore-${Date.now()}-full.zip`);
  await d.saveAs(backupFile);
  if (!/^taverna-full-\d{8}-\d{6}\.zip$/.test(d.suggestedFilename())) throw new Error('имя файла: ' + d.suggestedFilename());
  const zip = await openZip(backupFile);
  const names = zip.entries.map((e) => e.name);
  await zip.close();
  for (const n of ['taverna-backup.json', 'README.txt', 'taverna.db', 'uploads/' + map1.url.replace(/^\/uploads\//, '')]) if (!names.includes(n)) throw new Error('в архиве нет ' + n + ': ' + names.join(', '));
  await gm.page.keyboard.press('Escape');
});

await step('после копии данные меняются: новый стол, персонаж удалён, картинка удалена', async () => {
  await gm.api('/api/games', { name: 'Новый стол' });
  await gm.api('/api/assets/' + map1.id, null, 'DELETE');
  await gm.page.goto(`${BASE}/game/${game.id}`);
  await gm.page.waitForSelector('.board');
  await gm.page.evaluate(async () => {
    const { net, store } = window.__board;
    for (const c of [...store.col.char.values()]) if (c.name === 'Тарен') await net.remove('char', c.id);
  });
  await gm.page.waitForTimeout(2000);
  const left = await gm.page.evaluate(async (id) => (await (await fetch(`/api/games/${id}/export`)).json()).entities.filter((e) => e.type === 'char').length, game.id);
  if (left) throw new Error('персонаж не удалился');
  if ((await status(map1.url)) !== 404) throw new Error('картинка не удалилась');
  if (JSON.stringify(await games(gm.api)) !== JSON.stringify(['Кампания', 'Новый стол'])) throw new Error('столы: ' + (await games(gm.api)));
});

let pl;
await step('«Восстановить из файла»: игрок за столом отключается, данные — как в копии', async () => {
  pl = await user('Игрок', 'pl' + Date.now().toString(36));
  await pl.api('/api/games/join', { code: game.inviteCode });
  await pl.page.goto(`${BASE}/game/${game.id}`);
  await pl.page.waitForSelector('.board');
  await gm.page.goto(BASE);
  await gm.page.getByRole('button', { name: 'Администрирование' }).click();
  await gm.page.locator('.admin-backups input[type=file]').setInputFiles(backupFile);
  await gm.page.getByRole('button', { name: 'Восстановить', exact: true }).click();
  await gm.page.locator('.restore-task').waitFor({ timeout: 5000 });
  await gm.page.screenshot({ path: `${SHOTS}/restore-progress.png` });
  await gm.page.locator('.restore-task.ok').waitFor({ timeout: 30000 });
  await gm.page.screenshot({ path: `${SHOTS}/restore-done.png` });
  await gm.page.waitForEvent('load', { timeout: 10000 });
  await pl.page.getByText('Мастер восстанавливает данные').waitFor({ timeout: 10000 });
  const g = await games(gm.api);
  if (JSON.stringify(g) !== JSON.stringify(['Кампания'])) throw new Error('столы после восстановления: ' + g);
  if ((await status(map1.url)) !== 200) throw new Error('картинка не вернулась');
  const chars = await gm.page.evaluate(async (id) => {
    const r = await fetch(`/api/games/${id}/export`);
    return (await r.json()).entities.filter((e) => e.type === 'char').map((e) => e.data.name);
  }, game.id);
  if (!chars.includes('Тарен')) throw new Error('персонажа нет: ' + chars);
});

await step('«Как было до восстановления» → вернуть: снова новый стол', async () => {
  await gm.page.getByRole('button', { name: 'Администрирование' }).click();
  await gm.page.getByText('Как было до восстановления').waitFor();
  await gm.page.screenshot({ path: `${SHOTS}/restore-admin.png` });
  await gm.page.locator('.admin-backups li', { hasText: 'до восстановления из файла' }).getByRole('button', { name: 'вернуть' }).click();
  await gm.page.getByRole('button', { name: 'Вернуть', exact: true }).click();
  await gm.page.locator('.restore-task.ok').waitFor({ timeout: 30000 });
  await gm.page.waitForEvent('load', { timeout: 10000 });
  const g = await games(gm.api);
  if (JSON.stringify(g) !== JSON.stringify(['Кампания', 'Новый стол'])) throw new Error('столы: ' + g);
  if ((await status(map1.url)) !== 404) throw new Error('картинка должна быть удалена, как было');
});

await step('копия базы → изменения → «вернуть» базу (картинки не трогаются)', async () => {
  const b = (await gm.api('/api/admin/backups', {})).backup;
  await gm.api('/api/games', { name: 'Лишний стол' });
  const r = await gm.api(`/api/admin/backups/${b.name}/restore`, {});
  if (!r.job) throw new Error('не запустилось: ' + JSON.stringify(r));
  let j;
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    const s = await gm.api('/api/admin/restore/status');
    if (s.status !== 200) continue;
    j = s.job;
    if (j.id === r.job.id && (j.state === 'done' || j.state === 'error')) break;
  }
  if (j?.state !== 'done') throw new Error('восстановление: ' + JSON.stringify(j));
  const g = await games(gm.api);
  if (JSON.stringify(g) !== JSON.stringify(['Кампания', 'Новый стол'])) throw new Error('столы: ' + g);
});

await step('не ZIP — понятная ошибка, данные целы', async () => {
  const bad = path.join(os.tmpdir(), `taverna-restore-${Date.now()}-bad.zip`);
  fs.writeFileSync(bad, 'это не архив');
  await gm.page.goto(BASE);
  await gm.page.getByRole('button', { name: 'Администрирование' }).click();
  await gm.page.locator('.admin-backups input[type=file]').setInputFiles(bad);
  await gm.page.getByRole('button', { name: 'Восстановить', exact: true }).click();
  await gm.page.locator('.toast-error', { hasText: 'не ZIP' }).waitFor({ timeout: 10000 });
  const g = await games(gm.api);
  if (JSON.stringify(g) !== JSON.stringify(['Кампания', 'Новый стол'])) throw new Error('столы: ' + g);
  fs.rmSync(bad, { force: true });
});

await step('остатки восстановления убраны, хранится не больше трёх прежних состояний', async () => {
  const left = fs.readdirSync(DATA).filter((n) => n.startsWith('restore-tmp-'));
  if (left.length) throw new Error('остались ' + left);
  const tmp = fs.existsSync(path.join(DATA, 'tmp')) ? fs.readdirSync(path.join(DATA, 'tmp')).filter((n) => /^restore-|^full-/.test(n)) : [];
  if (tmp.length) throw new Error('в tmp остались ' + tmp);
  const points = fs.readdirSync(DATA).filter((n) => n.startsWith('before-restore-'));
  if (points.length < 2 || points.length > 3) throw new Error('прежних состояний: ' + points.length);
});

console.log('ошибки:', errors.length ? '\n' + errors.join('\n') : 'нет');
await browser.close();
if (srv) {
  srv.kill('SIGTERM');
  await sleep(500);
  fs.rmSync(DATA, { recursive: true, force: true });
}
fs.rmSync(backupFile || '/nonexistent', { force: true });
if (failures.length) {
  console.log(log.split('\n').slice(-30).join('\n'));
  process.exit(1);
}
