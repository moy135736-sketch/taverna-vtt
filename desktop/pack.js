// Архив файлов сайта, вшитый в программу: сжатый brotli поток
//   'TVPK' | версия (1 байт) | записи: длина пути (2 байта) | путь (utf-8) | размер (4 байта) | данные
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const MAGIC = 'TVPK';

/** Упаковать файлы [{ path, data }] (для сборки) */
export function encodePack(files) {
  const parts = [Buffer.from(MAGIC, 'ascii'), Buffer.from([1])];
  for (const f of files) {
    const p = Buffer.from(f.path.split(path.sep).join('/'), 'utf8');
    const head = Buffer.alloc(6);
    head.writeUInt16LE(p.length, 0);
    head.writeUInt32LE(f.data.length, 2);
    parts.push(head.subarray(0, 2), p, head.subarray(2), f.data);
  }
  return zlib.brotliCompressSync(Buffer.concat(parts), {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: 24 },
  });
}

/** Перебрать файлы архива: { path, data } */
export function* readPack(compressed) {
  const buf = zlib.brotliDecompressSync(compressed);
  if (buf.toString('ascii', 0, 4) !== MAGIC) throw new Error('повреждён архив файлов программы');
  let i = 5;
  while (i < buf.length) {
    const n = buf.readUInt16LE(i);
    const p = buf.toString('utf8', i + 2, i + 2 + n);
    const size = buf.readUInt32LE(i + 2 + n);
    const start = i + 6 + n;
    yield { path: p, data: buf.subarray(start, start + size) };
    i = start + size;
  }
}

/** Распаковать в папку (пути проверяются: только внутрь папки) */
export function extractPack(compressed, dir) {
  const root = path.resolve(dir);
  let count = 0;
  for (const f of readPack(compressed)) {
    const out = path.resolve(root, f.path);
    if (!out.startsWith(root + path.sep)) throw new Error('недопустимый путь в архиве: ' + f.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, f.data);
    count++;
  }
  return count;
}
