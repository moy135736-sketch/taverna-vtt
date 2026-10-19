// Сборка и запуск сервера. Используется обычным запуском (server/index.js)
// и программой одним файлом (desktop/launcher.js).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import compression from 'compression';
import { config, VERSION } from './config.js';
import './db.js';
import { authMiddleware, authRouter, csrfGuard, requireUser } from './auth.js';
import { lanAddresses } from './lan.js';
import { gamesRouter } from './api/games.js';
import { assetsRouter } from './api/assets.js';
import { sheetsRouter, loadBuiltinSheets } from './api/sheets.js';
import { adminRouter } from './api/admin.js';
import { bestiaryRouter } from './api/bestiary.js';
import { setupSockets } from './game/socket.js';
import { scheduleBackups } from './backup.js';
import { rooms } from './game/rooms.js';
import { listen } from './listen.js';
import { maintenanceGuard } from './maintenance.js';
import { cleanupRestoreLeftovers } from './restore.js';

// Базовые заголовки безопасности.
// CSP запрещает внедрённые скрипты; картинки, шрифты и стили листов могут быть с любых https-адресов
// (так устроены листы Roll20). 'unsafe-eval' нужен песочнице sheet workers (код листа исполняется в Web Worker).
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval'",
  "worker-src 'self' blob: data:",
  "style-src 'self' 'unsafe-inline' https:",
  "font-src 'self' data: https:",
  "img-src 'self' data: blob: https: http:",
  "media-src 'self' data: blob: https: http:",
  // бестиарий мастера загружает монстров прямо с GitHub (gist и файлы репозиториев)
  "connect-src 'self' https://raw.githubusercontent.com https://gist.githubusercontent.com",
  "frame-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

export function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy === 'false' ? false : isNaN(Number(config.trustProxy)) ? config.trustProxy : Number(config.trustProxy));
  app.disable('x-powered-by');
  app.use(compression());

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    // микрофон и камера — только самому сайту (голосовой чат), остальное не нужно
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(), geolocation=(), payment=(), usb=(), serial=()');
    if (config.hsts && req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (!req.path.startsWith('/uploads/') && !req.path.startsWith('/api/')) res.setHeader('Content-Security-Policy', CSP);
    next();
  });

  app.use(maintenanceGuard);
  app.use('/api', express.json({ limit: '20mb' }));
  app.use(authMiddleware);
  app.use('/api', csrfGuard);
  app.use('/api/auth', authRouter);
  app.use('/api/games', gamesRouter);
  app.use('/api/assets', assetsRouter);
  app.use('/api/sheets', sheetsRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/bestiary', bestiaryRouter);
  app.get('/api/health', (req, res) => res.json({ ok: true, app: 'taverna', version: VERSION }));
  // как открыть стол с телефона или с другого компьютера: адреса этого компьютера в сети, порт, есть ли https
  app.get('/api/lan', requireUser, (req, res) => {
    res.json({
      addresses: config.publicUrl ? [] : lanAddresses(),
      port: req.socket.localPort || config.port,
      https: config.httpsSamePort,
      publicUrl: config.publicUrl || null,
    });
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'Не найдено' }));

  // Загруженные файлы (картинки, видео, звук)
  app.use(
    '/uploads',
    express.static(config.uploadsDir, {
      maxAge: '365d',
      immutable: true,
      fallthrough: false,
      setHeaders: (res) => {
        res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
        res.setHeader('Access-Control-Allow-Origin', '*');
      },
    }),
  );

  // Клиент (собранный Vite)
  const indexHtml = path.join(config.clientDist, 'index.html');
  if (fs.existsSync(indexHtml)) {
    app.use(
      express.static(config.clientDist, {
        index: false,
        setHeaders: (res, p) => {
          if (/[\\/]assets[\\/]/.test(p)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          else res.setHeader('Cache-Control', 'no-cache');
        },
      }),
    );
    app.get(/^\/(?!api|uploads|socket\.io).*/, (req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  } else {
    app.get('/', (req, res) =>
      res
        .type('html')
        .send('<h1>Таверна</h1><p>Клиент ещё не собран. Выполните <code>npm run build</code> или запустите <code>npm run dev:client</code>.</p>'),
    );
  }

  // Обработчик ошибок
  app.use((err, req, res, next) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Файл слишком большой' });
    if (err?.status === 404 || err?.statusCode === 404) return res.status(404).end();
    console.error('[http]', err);
    res.status(err.status || 500).json({ error: err.expose ? err.message : 'Внутренняя ошибка сервера' });
  });
  return app;
}

/**
 * Запустить сервер. tls — { context(): SecureContext, plain: 'serve' | 'redirect' }:
 * тогда на одном порту работают и https://, и http:// (см. listen.js).
 * Возвращает { server, listener, port }.
 */
export async function startServer({ port = config.port, host = config.host, tls = null } = {}) {
  cleanupRestoreLeftovers();
  loadBuiltinSheets();
  const app = createApp();
  const server = http.createServer(app);
  setupSockets(server);
  scheduleBackups();
  const listener = await listen(server, { port, host, tls });
  return { app, server, listener, port: listener.address().port, host };
}

let stopping = false;
/** Сохранить столы и закрыть сервер (Ctrl+C, закрытие окна, остановка службы) */
export function stopServer(handle, reason = '', { exit = true } = {}) {
  if (stopping) return;
  stopping = true;
  console.log(`[taverna] ${reason ? `получен ${reason}, ` : ''}сохраняю данные...`);
  try {
    rooms.flushAll();
  } catch (e) {
    console.error('[taverna] не удалось сохранить столы:', e);
  }
  const done = () => exit && process.exit(0);
  if (handle?.listener && handle.listener !== handle.server) handle.listener.close();
  if (handle?.server) {
    handle.server.close(done);
    handle.server.closeAllConnections?.();
  } else done();
  if (exit) setTimeout(() => process.exit(0), 3000).unref();
}
