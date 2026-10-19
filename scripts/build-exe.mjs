#!/usr/bin/env node
// Сборка Таверны в один исполняемый файл (Node.js Single Executable Application).
//   npm run build:exe                                  — Windows x64, Linux x64 и Linux ARM64
//   npm run build:exe -- --targets win-x64 --skip-client   — только нужные платформы, без пересборки сайта
// Результат — в папке release/:
//   Taverna-<версия>-setup.exe         установщик для Windows (нужен makensis: apt install nsis)
//   Taverna-<версия>-update.exe        обновление уже установленной Таверны (меняет программу, данные не трогает)
//   Taverna-<версия>-windows-x64.zip   переносная версия: Taverna.exe + «Как запустить.txt» + лицензии
//   taverna-<версия>-linux-x64.tar.xz  taverna-linux-x64 + инструкция + лицензии (и arm64)
// Node.js для каждой платформы берётся из npm-пакетов node-<платформа> (официальные сборки).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { encodePack } from '../desktop/pack.js';
import { licenseReport, packageDirOf } from './licenses.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const argv = process.argv.slice(2);
const arg = (name, d) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : d;
};
const NODE_VERSION = arg('node', '22.23.3');
const TARGETS = arg('targets', 'win-x64,linux-x64,linux-arm64').split(',').map((s) => s.trim()).filter(Boolean);
const SKIP_CLIENT = argv.includes('--skip-client');
const BUILD = path.join(ROOT, 'build', 'exe');
const CACHE = path.join(ROOT, 'build', 'cache');
const RELEASE = path.join(ROOT, 'release');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const t0 = Date.now();
const step = (s) => console.log(`\n▸ ${s}`);
const mb = (n) => (n / 1048576).toFixed(1) + ' МБ';
fs.mkdirSync(BUILD, { recursive: true });
fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(RELEASE, { recursive: true });

// ---------- 1. сайт ----------
if (!SKIP_CLIENT) {
  step('Сборка сайта (vite build)');
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: ROOT, stdio: 'inherit' });
}
if (!fs.existsSync(path.join(ROOT, 'dist/index.html'))) throw new Error('нет dist/ — соберите сайт (npm run build)');

// ---------- 2. код ----------
step('Сборка кода сервера в один файл (esbuild)');
const bundle = path.join(BUILD, 'taverna.cjs');
const serverBuild = await build({
  metafile: true,
  entryPoints: [path.join(ROOT, 'desktop/launcher.js')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  minifyWhitespace: true,
  minifySyntax: true,
  legalComments: 'none',
  external: ['bufferutil', 'utf-8-validate'],
  define: { __TAVERNA_VERSION__: JSON.stringify(pkg.version) },
  logOverride: { 'empty-import-meta': 'silent' },
  logLevel: 'warning',
});
console.log('  ', path.relative(ROOT, bundle), mb(fs.statSync(bundle).size));
// лицензии пакетов, вошедших в программу: сервер (по карте сборки esbuild) и сайт (dist/licenses.txt от Vite)
const serverPkgs = new Set(Object.keys(serverBuild.metafile.inputs).map((f) => packageDirOf(path.resolve(ROOT, f))).filter(Boolean));
const thirdParty = [
  licenseReport([...serverPkgs], 'Таверна, сервер (внутри программы)'),
  fs.existsSync(path.join(ROOT, 'dist/licenses.txt')) ? fs.readFileSync(path.join(ROOT, 'dist/licenses.txt'), 'utf8') : '',
].join('\n');
console.log(`   лицензии: пакетов сервера ${serverPkgs.size}`);

// ---------- 3. файлы сайта и листов ----------
step('Архив файлов сайта, листов и примера стола');
function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push(p);
  }
  return out;
}
const files = [];
const add = (abs) => files.push({ path: path.relative(ROOT, abs), data: fs.readFileSync(abs) });
for (const dir of ['dist', 'sheets', 'server/demo']) for (const f of walk(path.join(ROOT, dir))) add(f);
files.push({ path: 'package.json', data: Buffer.from(JSON.stringify({ name: pkg.name, version: pkg.version, private: true }, null, 2)) });
add(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'));
const pack = encodePack(files);
const packFile = path.join(BUILD, 'app.pack');
fs.writeFileSync(packFile, pack);
console.log(`   файлов: ${files.length}, ${mb(files.reduce((s, f) => s + f.data.length, 0))} → ${mb(pack.length)} (brotli)`);

// ---------- 4. Node.js для платформ ----------
const host = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
function nodeBinary(target) {
  const dir = path.join(CACHE, `node-${target}-${NODE_VERSION}`);
  const exe = path.join(dir, 'package', 'bin', target.startsWith('win') ? 'node.exe' : 'node');
  if (fs.existsSync(exe)) return exe;
  const tgz = path.join(CACHE, `node-${target}-${NODE_VERSION}.tgz`);
  if (!fs.existsSync(tgz)) {
    console.log(`   загрузка node-${target}@${NODE_VERSION} из npm…`);
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', `node-${target}@${NODE_VERSION}`, '--silent'], { cwd: CACHE, stdio: 'inherit', shell: process.platform === 'win32' });
  }
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('tar', ['-xzf', tgz, '-C', dir, 'package/bin']);
  try {
    execFileSync('tar', ['-xzf', tgz, '-C', dir, 'package/LICENSE'], { stdio: 'ignore' });
  } catch {
    /* в пакете для Windows лицензии нет — возьмём из другого пакета той же версии */
  }
  return exe;
}

// ---------- 5. заготовка SEA ----------
step(`Заготовка программы (Node.js ${NODE_VERSION})`);
const blob = path.join(BUILD, 'sea-prep.blob');
const seaConfig = path.join(BUILD, 'sea-config.json');
fs.writeFileSync(
  seaConfig,
  JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, assets: { 'app.pack': packFile } }, null, 2),
);
// заготовку делает тот же Node.js, что окажется внутри программы
const hostNode = nodeBinary(host);
execFileSync(hostNode, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });
const blobData = fs.readFileSync(blob);
console.log('  ', path.relative(ROOT, blob), mb(blobData.length));

// ---------- 6. программы ----------
const { inject } = await import('postject');

async function windowsResources(file) {
  const ResEdit = await import('resedit');
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(file), { ignoreCert: true }); // подпись Node.js после изменений недействительна — убираем
  const res = ResEdit.NtExecutableResource.from(exe);
  const icon = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(ROOT, 'desktop/taverna.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  for (const g of groups) ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, g.id, g.lang, icon.icons.map((i) => i.data));
  if (!groups.length) ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, icon.icons.map((i) => i.data));
  const [vi] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (vi) {
    const [a, b, c] = pkg.version.split('.').map(Number);
    vi.setFileVersion(a, b, c, 0, 1033);
    vi.setProductVersion(a, b, c, 0, 1033);
    vi.setStringValues(
      { lang: 1033, codepage: 1200 },
      {
        FileDescription: 'Taverna — virtual tabletop',
        ProductName: 'Taverna',
        CompanyName: 'Taverna VTT',
        OriginalFilename: 'Taverna.exe',
        InternalName: 'taverna',
        FileVersion: pkg.version,
        ProductVersion: pkg.version,
        LegalCopyright: 'MIT; Node.js (c) OpenJS Foundation and contributors',
      },
    );
    vi.outputToResourceEntries(res.entries);
  }
  res.outputResource(exe);
  fs.writeFileSync(file, Buffer.from(exe.generate()));
}

const NAMES = { 'win-x64': 'Taverna.exe', 'linux-x64': 'taverna-linux-x64', 'linux-arm64': 'taverna-linux-arm64' };
const built = [];
for (const target of TARGETS) {
  if (!NAMES[target]) throw new Error('неизвестная платформа: ' + target);
  step(`Программа для ${target}`);
  const out = path.join(BUILD, target, NAMES[target]);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(nodeBinary(target), out);
  fs.chmodSync(out, 0o755);
  await inject(out, 'NODE_SEA_BLOB', blobData, { sentinelFuse: FUSE });
  // Windows: иконка, сведения о программе и снятие подписи Node.js (после изменений она недействительна)
  if (target.startsWith('win')) await windowsResources(out);
  console.log('  ', path.relative(ROOT, out), mb(fs.statSync(out).size));
  built.push({ target, file: out });
}

// ---------- 7. архивы для раздачи ----------
step('Архивы в release/');
const crcTable = (() => {
  if (zlib.crc32) return null;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  if (zlib.crc32) return zlib.crc32(buf) >>> 0;
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
/** Простой zip (deflate, имена в UTF-8) */
function writeZip(out, entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = e.data;
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE((3 << 8) | 20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(dosTime, 12);
    cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(((e.mode || 0o644) << 16) >>> 0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(out, Buffer.concat([...parts, cd, end]));
}

const howto = (target, { installer = false } = {}) =>
  (target.startsWith('win')
    ? `ТАВЕРНА ${pkg.version} — виртуальный стол для настольных ролевых игр

КАК ЗАПУСТИТЬ
${
  installer
    ? `1. Таверна установлена. Запускайте её ярлыком «Таверна» на рабочем столе или в меню «Пуск».
2. Откроется окно сервера и браузер со столом.`
    : `1. Распакуйте архив в обычную папку (например, «Документы\\Таверна»). Не запускайте программу прямо из архива.
2. Дважды щёлкните Taverna.exe. Откроется окно сервера и браузер со столом.`
}
   Если Windows покажет «Система Windows защитила ваш компьютер» — нажмите «Подробнее» → «Выполнить в любом случае»
   (у программы нет платной цифровой подписи). Если спросит о доступе к сети — разрешите.
   Антивирусы иногда ошибочно реагируют на программы, собранные из Node.js; при сомнениях соберите файл сами
   из исходников (README, раздел «Сборка программы») — результат будет тем же.
3. Зарегистрируйтесь — первый аккаунт становится администратором. Создайте стол или откройте «Пример стола».
4. В окне сервера написан адрес для игроков (http://192.168.…:3000). Отправьте им его или ссылку-приглашение со стола.

Чтобы остановить сервер, закройте его окно. Все данные — в папке taverna-data рядом с программой${installer ? ' (ярлык «Папка с данными» в меню «Пуск» → «Таверна»)' : ''}:
её достаточно скопировать, чтобы сделать резервную копию или перенести стол на другой компьютер.
Настройки (порт, регистрация и т. п.) — в файле taverna-data\\config.env, открывается Блокнотом.
Обновить Таверну: закройте её окно и запустите файл обновления Taverna-<версия>-update.exe${installer ? '' : ', положив его рядом с Taverna.exe'}.
Заменится только программа — столы, персонажи и настройки останутся.
${installer ? 'Удалить программу — «Параметры» → «Приложения» или ярлык «Удалить Таверну»; данные можно оставить.\n' : ''}

ИГРОКИ НЕ В ВАШЕЙ СЕТИ
- Проще всего — общая виртуальная сеть: Radmin VPN, ZeroTier или Tailscale. Все ставят её, вступают в одну сеть,
  и игроки открывают адрес из окна сервера, который относится к этой сети.
- Или пробросьте порт 3000 на роутере (нужен «белый» IP от провайдера) и дайте игрокам ваш внешний IP.
- Или разместите Таверну на сервере в интернете (VPS) — версия для Linux ставится одной командой, см. README.

Голосовой чат браузер разрешает только по защищённому адресу. Игрокам по сети дайте адрес https://… из окна
сервера: браузер предупредит о самоподписанном сертификате — «Дополнительно» → «Перейти на сайт».
`
    : `ТАВЕРНА ${pkg.version} — виртуальный стол для настольных ролевых игр (Linux, ${target.split('-')[1]})

НА СЕРВЕРЕ (VPS) — одна команда:
  1. Направьте домен (A-запись) на IP сервера. Бесплатный поддомен можно взять, например, на duckdns.org.
  2. Загрузите файл ${NAMES[target]} на сервер и выполните:
       chmod +x ${NAMES[target]} && sudo ./${NAMES[target]} install
     Программа спросит домен и e-mail, установит службу, сама получит сертификат Let's Encrypt
     и будет запускаться вместе с сервером. Сайт: https://ваш-домен
  Обновление: так же запустите install из новой версии — настройки и данные сохранятся.
  Состояние: sudo taverna status. Журнал: journalctl -u taverna -f. Удаление: sudo taverna uninstall.
  Управление: sudo taverna admin list-users | reset-password <логин> <пароль> | make-admin <логин>

НА СВОЁМ КОМПЬЮТЕРЕ:
  ./${NAMES[target]}      — запустится сервер, данные — в папке taverna-data рядом с программой.

Справка по всем командам: ./${NAMES[target]} help
`
  ).replace(/\n/g, target.startsWith('win') ? '\r\n' : '\n');

const licenses = (target) => {
  const nodeLicense = [target, host]
    .map((t) => path.join(path.dirname(path.dirname(nodeBinary(t))), 'LICENSE'))
    .find((f) => fs.existsSync(f));
  const own = fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
  return [
    // сама Таверна — свободная программа под GNU AGPL-3.0
    { name: 'licenses/Taverna-LICENSE-AGPL-3.0.txt', data: Buffer.from(target.startsWith('win') ? '\ufeff' + own.replace(/\n/g, '\r\n') : own) },
    { name: 'licenses/THIRD_PARTY_NOTICES.md', data: fs.readFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md')) },
    { name: 'licenses/THIRD-PARTY-LICENSES.txt', data: Buffer.from((target.startsWith('win') ? '\ufeff' : '') + (target.startsWith('win') ? thirdParty.replace(/\n/g, '\r\n') : thirdParty)) },
    { name: 'licenses/Node.js-LICENSE.txt', data: fs.readFileSync(nodeLicense) },
    { name: 'licenses/roll20-character-sheets-LICENSE.txt', data: fs.readFileSync(path.join(ROOT, 'sheets/LICENSE-roll20-character-sheets.txt')) },
  ];
};

const sums = [];
const outputs = [];
const hasMakensis = (() => {
  try {
    execFileSync('makensis', ['-VERSION'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
for (const { target, file } of built) {
  if (target.startsWith('win')) {
    // переносная версия: zip
    const zip = path.join(RELEASE, `Taverna-${pkg.version}-windows-x64.zip`);
    writeZip(zip, [{ name: 'Taverna/Taverna.exe', data: fs.readFileSync(file), mode: 0o755 }, { name: 'Taverna/Как запустить.txt', data: Buffer.from('\ufeff' + howto(target)) }, ...licenses(target).map((l) => ({ ...l, name: 'Taverna/' + l.name }))]);
    outputs.push(zip);
    // установщик: один файл — ставит в папку пользователя, делает ярлыки и запускает
    if (hasMakensis) {
      const stage = path.join(BUILD, 'stage-' + target);
      fs.rmSync(stage, { recursive: true, force: true });
      fs.mkdirSync(path.join(stage, 'licenses'), { recursive: true });
      fs.copyFileSync(file, path.join(stage, 'Taverna.exe'));
      fs.copyFileSync(path.join(ROOT, 'desktop/taverna.ico'), path.join(stage, 'taverna.ico'));
      fs.copyFileSync(path.join(ROOT, 'desktop/wizard.bmp'), path.join(stage, 'wizard.bmp'));
      fs.writeFileSync(path.join(stage, 'Как запустить.txt'), '\ufeff' + howto(target, { installer: true }));
      for (const l of licenses(target)) fs.writeFileSync(path.join(stage, l.name), l.data);
      const setup = path.join(RELEASE, `Taverna-${pkg.version}-setup.exe`);
      const nsisEnv = { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }; // без UTF-8 makensis падает на русских именах файлов
      console.log('   установщик (NSIS, сжатие LZMA)…');
      execFileSync('makensis', ['-INPUTCHARSET', 'UTF8', '-V2', `-DVERSION=${pkg.version}`, `-DSTAGE=${stage}`, `-DOUTFILE=${setup}`, path.join(ROOT, 'desktop/installer.nsi')], { stdio: 'inherit', env: nsisEnv });
      outputs.push(setup);
      // файл обновления: находит установленную (или переносную) Таверну и меняет только программу, taverna-data не трогает
      fs.writeFileSync(path.join(stage, 'howto-installed.txt'), '﻿' + howto(target, { installer: true }));
      fs.writeFileSync(path.join(stage, 'howto-portable.txt'), '﻿' + howto(target));
      const [vMaj, vMin, vPatch] = pkg.version.split('.').map((n) => parseInt(n, 10) || 0);
      const update = path.join(RELEASE, `Taverna-${pkg.version}-update.exe`);
      console.log('   файл обновления…');
      execFileSync(
        'makensis',
        ['-INPUTCHARSET', 'UTF8', '-V2', `-DVERSION=${pkg.version}`, `-DVNUM=${vMaj * 1000000 + vMin * 1000 + vPatch}`, `-DSTAGE=${stage}`, `-DOUTFILE=${update}`, path.join(ROOT, 'desktop/update.nsi')],
        { stdio: 'inherit', env: nsisEnv },
      );
      outputs.push(update);
    } else console.log('   установщик пропущен: нет makensis (apt install nsis)');
  } else {
    const stage = path.join(BUILD, 'stage-' + target);
    fs.rmSync(stage, { recursive: true, force: true });
    const dir = path.join(stage, 'taverna');
    fs.mkdirSync(path.join(dir, 'licenses'), { recursive: true });
    fs.copyFileSync(file, path.join(dir, NAMES[target]));
    fs.chmodSync(path.join(dir, NAMES[target]), 0o755);
    fs.writeFileSync(path.join(dir, 'README.txt'), howto(target));
    for (const l of licenses(target)) fs.writeFileSync(path.join(dir, l.name), l.data);
    const out = path.join(RELEASE, `taverna-${pkg.version}-${target}.tar.xz`);
    console.log(`   архив ${path.basename(out)} (xz, около минуты)…`);
    execFileSync('tar', ['-cJf', out, '-C', stage, 'taverna'], { env: { ...process.env, XZ_OPT: '-9' } });
    outputs.push(out);
    // сам файл программы — тоже отдельно (удобно скачать прямо на сервер)
    fs.copyFileSync(file, path.join(RELEASE, NAMES[target]));
    fs.chmodSync(path.join(RELEASE, NAMES[target]), 0o755);
  }
}
for (const out of outputs) console.log('  ', path.relative(ROOT, out), mb(fs.statSync(out).size));
// контрольные суммы всех файлов этой версии (и собранных раньше, если сейчас собирались не все платформы)
for (const name of fs.readdirSync(RELEASE).sort()) {
  if (!name.includes(`-${pkg.version}-`)) continue;
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(RELEASE, name))).digest('hex');
  sums.push(`${hash}  ${name}`);
}
fs.writeFileSync(path.join(RELEASE, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
console.log(`\nГотово за ${Math.round((Date.now() - t0) / 1000)} с. Файлы — в ${path.relative(ROOT, RELEASE)}/`);
if (os.platform() !== 'linux') console.log('(сборка на этой ОС не проверялась — основной путь: Linux или WSL)');
