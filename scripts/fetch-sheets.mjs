#!/usr/bin/env node
// Скачать листы из репозитория Roll20 в папку sheets/ — после перезапуска сервера
// они станут встроенными (доступны всем мастерам без импорта).
//   node scripts/fetch-sheets.mjs "Pathfinder Second Edition" "Call of Cthulhu 7th Edition Official"
//   node scripts/fetch-sheets.mjs --list [фильтр]     список папок репозитория
// Переменные: SHEETS_REPO, SHEETS_BRANCH, GITHUB_TOKEN (необязательно).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = process.env.SHEETS_REPO || 'Roll20/roll20-character-sheets';
const BRANCH = process.env.SHEETS_BRANCH || 'master';
const headers = { 'User-Agent': 'Taverna-VTT', Accept: 'application/vnd.github+json' };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
const raw = (p) => `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${enc(p)}`;

async function get(url, optional = false) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Taverna-VTT' } });
  if (!r.ok) {
    if (optional) return null;
    throw new Error(`${r.status} ${url}`);
  }
  return Buffer.from(await r.arrayBuffer());
}

async function list(filter) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/git/trees/${BRANCH}`, { headers });
  if (!r.ok) throw new Error('GitHub API: ' + r.status);
  const names = (await r.json()).tree.filter((e) => e.type === 'tree' && !/^[._]/.test(e.path)).map((e) => e.path);
  const f = (filter || '').toLowerCase();
  for (const n of names) if (!f || n.toLowerCase().includes(f)) console.log(n);
}

async function fetchSheet(folder) {
  const metaBuf = await get(raw(`${folder}/sheet.json`), true);
  if (!metaBuf) throw new Error('нет sheet.json — проверьте имя папки (--list покажет все)');
  const meta = JSON.parse(metaBuf.toString('utf8').replace(/^﻿/, ''));
  if (!meta.html) throw new Error('в sheet.json нет поля html');
  const dir = path.join(ROOT, 'sheets', folder);
  fs.mkdirSync(path.join(dir, 'translations'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sheet.json'), metaBuf);
  fs.writeFileSync(path.join(dir, meta.html), await get(raw(`${folder}/${meta.html}`)));
  if (meta.css) {
    const css = await get(raw(`${folder}/${meta.css}`), true);
    if (css) fs.writeFileSync(path.join(dir, meta.css), css);
  }
  const tr = await get(raw(`${folder}/translation.json`), true);
  if (tr) fs.writeFileSync(path.join(dir, 'translation.json'), tr);
  let langs = [];
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${enc(folder)}/translations?ref=${BRANCH}`, { headers });
  if (r.ok) langs = (await r.json()).filter((e) => /\.json$/.test(e.name)).map((e) => e.name);
  else langs = ['en.json', 'ru.json'];
  let n = 0;
  for (const f of langs) {
    const t = await get(raw(`${folder}/translations/${f}`), true);
    if (t) {
      fs.writeFileSync(path.join(dir, 'translations', f), t);
      n++;
    }
  }
  console.log(`✓ ${folder}: ${meta.html}${meta.css ? ', ' + meta.css : ''}, переводов: ${n}`);
}

const args = process.argv.slice(2);
if (!args.length) {
  console.log('Использование: node scripts/fetch-sheets.mjs <папка> [папка...] | --list [фильтр]');
  process.exit(1);
}
if (args[0] === '--list') await list(args[1]);
else {
  let failed = 0;
  for (const folder of args) {
    try {
      await fetchSheet(folder.replace(/^\/+|\/+$/g, ''));
    } catch (e) {
      failed++;
      console.error(`✗ ${folder}: ${e.message}`);
    }
  }
  if (!failed) console.log('Готово. Перезапустите сервер — листы появятся в списке при создании стола.');
  process.exit(failed ? 1 : 0);
}
