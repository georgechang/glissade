// Generates the toolbar/notification icon set (public/icon/{16,32,48,128}.png):
// a solid rounded-square background + a white down-arrow (matching the popup logo
// glyph). No image deps — rasterizes by supersampling and PNG-encodes with Node's
// built-in zlib. Re-run after changing ICON_BG to recolor the icons.
//   node packages/extension/scripts/gen-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ICON_BG = [13, 148, 136]; // teal-600 (#0d9488) — keep in sync with popup --accent
const ARROW = [255, 255, 255];
const SIZES = [16, 32, 48, 128];
const SS = 4; // supersample factor → anti-aliasing on downsample

const distToSeg = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
};

// Down-arrow in a 0..24 space (matches the popup SVG): stem + chevron.
const SEGS = [
  [12, 4, 12, 16], // stem
  [6, 10, 12, 16], // chevron left
  [12, 16, 18, 10], // chevron right
];

function renderHiRes(N) {
  const buf = new Uint8ClampedArray(N * N * 4);
  const r = 0.22 * N; // corner radius
  const f = (N * 0.6) / 24; // arrow occupies ~60% of the canvas, centered
  const tx = N / 2 - 12 * f;
  const ty = N / 2 - 10 * f; // arrow bbox center is (12,10) in 24-space
  const half = (2.4 * f) / 2; // stroke-width 2.4, round caps

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      // rounded-rect coverage (transparent outside)
      const qx = Math.max(r - cx, cx - (N - r), 0);
      const qy = Math.max(r - cy, cy - (N - r), 0);
      const inside = Math.hypot(qx, qy) <= r;
      const i = (y * N + x) * 4;
      if (!inside) continue;
      let col = ICON_BG;
      let d = Infinity;
      for (const [ax, ay, bx, by] of SEGS) {
        d = Math.min(d, distToSeg(cx, cy, ax * f + tx, ay * f + ty, bx * f + tx, by * f + ty));
      }
      if (d <= half) col = ARROW;
      buf[i] = col[0]; buf[i + 1] = col[1]; buf[i + 2] = col[2]; buf[i + 3] = 255;
    }
  }
  return buf;
}

function downsample(hi, N, S) {
  const out = new Uint8ClampedArray(S * S * 4);
  const n = SS * SS;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const i = ((y * SS + dy) * N + (x * SS + dx)) * 4;
          r += hi[i]; g += hi[i + 1]; b += hi[i + 2]; a += hi[i + 3];
        }
      }
      const o = (y * S + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return out;
}

// --- minimal PNG (RGBA, 8-bit) ---
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, S) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icon');
mkdirSync(outDir, { recursive: true });
for (const S of SIZES) {
  const N = S * SS;
  const png = encodePng(downsample(renderHiRes(N), N, S), S);
  writeFileSync(join(outDir, `${S}.png`), png);
  console.log(`wrote icon/${S}.png (${png.length} bytes)`);
}
