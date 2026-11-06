// Sao chép các subset font (latin + vietnamese) dùng cho khung xem trước artifact vào media/fonts/.
// Các tệp này được nhúng dạng data URI vào mỗi artifact, nên chỉ lấy đúng số trọng lượng cần dùng.
//   node scripts/copy-artifact-fonts.mjs
import { copyFile, mkdir } from 'node:fs/promises';

const jobs = [
  ...[400, 600, 700].flatMap((w) => ['latin', 'vietnamese'].map((s) => ['be-vietnam-pro', `be-vietnam-pro-${s}-${w}-normal.woff2`])),
  ...[400, 700].flatMap((w) => ['latin', 'vietnamese'].map((s) => ['jetbrains-mono', `jetbrains-mono-${s}-${w}-normal.woff2`])),
];

await mkdir('media/fonts', { recursive: true });
for (const [pkg, file] of jobs) await copyFile(`node_modules/@fontsource/${pkg}/files/${file}`, `media/fonts/${file}`);
console.log(`Đã sao chép ${jobs.length} tệp font vào media/fonts/`);
