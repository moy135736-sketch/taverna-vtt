import crypto from 'node:crypto';
import express from 'express';
import { EventEmitter } from 'node:events';
import { db, now, parseJSON } from './db.js';
import { config } from './config.js';
import { newId } from '../shared/ids.js';

export const SESSION_COOKIE = 'tv_session';

// ---------------------------------------------------------------------------
// Пароли (scrypt из стандартной библиотеки)
// ---------------------------------------------------------------------------

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));

export function verifyPassword(password, stored) {
  try {
    const [algo, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Сессии
// ---------------------------------------------------------------------------

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createSession(userId, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  const t = now();
  db.prepare(`INSERT INTO sessions(id, user_id, created_at, expires_at, last_seen, ip, ua) VALUES (?,?,?,?,?,?,?)`).run(
    sha256(token),
    userId,
    t,
    t + config.sessionDays * 86400000,
    t,
    req?.ip || '',
    String(req?.headers?.['user-agent'] || '').slice(0, 200),
  );
  return token;
}

export function destroySession(token) {
  if (token) db.prepare(`DELETE FROM sessions WHERE id=?`).run(sha256(token));
}

const userCache = new Map(); // sessionHash -> {user, until}

export function userFromToken(token) {
  if (!token) return null;
  const h = sha256(token);
  const cached = userCache.get(h);
  const t = now();
  if (cached && cached.until > t) return cached.user;
  const row = db
    .prepare(
      `SELECT u.*, s.expires_at AS s_exp, s.last_seen AS s_seen FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    )
    .get(h);
  if (!row || row.s_exp < t || row.disabled) {
    userCache.delete(h);
    return null;
  }
  if (t - row.s_seen > 3600000) {
    // продлеваем «скользящую» сессию раз в час
    db.prepare(`UPDATE sessions SET last_seen=?, expires_at=? WHERE id=?`).run(t, t + config.sessionDays * 86400000, h);
  }
  const user = publicUser(row, true);
  userCache.set(h, { user, until: t + 30000 });
  return user;
}

export function invalidateUserCache() {
  userCache.clear();
}

export function publicUser(row, includePrivate = false) {
  if (!row) return null;
  const u = {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    color: row.color,
    avatar: row.avatar,
  };
  if (includePrivate) {
    u.isAdmin = !!row.is_admin;
    u.settings = parseJSON(row.settings, {});
  }
  return u;
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function isSecureRequest(req) {
  if (config.cookieSecure !== null) return config.cookieSecure;
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

function setSessionCookie(req, res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
    maxAge: config.sessionDays * 86400000,
    path: '/',
  });
}

/** middleware: req.user */
export function authMiddleware(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  req.sessionToken = cookies[SESSION_COOKIE] || null;
  req.user = userFromToken(req.sessionToken);
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Нужно войти в аккаунт' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Нужно войти в аккаунт' });
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Нужны права администратора' });
  next();
}

/** Защита от CSRF: изменяющие запросы должны нести заголовок X-Taverna */
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers['x-taverna'] !== '1') return res.status(403).json({ error: 'Запрос отклонён (CSRF)' });
  next();
}

// ---------------------------------------------------------------------------
// Ограничение частоты попыток входа
// ---------------------------------------------------------------------------

const attempts = new Map();
function rateLimited(key, limit = 20, windowMs = 10 * 60000) {
  const t = now();
  const a = (attempts.get(key) || []).filter((x) => t - x < windowMs);
  a.push(t);
  attempts.set(key, a);
  if (attempts.size > 10000) attempts.clear();
  return a.length > limit;
}

// ---------------------------------------------------------------------------
// Маршруты
// ---------------------------------------------------------------------------

const USERNAME_RE = /^[\p{L}\p{N}_.-]{3,32}$/u;
const PALETTE = ['#c0392b', '#2980b9', '#27ae60', '#8e44ad', '#d35400', '#16a085', '#f39c12', '#2c3e50', '#e84393', '#6c5ce7'];

export function createUser({ username, password, displayName, isAdmin = false }) {
  const id = newId();
  const color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
  db.prepare(
    `INSERT INTO users(id, username, display_name, password_hash, is_admin, color, created_at) VALUES (?,?,?,?,?,?,?)`,
  ).run(id, username, displayName || username, hashPassword(password), isAdmin ? 1 : 0, color, now());
  return db.prepare(`SELECT * FROM users WHERE id=?`).get(id);
}

/** «Профиль пользователя изменился» — столы обновляют список участников (имя, цвет, кубики) */
export const userEvents = new EventEmitter();

export const authRouter = express.Router();

authRouter.get('/config', (req, res) => {
  res.json({
    allowRegistration: config.allowRegistration,
    registrationCodeRequired: !!config.registrationCode,
  });
});

authRouter.post('/register', (req, res) => {
  if (rateLimited('reg:' + req.ip, config.registerRateLimit)) return res.status(429).json({ error: 'Слишком много попыток, подождите' });
  if (!config.allowRegistration) return res.status(403).json({ error: 'Регистрация закрыта администратором' });
  const { username, password, displayName, regCode } = req.body || {};
  if (config.registrationCode && regCode !== config.registrationCode)
    return res.status(403).json({ error: 'Неверный код регистрации' });
  if (!USERNAME_RE.test(String(username || '')))
    return res.status(400).json({ error: 'Логин: 3–32 символа (буквы, цифры, _ . -)' });
  if (String(password || '').length < 6) return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });
  if (db.prepare(`SELECT 1 FROM users WHERE username=?`).get(username))
    return res.status(409).json({ error: 'Такой логин уже занят' });
  const userCount = db.prepare(`SELECT COUNT(*) c FROM users`).get().c;
  const isAdmin = userCount === 0 || (config.adminUsername && config.adminUsername === String(username).toLowerCase());
  const row = createUser({
    username: String(username),
    password: String(password),
    displayName: String(displayName || username).slice(0, 40),
    isAdmin,
  });
  const token = createSession(row.id, req);
  setSessionCookie(req, res, token);
  res.json({ user: publicUser(row, true) });
});

authRouter.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (rateLimited('login:' + req.ip, 30)) return res.status(429).json({ error: 'Слишком много попыток, подождите 10 минут' });
  const row = db.prepare(`SELECT * FROM users WHERE username=?`).get(String(username || ''));
  // проверяем пароль и для несуществующего логина — чтобы по времени ответа нельзя было угадывать логины
  const ok = verifyPassword(String(password || ''), row ? row.password_hash : DUMMY_HASH);
  if (!row || !ok) return res.status(401).json({ error: 'Неверный логин или пароль' });
  if (row.disabled) return res.status(403).json({ error: 'Аккаунт заблокирован' });
  db.prepare(`UPDATE users SET last_login=? WHERE id=?`).run(now(), row.id);
  const token = createSession(row.id, req);
  setSessionCookie(req, res, token);
  res.json({ user: publicUser(row, true) });
});

authRouter.post('/logout', (req, res) => {
  destroySession(req.sessionToken);
  invalidateUserCache();
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  res.json({ user: req.user || null });
});

authRouter.patch('/me', requireUser, (req, res) => {
  const { displayName, color, avatar, settings, oldPassword, newPassword } = req.body || {};
  const row = db.prepare(`SELECT * FROM users WHERE id=?`).get(req.user.id);
  if (displayName !== undefined) {
    const dn = String(displayName).trim().slice(0, 40);
    if (!dn) return res.status(400).json({ error: 'Имя не может быть пустым' });
    db.prepare(`UPDATE users SET display_name=? WHERE id=?`).run(dn, row.id);
  }
  if (color !== undefined && /^#[0-9a-fA-F]{6}$/.test(color)) db.prepare(`UPDATE users SET color=? WHERE id=?`).run(color, row.id);
  if (avatar !== undefined) db.prepare(`UPDATE users SET avatar=? WHERE id=?`).run(String(avatar).slice(0, 1000), row.id);
  if (settings !== undefined && settings && typeof settings === 'object' && !Array.isArray(settings)) {
    const merged = JSON.stringify({ ...parseJSON(row.settings, {}), ...settings });
    if (merged.length > 20000) return res.status(400).json({ error: 'Слишком большие настройки' });
    db.prepare(`UPDATE users SET settings=? WHERE id=?`).run(merged, row.id);
  }
  if (newPassword !== undefined) {
    if (!verifyPassword(String(oldPassword || ''), row.password_hash))
      return res.status(400).json({ error: 'Старый пароль указан неверно' });
    if (String(newPassword).length < 6) return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });
    db.prepare(`UPDATE users SET password_hash=? WHERE id=?`).run(hashPassword(String(newPassword)), row.id);
    // завершаем остальные сессии
    db.prepare(`DELETE FROM sessions WHERE user_id=? AND id<>?`).run(row.id, sha256(req.sessionToken || ''));
  }
  invalidateUserCache();
  const fresh = db.prepare(`SELECT * FROM users WHERE id=?`).get(row.id);
  if (displayName !== undefined || color !== undefined || avatar !== undefined || settings !== undefined) userEvents.emit('changed', row.id);
  res.json({ user: publicUser(fresh, true) });
});

// Периодическая очистка просроченных сессий
setInterval(() => {
  try {
    db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(now());
  } catch (e) {
    console.error('[auth] очистка сессий:', e.message);
  }
}, 6 * 3600000).unref();
