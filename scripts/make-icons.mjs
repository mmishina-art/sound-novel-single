// アイコンを生成する（標準ライブラリのみ）: npm run icons
// 色・形はここを書き換えて再実行する。PNG を直接編集しない。
// maskable は端末が外側を円や角丸で切り抜くため、図柄を中央 60% に収める。
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

// この本の色: 地は表紙の紺、図柄は紙色の「本」（右側に背の溝）
const BG = [0x1b, 0x2a, 0x4a];
const FG = [0xf5, 0xef, 0xdd];

function crc32(buf) {
  let c;
  const table = Array.from({ length: 256 }, (_, n) => {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// size: 一辺(px) / figure: 図柄の大きさ(一辺に対する割合) / fullBleed: 背景を全面に塗る
function png(size, figure, fullBleed) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const c = size / 2;
  const half = (size * figure) / 2;
  const radius = size * 0.22;
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      // 角丸の背景（fullBleed のときは全面）
      const dx = Math.max(Math.abs(x - c) - (c - radius), 0);
      const dy = Math.max(Math.abs(y - c) - (c - radius), 0);
      const inBg = fullBleed || dx * dx + dy * dy <= radius * radius;
      // 図柄: 中央の本（縦長の角丸四角）。右綴じなので、背の溝を右側に入れる
      const bw = half * 0.62;
      const bh = half * 0.92;
      const br = size * 0.03;
      const bx = Math.max(Math.abs(x - c) - (bw - br), 0);
      const by = Math.max(Math.abs(y - c) - (bh - br), 0);
      const inBook = bx * bx + by * by <= br * br;
      const spine = x > c + bw - size * figure * 0.14 && x < c + bw - size * figure * 0.05;
      const px = inBook ? (spine ? BG : FG) : BG;
      const o = row + 1 + x * 4;
      raw[o] = px[0];
      raw[o + 1] = px[1];
      raw[o + 2] = px[2];
      raw[o + 3] = inBg ? 255 : 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = new URL('../public/icons/', import.meta.url);
mkdirSync(out, { recursive: true });
const files = {
  'icon-192.png': png(192, 0.7, false),
  'icon-512.png': png(512, 0.7, false),
  'icon-maskable-512.png': png(512, 0.6, true),
  // apple-touch-icon は iOS が角を丸めるので全面塗りにする
  'apple-touch-icon.png': png(180, 0.7, true),
};
for (const [name, data] of Object.entries(files)) writeFileSync(new URL(name, out), data);

writeFileSync(
  new URL('icon.svg', out),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#1b2a4a"/><rect x="166" y="92" width="180" height="328" rx="14" fill="#f5efdd"/><rect x="306" y="92" width="16" height="328" fill="#1b2a4a"/></svg>\n`,
);
console.log('icons generated:', [...Object.keys(files), 'icon.svg'].join(', '));
