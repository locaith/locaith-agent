// Đóng gói thư mục dist-browser/ (bản phát hành) thành tệp zip: nộp Chrome Web Store / Microsoft Edge Add-ons, hoặc gửi người khác tự nạp.
//   npm run package:browser        (build bản phát hành rồi đóng gói)
//   node scripts/pack-browser.mjs  (chỉ đóng gói dist-browser/ hiện có)
import { zipSync } from 'fflate';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBrowserPackage } from './verify-browser-package.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist-browser');

function walk(dir, base = '') {
  const out = {};
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(abs).isDirectory()) Object.assign(out, walk(abs, rel));
    else if (!name.endsWith('.map')) out[rel] = readFileSync(abs);
  }
  return out;
}

let files;
try {
  files = walk(dist);
} catch {
  throw new Error('Chưa có dist-browser/. Chạy `npm run build:browser:prod` trước.');
}
if (!files['manifest.json']) throw new Error('dist-browser/manifest.json không tồn tại.');
const manifest = JSON.parse(files['manifest.json'].toString('utf8'));

// Chốt chặn tổng TRƯỚC khi nén (biểu tượng Lo, mô tả không tên hãng, không CDN, không quyền thừa, thông báo đồng ý, bản không phải TEST…): xem scripts/verify-browser-package.mjs.
// Thất bại thì ném lỗi liệt kê mọi mục hỏng và KHÔNG tạo tệp zip.
const { passed } = verifyBrowserPackage(dist, { root });
console.log(`Chốt chặn gói: ${passed.length} mục kiểm đạt.`);

// Thời gian cố định để cùng một mã nguồn cho ra cùng một tệp zip.
const mtime = new Date('2026-01-01T00:00:00Z');
const entries = Object.fromEntries(Object.entries(files).map(([name, data]) => [name, [data, { level: 9, mtime }]]));
const zip = zipSync(entries);
const out = path.join(root, `locaith-agent-browser-${manifest.version}.zip`);
writeFileSync(out, zip);
console.log(`Đã tạo ${path.relative(root, out)} — ${Object.keys(files).length} tệp, ${(zip.length / 1024 / 1024).toFixed(2)} MB`);
