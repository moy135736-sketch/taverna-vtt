#!/usr/bin/env node
// Администрирование из командной строки:
//   node server/cli.js list-users
//   node server/cli.js create-user <логин> <пароль> [имя] [--admin]
//   node server/cli.js reset-password <логин> <новый пароль>
//   node server/cli.js make-admin <логин>       (и remove-admin)
//   node server/cli.js disable <логин>           (и enable)
//   node server/cli.js stats
// В Docker: docker compose exec app node server/cli.js list-users
import { db } from './db.js';
import { createUser, hashPassword } from './auth.js';

const [cmd, ...args] = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const pos = args.filter((a) => !a.startsWith('--'));

function findUser(username) {
  const u = db.prepare(`SELECT * FROM users WHERE username=?`).get(username);
  if (!u) fail(`Пользователь «${username}» не найден`);
  return u;
}

function fail(msg) {
  console.error('Ошибка:', msg);
  process.exit(1);
}

function need(n, usage) {
  if (pos.length < n) fail('использование: node server/cli.js ' + usage);
}

const fmtDate = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) : '—');

switch (cmd) {
  case 'list-users': {
    const rows = db.prepare(`SELECT username, display_name, is_admin, disabled, created_at, last_login FROM users ORDER BY created_at`).all();
    if (!rows.length) console.log('Пользователей пока нет. Первый зарегистрированный станет администратором.');
    for (const r of rows) {
      const tags = [r.is_admin ? 'админ' : '', r.disabled ? 'заблокирован' : ''].filter(Boolean).join(', ');
      console.log(`${r.username.padEnd(24)} ${r.display_name.padEnd(24)} создан ${fmtDate(r.created_at)}  вход ${fmtDate(r.last_login)}${tags ? '  [' + tags + ']' : ''}`);
    }
    break;
  }
  case 'create-user': {
    need(2, 'create-user <логин> <пароль> [имя] [--admin]');
    const [username, password, displayName] = pos;
    if (password.length < 6) fail('пароль должен быть не короче 6 символов');
    if (db.prepare(`SELECT 1 FROM users WHERE username=?`).get(username)) fail('такой логин уже занят');
    const u = createUser({ username, password, displayName: displayName || username, isAdmin: flags.has('--admin') });
    console.log(`Создан пользователь ${u.username}${u.is_admin ? ' (администратор)' : ''}`);
    break;
  }
  case 'reset-password': {
    need(2, 'reset-password <логин> <новый пароль>');
    const u = findUser(pos[0]);
    if (pos[1].length < 6) fail('пароль должен быть не короче 6 символов');
    db.prepare(`UPDATE users SET password_hash=? WHERE id=?`).run(hashPassword(pos[1]), u.id);
    db.prepare(`DELETE FROM sessions WHERE user_id=?`).run(u.id);
    console.log(`Пароль ${u.username} изменён, все его сессии завершены`);
    break;
  }
  case 'make-admin':
  case 'remove-admin': {
    need(1, `${cmd} <логин>`);
    const u = findUser(pos[0]);
    db.prepare(`UPDATE users SET is_admin=? WHERE id=?`).run(cmd === 'make-admin' ? 1 : 0, u.id);
    console.log(`${u.username}: ${cmd === 'make-admin' ? 'теперь администратор' : 'больше не администратор'}`);
    break;
  }
  case 'disable':
  case 'enable': {
    need(1, `${cmd} <логин>`);
    const u = findUser(pos[0]);
    db.prepare(`UPDATE users SET disabled=? WHERE id=?`).run(cmd === 'disable' ? 1 : 0, u.id);
    if (cmd === 'disable') db.prepare(`DELETE FROM sessions WHERE user_id=?`).run(u.id);
    console.log(`${u.username}: ${cmd === 'disable' ? 'заблокирован' : 'разблокирован'}`);
    break;
  }
  case 'stats': {
    const c = (sql) => db.prepare(sql).get().c;
    console.log(`Пользователей: ${c('SELECT COUNT(*) c FROM users')}`);
    console.log(`Столов: ${c('SELECT COUNT(*) c FROM games')}`);
    console.log(`Персонажей и объектов: ${c('SELECT COUNT(*) c FROM entities')}`);
    console.log(`Сообщений в чате: ${c('SELECT COUNT(*) c FROM messages')}`);
    const bytes = db.prepare('SELECT COALESCE(SUM(size),0) s FROM assets').get().s;
    console.log(`Загружено файлов: ${c('SELECT COUNT(*) c FROM assets')} (${(bytes / 1048576).toFixed(1)} МБ)`);
    break;
  }
  default:
    console.log(`Команды:
  list-users                               список пользователей
  create-user <логин> <пароль> [имя] [--admin]
  reset-password <логин> <новый пароль>
  make-admin <логин> | remove-admin <логин>
  disable <логин> | enable <логин>
  stats                                    сводка по базе`);
    if (cmd) process.exit(1);
}
db.close();
