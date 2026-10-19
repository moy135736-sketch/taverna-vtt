// Установка на Linux-сервер (VPS) одной командой: служба systemd, порты 80/443, сертификат Let's Encrypt.
//   sudo ./taverna install [--domain dnd.example.ru] [--email you@example.ru]
// Повторный запуск новой версии программы с install — обновление с прежними настройками.
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import readline from 'node:readline/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { c, lanAddresses } from './ui.js';

export const INSTALL_DIR = '/opt/taverna';
export const BINARY = path.join(INSTALL_DIR, 'taverna');
export const INSTALL_INFO = path.join(INSTALL_DIR, 'install.json');
const UNIT = '/etc/systemd/system/taverna.service';
const LINK = '/usr/local/bin/taverna';
const USER = 'taverna';
const DOMAIN_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function readInstallInfo() {
  try {
    return JSON.parse(fs.readFileSync(INSTALL_INFO, 'utf8'));
  } catch {
    return null;
  }
}

function run(cmd, args, { quiet = false } = {}) {
  const r = spawnSync(cmd, args, { stdio: quiet ? 'ignore' : 'inherit' });
  return r.status === 0;
}

function has(cmd) {
  return spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
}

function fail(msg) {
  const e = new Error(msg);
  e.userMessage = true;
  throw e;
}

async function ask(rl, q) {
  return (await rl.question(q)).trim();
}

function unitText({ data, domain, email, port, httpPort, staging, acmeDirectory }) {
  const args = ['serve', '--data', data];
  if (domain) args.push('--domain', domain);
  if (email) args.push('--email', email);
  if (port) args.push('--port', String(port));
  if (httpPort) args.push('--http-port', String(httpPort));
  if (staging) args.push('--staging');
  if (acmeDirectory) args.push('--acme-directory', acmeDirectory);
  return `[Unit]
Description=Taverna — virtual tabletop
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${USER}
Group=${USER}
WorkingDirectory=${data}
ExecStart=${BINARY} ${args.join(' ')}
Restart=always
RestartSec=3
TimeoutStopSec=15
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
ReadWritePaths=${data}
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
`;
}

function ensureUser(data) {
  if (spawnSync('id', ['-u', USER], { stdio: 'ignore' }).status === 0) return;
  const nologin = fs.existsSync('/usr/sbin/nologin') ? '/usr/sbin/nologin' : '/bin/false';
  if (has('useradd')) {
    if (!run('useradd', ['--system', '--home-dir', data, '--no-create-home', '--shell', nologin, USER])) fail('не удалось создать пользователя ' + USER);
  } else if (has('adduser')) {
    if (!run('adduser', ['-S', '-D', '-H', '-h', data, '-s', nologin, USER]) && !run('adduser', ['--system', '--group', '--home', data, '--no-create-home', USER])) fail('не удалось создать пользователя ' + USER);
  } else fail('нет команды useradd/adduser для создания пользователя службы');
}

function openFirewall(ports) {
  if (has('ufw')) {
    const st = spawnSync('ufw', ['status'], { encoding: 'utf8' });
    if (/Status: active/i.test(st.stdout || '')) {
      for (const p of ports) run('ufw', ['allow', `${p}/tcp`], { quiet: true });
      return `ufw: открыты порты ${ports.join(', ')}`;
    }
  }
  if (has('firewall-cmd') && run('firewall-cmd', ['--state'], { quiet: true })) {
    for (const p of ports) run('firewall-cmd', ['--permanent', `--add-port=${p}/tcp`], { quiet: true });
    run('firewall-cmd', ['--reload'], { quiet: true });
    return `firewalld: открыты порты ${ports.join(', ')}`;
  }
  return '';
}

async function health(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

export async function install(opts) {
  if (process.platform !== 'linux') fail('установка службы нужна только на Linux-сервере. На своём компьютере просто запустите программу двойным щелчком.');
  if (process.getuid?.() !== 0) fail('нужны права администратора. Запустите так: sudo ./' + path.basename(process.execPath) + ' install');
  if (!fs.existsSync('/run/systemd/system')) fail('на сервере нет systemd. Запустите вручную: ./' + path.basename(process.execPath) + ' serve --domain ваш-домен');
  if (!opts.isSea) fail('установка работает из собранной программы (файл taverna-linux-…), а не из исходников.');

  const prev = readInstallInfo() || {};
  const rl = process.stdin.isTTY && !opts.yes ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    let domain = (opts.domain || '').toLowerCase();
    let email = opts.email || '';
    if (!domain && !opts.noDomain) domain = prev.domain || '';
    if (!email) email = prev.email || '';
    if (!domain && !opts.noDomain && rl) {
      console.log('');
      console.log('  Для https (и голосового чата) нужен домен, который указывает на IP этого сервера.');
      console.log(c.dim('  Бесплатный поддомен можно получить, например, на duckdns.org.'));
      domain = (await ask(rl, '  Домен сайта (например, dnd.example.ru), Enter — без домена: ')).toLowerCase();
    }
    if (domain && !DOMAIN_RE.test(domain)) fail(`«${domain}» не похоже на домен`);
    if (domain && !email && rl) email = await ask(rl, '  E-mail для писем Let’s Encrypt о сертификате (можно пропустить): ');
    if (email && !EMAIL_RE.test(email)) fail(`«${email}» не похоже на e-mail`);

    const data = path.resolve(opts.data || prev.data || '/var/lib/taverna');
    const samePlan = domain ? prev.domain === domain : !prev.domain;
    const port = Number(opts.port || (samePlan && prev.port) || (domain ? 443 : 3000));
    const httpPort = domain ? Number(opts.httpPort || (samePlan && prev.httpPort) || 80) : 0;
    const staging = !!(opts.staging || (prev.staging && !opts.domain));

    if (domain) {
      try {
        const ips = (await dns.lookup(domain, { all: true })).map((a) => a.address);
        console.log(`  Домен ${domain} указывает на ${ips.join(', ')}`);
      } catch {
        console.log(c.gold(`  Внимание: домен ${domain} пока не находится в DNS. Сертификат будет получен, когда запись появится.`));
      }
    }

    // 1. программа
    fs.mkdirSync(INSTALL_DIR, { recursive: true });
    if (path.resolve(process.execPath) !== BINARY) {
      fs.copyFileSync(process.execPath, BINARY + '.new');
      fs.chmodSync(BINARY + '.new', 0o755);
      fs.renameSync(BINARY + '.new', BINARY);
    }
    try {
      fs.rmSync(LINK, { force: true });
      fs.symlinkSync(BINARY, LINK);
    } catch {
      /* без ссылки тоже работает */
    }
    // 2. пользователь и данные
    ensureUser(data);
    fs.mkdirSync(data, { recursive: true });
    execFileSync('chown', ['-R', `${USER}:${USER}`, data]);
    // 3. служба
    const acmeDirectory = opts.acmeDirectory || (samePlan && prev.acmeDirectory) || '';
    if (acmeDirectory && !/^https:\/\/[\w.:/-]+$/.test(acmeDirectory)) fail('неверный адрес ACME');
    const info = { domain, email, data, port, httpPort, staging, ...(acmeDirectory ? { acmeDirectory } : {}), installed: new Date().toISOString() };
    fs.writeFileSync(INSTALL_INFO, JSON.stringify(info, null, 2));
    fs.writeFileSync(UNIT, unitText(info));
    run('systemctl', ['daemon-reload'], { quiet: true });
    run('systemctl', ['enable', 'taverna'], { quiet: true });
    if (!run('systemctl', ['restart', 'taverna'])) fail('служба не запустилась. Подробности: journalctl -u taverna -n 50');
    const fw = openFirewall(domain ? [httpPort, port] : [port]);
    if (fw) console.log('  ' + fw);

    // 4. проверка
    process.stdout.write('  Запускаю службу');
    const probe = domain ? `http://127.0.0.1:${httpPort}/api/health` : `http://127.0.0.1:${port}/api/health`;
    let h = null;
    for (let i = 0; i < 40 && !h; i++) {
      await sleep(500);
      process.stdout.write('.');
      h = await health(probe);
    }
    console.log('');
    if (!h) fail('служба не отвечает. Подробности: journalctl -u taverna -n 50');
    let url = domain ? `https://${domain}${port === 443 ? '' : ':' + port}` : '';
    if (domain) {
      process.stdout.write('  Получаю сертификат Let’s Encrypt');
      let st = h.https;
      for (let i = 0; i < 90 && !['ok', 'error'].includes(st?.state); i++) {
        await sleep(1000);
        process.stdout.write('.');
        st = (await health(probe))?.https;
      }
      console.log('');
      if (st?.state === 'ok') console.log(c.green('  Сертификат получен.'));
      else {
        console.log(c.gold('  Сертификат пока не получен: ' + (st?.message || 'нет ответа')));
        console.log('  Проверьте, что домен указывает на этот сервер и порт 80 открыт. Служба будет пробовать снова каждый час.');
      }
    } else {
      const ip = lanAddresses()[0]?.address || 'IP-сервера';
      url = `http://${ip}:${port}`;
    }
    console.log('');
    console.log(c.bold('  Готово! Таверна работает как служба и запускается вместе с сервером.'));
    console.log(`  Откройте ${c.cyan(url)} — первый зарегистрированный станет администратором.`);
    console.log(c.dim(`  Данные: ${data}. Журнал: journalctl -u taverna -f. Удаление: sudo taverna uninstall`));
    console.log('');
  } finally {
    rl?.close();
  }
}

export async function uninstall() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) fail('удаление службы: sudo taverna uninstall');
  const info = readInstallInfo();
  run('systemctl', ['disable', '--now', 'taverna'], { quiet: true });
  fs.rmSync(UNIT, { force: true });
  run('systemctl', ['daemon-reload'], { quiet: true });
  fs.rmSync(LINK, { force: true });
  fs.rmSync(INSTALL_DIR, { recursive: true, force: true });
  console.log('  Служба Таверны удалена.');
  if (info?.data) console.log(`  Данные (база, загруженные файлы, копии) остались в ${info.data} — удалите папку вручную, если они не нужны.`);
}

export async function status() {
  const info = readInstallInfo();
  if (!info) {
    console.log('  Служба не установлена (sudo ./taverna install).');
    return;
  }
  const active = spawnSync('systemctl', ['is-active', 'taverna'], { encoding: 'utf8' }).stdout.trim();
  console.log(`  Служба: ${active === 'active' ? c.green('работает') : c.red(active || 'остановлена')}`);
  const probe = info.domain ? `http://127.0.0.1:${info.httpPort || 80}/api/health` : `http://127.0.0.1:${info.port}/api/health`;
  const h = await health(probe);
  if (info.domain) {
    const st = h?.https;
    console.log(`  Адрес: https://${info.domain}${info.port === 443 ? '' : ':' + info.port}`);
    if (st) console.log(`  Сертификат: ${st.state === 'ok' ? c.green('действует до ' + String(st.expires).slice(0, 10)) : c.gold(st.message || st.state)}`);
  } else console.log(`  Адрес: http://<IP сервера>:${info.port}`);
  console.log(`  Данные: ${info.data}`);
}
