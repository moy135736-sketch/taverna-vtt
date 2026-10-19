#!/usr/bin/env node
// Резервная копия базы данных (безопасно при работающем сервере — согласованный снимок через VACUUM INTO).
//   node scripts/backup.mjs [папка]        по умолчанию: <DATA_DIR>/backups
// Хранит последние BACKUP_KEEP копий (по умолчанию 14).
// Загруженные файлы лежат в <DATA_DIR>/uploads — их копируйте вместе с базой (см. README).
import fs from 'node:fs';
import path from 'node:path';
import Database from '../server/sqlite.js';
import { config } from '../server/config.js';

const dir = path.resolve(process.argv[2] || path.join(config.dataDir, 'backups'));
const keep = Number(process.env.BACKUP_KEEP || 14);
fs.mkdirSync(dir, { recursive: true });

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
const out = path.join(dir, `taverna-${stamp}.db`);
const db = new Database(config.dbPath, { readonly: true, fileMustExist: true });
await db.backup(out);
db.close();
console.log('Копия базы:', out, `(${(fs.statSync(out).size / 1048576).toFixed(1)} МБ)`);

const old = fs
  .readdirSync(dir)
  .filter((f) => /^taverna-\d{8}-\d{4}\.db$/.test(f))
  .sort()
  .reverse()
  .slice(keep);
for (const f of old) {
  fs.unlinkSync(path.join(dir, f));
  console.log('Удалена старая копия:', f);
}
