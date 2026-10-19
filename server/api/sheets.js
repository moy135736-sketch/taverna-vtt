import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { db, now, parseJSON } from '../db.js';
import { config } from '../config.js';
import { requireUser } from '../auth.js';
import { newId } from '../../shared/ids.js';
import { rooms } from '../game/rooms.js';

export const sheetsRouter = express.Router();
sheetsRouter.use(requireUser);

const MAX_SHEET_BYTES = 15 * 1024 * 1024;

function sheetListItem(s) {
  const meta = parseJSON(s.meta, {});
  let preview = '';
  if ((s.source === 'github' || s.source === 'builtin') && meta.preview) {
    preview = `https://raw.githubusercontent.com/${config.githubRepo}/${config.githubBranch}/${encodeURIComponent(s.source_ref).replace(/%2F/g, '/')}/${encodeURIComponent(meta.preview)}`;
  }
  return {
    id: s.id,
    name: s.name,
    source: s.source,
    sourceRef: s.source_ref,
    legacy: !!s.legacy,
    builtin: !!s.builtin,
    authors: meta.authors || '',
    instructions: typeof meta.instructions === 'string' ? meta.instructions.slice(0, 1500) : '',
    preview,
    version: s.version,
    updatedAt: s.updated_at,
    createdBy: s.created_by,
    languages: Object.keys(parseJSON(s.translations, {})),
  };
}

sheetsRouter.get('/', (req, res) => {
  const rows = db.prepare(`SELECT id, name, source, source_ref, legacy, builtin, meta, version, updated_at, created_by, translations FROM sheets ORDER BY builtin DESC, name`).all();
  res.json({ sheets: rows.map(sheetListItem) });
});

/** Получить лист целиком (для клиента). Перевод: базовый + выбранный язык. */
sheetsRouter.get('/:id/bundle', (req, res) => {
  const s = db.prepare(`SELECT * FROM sheets WHERE id=?`).get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Лист не найден' });
  const etag = `"${s.id}-${s.version}-${req.query.lang || ''}"`;
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  const translations = parseJSON(s.translations, {});
  const lang = String(req.query.lang || 'en');
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, no-cache');
  res.json({
    id: s.id,
    name: s.name,
    legacy: !!s.legacy,
    html: s.html,
    css: s.css,
    translation: parseJSON(s.translation, {}),
    lang: translations[lang] ? lang : 'en',
    langTranslation: translations[lang] || null,
    languages: Object.keys(translations),
    meta: parseJSON(s.meta, {}),
    version: s.version,
  });
});

// ---------------------------------------------------------------------------
// Сохранение листа
// ---------------------------------------------------------------------------

export function upsertSheet({ id, name, source, sourceRef, html, css, translation, translations, meta, builtin = false, userId = null }) {
  if (!html || typeof html !== 'string') throw new Error('Нет HTML листа');
  if (html.length > MAX_SHEET_BYTES) throw new Error('HTML листа слишком большой');
  const legacy = meta && meta.legacy === false ? 0 : 1;
  const t = now();
  const existing = id
    ? db.prepare(`SELECT id, version FROM sheets WHERE id=?`).get(id)
    : db.prepare(`SELECT id, version FROM sheets WHERE source=? AND source_ref=? AND source<>'upload'`).get(source, sourceRef);
  if (existing) {
    db.prepare(
      `UPDATE sheets SET name=?, legacy=?, html=?, css=?, translation=?, translations=?, meta=?, updated_at=?, version=version+1, builtin=? WHERE id=?`,
    ).run(name, legacy, html, css || '', JSON.stringify(translation || {}), JSON.stringify(translations || {}), JSON.stringify(meta || {}), t, builtin ? 1 : 0, existing.id);
    for (const room of rooms.all()) if (room.game.sheet_id === existing.id) room.broadcastSheetChanged();
    return existing.id;
  }
  const sid = id || newId();
  db.prepare(
    `INSERT INTO sheets(id, name, source, source_ref, legacy, html, css, translation, translations, meta, builtin, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(sid, name, source, sourceRef || '', legacy, html, css || '', JSON.stringify(translation || {}), JSON.stringify(translations || {}), JSON.stringify(meta || {}), builtin ? 1 : 0, userId, t, t);
  return sid;
}

function readJSONFile(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

/** Загрузить лист из папки на диске (структура как в репозитории Roll20). */
export function readSheetFolder(dir) {
  const meta = readJSONFile(path.join(dir, 'sheet.json')) || {};
  const files = fs.readdirSync(dir);
  const htmlName = meta.html && files.includes(meta.html) ? meta.html : files.find((f) => /\.html?$/i.test(f));
  const cssName = meta.css && files.includes(meta.css) ? meta.css : files.find((f) => /\.css$/i.test(f));
  if (!htmlName) throw new Error(`В папке ${dir} нет HTML листа`);
  const html = fs.readFileSync(path.join(dir, htmlName), 'utf8');
  const css = cssName ? fs.readFileSync(path.join(dir, cssName), 'utf8') : '';
  let translation = readJSONFile(path.join(dir, 'translation.json'));
  const translations = {};
  const tdir = path.join(dir, 'translations');
  if (fs.existsSync(tdir)) {
    for (const f of fs.readdirSync(tdir)) {
      const m = /^([a-zA-Z_-]+)\.json$/.exec(f);
      if (!m) continue;
      const data = readJSONFile(path.join(tdir, f));
      if (data) translations[m[1].toLowerCase()] = data;
    }
  }
  if (!translation) translation = translations.en || readJSONFile(path.join(dir, '_translation.json')) || {};
  return { meta, html, css, translation, translations };
}

/** Встроенные листы из папки sheets/ */
export function loadBuiltinSheets() {
  if (!fs.existsSync(config.sheetsDir)) return;
  const catalog = readJSONFile(path.join(config.sheetsDir, 'catalog.json')) || {};
  for (const folder of fs.readdirSync(config.sheetsDir)) {
    if (folder.startsWith('.') || folder === 'node_modules') continue;
    const dir = path.join(config.sheetsDir, folder);
    if (!fs.statSync(dir).isDirectory()) continue;
    try {
      const data = readSheetFolder(dir);
      const hash = crypto.createHash('sha1').update(data.html).update(data.css).update(JSON.stringify(data.translations)).update(JSON.stringify(data.meta)).digest('hex');
      const existing = db.prepare(`SELECT id, meta FROM sheets WHERE source='builtin' AND source_ref=?`).get(folder);
      if (existing && parseJSON(existing.meta, {})._hash === hash) continue;
      upsertSheet({
        name: catalog[folder]?.name || folder,
        source: 'builtin',
        sourceRef: folder,
        html: data.html,
        css: data.css,
        translation: data.translation,
        translations: data.translations,
        meta: { ...data.meta, _hash: hash, _description: catalog[folder]?.description || '' },
        builtin: true,
      });
      console.log(`[sheets] встроенный лист: ${catalog[folder]?.name || folder}`);
    } catch (e) {
      console.warn(`[sheets] не удалось загрузить ${folder}: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Импорт из GitHub (репозиторий Roll20/roll20-character-sheets)
// ---------------------------------------------------------------------------

const ghHeaders = () => {
  const h = { 'User-Agent': 'Taverna-VTT', Accept: 'application/vnd.github+json' };
  if (config.githubToken) h.Authorization = `Bearer ${config.githubToken}`;
  return h;
};

const rawUrl = (p) =>
  `https://raw.githubusercontent.com/${config.githubRepo}/${config.githubBranch}/${p
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;

async function fetchText(url, optional = false) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Taverna-VTT' } });
  if (!r.ok) {
    if (optional) return null;
    throw new Error(`GitHub ответил ${r.status} для ${url}`);
  }
  return r.text();
}

let folderCache = { at: 0, list: [] };

async function listRepoFolders() {
  if (folderCache.list.length && Date.now() - folderCache.at < 12 * 3600000) return folderCache.list;
  const r = await fetch(`https://api.github.com/repos/${config.githubRepo}/git/trees/${config.githubBranch}`, { headers: ghHeaders() });
  if (!r.ok) throw new Error(`GitHub API: ${r.status}`);
  const data = await r.json();
  const list = (data.tree || [])
    .filter((e) => e.type === 'tree' && !e.path.startsWith('.') && !e.path.startsWith('_'))
    .map((e) => e.path)
    .sort((a, b) => a.localeCompare(b));
  folderCache = { at: Date.now(), list };
  return list;
}

sheetsRouter.get('/github/list', async (req, res) => {
  try {
    res.json({ folders: await listRepoFolders() });
  } catch (e) {
    res.status(502).json({ error: 'Не удалось получить список листов с GitHub: ' + e.message });
  }
});

export async function importFromGithub(folder, userId) {
  folder = String(folder || '').trim().replace(/^\/+|\/+$/g, '');
  if (!folder || folder.includes('..')) throw new Error('Неверное имя папки');
  const metaText = await fetchText(rawUrl(`${folder}/sheet.json`), true);
  let meta = {};
  if (metaText) {
    try {
      meta = JSON.parse(metaText.replace(/^﻿/, ''));
    } catch {
      meta = {};
    }
  }
  if (!meta.html) throw new Error('В папке нет sheet.json с полем html — проверьте имя папки');
  const html = await fetchText(rawUrl(`${folder}/${meta.html}`));
  const css = meta.css ? (await fetchText(rawUrl(`${folder}/${meta.css}`), true)) || '' : '';
  let translation = null;
  const tText = await fetchText(rawUrl(`${folder}/translation.json`), true);
  if (tText) {
    try {
      translation = JSON.parse(tText.replace(/^﻿/, ''));
    } catch {
      /* ignore */
    }
  }
  const translations = {};
  let langs = [];
  try {
    const r = await fetch(`https://api.github.com/repos/${config.githubRepo}/contents/${folder.split('/').map(encodeURIComponent).join('/')}/translations?ref=${config.githubBranch}`, { headers: ghHeaders() });
    if (r.ok) langs = (await r.json()).filter((e) => /\.json$/.test(e.name)).map((e) => e.name.replace(/\.json$/, ''));
  } catch {
    /* ignore */
  }
  if (!langs.length) langs = ['en', 'ru', 'uk'];
  for (const lang of langs) {
    const t = await fetchText(rawUrl(`${folder}/translations/${lang}.json`), true);
    if (!t) continue;
    try {
      translations[lang.toLowerCase()] = JSON.parse(t.replace(/^﻿/, ''));
    } catch {
      /* ignore */
    }
  }
  if (!translation) translation = translations.en || {};
  return upsertSheet({ name: folder, source: 'github', sourceRef: folder, html, css, translation, translations, meta, userId });
}

sheetsRouter.post('/github/import', async (req, res) => {
  if (config.sheetImport === 'admin' && !req.user.isAdmin) return res.status(403).json({ error: 'Импорт листов разрешён только администратору' });
  try {
    const id = await importFromGithub(req.body?.folder, req.user.id);
    const s = db.prepare(`SELECT * FROM sheets WHERE id=?`).get(id);
    res.json({ sheet: sheetListItem(s) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

const canImport = (req) => config.sheetImport !== 'admin' || req.user.isAdmin;

sheetsRouter.post('/:id/refresh', async (req, res) => {
  if (!canImport(req)) return res.status(403).json({ error: 'Обновлять листы может только администратор' });
  const s = db.prepare(`SELECT * FROM sheets WHERE id=?`).get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Лист не найден' });
  if (s.source !== 'github' && s.source !== 'builtin') return res.status(400).json({ error: 'Этот лист загружен вручную — загрузите файлы заново' });
  try {
    await importFromGithub(s.source_ref, req.user.id);
    res.json({ sheet: sheetListItem(db.prepare(`SELECT * FROM sheets WHERE id=?`).get(s.id)) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Загрузка своих файлов листа
// ---------------------------------------------------------------------------

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_SHEET_BYTES, files: 80 } });

sheetsRouter.post('/upload', upload.array('files', 80), (req, res) => {
  if (!canImport(req)) return res.status(403).json({ error: 'Загружать листы может только администратор' });
  try {
    const files = req.files || [];
    let html = null,
      css = '',
      translation = null,
      meta = {};
    const translations = {};
    for (const f of files) {
      const name = Buffer.from(f.originalname, 'latin1').toString('utf8').split(/[\\/]/).pop();
      const text = f.buffer.toString('utf8').replace(/^﻿/, '');
      if (/\.html?$/i.test(name)) html = text;
      else if (/\.css$/i.test(name)) css = text;
      else if (name === 'sheet.json') meta = JSON.parse(text);
      else if (name === 'translation.json') translation = JSON.parse(text);
      else if (/^[a-zA-Z_-]{2,6}\.json$/.test(name)) translations[name.replace(/\.json$/, '').toLowerCase()] = JSON.parse(text);
    }
    if (!html) return res.status(400).json({ error: 'Нужен HTML-файл листа' });
    if (req.body?.legacy !== undefined && meta.legacy === undefined) meta.legacy = req.body.legacy !== 'false';
    const name = String(req.body?.name || '').trim().slice(0, 100) || 'Мой лист';
    let id = null;
    if (req.body?.replaceId) {
      const s = db.prepare(`SELECT * FROM sheets WHERE id=?`).get(req.body.replaceId);
      if (s && (s.created_by === req.user.id || req.user.isAdmin) && s.source === 'upload') id = s.id;
    }
    const sid = upsertSheet({ id, name, source: 'upload', sourceRef: '', html, css, translation: translation || translations.en || {}, translations, meta, userId: req.user.id });
    res.json({ sheet: sheetListItem(db.prepare(`SELECT * FROM sheets WHERE id=?`).get(sid)) });
  } catch (e) {
    res.status(400).json({ error: 'Ошибка в файлах листа: ' + e.message });
  }
});

sheetsRouter.delete('/:id', (req, res) => {
  const s = db.prepare(`SELECT * FROM sheets WHERE id=?`).get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Лист не найден' });
  if (s.builtin) return res.status(400).json({ error: 'Встроенный лист удалить нельзя' });
  if (s.created_by !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: 'Удалить может только загрузивший или администратор' });
  const used = db.prepare(`SELECT COUNT(*) c FROM games WHERE sheet_id=?`).get(s.id).c;
  if (used) return res.status(400).json({ error: `Лист используется в столах: ${used}` });
  db.prepare(`DELETE FROM sheets WHERE id=?`).run(s.id);
  res.json({ ok: true });
});
