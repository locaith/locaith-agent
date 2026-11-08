// Sinh `src/cli/tui/logoArt.ts`: logo «Lo» dựng bằng khối nửa ô (▀ ▄ █) từ đường vẽ ở webview/src/brand/lo.ts.
// Không cần trình duyệt: đường vẽ chỉ gồm các đa giác M…Z, tô quy tắc chẵn-lẻ (even-odd) với lấy mẫu con 4×4.
// Chạy:  node scripts/cli-gen-logo.mjs [chiềuRộngPixel=26]
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(root, 'webview/src/brand/lo.ts'), 'utf8');
const d = /LO_PATH =\s*"([^"]+)"/.exec(src)?.[1];
const box = JSON.parse(/LO_BOX = (\{[^}]+\})/.exec(src)?.[1] ?? 'null');
if (!d || !box) throw new Error('Không đọc được LO_PATH/LO_BOX');

// các đa giác
const polys = d
  .split('Z')
  .map((s) => s.replace(/^M/, '').trim())
  .filter(Boolean)
  .map((s) => {
    const n = s.split(/\s+/).map(Number);
    const pts = [];
    for (let i = 0; i + 1 < n.length; i += 2) pts.push([n[i], n[i + 1]]);
    return pts;
  });

function raster(W) {
  const H = Math.round((W * box.h) / box.w / 2) * 2; // số hàng pixel chẵn (mỗi ô cao 2 pixel)
  const SS = 4;
  const cov = [];
  for (let py = 0; py < H; py++) {
    const row = [];
    for (let px = 0; px < W; px++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const x = box.x + ((px + (sx + 0.5) / SS) / W) * box.w;
          const y = box.y + ((py + (sy + 0.5) / SS) / H) * box.h;
          if (inside(x, y)) hit++;
        }
      row.push(hit / (SS * SS));
    }
    cov.push(row);
  }
  const on = (v) => v >= 0.5;
  const rows = [];
  const ascii = [];
  for (let r = 0; r < H; r += 2) {
    let s = '';
    let a = '';
    for (let x = 0; x < W; x++) {
      const t = on(cov[r][x]);
      const b = on(cov[r + 1][x]);
      s += t && b ? '█' : t ? '▀' : b ? '▄' : ' ';
      a += t || b ? '#' : ' ';
    }
    rows.push(s.replace(/\s+$/, ''));
    ascii.push(a.replace(/\s+$/, ''));
  }
  return { rows, ascii };
}

// điểm (x,y) trong hệ toạ độ logo có nằm trong hình (even-odd qua mọi đa giác)?
function inside(x, y) {
  let c = false;
  for (const pts of polys) {
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
  }
  return c;
}

const big = raster(26);
const small = raster(18);
const out = `/* TỆP SINH TỰ ĐỘNG bởi scripts/cli-gen-logo.mjs từ webview/src/brand/lo.ts — đừng sửa tay. */

/** Logo «Lo» bằng khối nửa ô (26 cột × ${big.rows.length} hàng). Gradient dọc #22bcec → #625aec được tô lúc vẽ. */
export const LOGO_WIDTH = 26;
export const LOGO_ROWS: readonly string[] = ${JSON.stringify(big.rows, null, 2)};

/** Bản nhỏ (18 cột × ${small.rows.length} hàng) cho terminal hẹp/thấp. */
export const LOGO_SMALL_WIDTH = 18;
export const LOGO_SMALL_ROWS: readonly string[] = ${JSON.stringify(small.rows, null, 2)};

/** Bản ASCII dự phòng (terminal không UTF-8 / LOCAITH_ASCII=1). */
export const LOGO_ASCII: readonly string[] = ${JSON.stringify(big.ascii, null, 2)};
export const LOGO_SMALL_ASCII: readonly string[] = ${JSON.stringify(small.ascii, null, 2)};
`;
writeFileSync(path.join(root, 'src/cli/tui/logoArt.ts'), out);
console.log(big.rows.join('\n'));
console.log(small.rows.join('\n'));
