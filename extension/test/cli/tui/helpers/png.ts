/** Dựng một ảnh PNG hợp lệ (RGB 8 bit, nhiễu giả ngẫu nhiên nên nén không quá nhỏ) — dùng cho test dán ảnh, không cần thư viện ảnh. */
import * as zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function makePng(w = 64, h = 48): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // độ sâu bit
  ihdr[9] = 2; // RGB
  const rows: Buffer[] = [];
  let seed = 12345;
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3); // byte đầu = bộ lọc 0
    for (let i = 1; i < row.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      row[i] = seed >> 16;
    }
    rows.push(row);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
