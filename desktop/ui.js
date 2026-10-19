// Окно программы: заставка с адресами, журнал в файл, открытие браузера, понятные ошибки
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { spawn } from 'node:child_process';
// адреса компьютера в локальных сетях и VPN (Radmin VPN, ZeroTier, Hamachi, Tailscale…)
import { lanAddresses } from '../server/lan.js';

export { lanAddresses };

const tty = !!process.stdout.isTTY;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const c = { bold: paint('1'), dim: paint('2'), gold: paint('33'), green: paint('32'), red: paint('31'), cyan: paint('36') };

export function banner({ version, port, https, dataDir, logFile }) {
  const lan = lanAddresses();
  const p = port === 80 ? '' : ':' + port;
  const lines = [
    '',
    `  ${c.gold('⬡')} ${c.bold('Таверна')} ${c.dim(version || '')} — стол запущен`,
    '',
    `  Откройте в браузере:        ${c.cyan('http://localhost' + p)}`,
  ];
  if (lan.length) {
    lines.push(`  Адрес для игроков в сети:   ${c.cyan(`http://${lan[0].address}${p}`)}  ${c.dim('(' + lan[0].name + ')')}`);
    for (const a of lan.slice(1)) lines.push(`                              ${c.cyan(`http://${a.address}${p}`)}  ${c.dim('(' + a.name + ')')}`);
    if (https) {
      lines.push('');
      lines.push(`  Голосовой чат у игроков работает по ${c.cyan(`https://${lan[0].address}${p}`)}`);
      lines.push(c.dim('  (браузер предупредит о сертификате — нажмите «Дополнительно» → «Перейти на сайт»)'));
    }
    lines.push('');
    lines.push(c.dim('  С телефона в этой же сети Wi-Fi — тот же адрес в браузере (QR-код: кнопка «Телефон» в главном меню).'));
  }
  lines.push('');
  lines.push(`  Данные и настройки: ${dataDir}`);
  if (logFile) lines.push(c.dim(`  Журнал: ${logFile}`));
  lines.push('');
  lines.push(`  ${c.bold('Чтобы остановить сервер, закройте это окно')} ${c.dim('(или нажмите Ctrl+C)')}.`);
  if (process.platform === 'win32') lines.push(c.dim('  Если Windows спросит о доступе к сети — разрешите, иначе друзья не подключатся.'));
  lines.push('');
  console.log(lines.join('\n'));
}

/**
 * Журнал в файл <данные>/logs/taverna.log. После запуска в окно попадают только ошибки:
 * в консоли Windows щелчок по окну включает выделение и останавливает вывод — пусть это не тормозит игру.
 */
export function setupLog(dataDir) {
  const dir = path.join(dataDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'taverna.log');
  try {
    if (fs.statSync(file).size > 5 * 1048576) fs.renameSync(file, path.join(dir, 'taverna.old.log'));
  } catch {
    /* файла ещё нет */
  }
  const stream = fs.createWriteStream(file, { flags: 'a' });
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  let quiet = false;
  const noisy = /^\[(sheets|db)\]/;
  const write = (level, args) => {
    const text = util.format(...args);
    stream.write(`${new Date().toISOString()} ${level} ${text.replace(/\x1b\[[0-9;]*m/g, '')}\n`);
    return text;
  };
  for (const level of ['log', 'info', 'warn']) {
    console[level] = (...args) => {
      const text = write(level, args);
      if (!quiet && !noisy.test(text)) orig[level](...args);
    };
  }
  console.error = (...args) => {
    write('error', args);
    orig.error(...args);
  };
  return {
    file,
    /** после заставки — в окно только ошибки */
    quiet() {
      quiet = true;
    },
    say(...args) {
      write('log', args);
      orig.log(...args);
    },
  };
}

/** Открыть адрес в браузере по умолчанию */
export function openBrowser(url) {
  let cmd;
  let args;
  if (process.platform === 'win32') [cmd, args] = ['rundll32', ['url.dll,FileProtocolHandler', url]];
  else if (process.platform === 'darwin') [cmd, args] = ['open', [url]];
  else if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) [cmd, args] = ['xdg-open', [url]];
  else return false;
  try {
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    p.on('error', () => {});
    p.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Windows: выключить «быстрое выделение» в окне консоли. Иначе случайный щелчок по окну
 * замораживает вывод, а вместе с ним и сервер, пока не нажать Esc.
 */
export function disableQuickEdit() {
  if (process.platform !== 'win32' || !process.stdin.isTTY) return;
  const ps = [
    "$s='[DllImport(\"kernel32.dll\")] public static extern IntPtr GetStdHandle(int h);",
    '[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr h, out int m);',
    "[DllImport(\"kernel32.dll\")] public static extern bool SetConsoleMode(IntPtr h, int m);';",
    '$k=Add-Type -MemberDefinition $s -Name Con -Namespace Taverna -PassThru;',
    '$h=$k::GetStdHandle(-10); $m=0;',
    'if($k::GetConsoleMode($h,[ref]$m)){ [void]$k::SetConsoleMode($h, ($m -band (-bnot 0x40)) -bor 0x80) }',
  ].join(' ');
  try {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { stdio: ['inherit', 'ignore', 'ignore'] });
    p.on('error', () => {});
    p.unref();
  } catch {
    /* PowerShell недоступен — не страшно */
  }
}

/** Показать ошибку; в Windows окно не закрывается сразу, чтобы её можно было прочитать */
export async function fatal(message, hint = '') {
  console.error('');
  console.error('  ' + c.red(c.bold('Таверна не запустилась: ')) + message);
  if (hint) console.error('  ' + hint);
  console.error('');
  await pauseIfWindowsConsole();
  process.exit(1);
}

export async function pauseIfWindowsConsole(text = 'Нажмите Enter, чтобы закрыть окно.') {
  if (process.platform !== 'win32' || !process.stdin.isTTY) return;
  console.error('  ' + text);
  await new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', resolve);
  });
}

/** Понятное описание частых ошибок запуска */
export function explain(e, { port } = {}) {
  if (e?.code === 'EADDRINUSE') return [`порт ${e.port || port} уже занят другой программой.`, 'Укажите другой порт в файле config.env (строка PORT=) или закройте программу, которая его заняла.'];
  if (e?.code === 'EACCES' && (e.port || port) < 1024) return [`нет прав открыть порт ${e.port || port}.`, 'Запустите от администратора или выберите порт больше 1024.'];
  if (e?.code === 'EACCES' || e?.code === 'EPERM') return [`нет доступа к файлу или папке: ${e.path || e.message}`, 'Переместите программу в папку, куда можно записывать (например, в «Документы»).'];
  if (e?.code === 'ENOSPC') return ['на диске закончилось место.', ''];
  return [e?.message || String(e), ''];
}
