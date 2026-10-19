// Полная резервная копия одним файлом (база + картинки, музыка, видео) и восстановление — из администрирования,
// без консоли. Перед заменой текущие данные откладываются в папку before-restore-…, и их можно вернуть.
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { db, reopenDb, SCHEMA_VERSION } from './db.js';
import { inspectDatabase } from './sqlite.js';
import { config, VERSION } from './config.js';
import { rooms } from './game/rooms.js';
import { maintenance } from './maintenance.js';
import { backupIdle, backupDir, BACKUP_NAME_RE } from './backup.js';
import { invalidateUserCache } from './auth.js';
import { loadBuiltinSheets } from './api/sheets.js';
import { planZip, writeZip, openZip, extractEntry } from './zip.js';

const MANIFEST = 'taverna-backup.json';
export const POINT_RE = /^before-restore-\d{8}-\d{6}$/;
const KEEP_POINTS = 3;
const UPLOAD_RE = /^[a-z0-9]{8,40}$/;
export const MAX_CHUNK = 64 * 1048576;
const KICK = 'Мастер восстанавливает данные из резервной копии. Обновите страницу через минуту.';

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const tmpDir = () => path.join(config.dataDir, 'tmp');
const fail = (message, status = 400) => Object.assign(new Error(message), { status, expose: true });

function walkFiles(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(abs, base, out);
    else if (e.isFile()) {
      const st = fs.statSync(abs);
      out.push({ rel: path.relative(base, abs).split(path.sep).join('/'), abs, size: st.size, mtime: st.mtime });
    }
  }
  return out;
}

/** Хватит ли места на диске (если узнать нельзя — считаем, что хватит) */
function checkSpace(dir, bytes) {
  try {
    const st = fs.statfsSync(dir);
    const free = Number(st.bavail) * Number(st.bsize);
    if (free < bytes) throw fail(`Не хватает места на диске: нужно ещё ${Math.ceil((bytes - free) / 1048576)} МБ`, 507);
  } catch (e) {
    if (e.status) throw e;
  }
}

const README = (m) =>
  '﻿' +
  [
    `Полная резервная копия Таверны от ${new Date(m.createdAt).toLocaleString('ru-RU')} (версия программы ${m.app}).`,
    '',
    'Внутри: taverna.db — база (аккаунты, столы, персонажи, листы, материалы, чат),',
    'папка uploads — загруженные картинки, музыка и видео.',
    '',
    'Как восстановить: войдите в Таверну администратором → «Администрирование» →',
    '«Восстановить из файла…» и выберите этот архив. Распаковывать его не нужно.',
    '',
  ].join('\r\n');

/** Отдать полную копию одним ZIP-файлом в ответ HTTP */
export async function sendFullBackup(res) {
  fs.mkdirSync(tmpDir(), { recursive: true });
  rooms.flushAll();
  const snap = path.join(tmpDir(), `full-${process.pid}-${Date.now()}.db`);
  await db.backup(snap);
  try {
    const files = fs.existsSync(config.uploadsDir) ? walkFiles(config.uploadsDir) : [];
    const info = inspectDatabase(snap);
    const manifest = {
      format: 'taverna-backup',
      version: 1,
      app: VERSION,
      schema: info.schema,
      createdAt: new Date().toISOString(),
      counts: info.counts,
      uploads: { files: files.length, bytes: files.reduce((s, f) => s + f.size, 0) },
    };
    const text = (s) => {
      const data = Buffer.from(s, 'utf8');
      return { data, size: data.length };
    };
    const plan = planZip([
      { name: MANIFEST, ...text(JSON.stringify(manifest, null, 2)) },
      { name: 'README.txt', ...text(README(manifest)) },
      { name: 'taverna.db', file: snap, size: fs.statSync(snap).size },
      ...files.map((f) => ({ name: 'uploads/' + f.rel, file: f.abs, size: f.size, mtime: f.mtime })),
    ]);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', String(plan.total));
    res.setHeader('Content-Disposition', `attachment; filename="taverna-full-${stamp()}.zip"`);
    res.setHeader('Cache-Control', 'no-store');
    await writeZip(res, plan);
    res.end();
  } finally {
    fs.rmSync(snap, { force: true });
  }
}

/** При запуске: убрать остатки прерванных копий и восстановлений */
export function cleanupRestoreLeftovers() {
  try {
    for (const n of fs.readdirSync(config.dataDir)) if (/^restore-tmp-\d{8}-\d{6}$/.test(n)) fs.rmSync(path.join(config.dataDir, n), { recursive: true, force: true });
    if (fs.existsSync(tmpDir())) for (const n of fs.readdirSync(tmpDir())) if (/^(full-\d+-\d+\.db|restore-[a-z0-9]+\.zip)$/.test(n)) fs.rmSync(path.join(tmpDir(), n), { force: true });
  } catch (e) {
    console.warn('[restore] уборка:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Ход восстановления: один за раз, клиент спрашивает состояние
// ---------------------------------------------------------------------------

export const job = { id: 0, state: 'idle', phase: '', title: '', done: 0, total: 0, error: '', result: null, at: 0 };
const setJob = (patch) => Object.assign(job, patch, { at: Date.now() });

function startJob(title, fn) {
  if (job.state === 'running') throw fail('Восстановление уже идёт', 409);
  setJob({ id: job.id + 1, state: 'running', phase: 'check', title, done: 0, total: 0, error: '', result: null });
  fn().then(
    (result) => setJob({ state: 'done', phase: 'done', result }),
    (e) => {
      console.error('[restore]', e);
      setJob({ state: 'error', phase: 'error', error: e.message || String(e) });
    },
  );
  return job;
}

// ---------------------------------------------------------------------------
// Загрузка файла копии кусками (большие файлы, медленная связь, прокси с лимитами)
// ---------------------------------------------------------------------------

const uploadPath = (id) => path.join(tmpDir(), `restore-${id}.zip`);

export async function appendChunk(id, offset, total, req) {
  if (!UPLOAD_RE.test(id)) throw fail('Неверный идентификатор загрузки');
  fs.mkdirSync(tmpDir(), { recursive: true });
  const file = uploadPath(id);
  if (offset === 0) {
    fs.rmSync(file, { force: true });
    // старые незаконченные загрузки — прочь
    for (const f of fs.readdirSync(tmpDir())) {
      const p = path.join(tmpDir(), f);
      if (/^restore-[a-z0-9]+\.zip$/.test(f) && Date.now() - fs.statSync(p).mtimeMs > 6 * 3600000) fs.rmSync(p, { force: true });
    }
    if (total > 0) checkSpace(config.dataDir, total * 2.1 + 100 * 1048576);
  }
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  if (offset !== size) throw Object.assign(fail('Кусок файла пришёл не по порядку', 409), { size });
  const out = fs.createWriteStream(file, { flags: 'a' });
  let n = 0;
  try {
    for await (const chunk of req) {
      n += chunk.length;
      if (n > MAX_CHUNK) throw fail('Слишком большой кусок файла', 413);
      if (!out.write(chunk)) await once(out, 'drain');
    }
    out.end();
    await once(out, 'finish');
  } catch (e) {
    out.destroy();
    throw e;
  }
  return size + n;
}

export function startRestoreFromUpload(id) {
  if (!UPLOAD_RE.test(id)) throw fail('Неверный идентификатор загрузки');
  const file = uploadPath(id);
  if (!fs.existsSync(file)) throw fail('Файл копии не загружен', 404);
  return startJob('Восстановление из файла', async () => {
    try {
      return await restoreZip(file);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
}

/** Безопасный относительный путь внутри uploads */
function safeRel(rel) {
  if (!rel || rel.length > 500 || rel.startsWith('/') || /[\0-\x1f:*?"<>|]/.test(rel)) return false;
  return rel.split('/').every((s) => s && s !== '.' && s !== '..');
}

async function restoreZip(file) {
  const zip = await openZip(file);
  const staging = path.join(config.dataDir, `restore-tmp-${stamp()}`);
  try {
    const all = zip.entries.filter((e) => !e.dir);
    // архив могли пересобрать вручную — тогда всё лежит в одной общей папке
    const top = all.find((e) => e.name.replace(/\\/g, '/').endsWith(MANIFEST) || e.name.replace(/\\/g, '/').endsWith('taverna.db'));
    const prefix = top ? top.name.replace(/\\/g, '/').replace(/(taverna-backup\.json|taverna\.db)$/, '') : '';
    let manifestEntry = null;
    let dbEntry = null;
    const files = [];
    for (const e of all) {
      const name = e.name.replace(/\\/g, '/');
      if (!name.startsWith(prefix)) continue;
      const rel = name.slice(prefix.length);
      if (rel === MANIFEST) manifestEntry = e;
      else if (rel === 'taverna.db') dbEntry = e;
      else if (rel.startsWith('uploads/')) {
        if (!safeRel(rel.slice(8))) throw fail('В архиве недопустимое имя файла: ' + name);
        files.push({ e, rel: rel.slice(8) });
      }
    }
    if (!dbEntry) throw fail('В архиве нет базы taverna.db — это не полная копия Таверны');
    if (manifestEntry) {
      if (manifestEntry.usize > 1048576) throw fail('Неверное описание копии');
      fs.mkdirSync(staging, { recursive: true });
      const mf = path.join(staging, MANIFEST);
      await extractEntry(zip, manifestEntry, mf);
      let m;
      try {
        m = JSON.parse(fs.readFileSync(mf, 'utf8'));
      } catch {
        throw fail('Неверное описание копии');
      }
      if (m.format !== 'taverna-backup') throw fail('Это не резервная копия Таверны');
      if (Number(m.schema) > SCHEMA_VERSION) throw fail(`Копия сделана более новой версией Таверны (${m.app || '?'}). Обновите программу и повторите.`);
    }
    const need = dbEntry.usize + files.reduce((s, x) => s + x.e.usize, 0);
    checkSpace(config.dataDir, need + 50 * 1048576);
    setJob({ phase: 'extract', done: 0, total: files.length + 1 });
    fs.mkdirSync(path.join(staging, 'uploads'), { recursive: true });
    await extractEntry(zip, dbEntry, path.join(staging, 'taverna.db'));
    setJob({ done: 1 });
    for (const { e, rel } of files) {
      const dest = path.join(staging, 'uploads', ...rel.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await extractEntry(zip, e, dest);
      job.done++;
    }
    await zip.close();
    let info;
    try {
      info = inspectDatabase(path.join(staging, 'taverna.db'));
    } catch (e) {
      throw fail('База в копии не годится: ' + e.message);
    }
    if (info.schema > SCHEMA_VERSION) throw fail('Копия сделана более новой версией Таверны. Обновите программу и повторите.');
    setJob({ phase: 'swap' });
    const point = await swapIn(staging, { uploads: true, reason: 'до восстановления из файла' });
    return { ...info.counts, files: files.length, point };
  } finally {
    await zip.close();
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Вернуть базу к автоматической копии (картинки и музыка не меняются) */
export function startRestoreFromBackup(name) {
  if (!BACKUP_NAME_RE.test(name)) throw fail('Неверное имя копии');
  const file = path.join(backupDir(), name);
  if (!fs.existsSync(file)) throw fail('Копия не найдена', 404);
  return startJob('Возврат базы к копии', async () => {
    const staging = path.join(config.dataDir, `restore-tmp-${stamp()}`);
    fs.mkdirSync(staging, { recursive: true });
    try {
      fs.copyFileSync(file, path.join(staging, 'taverna.db'));
      let info;
      try {
        info = inspectDatabase(path.join(staging, 'taverna.db'));
      } catch (e) {
        throw fail('Копия не годится: ' + e.message);
      }
      if (info.schema > SCHEMA_VERSION) throw fail('Копия сделана более новой версией Таверны');
      setJob({ phase: 'swap' });
      const when = new Date(fs.statSync(file).mtimeMs).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
      const point = await swapIn(staging, { uploads: false, reason: `до возврата базы к копии от ${when}` });
      return { ...info.counts, point };
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Состояния до восстановления: можно вернуть
// ---------------------------------------------------------------------------

export function listRestorePoints() {
  if (!fs.existsSync(config.dataDir)) return [];
  return fs
    .readdirSync(config.dataDir)
    .filter((n) => POINT_RE.test(n) && fs.existsSync(path.join(config.dataDir, n, 'taverna.db')))
    .map((name) => {
      let info = {};
      try {
        info = JSON.parse(fs.readFileSync(path.join(config.dataDir, name, 'info.json'), 'utf8'));
      } catch {
        /* описания нет */
      }
      return { name, time: info.time || fs.statSync(path.join(config.dataDir, name)).mtimeMs, reason: info.reason || '', uploads: fs.existsSync(path.join(config.dataDir, name, 'uploads')) };
    })
    .sort((a, b) => b.time - a.time);
}

export function startRestoreFromPoint(name) {
  if (!POINT_RE.test(name)) throw fail('Неверное имя');
  const dir = path.join(config.dataDir, name);
  if (!fs.existsSync(path.join(dir, 'taverna.db'))) throw fail('Сохранённое состояние не найдено', 404);
  return startJob('Возврат к прежнему состоянию', async () => {
    let info;
    try {
      info = inspectDatabase(path.join(dir, 'taverna.db'));
    } catch (e) {
      throw fail('Сохранённая база не годится: ' + e.message);
    }
    setJob({ phase: 'swap' });
    const point = await swapIn(dir, { uploads: fs.existsSync(path.join(dir, 'uploads')), reason: 'до возврата к прежнему состоянию' });
    fs.rmSync(dir, { recursive: true, force: true });
    return { ...info.counts, point };
  });
}

function prunePoints() {
  for (const p of listRestorePoints().slice(KEEP_POINTS)) {
    try {
      fs.rmSync(path.join(config.dataDir, p.name), { recursive: true, force: true });
    } catch (e) {
      console.warn('[restore] не удалось удалить', p.name, e.message);
    }
  }
}

/** Переименовать с повторами: в Windows файл может ненадолго держать антивирус или отдача картинки */
async function moveRetry(src, dest) {
  if (!fs.existsSync(src)) {
    fs.mkdirSync(dest, { recursive: true });
    return;
  }
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(src, dest);
      return;
    } catch (e) {
      if (i >= 40 || !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(e.code)) throw e;
      await sleep(250);
    }
  }
}

const DB_FILES = ['', '-wal', '-shm'];

/**
 * Подменить данные содержимым папки staging (taverna.db и, если uploads, папка uploads).
 * Текущие данные уезжают в before-restore-… Возвращает имя этой папки.
 */
async function swapIn(staging, { uploads, reason }) {
  maintenance.on(KICK);
  const name = 'before-restore-' + stamp();
  const point = path.join(config.dataDir, name);
  let uploadsMoved = false;
  try {
    await backupIdle();
    rooms.closeAll(KICK);
    await sleep(300); // даём закончиться отдаче файлов
    fs.mkdirSync(point, { recursive: true });
    if (uploads) {
      await moveRetry(config.uploadsDir, path.join(point, 'uploads'));
      uploadsMoved = true;
      await moveRetry(path.join(staging, 'uploads'), config.uploadsDir);
    }
    // база: синхронно, без пауз — пока она закрыта, никакой другой код сервера не выполняется
    db.close();
    const moved = [];
    try {
      for (const sfx of DB_FILES) {
        if (!fs.existsSync(config.dbPath + sfx)) continue;
        fs.renameSync(config.dbPath + sfx, path.join(point, 'taverna.db' + sfx));
        moved.push(sfx);
      }
      for (const sfx of DB_FILES) if (fs.existsSync(path.join(staging, 'taverna.db' + sfx))) fs.renameSync(path.join(staging, 'taverna.db' + sfx), config.dbPath + sfx);
      reopenDb();
      loadBuiltinSheets();
    } catch (e) {
      // возвращаем прежнюю базу
      try {
        db.close();
      } catch {
        /* уже закрыта */
      }
      for (const sfx of DB_FILES) fs.rmSync(config.dbPath + sfx, { force: true });
      for (const sfx of moved) fs.renameSync(path.join(point, 'taverna.db' + sfx), config.dbPath + sfx);
      reopenDb();
      throw e;
    }
    invalidateUserCache();
    fs.writeFileSync(path.join(point, 'info.json'), JSON.stringify({ time: Date.now(), reason, app: VERSION }, null, 2));
    console.log(`[restore] данные заменены; прежние — в ${point}`);
    prunePoints();
    return name;
  } catch (e) {
    if (uploadsMoved) {
      // картинки и музыку — тоже обратно
      try {
        if (fs.existsSync(config.uploadsDir)) await moveRetry(config.uploadsDir, path.join(staging, 'uploads-failed'));
        await moveRetry(path.join(point, 'uploads'), config.uploadsDir);
      } catch (e2) {
        console.error('[restore] не удалось вернуть папку uploads:', e2);
      }
    }
    try {
      if (fs.existsSync(point) && !fs.readdirSync(point).length) fs.rmdirSync(point);
    } catch {
      /* не страшно */
    }
    throw e;
  } finally {
    maintenance.off();
  }
}
