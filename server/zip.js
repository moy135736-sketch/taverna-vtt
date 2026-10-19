// ZIP для полной резервной копии: запись потоком (без сжатия — картинки и музыка уже сжаты),
// CRC считается на лету и пишется после данных (бит 3), большие архивы — ZIP64.
// Чтение — по центральному каталогу, с проверкой CRC; понимает и сжатые (deflate) архивы,
// например пересобранные проводником Windows.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { once } from 'node:events';

const U32 = 0xffffffff;
const U16 = 0xffff;

function dosTime(d) {
  const t = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dt = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return [t, dt];
}

/**
 * План архива: смещения, ZIP64 там, где нужно, и итоговый размер — его можно отдать в Content-Length.
 * entries: [{name, size, file?, data?: Buffer, mtime?: Date}]
 */
export function planZip(entries, { force64 = false } = {}) {
  let offset = 0;
  const items = entries.map((e) => {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const z64 = force64 || e.size >= U32 || offset >= U32;
    const it = { ...e, nameBuf, offset, z64, mtime: e.mtime || new Date() };
    offset += 30 + nameBuf.length + (z64 ? 20 : 0) + e.size + (z64 ? 24 : 16);
    return it;
  });
  const cdStart = offset;
  let cdSize = 0;
  for (const it of items) cdSize += 46 + it.nameBuf.length + (it.z64 ? 28 : 0);
  const eocd64 = force64 || items.length >= U16 || cdStart >= U32 || cdSize >= U32;
  const total = cdStart + cdSize + (eocd64 ? 56 + 20 : 0) + 22;
  return { items, cdStart, cdSize, eocd64, total };
}

async function put(out, buf) {
  if (out.destroyed || out.writableEnded) throw new Error('получатель закрыл соединение');
  if (!out.write(buf)) await Promise.race([once(out, 'drain'), once(out, 'close').then(() => Promise.reject(new Error('получатель закрыл соединение')))]);
}

/** Записать архив по плану в поток out (например, ответ HTTP). onFile(n) — после каждого файла */
export async function writeZip(out, plan, { onFile } = {}) {
  let n = 0;
  for (const it of plan.items) {
    const [t, d] = dosTime(it.mtime);
    const lh = Buffer.alloc(30 + it.nameBuf.length + (it.z64 ? 20 : 0));
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(it.z64 ? 45 : 20, 4);
    lh.writeUInt16LE(0x0808, 6); // бит 3 — CRC и размеры после данных, бит 11 — имена в UTF-8
    lh.writeUInt16LE(0, 8); // без сжатия
    lh.writeUInt16LE(t, 10);
    lh.writeUInt16LE(d, 12);
    lh.writeUInt32LE(0, 14);
    lh.writeUInt32LE(it.z64 ? U32 : 0, 18);
    lh.writeUInt32LE(it.z64 ? U32 : 0, 22);
    lh.writeUInt16LE(it.nameBuf.length, 26);
    lh.writeUInt16LE(it.z64 ? 20 : 0, 28);
    it.nameBuf.copy(lh, 30);
    if (it.z64) {
      const x = 30 + it.nameBuf.length;
      lh.writeUInt16LE(0x0001, x);
      lh.writeUInt16LE(16, x + 2); // размеры будут в дескрипторе после данных
    }
    await put(out, lh);
    let crc = 0;
    let size = 0;
    if (it.data) {
      crc = zlib.crc32(it.data);
      size = it.data.length;
      await put(out, it.data);
    } else {
      const fh = await fs.promises.open(it.file, 'r');
      try {
        for await (const chunk of fh.createReadStream({ autoClose: false, highWaterMark: 1 << 20 })) {
          crc = zlib.crc32(chunk, crc);
          size += chunk.length;
          if (size > it.size) break;
          await put(out, chunk);
        }
      } finally {
        await fh.close();
      }
    }
    if (size !== it.size) throw new Error(`файл ${it.name} изменился во время копирования`);
    it.crc = crc >>> 0;
    const dd = Buffer.alloc(it.z64 ? 24 : 16);
    dd.writeUInt32LE(0x08074b50, 0);
    dd.writeUInt32LE(it.crc, 4);
    if (it.z64) {
      dd.writeBigUInt64LE(BigInt(size), 8);
      dd.writeBigUInt64LE(BigInt(size), 16);
    } else {
      dd.writeUInt32LE(size, 8);
      dd.writeUInt32LE(size, 12);
    }
    await put(out, dd);
    onFile?.(++n);
  }
  // центральный каталог
  for (const it of plan.items) {
    const [t, d] = dosTime(it.mtime);
    const ch = Buffer.alloc(46 + it.nameBuf.length + (it.z64 ? 28 : 0));
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE((3 << 8) | (it.z64 ? 45 : 20), 4);
    ch.writeUInt16LE(it.z64 ? 45 : 20, 6);
    ch.writeUInt16LE(0x0808, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(t, 12);
    ch.writeUInt16LE(d, 14);
    ch.writeUInt32LE(it.crc, 16);
    ch.writeUInt32LE(it.z64 ? U32 : it.size, 20);
    ch.writeUInt32LE(it.z64 ? U32 : it.size, 24);
    ch.writeUInt16LE(it.nameBuf.length, 28);
    ch.writeUInt16LE(it.z64 ? 28 : 0, 30);
    ch.writeUInt32LE(((0o100644 << 16) >>> 0) >>> 0, 38);
    ch.writeUInt32LE(it.z64 ? U32 : it.offset, 42);
    it.nameBuf.copy(ch, 46);
    if (it.z64) {
      const x = 46 + it.nameBuf.length;
      ch.writeUInt16LE(0x0001, x);
      ch.writeUInt16LE(24, x + 2);
      ch.writeBigUInt64LE(BigInt(it.size), x + 4);
      ch.writeBigUInt64LE(BigInt(it.size), x + 12);
      ch.writeBigUInt64LE(BigInt(it.offset), x + 20);
    }
    await put(out, ch);
  }
  const count = plan.items.length;
  if (plan.eocd64) {
    const z = Buffer.alloc(56 + 20);
    z.writeUInt32LE(0x06064b50, 0);
    z.writeBigUInt64LE(44n, 4);
    z.writeUInt16LE(45, 12);
    z.writeUInt16LE(45, 14);
    z.writeBigUInt64LE(BigInt(count), 24);
    z.writeBigUInt64LE(BigInt(count), 32);
    z.writeBigUInt64LE(BigInt(plan.cdSize), 40);
    z.writeBigUInt64LE(BigInt(plan.cdStart), 48);
    z.writeUInt32LE(0x07064b50, 56);
    z.writeBigUInt64LE(BigInt(plan.cdStart + plan.cdSize), 64);
    z.writeUInt32LE(1, 72);
    await put(out, z);
  }
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(plan.eocd64 ? U16 : count, 8);
  e.writeUInt16LE(plan.eocd64 ? U16 : count, 10);
  e.writeUInt32LE(plan.eocd64 ? U32 : plan.cdSize, 12);
  e.writeUInt32LE(plan.eocd64 ? U32 : plan.cdStart, 16);
  await put(out, e);
}

// ---------------------------------------------------------------------------
// Чтение
// ---------------------------------------------------------------------------

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}

/** Открыть архив: { entries: [{name, method, crc, csize, usize, offset}], close() } */
export async function openZip(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 22 + 0xffff + 76);
    const tail = await readAt(fh, size - tailLen, tailLen);
    let p = -1;
    for (let i = tail.length - 22; i >= 0; i--)
      if (tail.readUInt32LE(i) === 0x06054b50) {
        p = i;
        break;
      }
    if (p < 0) throw new Error('это не ZIP-архив (нет оглавления)');
    let count = tail.readUInt16LE(p + 10);
    let cdSize = tail.readUInt32LE(p + 12);
    let cdStart = tail.readUInt32LE(p + 16);
    if (count === U16 || cdSize === U32 || cdStart === U32) {
      const lp = p - 20;
      if (lp < 0 || tail.readUInt32LE(lp) !== 0x07064b50) throw new Error('повреждено оглавление ZIP64');
      const z64pos = Number(tail.readBigUInt64LE(lp + 8));
      const z = await readAt(fh, z64pos, 56);
      if (z.readUInt32LE(0) !== 0x06064b50) throw new Error('повреждено оглавление ZIP64');
      count = Number(z.readBigUInt64LE(32));
      cdSize = Number(z.readBigUInt64LE(40));
      cdStart = Number(z.readBigUInt64LE(48));
    }
    if (cdStart + cdSize > size) throw new Error('архив обрезан — скачайте копию заново');
    const cd = await readAt(fh, cdStart, cdSize);
    const entries = [];
    let q = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(q) !== 0x02014b50) throw new Error('повреждено оглавление архива');
      const flags = cd.readUInt16LE(q + 8);
      const method = cd.readUInt16LE(q + 10);
      const crc = cd.readUInt32LE(q + 16);
      let csize = cd.readUInt32LE(q + 20);
      let usize = cd.readUInt32LE(q + 24);
      const nl = cd.readUInt16LE(q + 28);
      const xl = cd.readUInt16LE(q + 30);
      const cl = cd.readUInt16LE(q + 32);
      let offset = cd.readUInt32LE(q + 42);
      const nameRaw = cd.subarray(q + 46, q + 46 + nl);
      const name = flags & 0x800 ? nameRaw.toString('utf8') : nameRaw.toString('latin1');
      let x = q + 46 + nl;
      const xEnd = x + xl;
      while (x + 4 <= xEnd) {
        const id = cd.readUInt16LE(x);
        const len = cd.readUInt16LE(x + 2);
        if (id === 0x0001) {
          let y = x + 4;
          if (usize === U32) {
            usize = Number(cd.readBigUInt64LE(y));
            y += 8;
          }
          if (csize === U32) {
            csize = Number(cd.readBigUInt64LE(y));
            y += 8;
          }
          if (offset === U32) offset = Number(cd.readBigUInt64LE(y));
        }
        x += 4 + len;
      }
      entries.push({ name, method, crc, csize, usize, offset, dir: name.endsWith('/') });
      q += 46 + nl + xl + cl;
    }
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await fh.close();
    };
    return { entries, fh, close };
  } catch (e) {
    await fh.close();
    throw e;
  }
}

/** Распаковать запись архива в файл dest с проверкой CRC и размера */
export async function extractEntry(zip, entry, dest) {
  const lh = await readAt(zip.fh, entry.offset, 30);
  if (lh.length < 30 || lh.readUInt32LE(0) !== 0x04034b50) throw new Error(`повреждена запись ${entry.name}`);
  const start = entry.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`${entry.name}: неизвестный способ сжатия (${entry.method})`);
  const src = entry.csize > 0 ? zip.fh.createReadStream({ start, end: start + entry.csize - 1, autoClose: false }) : null;
  const out = fs.createWriteStream(dest);
  let crc = 0;
  let size = 0;
  try {
    if (src) {
      const stream = entry.method === 8 ? src.pipe(zlib.createInflateRaw()) : src;
      for await (const chunk of stream) {
        crc = zlib.crc32(chunk, crc);
        size += chunk.length;
        if (size > entry.usize) throw new Error(`${entry.name}: данные больше заявленного`);
        if (!out.write(chunk)) await once(out, 'drain');
      }
    }
    out.end();
    await once(out, 'finish');
  } catch (e) {
    out.destroy();
    fs.rmSync(dest, { force: true });
    throw e;
  }
  if (size !== entry.usize || crc >>> 0 !== entry.crc) {
    fs.rmSync(dest, { force: true });
    throw new Error(`${entry.name}: файл в архиве повреждён (не сходится контрольная сумма)`);
  }
}
