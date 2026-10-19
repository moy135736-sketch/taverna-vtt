import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAdmin, hashPassword, invalidateUserCache } from '../auth.js';
import { rooms } from '../game/rooms.js';
import { listBackups, makeBackup, backupDir, BACKUP_NAME_RE } from '../backup.js';
import { sendFullBackup, appendChunk, startRestoreFromUpload, startRestoreFromBackup, startRestoreFromPoint, listRestorePoints, job } from '../restore.js';

export const adminRouter = express.Router();
adminRouter.use(requireAdmin);

adminRouter.get('/users', (req, res) => {
  const users = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.is_admin, u.disabled, u.created_at, u.last_login,
        (SELECT COUNT(*) FROM members m WHERE m.user_id=u.id) AS games,
        (SELECT COALESCE(SUM(size),0) FROM assets a WHERE a.owner_id=u.id) AS storage
       FROM users u ORDER BY u.created_at`,
    )
    .all();
  res.json({
    users: users.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      isAdmin: !!u.is_admin,
      disabled: !!u.disabled,
      createdAt: u.created_at,
      lastLogin: u.last_login,
      games: u.games,
      storage: u.storage,
    })),
  });
});

adminRouter.patch('/users/:id', (req, res) => {
  const u = db.prepare(`SELECT * FROM users WHERE id=?`).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Пользователь не найден' });
  const { isAdmin, disabled, password } = req.body || {};
  if (isAdmin !== undefined) {
    if (u.id === req.user.id && !isAdmin) return res.status(400).json({ error: 'Нельзя снять права с самого себя' });
    db.prepare(`UPDATE users SET is_admin=? WHERE id=?`).run(isAdmin ? 1 : 0, u.id);
  }
  if (disabled !== undefined) {
    if (u.id === req.user.id) return res.status(400).json({ error: 'Нельзя заблокировать самого себя' });
    db.prepare(`UPDATE users SET disabled=? WHERE id=?`).run(disabled ? 1 : 0, u.id);
    if (disabled) {
      db.prepare(`DELETE FROM sessions WHERE user_id=?`).run(u.id);
      invalidateUserCache();
      rooms.disconnectUser(u.id, 'Аккаунт заблокирован администратором');
    }
  }
  if (password) {
    if (String(password).length < 6) return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });
    db.prepare(`UPDATE users SET password_hash=? WHERE id=?`).run(hashPassword(String(password)), u.id);
    db.prepare(`DELETE FROM sessions WHERE user_id=?`).run(u.id);
    invalidateUserCache();
    if (u.id !== req.user.id) rooms.disconnectUser(u.id, 'Пароль изменён администратором — войдите заново');
  }
  invalidateUserCache();
  res.json({ ok: true });
});

adminRouter.get('/stats', (req, res) => {
  const count = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  let dbSize = 0;
  try {
    dbSize = fs.statSync(config.dbPath).size;
  } catch {
    /* ignore */
  }
  const storage = db.prepare(`SELECT COALESCE(SUM(size),0) s FROM assets`).get().s;
  res.json({
    users: count('users'),
    games: count('games'),
    sheets: count('sheets'),
    messages: count('messages'),
    assets: count('assets'),
    storage,
    dbSize,
    activeRooms: rooms.all().map((r) => ({ id: r.id, name: r.game.name, online: r.onlineUserIds().length })),
    uptime: process.uptime(),
    dataDir: path.resolve(config.dataDir),
  });
});

// ---------------------------------------------------------------------------
// Резервные копии базы
// ---------------------------------------------------------------------------

adminRouter.get('/backups', (req, res) => {
  res.json({ backups: listBackups(), restorePoints: listRestorePoints(), intervalHours: config.backupIntervalHours, keep: config.backupKeep });
});

adminRouter.post('/backups', async (req, res) => {
  try {
    const b = await makeBackup();
    res.json({ backup: b, backups: listBackups() });
  } catch (e) {
    res.status(500).json({ error: 'Не удалось сделать копию: ' + e.message });
  }
});

adminRouter.get('/backups/:name', (req, res) => {
  const name = String(req.params.name || '');
  if (!BACKUP_NAME_RE.test(name)) return res.status(400).json({ error: 'Неверное имя файла' });
  const file = path.join(backupDir(), name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Копия не найдена' });
  res.download(file, name);
});

// ---------------------------------------------------------------------------
// Полная копия одним файлом и восстановление
// ---------------------------------------------------------------------------

const sendError = (res, e) => res.status(e.status || 500).json({ error: e.expose || e.status ? e.message : 'Не удалось: ' + e.message, ...(e.size !== undefined ? { size: e.size } : {}) });

adminRouter.get('/backup/full', async (req, res) => {
  try {
    await sendFullBackup(res);
  } catch (e) {
    console.error('[backup] полная копия:', e.message);
    if (!res.headersSent) sendError(res, e);
    else res.destroy(e);
  }
});

// файл копии приходит кусками: X-Upload-Id, X-Offset (с какого байта), X-Total (размер всего файла)
adminRouter.post('/restore/upload', async (req, res) => {
  try {
    const size = await appendChunk(String(req.get('X-Upload-Id') || ''), Number(req.get('X-Offset') || 0), Number(req.get('X-Total') || 0), req);
    res.json({ size });
  } catch (e) {
    sendError(res, e);
  }
});

adminRouter.post('/restore/start', (req, res) => {
  try {
    res.json({ job: startRestoreFromUpload(String(req.body?.uploadId || '')) });
  } catch (e) {
    sendError(res, e);
  }
});

adminRouter.post('/backups/:name/restore', (req, res) => {
  try {
    res.json({ job: startRestoreFromBackup(String(req.params.name || '')) });
  } catch (e) {
    sendError(res, e);
  }
});

adminRouter.post('/restore-points/:name/restore', (req, res) => {
  try {
    res.json({ job: startRestoreFromPoint(String(req.params.name || '')) });
  } catch (e) {
    sendError(res, e);
  }
});

adminRouter.get('/restore/status', (req, res) => res.json({ job }));
