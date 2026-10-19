// Тексты лицензий сторонних пакетов, вошедших в сборку (сайт собирает Vite, сервер — esbuild).
// Лицензии MIT, BSD, Apache и др. требуют распространять их текст вместе с программой.
import fs from 'node:fs';
import path from 'node:path';

/** Папка пакета по пути файла внутри node_modules (null — не из node_modules) */
export function packageDirOf(file) {
  const p = String(file).replace(/^\0/, '').split('?')[0].replace(/\\/g, '/');
  const i = p.lastIndexOf('/node_modules/');
  if (i < 0) return null;
  const rest = p.slice(i + 14).split('/');
  const n = rest[0].startsWith('@') ? 2 : 1;
  if (rest.length <= n - 1 || !rest[n - 1]) return null;
  return p.slice(0, i + 14) + rest.slice(0, n).join('/');
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;

function licenseText(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => LICENSE_FILE.test(f) && fs.statSync(path.join(dir, f)).isFile());
  } catch {
    return '';
  }
  // сначала LICENSE, потом NOTICE (её требует Apache-2.0)
  files.sort((a, b) => /^notice/i.test(a) - /^notice/i.test(b) || a.localeCompare(b));
  return files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim()).join('\n\n');
}

/** Отчёт по пакетам: имя, версия, лицензия, ссылка и полный текст лицензии */
export function licenseReport(dirs, title) {
  const seen = new Map();
  for (const d of dirs) {
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    if (!pkg.name) continue;
    const key = pkg.name + '@' + pkg.version;
    if (seen.has(key)) continue;
    const lic = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type || (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type || l).join(' OR ') : '');
    const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || '';
    const url = pkg.homepage || repo.replace(/^git\+/, '').replace(/\.git$/, '');
    seen.set(key, { name: pkg.name, version: pkg.version, lic: lic || 'см. текст', url, text: licenseText(d) });
  }
  const list = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  const line = '='.repeat(72);
  const out = [`${title}: сторонние пакеты (${list.length}) и тексты их лицензий.`, ''];
  for (const p of list) {
    out.push(line, `${p.name} ${p.version} — ${p.lic}`);
    if (p.url) out.push(p.url);
    out.push('', p.text || `(в пакете нет отдельного файла лицензии; лицензия: ${p.lic})`, '');
  }
  return out.join('\n') + '\n';
}
