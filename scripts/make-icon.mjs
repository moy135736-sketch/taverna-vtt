#!/usr/bin/env node
// Картинки для Windows из client/public/favicon.svg:
//   desktop/taverna.ico  — иконка программы, установщика и файла обновления;
//   desktop/wizard.bmp   — картинка слева на первой и последней странице установщика и файла обновления (164×314).
// Нужен Chromium для Playwright: node scripts/make-icon.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = fs.readFileSync(path.join(ROOT, 'client/public/favicon.svg'), 'utf8');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage();
const pngs = [];
for (const size of SIZES) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  pngs.push(await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
}

// ICO: заголовок, каталог, затем PNG-данные каждого размера
const head = Buffer.alloc(6);
head.writeUInt16LE(0, 0);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(SIZES.length, 4);
const dir = Buffer.alloc(16 * SIZES.length);
let offset = 6 + dir.length;
SIZES.forEach((size, i) => {
  const e = i * 16;
  dir.writeUInt8(size >= 256 ? 0 : size, e);
  dir.writeUInt8(size >= 256 ? 0 : size, e + 1);
  dir.writeUInt8(0, e + 2);
  dir.writeUInt8(0, e + 3);
  dir.writeUInt16LE(1, e + 4);
  dir.writeUInt16LE(32, e + 6);
  dir.writeUInt32LE(pngs[i].length, e + 8);
  dir.writeUInt32LE(offset, e + 12);
  offset += pngs[i].length;
});
const out = path.join(ROOT, 'desktop', 'taverna.ico');
fs.writeFileSync(out, Buffer.concat([head, dir, ...pngs]));
console.log('Иконка:', out, `(${SIZES.join(', ')} px)`);

// ---------- картинка мастера установки: знак и название на тёмном дубе, как шапка сайта ----------
const W = 164;
const H = 314;
const font = fs.readFileSync(path.join(ROOT, 'node_modules/@fontsource/alegreya/files/alegreya-cyrillic-700-normal.woff2')).toString('base64');
const mark = svg.replace(/<rect[^>]*\/>/, '').replace('<svg ', '<svg width="104" height="104" ');
await page.setViewportSize({ width: W, height: H });
await page.setContent(`<html><head><style>
  @font-face { font-family: Alegreya; font-weight: 700; src: url(data:font/woff2;base64,${font}) format('woff2'); }
  html, body { margin: 0; width: ${W}px; height: ${H}px; background: #1d1813; }
  body { display: flex; flex-direction: column; align-items: center; padding-top: 74px; box-sizing: border-box; }
  .name { margin-top: 18px; font: 700 27px/1 Alegreya, Georgia, serif; color: #ece3d0; letter-spacing: 0.01em; }
</style></head><body>${mark}<div class="name">Таверна</div></body></html>`);
await page.evaluate(() => document.fonts.ready);
const shot = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
// PNG → пиксели через canvas самого браузера, затем 24-битный BMP (снизу вверх, строки по 4 байта)
const rgba = await page.evaluate(async (b64) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return Array.from(ctx.getImageData(0, 0, c.width, c.height).data);
}, shot.toString('base64'));
await browser.close();

const rowSize = Math.ceil((W * 3) / 4) * 4;
const bmp = Buffer.alloc(54 + rowSize * H);
bmp.write('BM', 0, 'ascii');
bmp.writeUInt32LE(bmp.length, 2);
bmp.writeUInt32LE(54, 10);
bmp.writeUInt32LE(40, 14);
bmp.writeInt32LE(W, 18);
bmp.writeInt32LE(H, 22);
bmp.writeUInt16LE(1, 26);
bmp.writeUInt16LE(24, 28);
bmp.writeUInt32LE(rowSize * H, 34);
bmp.writeInt32LE(2835, 38);
bmp.writeInt32LE(2835, 42);
for (let y = 0; y < H; y++) {
  const row = 54 + (H - 1 - y) * rowSize;
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    bmp[row + x * 3] = rgba[i + 2];
    bmp[row + x * 3 + 1] = rgba[i + 1];
    bmp[row + x * 3 + 2] = rgba[i];
  }
}
const wiz = path.join(ROOT, 'desktop', 'wizard.bmp');
fs.writeFileSync(wiz, bmp);
console.log('Картинка установщика:', wiz, `(${W}×${H})`);
