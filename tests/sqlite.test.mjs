// Обёртка над node:sqlite: привязка чисел, транзакции, копия базы
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '../server/sqlite.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taverna-sqlite-test-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('целые числа в TEXT-колонке хранятся без «.0»', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (a TEXT, b INTEGER, c REAL)');
  db.prepare('INSERT INTO t VALUES (?, ?, ?)').run(4, 1700000000000, 1.5);
  db.prepare('INSERT INTO t VALUES (@a, @b, @c)').run({ a: -7, b: 2, c: 3 });
  const rows = db.prepare('SELECT a, b, c, typeof(b) tb FROM t').all();
  assert.equal(rows[0].a, '4');
  assert.equal(rows[0].b, 1700000000000);
  assert.equal(rows[0].tb, 'integer');
  assert.equal(rows[0].c, 1.5);
  assert.equal(rows[1].a, '-7');
  assert.equal(db.prepare('SELECT 1 WHERE 0').get(), undefined);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
});

test('транзакция откатывается целиком, вложенная — только своя часть', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (v INTEGER)');
  const add = db.prepare('INSERT INTO t VALUES (?)');
  const count = () => db.prepare('SELECT count(*) n FROM t').get().n;
  assert.throws(() =>
    db.transaction(() => {
      add.run(1);
      throw new Error('стоп');
    })(),
  );
  assert.equal(count(), 0);
  db.transaction(() => {
    add.run(1);
    try {
      db.transaction(() => {
        add.run(2);
        throw new Error('внутри');
      })();
    } catch {
      /* откат вложенной части */
    }
    add.run(3);
  })();
  assert.deepEqual(
    db.prepare('SELECT v FROM t ORDER BY v').all().map((r) => r.v),
    [1, 3],
  );
  assert.equal(db.inTransaction, false);
});

test('копия базы на ходу — полная и открывается', async () => {
  const file = path.join(dir, 'live.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE t (v TEXT)');
  const add = db.prepare('INSERT INTO t VALUES (?)');
  db.transaction(() => {
    for (let i = 0; i < 2000; i++) add.run('строка ' + i);
  })();
  const out = path.join(dir, 'copy.db');
  await db.backup(out);
  // повторная копия в тот же файл заменяет его
  add.run('ещё');
  await db.backup(out);
  const copy = new Database(out, { readonly: true, fileMustExist: true });
  assert.equal(copy.prepare('SELECT count(*) n FROM t').get().n, 2001);
  copy.close();
  db.close();
  assert.ok(!fs.existsSync(out + '.part'));
});
