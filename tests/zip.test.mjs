// ZIP для полной копии: запись потоком (обычный и ZIP64), чтение, проверка CRC, совместимость с Python
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { planZip, writeZip, openZip, extractEntry } from '../server/zip.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-zip-'));
const big = crypto.randomBytes(3 * 1048576 + 17);
fs.writeFileSync(path.join(dir, 'map.png'), big);
fs.writeFileSync(path.join(dir, 'empty.txt'), '');
const python = (() => {
  try {
    execFileSync('python3', ['-c', 'import zipfile'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

async function make(file, opts) {
  const entries = [
    { name: 'taverna-backup.json', data: Buffer.from('{"format":"taverna-backup"}'), size: 27 },
    { name: 'uploads/карты/подземелье.png', file: path.join(dir, 'map.png'), size: big.length },
    { name: 'uploads/empty.txt', file: path.join(dir, 'empty.txt'), size: 0 },
  ];
  const plan = planZip(entries, opts);
  const out = fs.createWriteStream(file);
  await writeZip(out, plan);
  out.end();
  await once(out, 'finish');
  return plan;
}

for (const force64 of [false, true]) {
  test(`запись и чтение${force64 ? ' (ZIP64)' : ''}`, async () => {
    const file = path.join(dir, `a${force64 ? 64 : 32}.zip`);
    const plan = await make(file, { force64 });
    assert.equal(fs.statSync(file).size, plan.total, 'размер совпадает с планом (Content-Length)');
    const zip = await openZip(file);
    assert.deepEqual(
      zip.entries.map((e) => [e.name, e.usize]),
      [
        ['taverna-backup.json', 27],
        ['uploads/карты/подземелье.png', big.length],
        ['uploads/empty.txt', 0],
      ],
    );
    const dest = path.join(dir, 'out.png');
    await extractEntry(zip, zip.entries[1], dest);
    assert.ok(fs.readFileSync(dest).equals(big));
    await extractEntry(zip, zip.entries[2], dest);
    assert.equal(fs.statSync(dest).size, 0);
    await zip.close();
    await zip.close(); // повторное закрытие не мешает
    if (python) {
      const r = execFileSync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(z.testzip()); print("|".join(z.namelist()))', file]).toString().trim().split('\n');
      assert.equal(r[0], 'None', 'Python: архив цел');
      assert.equal(r[1], 'taverna-backup.json|uploads/карты/подземелье.png|uploads/empty.txt');
    }
  });
}

test('порча данных и обрезанный архив замечаются', async () => {
  const file = path.join(dir, 'bad.zip');
  await make(file);
  const buf = fs.readFileSync(file);
  // байт внутри картинки
  const i = buf.indexOf(big.subarray(1000, 1032));
  buf[i + 5] ^= 0xff;
  fs.writeFileSync(file, buf);
  const zip = await openZip(file);
  await assert.rejects(extractEntry(zip, zip.entries[1], path.join(dir, 'x.png')), /контрольная сумма/);
  await zip.close();
  assert.ok(!fs.existsSync(path.join(dir, 'x.png')), 'испорченный файл не остаётся');
  fs.writeFileSync(file, buf.subarray(0, buf.length - 200));
  await assert.rejects(openZip(file), /ZIP|архив/);
  fs.writeFileSync(file, 'просто текст');
  await assert.rejects(openZip(file), /не ZIP/);
});

test('архив, пересобранный другой программой (deflate, общая папка)', { skip: !python }, async () => {
  const file = path.join(dir, 'py.zip');
  execFileSync('python3', [
    '-c',
    'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED); z.writestr("копия/taverna.db", "x"*100000); z.write(sys.argv[2], "копия/uploads/a.png"); z.close()',
    file,
    path.join(dir, 'map.png'),
  ]);
  const zip = await openZip(file);
  assert.deepEqual(
    zip.entries.map((e) => [e.name, e.method]),
    [
      ['копия/taverna.db', 8],
      ['копия/uploads/a.png', 8],
    ],
  );
  await extractEntry(zip, zip.entries[0], path.join(dir, 'db'));
  assert.equal(fs.readFileSync(path.join(dir, 'db'), 'utf8'), 'x'.repeat(100000));
  await extractEntry(zip, zip.entries[1], path.join(dir, 'a.png'));
  assert.ok(fs.readFileSync(path.join(dir, 'a.png')).equals(big));
  await zip.close();
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
