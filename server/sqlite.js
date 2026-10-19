// База данных на встроенном в Node модуле node:sqlite — без нативных зависимостей,
// поэтому сервер собирается в один исполняемый файл и ставится без компилятора.
// Обёртка повторяет нужную серверу часть привычного API: prepare().run/get/all/iterate,
// exec, pragma, transaction (с вложенностью через SAVEPOINT), backup.
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';

// Модуль пока помечен как экспериментальный: прячем одно-единственное предупреждение об этом
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  if (/SQLite is an experimental feature/.test(String(warning?.message ?? warning))) return;
  return emitWarning.call(this, warning, ...rest);
};
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
process.emitWarning = emitWarning;

// node:sqlite передаёт любые числа JS как REAL, и в TEXT-колонке 4 превращается в «4.0».
// Целые передаём как INTEGER (BigInt), как это делают другие драйверы SQLite.
function bindValue(v) {
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === 'boolean') return v ? 1n : 0n;
  return v;
}
function bindArgs(args) {
  return args.map((a) => {
    if (a && typeof a === 'object' && !ArrayBuffer.isView(a)) {
      const o = {};
      for (const k of Object.keys(a)) o[k] = bindValue(a[k]);
      return o;
    }
    return bindValue(a);
  });
}

// Код потока для копии базы: отдельное соединение, VACUUM INTO, ответ «ok» или текст ошибки
const VACUUM_WORKER = `
process.emitWarning = () => {};
const { workerData, parentPort } = process.getBuiltinModule('node:worker_threads');
try {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(workerData.src);
  db.exec('PRAGMA busy_timeout = 10000');
  db.prepare('VACUUM INTO ?').run(workerData.dest);
  db.close();
  parentPort.postMessage('ok');
} catch (e) {
  parentPort.postMessage(String((e && e.message) || e));
}
`;

function vacuumInThread(src, dest) {
  return new Promise((resolve, reject) => {
    const w = new Worker(VACUUM_WORKER, { eval: true, workerData: { src, dest } });
    w.once('message', (m) => (m === 'ok' ? resolve() : reject(new Error(m))));
    w.once('error', reject);
    w.once('exit', (code) => (code ? reject(new Error('поток копирования завершился с кодом ' + code)) : resolve()));
  });
}

class Statement {
  constructor(stmt, owner) {
    this.stmt = stmt;
    this.owner = owner;
  }
  run(...args) {
    this.owner.lastWrite = Date.now();
    return this.stmt.run(...bindArgs(args));
  }
  get(...args) {
    return this.stmt.get(...bindArgs(args));
  }
  all(...args) {
    return this.stmt.all(...bindArgs(args));
  }
  iterate(...args) {
    return this.stmt.iterate(...bindArgs(args));
  }
  get source() {
    return this.stmt.sourceSQL;
  }
}

/**
 * Проверить файл базы Таверны (например, из резервной копии): цел ли он и что в нём.
 * Возвращает { schema, counts: {users, games, assets} } или бросает ошибку с понятным текстом.
 */
export function inspectDatabase(file) {
  let d;
  try {
    d = new DatabaseSync(file);
  } catch (e) {
    throw new Error('файл базы не открывается: ' + e.message);
  }
  try {
    let ok;
    try {
      ok = Object.values(d.prepare('PRAGMA quick_check').get() || {})[0];
    } catch (e) {
      throw new Error('это не база данных SQLite (' + e.message + ')');
    }
    if (ok !== 'ok') throw new Error('база в копии повреждена: ' + ok);
    const tables = new Set(d.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name));
    for (const t of ['users', 'games', 'entities', 'meta']) if (!tables.has(t)) throw new Error('это не база Таверны');
    const schema = Number(d.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get()?.value || 0);
    const count = (t) => (tables.has(t) ? Number(d.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c) : 0);
    return { schema, counts: { users: count('users'), games: count('games'), assets: count('assets') } };
  } finally {
    d.close();
  }
}

export default class Database {
  constructor(file, { readonly = false, fileMustExist = false } = {}) {
    if (fileMustExist && file !== ':memory:' && !fs.existsSync(file)) throw new Error('Файл базы не найден: ' + file);
    this.name = file;
    this.raw = new DatabaseSync(file, { readOnly: !!readonly });
    this.cache = new Map();
    this.depth = 0;
    this.lastWrite = 0; // время последнего изменения через это соединение (для копий «только если менялось»)
  }

  /** Подготовленные запросы кэшируются по тексту — сервер вызывает prepare() на каждом действии */
  prepare(sql) {
    if (this.closed) throw new Error('база данных закрыта на обслуживание');
    let st = this.cache.get(sql);
    if (!st) {
      if (this.cache.size > 500) this.cache.clear();
      st = new Statement(this.raw.prepare(sql), this);
      this.cache.set(sql, st);
    }
    return st;
  }

  exec(sql) {
    this.lastWrite = Date.now();
    this.raw.exec(sql);
    return this;
  }

  /** pragma('journal_mode = WAL'); с { simple: true } — только первое значение */
  pragma(text, { simple = false } = {}) {
    const rows = this.raw.prepare('PRAGMA ' + text).all();
    if (simple) return rows[0] ? Object.values(rows[0])[0] : undefined;
    return rows;
  }

  get inTransaction() {
    return this.depth > 0;
  }

  /** transaction(fn) возвращает функцию: вызов — BEGIN…COMMIT, при ошибке — откат; вложенные — через SAVEPOINT */
  transaction(fn) {
    const self = this;
    return function (...args) {
      const nested = self.depth > 0;
      const sp = 'tv_sp' + self.depth;
      self.raw.exec(nested ? `SAVEPOINT ${sp}` : 'BEGIN');
      self.depth++;
      try {
        const result = fn.apply(this, args);
        if (result && typeof result.then === 'function') throw new TypeError('Функция транзакции не может быть асинхронной');
        self.raw.exec(nested ? `RELEASE ${sp}` : 'COMMIT');
        return result;
      } catch (e) {
        try {
          if (nested) self.raw.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
          else if (self.raw.isTransaction !== false) self.raw.exec('ROLLBACK');
        } catch {
          /* транзакцию уже откатил сам SQLite */
        }
        throw e;
      } finally {
        self.depth--;
      }
    };
  }

  /**
   * Копия базы на ходу (согласованный снимок через VACUUM INTO). Большую базу копируем в отдельном
   * потоке, чтобы игра не замирала; файл пишется во временный и затем подменяет файл назначения.
   */
  async backup(dest) {
    const tmp = dest + '.part';
    fs.rmSync(tmp, { force: true });
    try {
      let done = false;
      if (this.name !== ':memory:') {
        done = await vacuumInThread(this.name, tmp).then(
          () => true,
          () => false,
        );
      }
      if (!done) {
        fs.rmSync(tmp, { force: true });
        this.raw.prepare('VACUUM INTO ?').run(tmp);
      }
      fs.renameSync(tmp, dest);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
  }

  close() {
    this.cache.clear();
    this.raw.close();
    this.closed = true;
  }

  /** Открыть файл заново (после подмены файла базы при восстановлении из копии) */
  open() {
    if (!this.closed) this.close();
    this.raw = new DatabaseSync(this.name);
    this.cache.clear();
    this.depth = 0;
    this.closed = false;
    this.lastWrite = Date.now();
  }
}
