// Встроенный бестиарий: монстры и животные System Reference Document 5.2.1 (CC BY 4.0, © Wizards of the Coast)
// из Markdown-версии SRD (github.com/downfallx/dnd-5e-srd-markdown, тоже CC BY 4.0).
//   git clone --depth 1 https://github.com/downfallx/dnd-5e-srd-markdown /tmp/srd-md
//   node scripts/make-srd-bestiary.mjs /tmp/srd-md
// Результат — client/public/srd/monsters.json (стол грузит его, когда мастер открывает бестиарий).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSrdMarkdown, SRD_ATTRIBUTION } from '../shared/bestiary.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = process.argv[2];
if (!src || !fs.existsSync(path.join(src, 'monsters-A-Z.md'))) {
  console.error('Укажите папку с dnd-5e-srd-markdown: node scripts/make-srd-bestiary.mjs <папка>');
  process.exit(1);
}
const monsters = [];
for (const f of ['monsters-A-Z.md', 'animals.md']) {
  const list = parseSrdMarkdown(fs.readFileSync(path.join(src, f), 'utf8'));
  console.log(`${f}: ${list.length}`);
  monsters.push(...list);
}
// одинаковые имена (бывает в разных файлах) — разные id
const seen = new Map();
for (const m of monsters) {
  const n = (seen.get(m.id) || 0) + 1;
  seen.set(m.id, n);
  if (n > 1) m.id += '-' + n;
}
monsters.sort((a, b) => a.name.localeCompare(b.name, 'en'));
const out = {
  source: 'SRD 5.2.1',
  license: 'CC BY 4.0',
  attribution: SRD_ATTRIBUTION + ' Markdown version: https://github.com/downfallx/dnd-5e-srd-markdown (CC BY 4.0).',
  monsters,
};
const file = path.join(ROOT, 'client/public/srd/monsters.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(out));
console.log(`монстров: ${monsters.length}, ${(fs.statSync(file).size / 1024).toFixed(0)} КБ → ${path.relative(ROOT, file)}`);
