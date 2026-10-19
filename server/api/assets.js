import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import express from 'express';
import multer from 'multer';
import { db, now } from '../db.js';
import { config } from '../config.js';
import { requireUser } from '../auth.js';
import { newId } from '../../shared/ids.js';
import { sniff } from '../../shared/sniff.js';

export const assetsRouter = express.Router();
assetsRouter.use(requireUser);

const tmpDir = path.join(config.dataDir, 'tmp');
fs.mkdirSync(tmpDir, { recursive: true });

const upload = multer({
  dest: tmpDir,
  limits: { fileSize: Math.max(config.maxUploadMb, config.maxAudioMb) * 1024 * 1024, files: 20 },
});

// Определение типа по сигнатуре файла (не доверяем расширению и заголовкам браузера) — общее с браузером
export { sniff };

// Размеры картинки по заголовку
export function imageSize(buf, mime) {
  try {
    if (mime === 'image/png') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (mime === 'image/gif') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (mime === 'image/webp') {
      const chunk = buf.slice(12, 16).toString('latin1');
      if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (chunk === 'VP8L') {
        const b0 = buf[21],
          b1 = buf[22],
          b2 = buf[23],
          b3 = buf[24];
        return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
      }
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) return null;
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        i += 2 + len;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function readHead(file, bytes = 256 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.slice(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

export function assetJSON(a) {
  return {
    id: a.id,
    name: a.name,
    url: '/uploads/' + a.file,
    mime: a.mime,
    kind: a.kind,
    size: a.size,
    width: a.width,
    height: a.height,
    folder: a.folder,
    gameId: a.game_id,
    ownerId: a.owner_id,
    createdAt: a.created_at,
  };
}

const usedBytes = (userId) => db.prepare(`SELECT COALESCE(SUM(size),0) s FROM assets WHERE owner_id=?`).get(userId).s;
/** Сколько ещё можно загрузить пользователю: без квоты (USER_QUOTA_MB=0) — сколько позволит диск */
const budgetFor = (userId) => (config.userQuotaMb > 0 ? config.userQuotaMb * 1024 * 1024 - usedBytes(userId) : Infinity);
const DISK_RESERVE = 200 * 1024 * 1024;

/** На диске должно остаться место и после загрузки — иначе сервер не сможет сохранить даже базу */
function checkDisk(size) {
  let free;
  try {
    const st = fs.statfsSync(config.uploadsDir);
    free = Number(st.bavail) * Number(st.bsize);
  } catch {
    return;
  }
  if (free - size < DISK_RESERVE) throw new Error(`На сервере заканчивается место на диске (свободно ${Math.max(0, Math.floor(free / 1048576))} МБ)`);
}

/** Проверить временный файл и сохранить его в библиотеку. Бросает ошибку с понятным текстом. */
function storeFile({ tmpPath, size, name, userId, gameId, folder, budget }) {
  const head = readHead(tmpPath);
  const type = sniff(head);
  if (!type || type.upload === false) throw new Error(`«${name}»: неподдерживаемый формат (нужны PNG, JPG, GIF, WebP, AVIF, MP4/WebM, MP3/OGG/WAV/FLAC)`);
  const limit = (type.kind === 'audio' ? config.maxAudioMb : config.maxUploadMb) * 1024 * 1024;
  if (size > limit) throw new Error(`«${name}»: файл слишком большой`);
  if (size > budget) throw new Error('Превышена квота места на диске для вашего аккаунта');
  checkDisk(size);
  const id = newId();
  const sub = id.slice(-2).replace(/[^A-Za-z0-9]/g, 'x');
  fs.mkdirSync(path.join(config.uploadsDir, sub), { recursive: true });
  const fileRel = `${sub}/${id}.${type.ext}`;
  fs.renameSync(tmpPath, path.join(config.uploadsDir, fileRel));
  const dims = type.kind === 'image' ? imageSize(head, type.mime) : null;
  const clean = String(name || 'file').replace(/\.[^.]+$/, '').slice(0, 120) || 'file';
  db.prepare(
    `INSERT INTO assets(id, owner_id, game_id, name, file, mime, kind, size, width, height, folder, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, userId, gameId, clean, fileRel, type.mime, type.kind, size, dims?.width || null, dims?.height || null, String(folder || '').slice(0, 100), now());
  return assetJSON(db.prepare(`SELECT * FROM assets WHERE id=?`).get(id));
}

const isMember = (gameId, userId) => !!db.prepare(`SELECT 1 FROM members WHERE game_id=? AND user_id=?`).get(gameId, userId);

assetsRouter.post('/', upload.array('files', 20), (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'Файл не получен' });
  const gameId = req.body?.gameId || null;
  if (gameId && !isMember(gameId, req.user.id)) {
    files.forEach((f) => fs.rmSync(f.path, { force: true }));
    return res.status(403).json({ error: 'Нет доступа к столу' });
  }
  let budget = budgetFor(req.user.id);
  const out = [];
  const errors = [];
  for (const f of files) {
    try {
      let name = Buffer.from(f.originalname || 'file', 'latin1').toString('utf8');
      if (/�/.test(name)) name = f.originalname || 'file';
      out.push(storeFile({ tmpPath: f.path, size: f.size, name, userId: req.user.id, gameId, folder: req.body?.folder, budget }));
      budget -= f.size;
    } catch (e) {
      fs.rmSync(f.path, { force: true });
      errors.push(e.message);
    }
  }
  if (!out.length) return res.status(400).json({ error: errors.join('; ') || 'Не удалось загрузить' });
  res.json({ assets: out, errors });
});

// ---------------------------------------------------------------------------
// Загрузка по ссылке: сервер сам скачивает картинку. Защита от SSRF: только http(s),
// адреса проверяются при соединении (внутренние сети и localhost запрещены).
// ---------------------------------------------------------------------------

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  const s = String(ip).toLowerCase();
  if (s === '::' || s === '::1') return true;
  if (/^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith('ff')) return true;
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  return m ? isPrivateIp(m[1]) : false;
}

function safeLookup(hostname, opts, cb) {
  dns.lookup(hostname, opts, (err, address, family) => {
    if (err) return cb(err);
    const list = Array.isArray(address) ? address : [{ address, family }];
    if (!config.assetFetchAllowPrivate && list.some((a) => isPrivateIp(a.address))) return cb(Object.assign(new Error('Адрес во внутренней сети запрещён'), { code: 'EPRIVATE' }));
    cb(null, address, family);
  });
}

function download(url, dest, maxBytes, redirects = 3) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error('Неверная ссылка'));
    }
    if (!/^https?:$/.test(u.protocol)) return reject(new Error('Нужна ссылка http(s)'));
    // IP-адрес в ссылке DNS не проходит — проверяем отдельно
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isPrivateIp(host) && !config.assetFetchAllowPrivate) return reject(Object.assign(new Error('Адрес во внутренней сети запрещён'), { code: 'EPRIVATE' }));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, { lookup: safeLookup, timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0 (Taverna VTT)', Accept: 'image/*,video/*,audio/*;q=0.9,*/*;q=0.5' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('Слишком много перенаправлений'));
        return resolve(download(new URL(res.headers.location, u).toString(), dest, maxBytes, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('Сайт ответил ' + res.statusCode));
      }
      if (Number(res.headers['content-length'] || 0) > maxBytes) {
        res.resume();
        return reject(new Error('Файл слишком большой'));
      }
      let size = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) req.destroy(new Error('Файл слишком большой'));
      });
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => {
        let name = '';
        try {
          name = decodeURIComponent(path.basename(u.pathname));
        } catch {
          name = path.basename(u.pathname);
        }
        resolve({ size, name: name || u.hostname });
      });
      res.pipe(out);
    });
    req.on('timeout', () => req.destroy(new Error('Сайт не ответил вовремя')));
    req.on('error', (e) => reject(e.code === 'EPRIVATE' ? e : new Error(e.message.startsWith('Файл') || e.message.startsWith('Сайт') ? e.message : 'Не удалось скачать: ' + e.message)));
  });
}

assetsRouter.post('/fetch', express.json(), async (req, res) => {
  const { url, gameId = null, folder = '' } = req.body || {};
  if (gameId && !isMember(gameId, req.user.id)) return res.status(403).json({ error: 'Нет доступа к столу' });
  const tmp = path.join(tmpDir, 'url-' + newId());
  try {
    const budget = budgetFor(req.user.id);
    const max = Math.min(Math.max(config.maxUploadMb, config.maxAudioMb) * 1024 * 1024, Math.max(0, budget));
    const { size, name } = await download(String(url || '').trim(), tmp, max);
    const asset = storeFile({ tmpPath: tmp, size, name, userId: req.user.id, gameId, folder, budget });
    res.json({ asset });
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    res.status(400).json({ error: e.message || 'Не удалось скачать файл' });
  }
});

assetsRouter.get('/', (req, res) => {
  const gameId = req.query.gameId;
  let rows;
  if (gameId && !db.prepare(`SELECT 1 FROM members WHERE game_id=? AND user_id=?`).get(gameId, req.user.id)) return res.status(403).json({ error: 'Нет доступа к столу' });
  const isGM = gameId && !!db.prepare(`SELECT 1 FROM members WHERE game_id=? AND user_id=? AND role='gm'`).get(gameId, req.user.id);
  if (gameId && isGM) {
    // мастер: свои файлы + файлы других мастеров этого стола, загруженные в этот стол
    rows = db
      .prepare(
        `SELECT * FROM assets WHERE owner_id=? OR (game_id=? AND owner_id IN (SELECT user_id FROM members WHERE game_id=? AND role='gm')) ORDER BY created_at DESC LIMIT 2000`,
      )
      .all(req.user.id, gameId, gameId);
  } else if (gameId) {
    // игрок видит только свои загрузки: карты и картинки мастера — не для его глаз
    rows = db.prepare(`SELECT * FROM assets WHERE owner_id=? ORDER BY created_at DESC LIMIT 2000`).all(req.user.id);
  } else {
    rows = db.prepare(`SELECT * FROM assets WHERE owner_id=? ORDER BY created_at DESC LIMIT 2000`).all(req.user.id);
  }
  const used = db.prepare(`SELECT COALESCE(SUM(size),0) s FROM assets WHERE owner_id=?`).get(req.user.id).s;
  res.json({ assets: rows.map(assetJSON), used, quota: config.userQuotaMb > 0 ? config.userQuotaMb * 1024 * 1024 : 0 });
});

assetsRouter.patch('/:id', (req, res) => {
  const a = db.prepare(`SELECT * FROM assets WHERE id=?`).get(req.params.id);
  if (!a || a.owner_id !== req.user.id) return res.status(404).json({ error: 'Файл не найден' });
  if (req.body?.name !== undefined) db.prepare(`UPDATE assets SET name=? WHERE id=?`).run(String(req.body.name).slice(0, 120), a.id);
  if (req.body?.folder !== undefined) db.prepare(`UPDATE assets SET folder=? WHERE id=?`).run(String(req.body.folder).slice(0, 100), a.id);
  res.json({ asset: assetJSON(db.prepare(`SELECT * FROM assets WHERE id=?`).get(a.id)) });
});

assetsRouter.delete('/:id', (req, res) => {
  const a = db.prepare(`SELECT * FROM assets WHERE id=?`).get(req.params.id);
  if (!a || a.owner_id !== req.user.id) return res.status(404).json({ error: 'Файл не найден' });
  db.prepare(`DELETE FROM assets WHERE id=?`).run(a.id);
  // Файл удаляем, только если на него больше никто не ссылается (ссылки в играх остаются строками URL)
  fs.rmSync(path.join(config.uploadsDir, a.file), { force: true });
  res.json({ ok: true });
});
