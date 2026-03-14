'use strict';
// Generates assets/icon.ico (16/32/48/256 px) and assets/tray-icon.png
// Uses only built-in Node.js modules — no dependencies required.
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

fs.mkdirSync(path.join(__dirname, 'assets'), { recursive: true });

// ── CRC32 ─────────────────────────────────────────────────────────────────────
const _crc = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = _crc[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ── PNG encoder ───────────────────────────────────────────────────────────────
function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const d = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(d.length);
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([t, d])));
  return Buffer.concat([lenBuf, t, d, crcBuf]);
}
function encodePNG(w, h, rgba) {
  const sig  = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;
    rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// ── ICO encoder ───────────────────────────────────────────────────────────────
function encodeICO(images) {
  const n = images.length;
  let off = 6 + 16 * n;
  const entries = [], datas = [];
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; e[1] = e[0];
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8); e.writeUInt32LE(off, 12);
    entries.push(e); datas.push(png); off += png.length;
  }
  const hdr = Buffer.alloc(6);
  hdr.writeUInt16LE(0, 0); hdr.writeUInt16LE(1, 2); hdr.writeUInt16LE(n, 4);
  return Buffer.concat([hdr, ...entries, ...datas]);
}

// ── Draw BGS hex icon ─────────────────────────────────────────────────────────
// Design: dark background, cyan flat-top hexagon ring, green center diamond
function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;

  // Fill background #020408
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 2; rgba[i + 1] = 4; rgba[i + 2] = 8; rgba[i + 3] = 255;
  }

  function set(x, y, r, g, b, a = 255) {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const i = (y * size + x) * 4;
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a;
  }

  // Flat-top regular hexagon test: |y| <= R*√3/2  AND  |x| + |y|/√3 <= R
  function inHex(x, y, R) {
    const dx = Math.abs(x - cx), dy = Math.abs(y - cy);
    return dy <= R * 0.866 && dx + dy * 0.5774 <= R;
  }

  const R1 = size * 0.44;   // outer hex radius
  const R2 = size * 0.25;   // inner cutout radius (creates ring)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inHex(x, y, R1) && !inHex(x, y, R2)) {
        // Cyan hex ring #00d4ff
        set(x, y, 0, 212, 255);
      } else if (inHex(x, y, R2)) {
        // Dark inner fill
        set(x, y, 4, 14, 26);
      }
    }
  }

  // Three small inner hex cells (BGS "grid" motif) — only at >= 32px
  if (size >= 32) {
    const RH  = size * 0.10;
    const off = size * 0.09;
    const cells = [
      { ox: 0,    oy: -off },
      { ox: -off, oy:  off * 0.55 },
      { ox:  off, oy:  off * 0.55 },
    ];
    for (const { ox, oy } of cells) {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const dx = Math.abs(x - cx - ox), dy = Math.abs(y - cy - oy);
          const inCell = dy <= RH * 0.866 && dx + dy * 0.5774 <= RH;
          if (inCell && inHex(x, y, R2)) set(x, y, 0, 150, 190);
        }
      }
    }
  }

  // Center diamond ◈ in green
  const dc = Math.round(cx), dy0 = Math.round(cy);
  const ds = Math.max(1, Math.round(size * 0.07));
  for (let dy = -ds; dy <= ds; dy++) {
    for (let dx = -ds; dx <= ds; dx++) {
      if (Math.abs(dx) + Math.abs(dy) <= ds) set(dc + dx, dy0 + dy, 0, 255, 136);
    }
  }

  return rgba;
}

// ── Generate and write ────────────────────────────────────────────────────────
const SIZES  = [16, 32, 48, 256];
const images = SIZES.map(size => ({ size, png: encodePNG(size, size, drawIcon(size)) }));

const icoPath  = path.join(__dirname, 'assets', 'icon.ico');
const trayPath = path.join(__dirname, 'assets', 'tray-icon.png');

fs.writeFileSync(icoPath,  encodeICO(images));
fs.writeFileSync(trayPath, images.find(i => i.size === 32).png);

console.log(`✓ assets/icon.ico    (${fs.statSync(icoPath).size} bytes, sizes: ${SIZES.join('/')})`);
console.log(`✓ assets/tray-icon.png (32×32)`);
