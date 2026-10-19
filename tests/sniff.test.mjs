// Тип файла по сигнатуре: картинки, звук и видео в WebM, анимированные GIF/APNG/WebP
import test from 'node:test';
import assert from 'node:assert/strict';
import { sniff, isAnimatedImage, gifFrames, hasMarker } from '../shared/sniff.js';

const bytes = (...parts) => {
  const out = [];
  for (const p of parts) {
    if (typeof p === 'string') for (const c of p) out.push(c.charCodeAt(0));
    else if (Array.isArray(p)) out.push(...p);
    else out.push(p);
  }
  return Uint8Array.from(out);
};
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (name, data = []) => [...u32(data.length), ...bytes(name), ...data, 0, 0, 0, 0];
const PNG_SIG = [0x89, ...bytes('PNG'), 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = chunk('IHDR', [...u32(4), ...u32(3), 8, 6, 0, 0, 0]);

// GIF 1×1 с палитрой из двух цветов и n кадрами
function gif(n) {
  const frame = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0x02, 0x02, 0x44, 0x01, 0x00];
  const gce = [0x21, 0xf9, 0x04, 0x04, 0x0a, 0x00, 0x00, 0x00];
  const parts = [...bytes('GIF89a'), 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255];
  for (let i = 0; i < n; i++) parts.push(...gce, ...frame);
  parts.push(0x3b);
  return Uint8Array.from(parts);
}

test('картинки по сигнатуре, а не по имени', () => {
  assert.equal(sniff(bytes(PNG_SIG, IHDR)).mime, 'image/png');
  assert.equal(sniff(bytes([0xff, 0xd8, 0xff, 0xe0], 'JFIF')).mime, 'image/jpeg');
  assert.equal(sniff(gif(1)).mime, 'image/gif');
  assert.equal(sniff(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ')).mime, 'image/webp');
  assert.equal(sniff(bytes([0, 0, 0, 0x1c], 'ftypavif', [0, 0, 0, 0])).mime, 'image/avif');
  // BMP распознаём (его можно сжать в WebP), но как есть сервер его не принимает
  const bmp = sniff(bytes('BM', new Array(30).fill(0)));
  assert.equal(bmp.mime, 'image/bmp');
  assert.equal(bmp.upload, false);
  assert.equal(sniff(bytes('<html>')), null);
});

test('WebM: звук отдельно от видео', () => {
  const ebml = [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84, ...bytes('webm')];
  const audio = sniff(bytes(ebml, new Array(40).fill(0), 'A_OPUS', [0, 0]));
  assert.deepEqual(audio, { mime: 'audio/webm', ext: 'webm', kind: 'audio' });
  const video = sniff(bytes(ebml, 'V_VP9', [0, 0], 'A_OPUS'));
  assert.equal(video.kind, 'video');
  // неизвестное содержимое — считаем видео, как раньше
  assert.equal(sniff(bytes(ebml)).kind, 'video');
  assert.ok(hasMarker(bytes(ebml), 'webm', 64));
  assert.ok(!hasMarker(bytes(ebml), 'matroska', 64));
});

test('звук: MP3, OGG, WAV, FLAC, M4A', () => {
  assert.equal(sniff(bytes('ID3', [3, 0, 0, 0, 0, 0, 0])).mime, 'audio/mpeg');
  assert.equal(sniff(bytes('OggS', [0, 2])).mime, 'audio/ogg');
  assert.equal(sniff(bytes('RIFF', [0, 0, 0, 0], 'WAVEfmt ')).mime, 'audio/wav');
  assert.equal(sniff(bytes('fLaC', [0, 0, 0, 0])).mime, 'audio/flac');
  assert.equal(sniff(bytes([0, 0, 0, 0x20], 'ftypM4A ', [0, 0, 0, 0])).kind, 'audio');
  assert.equal(sniff(bytes([0, 0, 0, 0x20], 'ftypisom', [0, 0, 0, 0])).mime, 'video/mp4');
});

test('анимация: GIF с несколькими кадрами, APNG, анимированный WebP', () => {
  assert.equal(gifFrames(gif(1)), 1);
  assert.equal(gifFrames(gif(5)), 5);
  assert.equal(gifFrames(gif(5), 2), 2);
  assert.equal(isAnimatedImage(gif(1), { mime: 'image/gif' }), false);
  assert.equal(isAnimatedImage(gif(3), { mime: 'image/gif' }), true);
  const still = bytes(PNG_SIG, IHDR, chunk('IDAT', [1, 2, 3]), chunk('IEND'));
  const apng = bytes(PNG_SIG, IHDR, chunk('acTL', [...u32(4), ...u32(0)]), chunk('IDAT', [1, 2, 3]), chunk('IEND'));
  assert.equal(isAnimatedImage(still, { mime: 'image/png' }), false);
  assert.equal(isAnimatedImage(apng, { mime: 'image/png' }), true);
  // acTL после данных — это не APNG
  const late = bytes(PNG_SIG, IHDR, chunk('IDAT', [1]), chunk('acTL', [...u32(4), ...u32(0)]));
  assert.equal(isAnimatedImage(late, { mime: 'image/png' }), false);
  assert.equal(isAnimatedImage(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8X', new Array(10).fill(0), 'ANIM'), { mime: 'image/webp' }), true);
  assert.equal(isAnimatedImage(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ', new Array(10).fill(0)), { mime: 'image/webp' }), false);
});
