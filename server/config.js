import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Корень проекта: рядом с server/ лежат dist/ (сайт), sheets/ (листы) и package.json.
// Программа одним файлом распаковывает их в свою папку и передаёт её через TAVERNA_ROOT.
export const ROOT = process.env.TAVERNA_ROOT ? path.resolve(process.env.TAVERNA_ROOT) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '';
  } catch {
    return '';
  }
})();

// Простейшая загрузка .env (без зависимостей)
function loadDotEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadDotEnv();

const env = process.env;
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));
const list = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const dataDir = path.resolve(ROOT, env.DATA_DIR || 'data');

export const config = {
  port: num(env.PORT, 3000),
  host: env.HOST || '0.0.0.0',
  dataDir,
  uploadsDir: path.join(dataDir, 'uploads'),
  dbPath: path.join(dataDir, 'taverna.db'),
  clientDist: path.join(ROOT, 'dist'),
  // папка встроенных листов (структура как в репозитории Roll20); можно подключить свою
  sheetsDir: path.resolve(ROOT, env.SHEETS_DIR || 'sheets'),
  publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
  // Регистрация: открытая (по умолчанию), по коду (REGISTRATION_CODE) или закрыта
  allowRegistration: bool(env.ALLOW_REGISTRATION, true),
  registrationCode: env.REGISTRATION_CODE || '',
  adminUsername: (env.ADMIN_USERNAME || '').toLowerCase(),
  // сколько аккаунтов можно создать с одного IP за 10 минут
  registerRateLimit: num(env.REGISTER_RATE_LIMIT, 10),
  maxUploadMb: num(env.MAX_UPLOAD_MB, 200),
  maxAudioMb: num(env.MAX_AUDIO_MB, 200),
  // место на диске для файлов одного пользователя, МБ; 0 — без ограничения (сколько позволит диск сервера)
  userQuotaMb: num(env.USER_QUOTA_MB, 0),
  sessionDays: num(env.SESSION_DAYS, 60),
  trustProxy: env.TRUST_PROXY === undefined ? 1 : env.TRUST_PROXY,
  cookieSecure: env.COOKIE_SECURE === undefined ? null : bool(env.COOKIE_SECURE, false),
  // заголовок HSTS (только когда сервер сам отвечает по https с настоящим сертификатом)
  hsts: bool(env.HSTS, false),
  // сервер сам отвечает и по https:// на том же порту (программа одним файлом) — клиент подскажет адрес
  httpsSamePort: bool(env.HTTPS_SAME_PORT, false),
  githubToken: env.GITHUB_TOKEN || '',
  githubRepo: env.SHEETS_REPO || 'Roll20/roll20-character-sheets',
  githubBranch: env.SHEETS_BRANCH || 'master',
  // Кто может импортировать листы с GitHub: admin | gm
  sheetImport: env.SHEET_IMPORT || 'gm',
  chatHistory: num(env.CHAT_HISTORY, 200),
  // автоматические копии базы: раз в N часов (0 — выключить), сколько хранить
  backupIntervalHours: num(env.BACKUP_INTERVAL_HOURS, 24),
  backupKeep: num(env.BACKUP_KEEP, 14),
  // Голосовой и видеочат (WebRTC): сервер только пересылает сигналы, звук идёт напрямую между игроками
  voiceEnabled: bool(env.VOICE_ENABLED, true),
  voiceMax: num(env.VOICE_MAX, 10),
  // STUN помогает игрокам за NAT найти друг друга; TURN — ретранслятор для строгих сетей
  stunUrls: list(env.STUN_URLS === undefined ? 'stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478' : env.STUN_URLS),
  turnUrls: list(env.TURN_URLS),
  turnSecret: env.TURN_SECRET || '', // общий секрет coturn (use-auth-secret) — временные пароли
  turnUsername: env.TURN_USERNAME || '',
  turnPassword: env.TURN_PASSWORD || '',
  // только для тестов: разрешить загрузку по ссылке с внутренних адресов
  assetFetchAllowPrivate: bool(env.ASSET_FETCH_ALLOW_PRIVATE, false),
  dev: env.NODE_ENV !== 'production',
};

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.uploadsDir, { recursive: true });
