// Резервные копии базы: копия делается на ходу, лишние старые удаляются
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taverna-backup-test-'));
process.env.DATA_DIR = dir;
const { makeBackup, listBackups, backupDir, BACKUP_NAME_RE } = await import('../server/backup.js');

test('копия базы создаётся и попадает в список', async () => {
  const b = await makeBackup({ keep: 3 });
  assert.match(b.name, BACKUP_NAME_RE);
  assert.ok(b.size > 0);
  const list = listBackups();
  assert.equal(list[0].name, b.name);
  assert.ok(fs.existsSync(path.join(backupDir(), b.name)));
});

test('хранятся только последние копии', async () => {
  // имитируем старые копии
  for (const stamp of ['20200101-0000', '20200102-0000', '20200103-0000', '20200104-0000']) {
    const f = path.join(backupDir(), `taverna-${stamp}.db`);
    fs.writeFileSync(f, 'x');
    const t = new Date(stamp.slice(0, 4) + '-' + stamp.slice(4, 6) + '-' + stamp.slice(6, 8)).getTime() / 1000;
    fs.utimesSync(f, t, t);
  }
  await makeBackup({ keep: 2 });
  const names = listBackups().map((b) => b.name);
  assert.equal(names.length, 2);
  assert.ok(!names.includes('taverna-20200101-0000.db'));
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
