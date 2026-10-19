// Обычный запуск сервера: node server/index.js (настройки — переменные окружения или файл .env)
import { config } from './config.js';
import { startServer, stopServer } from './main.js';

const handle = await startServer();
console.log(`[taverna] сервер запущен: http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${handle.port}`);
console.log(`[taverna] данные: ${config.dataDir}`);

process.on('SIGINT', () => stopServer(handle, 'SIGINT'));
process.on('SIGTERM', () => stopServer(handle, 'SIGTERM'));
process.on('uncaughtException', (e) => {
  console.error('[taverna] uncaught', e);
});
process.on('unhandledRejection', (e) => {
  console.error('[taverna] unhandled rejection', e);
});
