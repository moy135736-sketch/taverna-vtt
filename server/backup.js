// Резервные копии базы: по расписанию внутри сервера и по кнопке в администрировании.
// Копия — согласованный снимок базы (VACUUM INTO в отдельном потоке), игра не останавливается.
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { config } from './config.js';
import { maintenance } from './maintenance.js';

export const BACKUP_NAME_RE = /^taverna-\d{8}-\d{4}\.db$/;

export function backupDir() {
  return path.join(config.dataDir, 'backups');
}

/** Список копий: новые первыми */
export function listBackups() {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => BACKUP_NAME_RE.test(f))
    .map((name) => {
      const st = fs.statSync(path.join(dir, name));
      return { name, size: st.size, time: st.mtimeMs };
    })
    .sort((a, b) => b.time - a.time);
}

/** Время последней записи в базу: этим сервером или другим процессом (по файлам базы и журнала WAL) */
function lastWrite() {
  let t = db.lastWrite || 0;
  for (const f of [config.dbPath, config.dbPath + '-wal']) {
    try {
      t = Math.max(t, fs.statSync(f).mtimeMs);
    } catch {
      /* файла нет */
    }
  }
  return t;
}

let running = null;

/** Дождаться, пока закончится копирование базы (если оно идёт) */
export async function backupIdle() {
  while (running) await running.catch(() => {});
}

/** Сделать копию сейчас и удалить лишние старые */
export function makeBackup({ keep = config.backupKeep } = {}) {
  if (running) return running;
  running = (async () => {
    const dir = backupDir();
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
    const out = path.join(dir, `taverna-${stamp}.db`);
    const started = new Date();
    await db.backup(out);
    // время копии — момент снимка: всё, что записано позже, попадёт в следующую
    fs.utimesSync(out, started, started);
    const all = listBackups();
    for (const b of all.slice(Math.max(1, keep))) {
      try {
        fs.unlinkSync(path.join(dir, b.name));
      } catch {
        /* уже удалён */
      }
    }
    return { name: path.basename(out), size: fs.statSync(out).size, time: Date.now() };
  })().finally(() => {
    running = null;
  });
  return running;
}

/** Ежедневные (или с другим интервалом) копии; проверка — раз в час и через минуту после запуска */
export function scheduleBackups() {
  const hours = Number(config.backupIntervalHours);
  if (!(hours > 0)) return;
  const period = hours * 3600000;
  const tick = async () => {
    if (maintenance.active) return;
    const last = listBackups()[0];
    if (last && Date.now() - last.time < period - 5 * 60000) return;
    // база не менялась с прошлой копии (стол давно не открывали) — новая копия не нужна
    if (last && lastWrite() <= last.time) return;
    try {
      const r = await makeBackup();
      console.log(`[backup] копия базы: ${r.name} (${(r.size / 1048576).toFixed(1)} МБ)`);
    } catch (e) {
      console.error('[backup] не удалось сделать копию:', e.message);
    }
  };
  setTimeout(tick, 60000).unref();
  setInterval(tick, Math.min(period, 3600000)).unref();
}
