// Đóng gói thư mục dist-browser/ (bản phát hành) thành tệp zip: nộp Chrome Web Store / Microsoft Edge Add-ons, hoặc gửi người khác tự nạp.
//   npm run package:browser        (build bản phát hành rồi đóng gói)
//   node scripts/pack-browser.mjs  (chỉ đóng gói dist-browser/ hiện có)
import { zipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
if (/TEST/.test(manifest.name)) throw new Error('Đây là bản TEST (cấp sẵn quyền mọi trang) — không đóng gói. Build lại bằng `npm run build:browser:prod`.');
if ([...Object.keys(files)].some((f) => f.includes('testHooks'))) throw new Error('Bản build chứa móc kiểm thử.');

// Biểu tượng PHẢI là logo «Lo» (bản 0.6.27 lên cửa hàng mang chữ «N» của dự án cũ). Đối chiếu băm với scripts/browser-brand-icons.json.
{
  const brand = JSON.parse(readFileSync(path.join(root, 'scripts', 'browser-brand-icons.json'), 'utf8')).icons;
  for (const [size, want] of Object.entries(brand)) {
    const f = files[`icons/${size}.png`];
    if (!f) throw new Error(`Thiếu icons/${size}.png trong dist-browser/.`);
    const got = createHash('sha256').update(f).digest('hex');
    if (got !== want) throw new Error(`icons/${size}.png không phải logo Lo của Locaith (băm ${got.slice(0, 12)}…, cần ${want.slice(0, 12)}…). Khôi phục từ src/browser/static/icons rồi build lại.`);
  }
  for (const sz of Object.values(manifest.icons ?? {})) if (!files[sz]) throw new Error(`manifest.icons trỏ tới tệp không có trong gói: ${sz}`);
}

// Thời gian cố định để cùng một mã nguồn cho ra cùng một tệp zip.
const mtime = new Date('2026-01-01T00:00:00Z');
const entries = Object.fromEntries(Object.entries(files).map(([name, data]) => [name, [data, { level: 9, mtime }]]));
const zip = zipSync(entries);
const out = path.join(root, `locaith-agent-browser-${manifest.version}.zip`);
writeFileSync(out, zip);
console.log(`Đã tạo ${path.relative(root, out)} — ${Object.keys(files).length} tệp, ${(zip.length / 1024 / 1024).toFixed(2)} MB`);
