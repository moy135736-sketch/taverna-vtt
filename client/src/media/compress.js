// Сжатие файлов перед загрузкой — прямо в браузере, на сервер уходит уже лёгкий файл:
//   картинки (PNG, JPG, BMP, неподвижные GIF) → WebP;
//   анимированные GIF и APNG → WebM (VP9, прозрачность сохраняется);
//   видео (MP4, MOV, MKV) → WebM (VP9 + Opus);
//   звук (MP3, WAV, FLAC, OGG, M4A) → WebM (Opus).
// Если браузер чего-то не умеет, файл слишком большой или выигрыш меньше 10% — загружается оригинал.
import { sniff, isAnimatedImage, hasMarker } from '@shared/sniff.js';

const KEEP_RATIO = 0.9; // сжатый файл должен быть хотя бы на 10% легче
const MAX_IMAGE_PIXELS = 64e6; // больше — не трогаем (память браузера)
const MAX_VIDEO_PIXELS = 3840 * 2160;
const MAX_VIDEO_SECONDS = 20 * 60;
const MAX_AUDIO_SECONDS = 3 * 3600;
// качество VP9 по шкале 0…1 (0,6 ≈ квантователь 33 из 63): на глаз как оригинал, а файл в разы легче
const VIDEO_QUALITY = 0.6;

/** Сжимать ли загрузки: настройка аккаунта (по умолчанию — да) */
export const compressEnabled = (user) => user?.settings?.compressUploads !== false;

const rename = (name, ext) => (String(name || 'file').replace(/\.[^./\\]+$/, '') || 'file') + '.' + ext;

class Canceled extends Error {}
const REQUIRED = new WeakSet(); // результаты, без которых файл не загрузить

/**
 * Сжать список файлов. onStatus({ file, index, total, progress }) — для показа хода работы;
 * signal — AbortSignal: остановить и загрузить оставшиеся как есть.
 * Возвращает { files, before, after, changed }.
 */
export async function compressFiles(files, { onStatus, signal } = {}) {
  const out = [];
  let before = 0,
    after = 0,
    changed = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    let res = null;
    if (!signal?.aborted) {
      try {
        res = await compressFile(f, { signal, progress: (p) => onStatus?.({ file: f, index: i, total: files.length, progress: p }) });
      } catch (e) {
        if (!(e instanceof Canceled) && e?.name !== 'ConversionCanceledError') console.warn('[сжатие]', f.name, e);
        res = null;
      }
    }
    // формат, который сервер как есть не примет (BMP), берём сжатым в любом случае
    const use = res && (res.size < f.size * KEEP_RATIO || REQUIRED.has(res)) ? res : f;
    if (use !== f) changed++;
    before += f.size;
    after += use.size;
    out.push(use);
  }
  return { files: out, before, after, changed };
}

/** Один файл: сжатый File или null (оставить как есть) */
export async function compressFile(f, { progress, signal } = {}) {
  if (!f) return null;
  const head = new Uint8Array(await f.slice(0, 256 * 1024).arrayBuffer());
  const type = sniff(head);
  if (!type) return null;
  if (type.upload === false) {
    const res = type.kind === 'image' ? await imageToWebp(f) : null;
    if (res) REQUIRED.add(res);
    return res;
  }
  if (f.size < 16 * 1024) return null; // маленькие — не стоит труда
  if (type.kind === 'image') {
    if (type.mime === 'image/avif') return null;
    if (isAnimatedImage(head, type)) {
      // анимированный WebP и так сжат; GIF и APNG — в видео
      if (type.mime === 'image/webp') return null;
      return animationToWebm(f, type, { progress, signal });
    }
    if (type.mime === 'image/webp') return null;
    return imageToWebp(f);
  }
  // WebM уже сжат; Matroska (.mkv) с той же сигнатурой — перепаковываем
  if ((type.mime === 'video/webm' || type.mime === 'audio/webm') && !hasMarker(head, 'matroska', 64)) return null;
  if (type.kind === 'video' || type.kind === 'audio') return mediaToWebm(f, type.kind, { progress, signal });
  return null;
}

// ---------------------------------------------------------------------------
// Картинки → WebP

async function encodeWebp(source, w, h, quality = 0.9) {
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, w, h);
    return c.convertToBlob({ type: 'image/webp', quality });
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, w, h);
  return new Promise((r) => c.toBlob(r, 'image/webp', quality));
}

export async function imageToWebp(f) {
  if (typeof createImageBitmap === 'undefined') return null;
  let bmp;
  try {
    bmp = await createImageBitmap(f);
  } catch {
    return null; // браузер не умеет разобрать этот файл
  }
  try {
    const w = bmp.width,
      h = bmp.height;
    if (!w || !h || w * h > MAX_IMAGE_PIXELS || w > 16384 || h > 16384) return null;
    const blob = await encodeWebp(bmp, w, h);
    // Safari и старые браузеры вместо WebP молча отдают PNG — такой результат не нужен
    if (!blob || blob.type !== 'image/webp') return null;
    return new File([blob], rename(f.name, 'webp'), { type: 'image/webp', lastModified: f.lastModified });
  } finally {
    bmp.close?.();
  }
}

// ---------------------------------------------------------------------------
// Анимированные GIF и APNG → WebM

/** Есть ли в кадре прозрачные места (по уменьшенной копии) */
function hasTransparency(frame) {
  const w = frame.displayWidth || frame.codedWidth,
    h = frame.displayHeight || frame.codedHeight;
  const k = Math.min(1, 256 / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * k)),
    ch = Math.max(1, Math.round(h * k));
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(cw, ch) : Object.assign(document.createElement('canvas'), { width: cw, height: ch });
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(frame, 0, 0, cw, ch);
  const d = ctx.getImageData(0, 0, cw, ch).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
  return false;
}

async function pickVideoCodec(mb, w, h) {
  for (const codec of ['vp9', 'vp8']) if (await mb.canEncodeVideo(codec, { width: w, height: h })) return codec;
  return null;
}

async function animationToWebm(f, type, { progress, signal }) {
  if (typeof ImageDecoder === 'undefined' || typeof VideoEncoder === 'undefined') return null;
  if (!(await ImageDecoder.isTypeSupported(type.mime))) return null;
  const mb = await import('./mb.js');
  const dec = new ImageDecoder({ data: await f.arrayBuffer(), type: type.mime });
  try {
    await dec.tracks.ready;
    await dec.completed;
    const track = dec.tracks.selectedTrack;
    const n = track?.frameCount || 0;
    if (!track?.animated || n < 2) return imageToWebp(f);
    const first = (await dec.decode({ frameIndex: 0 })).image;
    const w = first.displayWidth,
      h = first.displayHeight;
    if (w * h > MAX_VIDEO_PIXELS) {
      first.close();
      return null;
    }
    let alpha = hasTransparency(first);
    if (!alpha && n > 2) {
      const mid = (await dec.decode({ frameIndex: Math.floor(n / 2) })).image;
      alpha = hasTransparency(mid);
      mid.close();
    }
    const codec = await pickVideoCodec(mb, w, h);
    if (!codec) {
      first.close();
      return null;
    }
    const output = new mb.Output({ format: new mb.WebMOutputFormat(), target: new mb.BufferTarget() });
    const src = new mb.VideoSampleSource({ codec, quality: new mb.Quality(VIDEO_QUALITY), alpha: alpha ? 'keep' : 'discard', sizeChangeBehavior: 'contain' });
    output.addVideoTrack(src);
    await output.start();
    let ts = 0;
    try {
      for (let i = 0; i < n; i++) {
        if (signal?.aborted) throw new Canceled();
        const img = i === 0 ? first : (await dec.decode({ frameIndex: i })).image;
        // задержки меньше 20 мс браузеры показывают как 100 мс — так же и сохраняем
        let dur = (img.duration ?? 100000) / 1e6;
        if (!(dur >= 0.02)) dur = 0.1;
        const sample = new mb.VideoSample(img, { timestamp: ts, duration: dur });
        try {
          await src.add(sample);
        } finally {
          sample.close();
          img.close();
        }
        ts += dur;
        progress?.((i + 1) / n);
      }
      src.close();
      await output.finalize();
    } catch (e) {
      first.close();
      await output.cancel().catch(() => {});
      throw e;
    }
    const buf = output.target.buffer;
    if (!buf) return null;
    return new File([buf], rename(f.name, 'webm'), { type: 'video/webm', lastModified: f.lastModified });
  } finally {
    dec.close();
  }
}

// ---------------------------------------------------------------------------
// Видео и звук → WebM (VP9 + Opus)

async function mediaToWebm(f, kind, { progress, signal }) {
  if (typeof AudioEncoder === 'undefined' && typeof VideoEncoder === 'undefined') return null;
  const mb = await import('./mb.js');
  const input = new mb.Input({ source: new mb.BlobSource(f), formats: [mb.MP4, mb.QTFF, mb.MATROSKA, mb.WEBM, mb.MP3, mb.WAVE, mb.OGG, mb.FLAC, mb.ADTS] });
  try {
    const vt = kind === 'video' ? await input.getPrimaryVideoTrack() : null;
    const at = await input.getPrimaryAudioTrack();
    if (!vt && !at) return null;
    const duration = await input.computeDuration();
    if (vt && (vt.displayWidth * vt.displayHeight > MAX_VIDEO_PIXELS || duration > MAX_VIDEO_SECONDS)) return null;
    if (!vt && duration > MAX_AUDIO_SECONDS) return null;
    const output = new mb.Output({ format: new mb.WebMOutputFormat(), target: new mb.BufferTarget() });
    const conv = await mb.Conversion.init({
      input,
      output,
      video: vt ? { codec: 'vp9', quality: new mb.Quality(VIDEO_QUALITY) } : { discard: true },
      // музыке — 128 кбит/с: на слух как оригинал; звуку в видео хватит 96
      audio: { codec: 'opus', quality: new mb.Quality({ bitrate: vt ? 96000 : 128000 }) },
      showWarnings: false,
    });
    // без звука или картинки файл испорчен — лучше загрузить как есть
    if (!conv.isValid || conv.discardedTracks.some((d) => d.reason !== 'discarded_by_user')) return null;
    conv.onProgress = (p) => progress?.(p);
    const stop = () => conv.cancel();
    signal?.addEventListener('abort', stop, { once: true });
    try {
      await conv.execute();
    } finally {
      signal?.removeEventListener('abort', stop);
    }
    const buf = output.target.buffer;
    if (!buf) return null;
    return new File([buf], rename(f.name, 'webm'), { type: vt ? 'video/webm' : 'audio/webm', lastModified: f.lastModified });
  } finally {
    input.dispose?.();
  }
}

// ---------------------------------------------------------------------------

/** «9,1 МБ», «640 КБ» */
export function sizeText(n) {
  if (n < 1048576) return `${Math.max(1, Math.round(n / 1024)).toLocaleString('ru-RU')} КБ`;
  return `${(n / 1048576).toLocaleString('ru-RU', { maximumFractionDigits: n < 10 * 1048576 ? 1 : 0 })} МБ`;
}

/** «48 МБ → 9,1 МБ», «900 КБ → 210 КБ» */
export const sizeChange = (a, b) => `${sizeText(a)} → ${sizeText(b)}`;
