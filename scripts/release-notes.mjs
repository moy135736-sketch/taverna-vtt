#!/usr/bin/env node
// Описание выпуска для GitHub из CHANGELOG.md: раздел «## X.Y.Z …» до следующего раздела.
//   node scripts/release-notes.mjs 1.9.0 > notes.md
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2] || JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const log = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8').replace(/\r\n?/g, '\n');
const lines = log.split('\n');
const start = lines.findIndex((l) => new RegExp(`^## ${version.replace(/\./g, '\\.')}(\\s|$)`).test(l));
if (start < 0) {
  console.error(`В CHANGELOG.md нет раздела «## ${version}»`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
if (end < 0) end = lines.length;
const body = lines.slice(start + 1, end).join('\n').trim();

const files = `
### Файлы

| Файл | Для чего |
|---|---|
| \`Taverna-${version}-setup.exe\` | установщик для Windows 10/11 (64 бит) |
| \`Taverna-${version}-update.exe\` | обновление уже установленной Таверны: столы и персонажи сохраняются |
| \`Taverna-${version}-windows-x64.zip\` | переносная версия для Windows — без установки |
| \`taverna-${version}-linux-x64.tar.xz\` | программа для сервера с Linux: \`sudo ./taverna-linux-x64 install\` |
| \`taverna-${version}-linux-arm64.tar.xz\` | то же для ARM (Raspberry Pi, Oracle Ampere) |
| \`SHA256SUMS.txt\` | контрольные суммы файлов |

Windows может предупредить «Система Windows защитила ваш компьютер» — «Подробнее» → «Выполнить в любом случае»:
у программы нет платной цифровой подписи.`;

process.stdout.write(`${body}\n${files}\n`);
