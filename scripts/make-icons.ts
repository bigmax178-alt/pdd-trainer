/**
 * Иконки приложения (PNG) без внешних библиотек: светофор автошколы рисуется попиксельно
 * с 4-кратным сглаживанием и упаковывается в PNG через node:zlib. Результат — assets/icons/, коммитится.
 */
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'assets/icons');

type Rgb = readonly [number, number, number];
const BG: Rgb = [23, 27, 31];
const BODY: Rgb = [32, 37, 42];
const RIM: Rgb = [59, 66, 72];
const RED: Rgb = [229, 50, 43];
const AMBER: Rgb = [245, 179, 0];
const GREEN: Rgb = [38, 178, 79];

/** Цвет точки (x, y) в единичном квадрате [0,1]²: фон → корпус → три огня. */
function colorAt(x: number, y: number, maskable: boolean): Rgb {
  const inRoundRect = (cx: number, cy: number, w: number, h: number, r: number) => {
    const dx = Math.max(Math.abs(x - cx) - (w / 2 - r), 0);
    const dy = Math.max(Math.abs(y - cy) - (h / 2 - r), 0);
    return Math.hypot(dx, dy) <= r;
  };
  // Безопасная зона maskable-иконки — центральные 80 %, поэтому корпус у неё меньше.
  const s = maskable ? 0.62 : 0.78;
  const w = 0.34 * s, h = 0.92 * s, r = 0.11 * s;
  if (!inRoundRect(0.5, 0.5, w, h, r)) return BG;
  if (!inRoundRect(0.5, 0.5, w - 0.035 * s, h - 0.035 * s, r - 0.02 * s)) return RIM;
  const lights: [number, Rgb][] = [[0.5 - 0.29 * s, RED], [0.5, AMBER], [0.5 + 0.29 * s, GREEN]];
  for (const [cy, c] of lights) if (Math.hypot(x - 0.5, y - cy) <= 0.115 * s) return c;
  return BODY;
}

function render(size: number, maskable: boolean): Uint8Array {
  const ss = 4;
  const px = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = colorAt((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size, maskable);
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const i = (y * size + x) * 3;
      px[i] = r / (ss * ss); px[i + 1] = g / (ss * ss); px[i + 2] = b / (ss * ss);
    }
  }
  return px;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Uint8Array) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(size: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0; // фильтр None
    Buffer.from(rgb.buffer, y * size * 3, size * 3).copy(raw, y * (size * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array(0)),
  ]);
}

await mkdir(out, { recursive: true });
for (const [name, size, maskable] of [['icon-192.png', 192, false], ['icon-512.png', 512, false], ['icon-maskable-512.png', 512, true], ['apple-touch-icon.png', 180, false]] as const) {
  await writeFile(join(out, name), png(size, render(size, maskable)));
}
console.log('Готово: иконки записаны в assets/icons/');
