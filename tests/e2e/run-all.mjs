// Прогон всех e2e-тестов по очереди. Нужен запущенный сервер (BASE, по умолчанию http://localhost:3000),
// запущенный с REGISTER_RATE_LIMIT=1000: тесты создают много аккаунтов, а по умолчанию можно лишь 10 за 10 минут.
// Chromium: переменная CHROME (путь к браузеру), иначе /opt/pw-browsers/chromium.
//   node tests/e2e/run-all.mjs [имя-теста ...]
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
// desktop и vps запускают свои серверы (программа одним файлом), остальным нужен общий сервер на BASE
const ALL = ['smoke', 'sheet5e', 'board', 'features', 'templates', 'align', 'touch', 'reconnect', 'demo', 'voice', 'transfer', 'turn', 'sheets', 'sheetlook', 'damage', 'dice3d', 'restore', 'fixes', 'tokens', 'effects', 'effects2', 'fun', 'bestiary', 'teapot', 'phone', 'vision', 'moves', 'sheet2024', 'themes', 'media', 'desktop', 'vps'];
const list = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
const results = [];
for (const name of list) {
  const t = Date.now();
  process.stdout.write(`\n=== ${name} ===\n`);
  const r = spawnSync(process.execPath, [path.join(dir, name + '.mjs')], { stdio: 'inherit', env: process.env, timeout: 15 * 60000 });
  results.push({ name, ok: r.status === 0, sec: Math.round((Date.now() - t) / 1000) });
}
console.log('\nИтог:');
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name} (${r.sec} с)`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
