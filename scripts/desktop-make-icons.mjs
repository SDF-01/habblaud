#!/usr/bin/env node
// Creates simple Habblaud placeholder icons for Tauri packaging (PNG + ICO).
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ICONS = join(ROOT, 'desktop', 'src-tauri', 'icons');
mkdirSync(ICONS, { recursive: true });

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function png(size, rgbaFn) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = rgbaFn(x, y, size);
      const i = row + 1 + x * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function pixel(x, y, size) {
  const nx = (x + 0.5) / size;
  const ny = (y + 0.5) / size;
  const cx = nx - 0.5;
  const cy = ny - 0.5;
  const dist = Math.sqrt(cx * cx + cy * cy);
  // Soft circle badge with Habblaud-ish sky accent.
  if (dist > 0.48) return [0, 0, 0, 0];
  const edge = dist > 0.42 ? 1 : 0;
  if (edge) return [15, 20, 29, 255];
  const warm = ny < 0.45;
  return warm ? [56, 189, 248, 255] : [240, 138, 60, 255];
}

function icoFromPng(pngBuf) {
  // PNG-compressed ICO (Vista+).
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = 0; // 256
  entry[1] = 0;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, pngBuf]);
}

const sizes = [
  ['32x32.png', 32],
  ['128x128.png', 128],
  ['henry.w@example.net', 256],
];

for (const [name, size] of sizes) {
  writeFileSync(join(ICONS, name), png(size, pixel));
}

const iconPng = png(256, pixel);
writeFileSync(join(ICONS, 'icon.png'), iconPng);
writeFileSync(join(ICONS, 'icon.ico'), icoFromPng(iconPng));
// Minimal ICNS placeholder: Tauri on Windows mainly needs ICO/PNG; keep a PNG copy named .icns for config completeness.
writeFileSync(join(ICONS, 'icon.icns'), iconPng);

console.log(`Wrote icons in ${ICONS}`);
