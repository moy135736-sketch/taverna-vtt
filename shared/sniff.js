// Тип файла по сигнатуре (первым байтам), а не по расширению: общее для сервера и браузера.
// bytes — Uint8Array (или Buffer) с началом файла; для WebM полезно дать побольше (кодеки — в заголовке дорожек).

const ascii = (b, o, n) => {
  let s = '';
  const end = Math.min(b.length, o + n);
  for (let i = o; i < end; i++) s += String.fromCharCode(b[i]);
  return s;
};

/** Есть ли в начале файла метка (строка в латинице) — например, кодек WebM или кусок APNG */
export function hasMarker(b, marker, limit = b.length) {
  const m = [...marker].map((c) => c.charCodeAt(0));
  const end = Math.min(b.length, limit) - m.length;
  outer: for (let i = 0; i <= end; i++) {
    for (let j = 0; j < m.length; j++) if (b[i + j] !== m[j]) continue outer;
    return true;
  }
  return false;
}

/** WebM/Matroska: только звук (Opus/Vorbis без видеодорожки) или видео */
function webmKind(b) {
  const video = ['V_VP8', 'V_VP9', 'V_AV1', 'V_MPEG4', 'V_MPEGH'].some((m) => hasMarker(b, m));
  if (!video && ['A_OPUS', 'A_VORBIS'].some((m) => hasMarker(b, m))) return { mime: 'audio/webm', ext: 'webm', kind: 'audio' };
  return { mime: 'video/webm', ext: 'webm', kind: 'video' };
}

export function sniff(b) {
  if (!b || b.length < 4) return null;
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return { mime: 'image/png', ext: 'png', kind: 'image' };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg', kind: 'image' };
  if (ascii(b, 0, 4) === 'GIF8') return { mime: 'image/gif', ext: 'gif', kind: 'image' };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return { mime: 'image/webp', ext: 'webp', kind: 'image' };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE') return { mime: 'audio/wav', ext: 'wav', kind: 'audio' };
  if (ascii(b, 0, 2) === 'BM' && b.length >= 26) return { mime: 'image/bmp', ext: 'bmp', kind: 'image', upload: false };
  if (ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4);
    if (brand === 'avif' || brand === 'avis') return { mime: 'image/avif', ext: 'avif', kind: 'image' };
    if (brand.startsWith('M4A') || brand === 'M4B ') return { mime: 'audio/mp4', ext: 'm4a', kind: 'audio' };
    return { mime: 'video/mp4', ext: 'mp4', kind: 'video' };
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return webmKind(b);
  if (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { mime: 'audio/mpeg', ext: 'mp3', kind: 'audio' };
  if (ascii(b, 0, 4) === 'OggS') return { mime: 'audio/ogg', ext: 'ogg', kind: 'audio' };
  if (ascii(b, 0, 4) === 'fLaC') return { mime: 'audio/flac', ext: 'flac', kind: 'audio' };
  return null;
}

/** Анимированная картинка: GIF с несколькими кадрами, APNG (кусок acTL до данных), анимированный WebP */
export function isAnimatedImage(b, type) {
  if (type?.mime === 'image/png') {
    // acTL обязан идти раньше первого IDAT
    for (let i = 8; i + 8 <= b.length; ) {
      const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
      const name = ascii(b, i + 4, 4);
      if (name === 'acTL') return true;
      if (name === 'IDAT' || name === 'IEND') return false;
      i += 12 + len;
    }
    return false;
  }
  if (type?.mime === 'image/webp') return hasMarker(b, 'ANIM', 4096);
  if (type?.mime === 'image/gif') return gifFrames(b, 2) > 1;
  return false;
}

/** Сколько кадров в GIF (считаем до max; по началу файла — сколько успели увидеть) */
export function gifFrames(b, max = Infinity) {
  if (b.length < 13) return 0;
  let i = 13;
  const flags = b[10];
  if (flags & 0x80) i += 3 * (1 << ((flags & 7) + 1));
  let n = 0;
  while (i < b.length) {
    const t = b[i];
    if (t === 0x3b) break; // конец
    if (t === 0x21) {
      // расширение: пропускаем подблоки
      i += 2;
      while (i < b.length && b[i] !== 0) i += b[i] + 1;
      i++;
    } else if (t === 0x2c) {
      if (++n >= max) return n;
      const lf = b[i + 9];
      i += 10;
      if (lf & 0x80) i += 3 * (1 << ((lf & 7) + 1));
      i++; // минимальный размер кода LZW
      while (i < b.length && b[i] !== 0) i += b[i] + 1;
      i++;
    } else break;
  }
  return n;
}
