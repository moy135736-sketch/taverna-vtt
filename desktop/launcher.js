// Таверна одним файлом. Двойной щелчок — сервер запущен, браузер открыт, в окне — адреса для друзей.
// Этот же файл на Linux-сервере: `install` ставит службу с https, `serve` — запуск службы, `admin` — управление.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { extractPack } from './pack.js';
import { c, banner, setupLog, openBrowser, disableQuickEdit, fatal, explain, lanAddresses, pauseIfWindowsConsole } from './ui.js';

/* global __TAVERNA_VERSION__ */
const sea = (() => {
  try {
    return process.getBuiltinModule('node:sea');
  } catch {
    return null;
  }
})();
const IS_SEA = !!sea?.isSea?.();
const EXE_NAME = IS_SEA ? path.basename(process.execPath) : 'node desktop/launcher.js';

function devRoot() {
  if (process.env.TAVERNA_ROOT) return path.resolve(process.env.TAVERNA_ROOT);
  // исходники (ESM) или собранный файл (CJS) без вшитого архива
  const here = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..');
}

const VERSION =
  typeof __TAVERNA_VERSION__ !== 'undefined'
    ? __TAVERNA_VERSION__
    : (() => {
        try {
          return JSON.parse(fs.readFileSync(path.join(devRoot(), 'package.json'), 'utf8')).version;
        } catch {
          return '';
        }
      })();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on|да)$/i.test(String(v).trim()));

// ---------- параметры командной строки ----------
const FLAGS = new Set(['no-browser', 'no-https', 'staging', 'yes', 'no-domain', 'help', 'version']);
function parseArgs(list) {
  const opts = { _: [] };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '-h') opts.help = true;
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const key = k.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      if (eq > 0) opts[key] = a.slice(eq + 1);
      else if (FLAGS.has(k)) opts[key] = true;
      else opts[key] = list[++i];
    } else opts._.push(a);
  }
  return opts;
}

const HELP = `
  Таверна ${VERSION} — виртуальный стол для настольных ролевых игр

  Двойной щелчок по программе: сервер запускается, браузер открывается сам.

  Команды:
    (без команды)          запустить на этом компьютере; данные — в папке taverna-data рядом с программой
    serve [--domain ДОМЕН] запустить как сайт в интернете: с доменом — порты 80/443 и сертификат Let's Encrypt
    install                Linux-сервер: установить службу (спросит домен). Обновление — install из новой версии
    uninstall              удалить службу (данные остаются)
    status                 состояние службы и сертификата
    admin <команда>        управление: list-users, reset-password <логин> <пароль>, make-admin <логин>, stats
    version                версия программы

  Параметры:
    --port N               порт (по умолчанию 3000; для serve с доменом — 443)
    --data ПАПКА           где хранить базу и загруженные файлы
    --no-browser           не открывать браузер
    --no-https             не отвечать по https:// на том же порту
    --email АДРЕС          e-mail для писем Let's Encrypt (serve, install)
`;

// ---------- папки ----------
function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.probe-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe);
    return true;
  } catch {
    return false;
  }
}

function userDataDir() {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Taverna');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Taverna');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'taverna');
}

/** Запущено из архива, не распакованного в папку (Windows открывает такие файлы во временной папке) */
function insideTemp(dir) {
  if (process.platform !== 'win32') return false;
  const tmp = path.resolve(os.tmpdir()).toLowerCase();
  return path.resolve(dir).toLowerCase().startsWith(tmp + path.sep);
}

function readInstalled() {
  if (!IS_SEA) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(process.execPath), 'install.json'), 'utf8'));
  } catch {
    return null;
  }
}

let dataWarning = '';
function resolveDataDir(opts) {
  if (opts.data) return path.resolve(opts.data);
  if (process.env.TAVERNA_DATA) return path.resolve(process.env.TAVERNA_DATA);
  const installed = readInstalled();
  if (installed?.data) return installed.data;
  const base = IS_SEA ? path.dirname(process.execPath) : devRoot();
  const near = path.join(base, 'taverna-data');
  if (insideTemp(base)) {
    dataWarning = 'Программа запущена прямо из архива. Распакуйте её в обычную папку — данные пока сохраняются в ' + userDataDir();
    return userDataDir();
  }
  // база, которую на ходу синхронизирует OneDrive, может повредиться — храним её вне облачной папки
  if (process.platform === 'win32' && /[\\/]OneDrive( - [^\\/]+)?([\\/]|$)/i.test(base) && !fs.existsSync(near)) {
    dataWarning = `Папка программы синхронизируется с OneDrive, поэтому данные хранятся в ${userDataDir()}`;
    return userDataDir();
  }
  if (writable(near)) return near;
  dataWarning = `В папку с программой нельзя записывать, данные сохраняются в ${userDataDir()}`;
  return userDataDir();
}

const CONFIG_TEMPLATE = `# Настройки Таверны. Чтобы поменять настройку, уберите # в начале строки,
# впишите значение и перезапустите программу.

# Порт: адрес будет http://localhost:ПОРТ
#PORT=3000

# Отвечать и по https:// на том же порту (нужно игрокам по сети для голосового чата): on / off
#HTTPS=on

# Открывать браузер при запуске: on / off
#OPEN_BROWSER=on

# Регистрация новых игроков: on — открыта, off — закрыта (вход только для уже созданных аккаунтов)
#ALLOW_REGISTRATION=on
# Или регистрация только по коду, который вы сообщите игрокам
#REGISTRATION_CODE=

# Внешний адрес, если вы открыли доступ из интернета (например, https://dnd.example.ru)
#PUBLIC_URL=

# Максимальный размер одного файла: картинки или видео и звука (МБ)
#MAX_UPLOAD_MB=200
#MAX_AUDIO_MB=200

# Место для файлов одного игрока (МБ); 0 — без ограничения, сколько позволит диск
#USER_QUOTA_MB=0

# Автоматические копии базы: раз в сколько часов (0 — выключить) и сколько хранить
#BACKUP_INTERVAL_HOURS=24
#BACKUP_KEEP=14
`;

// подсказки прежних версий с устаревшими значениями по умолчанию; меняются только строки-комментарии,
// то есть настройки, которые человек задал сам, не трогаются
const OLD_HINTS = [
  [
    /# Максимальный размер загружаемой картинки и звука \(МБ\)\r?\n#MAX_UPLOAD_MB=40\r?\n#MAX_AUDIO_MB=80(?=\r?\n)/,
    '# Максимальный размер одного файла: картинки или видео и звука (МБ)\n#MAX_UPLOAD_MB=200\n#MAX_AUDIO_MB=200\n\n# Место для файлов одного игрока (МБ); 0 — без ограничения, сколько позволит диск\n#USER_QUOTA_MB=0',
  ],
];

function refreshConfigHints(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let out = text;
  for (const [re, hint] of OLD_HINTS) out = out.replace(re, hint.replace(/\n/g, eol));
  return out;
}

/** config.env в папке данных: создать с подсказками и прочитать (переменные окружения важнее) */
function loadConfigFile(dataDir) {
  const file = path.join(dataDir, 'config.env');
  if (!fs.existsSync(file)) {
    try {
      fs.writeFileSync(file, CONFIG_TEMPLATE.replace(/\n/g, os.EOL));
    } catch {
      return file;
    }
  }
  try {
    const text = fs.readFileSync(file, 'utf8');
    const fresh = refreshConfigHints(text);
    if (fresh !== text) fs.writeFileSync(file, fresh);
  } catch {
    /* только подсказки — не страшно */
  }
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  return file;
}

/** Файлы сайта и листов: из архива внутри программы — в <данные>/app/<версия> (один раз) */
async function prepareAppFiles(dataDir) {
  if (!IS_SEA) return devRoot();
  const pack = Buffer.from(sea.getAsset('app.pack'));
  const id = crypto.createHash('sha256').update(pack).digest('hex').slice(0, 16);
  const base = path.join(dataDir, 'app');
  const dir = path.join(base, id);
  if (fs.existsSync(path.join(dir, '.complete'))) return dir;
  const tmp = `${dir}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  extractPack(pack, tmp);
  fs.writeFileSync(path.join(tmp, '.complete'), VERSION);
  let root = tmp;
  // антивирус может ненадолго держать свежие файлы — пробуем переименовать несколько раз
  for (let i = 0; i < 8; i++) {
    try {
      fs.renameSync(tmp, dir);
      root = dir;
      break;
    } catch {
      if (fs.existsSync(path.join(dir, '.complete'))) {
        fs.rmSync(tmp, { recursive: true, force: true });
        root = dir;
        break;
      }
      await sleep(250);
    }
  }
  // прежние версии больше не нужны (если заняты другим запуском — удалим в следующий раз)
  for (const d of fs.readdirSync(base)) {
    if (d === id || path.join(base, d) === root) continue;
    try {
      fs.rmSync(path.join(base, d), { recursive: true, force: true });
    } catch {
      /* занято */
    }
  }
  return root;
}

// ---------- сеть ----------
async function pickHost() {
  if (process.env.HOST) return process.env.HOST;
  // '::' принимает и IPv6, и IPv4; если IPv6 выключен — обычный 0.0.0.0
  const ok = await new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(0, '::', () => s.close(() => resolve(true)));
  });
  return ok ? '::' : '0.0.0.0';
}

function portFree(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

async function tavernaAt(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    return j?.app === 'taverna';
  } catch {
    return false;
  }
}

function listenPlain(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/** Самоподписанный сертификат для https:// в локальной сети; пересоздаётся при смене адресов */
async function localTls(dataDir) {
  const { selfSigned, certExpiry } = await import('../server/x509.js');
  const dir = path.join(dataDir, 'tls');
  fs.mkdirSync(dir, { recursive: true });
  const files = { key: path.join(dir, 'local.key'), cert: path.join(dir, 'local.crt'), info: path.join(dir, 'local.json') };
  const host = os.hostname();
  const want = {
    dns: ['localhost', ...(/^[a-z0-9-]+(\.[a-z0-9-]+)*$/i.test(host) ? [host.toLowerCase()] : [])],
    ips: ['127.0.0.1', '::1', ...lanAddresses().map((a) => a.address)],
  };
  let pair = null;
  try {
    const info = JSON.parse(fs.readFileSync(files.info, 'utf8'));
    const cert = fs.readFileSync(files.cert, 'utf8');
    const exp = certExpiry(cert);
    const covers = want.ips.every((ip) => info.ips.includes(ip)) && want.dns.every((d) => info.dns.includes(d));
    if (covers && exp && exp.getTime() - Date.now() > 30 * 86400000) pair = { key: fs.readFileSync(files.key, 'utf8'), cert };
  } catch {
    /* сертификата ещё нет */
  }
  if (!pair) {
    pair = selfSigned({ commonName: 'Taverna', dnsNames: want.dns, ips: want.ips });
    fs.writeFileSync(files.key, pair.key, { mode: 0o600 });
    fs.writeFileSync(files.cert, pair.cert);
    fs.writeFileSync(files.info, JSON.stringify(want));
  }
  const ctx = tls.createSecureContext(pair);
  return { context: () => ctx, plain: 'serve' };
}

// ---------- запуск ----------
function serverEnv(root, dataDir, extra = {}) {
  process.env.TAVERNA_ROOT = root;
  process.env.DATA_DIR = dataDir;
  process.env.NODE_ENV ||= 'production';
  process.env.TRUST_PROXY ||= 'false'; // сервер открыт напрямую, без прокси перед ним
  for (const [k, v] of Object.entries(extra)) if (process.env[k] === undefined) process.env[k] = v;
}

function onStop(fn) {
  let done = false;
  const handler = (sig) => {
    if (done) return;
    done = true;
    fn(sig);
  };
  // SIGHUP в Windows — закрытие окна консоли
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try {
      process.on(sig, () => handler(sig));
    } catch {
      /* сигнал не поддерживается */
    }
  }
}

async function runLocal(opts) {
  if (process.platform === 'win32') process.title = 'Таверна';
  const dataDir = resolveDataDir(opts);
  fs.mkdirSync(dataDir, { recursive: true });
  const configFile = loadConfigFile(dataDir);
  const log = setupLog(dataDir);
  disableQuickEdit();
  log.say(`\n  ${c.gold('⬡')} ${c.bold('Таверна')} ${c.dim(VERSION)} — запускаю…`);
  if (dataWarning) log.say('  ' + c.gold(dataWarning));

  const preferred = Number(opts.port || process.env.PORT || 3000);
  const openUrl = (port) => `http://localhost${port === 80 ? '' : ':' + port}`;
  const wantBrowser = !opts.noBrowser && bool(process.env.OPEN_BROWSER, true);

  // уже запущена (второй двойной щелчок) — просто открыть её
  const lockFile = path.join(dataDir, 'taverna.lock');
  try {
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    if (lock.pid !== process.pid && (await tavernaAt(lock.port))) {
      log.say(`  Таверна уже запущена: ${c.cyan(openUrl(lock.port))}`);
      if (wantBrowser) openBrowser(openUrl(lock.port));
      await sleep(2500);
      process.exit(0);
    }
  } catch {
    /* не запущена */
  }

  const host = await pickHost();
  let port = preferred;
  while (!(await portFree(port, host))) {
    if (port === preferred && (await tavernaAt(port))) log.say(c.dim(`  Порт ${port} занят другой Таверной (с другой папкой данных) — беру следующий.`));
    if (++port > preferred + 20) throw Object.assign(new Error(`порты ${preferred}–${preferred + 20} заняты`), { code: 'EADDRINUSE', port: preferred });
  }

  const root = await prepareAppFiles(dataDir);
  const https = !opts.noHttps && bool(process.env.HTTPS, true);
  serverEnv(root, dataDir, { COOKIE_SECURE: 'false', HTTPS_SAME_PORT: https ? '1' : '0' });
  const tlsOpt = https ? await localTls(dataDir) : null;

  const { startServer, stopServer } = await import('../server/main.js');
  const handle = await startServer({ port, host, tls: tlsOpt });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, port }));

  banner({ version: VERSION, port, https, dataDir, logFile: log.file });
  if (port !== preferred) log.say(c.gold(`  Порт ${preferred} был занят, сервер работает на ${port}.`));
  log.say(c.dim(`  Настройки: ${configFile}`) + '\n');
  log.quiet();
  if (wantBrowser) openBrowser(openUrl(port));

  onStop((sig) => {
    try {
      fs.rmSync(lockFile, { force: true });
    } catch {
      /* не страшно */
    }
    stopServer(handle, sig);
  });
}

async function serve(opts) {
  const dataDir = resolveDataDir(opts);
  fs.mkdirSync(dataDir, { recursive: true });
  loadConfigFile(dataDir);
  const root = await prepareAppFiles(dataDir);
  const host = await pickHost();
  const domains = String(opts.domain || process.env.DOMAIN || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (!domains.length) {
    const port = Number(opts.port || process.env.PORT || 3000);
    const https = !opts.noHttps && bool(process.env.HTTPS, true);
    serverEnv(root, dataDir, { COOKIE_SECURE: 'false', HTTPS_SAME_PORT: https ? '1' : '0' });
    const tlsOpt = https ? await localTls(dataDir) : null;
    const { startServer, stopServer } = await import('../server/main.js');
    const handle = await startServer({ port, host, tls: tlsOpt });
    console.log(`[taverna] ${VERSION} работает на порту ${port} (http${https ? ' и https' : ''}), данные: ${dataDir}`);
    onStop((sig) => stopServer(handle, sig));
    return;
  }

  const httpsPort = Number(opts.port || process.env.PORT || 443);
  const httpPort = Number(opts.httpPort || process.env.HTTP_PORT || 80);
  serverEnv(root, dataDir, { PUBLIC_URL: `https://${domains[0]}${httpsPort === 443 ? '' : ':' + httpsPort}` });
  const { CertManager, LETS_ENCRYPT, LETS_ENCRYPT_STAGING } = await import('../server/acme.js');
  const certs = new CertManager({
    dir: path.join(dataDir, 'tls'),
    domains,
    email: opts.email || process.env.ACME_EMAIL || '',
    directory: opts.acmeDirectory || process.env.ACME_DIRECTORY || (opts.staging ? LETS_ENCRYPT_STAGING : LETS_ENCRYPT),
  });
  const plain = http.createServer(certs.httpHandler(httpsPort));
  await listenPlain(plain, httpPort, host).catch((e) => {
    throw Object.assign(e, { port: httpPort });
  });
  const { startServer, stopServer } = await import('../server/main.js');
  const handle = await startServer({ port: httpsPort, host, tls: { context: () => certs.context(), plain: 'redirect' } }).catch((e) => {
    throw Object.assign(e, { port: httpsPort });
  });
  console.log(`[taverna] ${VERSION}: https://${domains[0]}${httpsPort === 443 ? '' : ':' + httpsPort} (порты ${httpPort} и ${httpsPort}), данные: ${dataDir}`);
  certs.start();
  onStop((sig) => {
    certs.stop();
    plain.close();
    stopServer(handle, sig);
  });
}

async function admin(rest, opts) {
  const installed = readInstalled();
  const dataDir = resolveDataDir(opts);
  if (installed && process.getuid?.() === 0) {
    // работаем от имени службы, чтобы файлы базы остались ей доступны
    try {
      const gid = Number(execFileSync('id', ['-g', 'taverna']).toString());
      const uid = Number(execFileSync('id', ['-u', 'taverna']).toString());
      process.setgid(gid);
      process.setuid(uid);
    } catch {
      /* пользователя нет — остаёмся как есть */
    }
  }
  serverEnv(dataDir, dataDir);
  process.argv = [process.argv[0], 'taverna', ...rest];
  await import('../server/cli.js');
}

async function main() {
  const raw = process.argv.slice(2);
  const known = ['run', 'serve', 'install', 'uninstall', 'status', 'admin', 'help', 'version'];
  const cmd = raw[0] && !raw[0].startsWith('-') ? raw[0] : 'run';
  if (cmd === 'admin') {
    // всё после admin — команде управления; --data можно указать до неё
    const rest = raw.slice(1);
    const di = rest.indexOf('--data');
    const opts = {};
    if (di >= 0) {
      opts.data = rest[di + 1];
      rest.splice(di, 2);
    }
    return admin(rest, opts);
  }
  const opts = parseArgs(cmd === 'run' && raw[0] !== 'run' ? raw : raw.slice(1));
  if (opts.help || cmd === 'help' || !known.includes(cmd)) {
    console.log(HELP);
    if (!known.includes(cmd)) {
      console.log(`  Неизвестная команда: ${cmd}\n`);
      await pauseIfWindowsConsole();
      process.exit(1);
    }
    return;
  }
  if (opts.version || cmd === 'version') return console.log(VERSION);
  if (cmd === 'install' || cmd === 'uninstall' || cmd === 'status') {
    const svc = await import('./service.js');
    if (cmd === 'install') return svc.install({ ...opts, isSea: IS_SEA });
    if (cmd === 'uninstall') return svc.uninstall();
    return svc.status();
  }
  if (cmd === 'serve') return serve(opts);
  return runLocal(opts);
}

process.on('uncaughtException', (e) => console.error('[taverna] непредвиденная ошибка:', e));
process.on('unhandledRejection', (e) => console.error('[taverna] непредвиденная ошибка:', e));

main().catch((e) => {
  if (e?.userMessage) return fatal(e.message);
  const [msg, hint] = explain(e);
  return fatal(msg, hint);
});
