// Sinh THIRD_PARTY_NOTICES từ các gói npm THỰC SỰ nằm trong gói cài đặt: đọc source map của bản build thường + các gói phông chữ @fontsource mà giao diện nhúng.
// Mã thoát 2 nếu gặp giấy phép copyleft/không rõ; mã thoát 3 nếu `--check` thấy tệp đã commit lệch với gói thực.
//
//   VS Code (mặc định):  `npm run build`  rồi  `npm run notices`           → THIRD_PARTY_NOTICES.md
//   Chrome / Edge:       `npm run notices:browser`                           → THIRD_PARTY_NOTICES.browser.md
//                        (dựng bản dev ra dist-browser-notices/ để có source map, rồi sinh; esbuild.browser.mjs chép tệp này vào gói thành THIRD_PARTY_NOTICES.md)
//   `--check`            không ghi, chỉ so tệp đã commit với gói thực (test/browser/notices.test.ts dùng để tệp không tự lỗi thời khi thêm thư viện)
//   `--maps=<thư mục>`   (chỉ với --browser) thư mục bản dev chứa *.map, mặc định dist-browser-notices/
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const browser = argv.includes('--browser');
const check = argv.includes('--check');
const mapsArg = argv.find((a) => a.startsWith('--maps='))?.slice('--maps='.length);
const mapsDir = mapsArg ? path.resolve(mapsArg) : path.join(root, 'dist-browser-notices');
const target = path.join(root, browser ? 'THIRD_PARTY_NOTICES.browser.md' : 'THIRD_PARTY_NOTICES.md');

const MAPS = browser
  ? (existsSync(mapsDir) ? readdirSync(mapsDir).filter((f) => f.endsWith('.map')).sort() : []).map((f) => path.join(mapsDir, f))
  : ['dist/extension.js.map', 'dist/webview/main.js.map', 'dist/webview/main.css.map'].map((m) => path.join(root, m));
const FONT_FILE = /^(.*?)-(?:latin|vietnamese|cyrillic|greek)/;
const dirs = new Set();
let maps = 0;
let usesBrandLogos = !browser; // bản VS Code luôn có logo thương hiệu của Chợ; bản trình duyệt chỉ khi mã logo thật sự nằm trong gói
for (const f of MAPS) {
  if (!existsSync(f)) continue;
  maps++;
  for (const s of JSON.parse(readFileSync(f, 'utf8')).sources ?? []) {
    const p = String(s).replace(/\\/g, '/');
    if (/(^|\/)webview\/src\/brand\/logos\.ts$/.test(p)) usesBrandLogos = true;
    const i = p.indexOf('node_modules/');
    if (i < 0) continue;
    const segs = p.slice(i).split('/');
    let dir = '';
    for (let k = 0; k < segs.length; k++) {
      if (segs[k] !== 'node_modules') continue;
      const n = segs[k + 1]?.startsWith('@') ? `${segs[k + 1]}/${segs[k + 2]}` : segs[k + 1];
      if (n) dir = `${segs.slice(0, k + 1).join('/')}/${n}`;
    }
    if (dir) dirs.add(dir);
  }
}
// Phông chữ là TỆP (woff2) đi theo CSS/thư mục phông, không có trong source map của mã: lấy từ chính tên tệp nằm trong gói.
const fonts = new Set();
if (browser) {
  for (const sub of ['assets', 'fonts']) {
    const d = path.join(mapsDir, sub);
    if (existsSync(d)) for (const f of readdirSync(d)) { const m = FONT_FILE.exec(f); if (m) fonts.add(m[1]); }
  }
} else {
  const css = path.join(root, 'webview/src/styles/fonts.css');
  if (existsSync(css)) for (const m of readFileSync(css, 'utf8').matchAll(/@fontsource\/([a-z0-9-]+)\//g)) fonts.add(m[1]);
  const mf = path.join(root, 'media/fonts');
  if (existsSync(mf)) for (const f of readdirSync(mf)) { const m = FONT_FILE.exec(f); if (m) fonts.add(m[1]); }
}
for (const p of fonts) {
  if (existsSync(path.join(root, 'node_modules/@fontsource', p))) dirs.add(`node_modules/@fontsource/${p}`);
  else if (browser) { console.error(`CẦN XEM LẠI: gói có phông «${p}» nhưng không có node_modules/@fontsource/${p} để ghi nhận bản quyền`); process.exit(2); }
}
if (maps === 0 || dirs.size === 0) {
  console.error(browser ? 'Không có source map/gói nào — chạy `node esbuild.browser.mjs --out=dist-browser-notices` trước (hoặc dùng `npm run notices:browser`).' : 'Không có source map/gói nào — chạy `npm run build` trước.');
  process.exit(1);
}

const LIC = /^(licen[cs]e|copying|notice|unlicense)([-_. ].*)?$/i;
const pkgs = new Map();
for (const d of [...dirs].sort()) {
  const pj = path.join(root, d, 'package.json');
  if (!existsSync(pj)) continue;
  const j = JSON.parse(readFileSync(pj, 'utf8'));
  let lic = j.license ?? j.licenses ?? '';
  if (Array.isArray(lic)) lic = lic.map((l) => (typeof l === 'string' ? l : l.type)).join(' OR ');
  else if (lic && typeof lic === 'object') lic = lic.type ?? '';
  const texts = readdirSync(path.join(root, d))
    .filter((f) => LIC.test(f) && !/\.(js|ts|json|map)$/i.test(f) && statSync(path.join(root, d, f)).isFile())
    .sort()
    .map((f) => readFileSync(path.join(root, d, f), 'utf8').replace(/\r\n/g, '\n').trim().slice(0, 80000))
    .filter(Boolean);
  const repo = String(typeof j.repository === 'string' ? j.repository : j.repository?.url ?? j.homepage ?? '').replace(/^git\+/, '').replace(/\.git$/, '');
  const author = String(typeof j.author === 'string' ? j.author : (j.author?.name ?? '')).replace(/\s*<[^>]*>/, '').trim();
  pkgs.set(`${j.name}@${j.version}`, { name: j.name, version: j.version, license: String(lic || 'UNKNOWN'), repo, author, texts });
}
// Thành phần nhúng BÊN TRONG một gói khác (không có thư mục riêng): ghi nhận để đủ thông báo bản quyền. Văn bản giấy phép lấy từ một gói cùng giấy phép đã có.
const EMBEDDED = [{ inside: 'unpdf', textFrom: '@opentelemetry/api', name: 'pdf.js (Mozilla Foundation and contributors; bundled inside unpdf as dist/pdfjs.mjs)', version: 'bundled', license: 'Apache-2.0', repo: 'https://github.com/mozilla/pdf.js' }];
for (const e of EMBEDDED) {
  const host = [...pkgs.values()].some((p) => p.name === e.inside);
  const from = [...pkgs.values()].find((p) => p.name === e.textFrom && p.license === e.license);
  if (host && from) pkgs.set(`${e.name}@${e.version}`, { name: e.name, version: e.version, license: e.license, repo: e.repo, texts: from.texts });
  else if (host) console.error(`CẦN XEM LẠI: không có văn bản giấy phép ${e.license} để ghi nhận ${e.name}`);
}
// So sánh theo ngôn ngữ cố định để thứ tự không đổi giữa các máy (test --check so từng byte).
const list = [...pkgs.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
const groups = new Map();
for (const p of list) {
  const key = createHash('sha1').update(p.texts.join('\n=====\n')).digest('hex');
  const g = groups.get(key) ?? { text: p.texts.join('\n\n-----\n\n'), names: [], pkgs: [] };
  g.names.push(`${p.name}@${p.version}`);
  g.pkgs.push(p);
  groups.set(key, g);
}
// Gói không kèm tệp giấy phép: ghi đúng những gì chính gói tuyên bố (giấy phép, tác giả, nguồn) — không tự bịa dòng bản quyền.
const noFile = (p) => `_No license file ships with ${p.name}@${p.version}._ Its package.json declares the license **${p.license}**${p.author ? `, author "${p.author}"` : ''}${p.repo ? `, upstream ${p.repo}` : ''}. This notice therefore repeats only what the package itself states.`;
const out = [
  '# Third-party notices',
  '',
  browser
    ? `Locaith AI Agent for Chrome and Edge bundles the third-party software listed below (${list.length} packages, found in the files actually built into this extension package). Each component remains under its own license; the full texts follow the table.`
    : `Locaith AI Agent bundles the third-party software listed below (${list.length} packages, found in the files actually built into the extension). Each component remains under its own license; the full texts follow the table.`,
  browser
    ? "Generated by `scripts/gen-notices.mjs --browser`. The extension's own license is in `LICENSE.txt` in this package."
    : 'Generated by `scripts/gen-notices.mjs`. The skills bundled in the Market are covered separately by `market/NOTICE.md` and `market/licenses/`.',
  '',
  '| Package | Version | License | Source |',
  '| --- | --- | --- | --- |',
  ...list.map((p) => `| ${p.name} | ${p.version} | ${p.license.replace(/\|/g, '/')} | ${p.repo} |`),
  '',
  '## License texts',
  '',
];
for (const g of groups.values()) out.push(`### ${g.names.join(', ')}`, '', g.text ? `\`\`\`text\n${g.text}\n\`\`\`` : g.pkgs.map(noFile).join('\n\n'), '');
// Logo thương hiệu trong Chợ là DỮ LIỆU nhúng (webview/src/brand/logos.ts), không phải gói npm nên không có trong source map: ghi nhận riêng.
if (usesBrandLogos) {
  const brand = path.join(root, 'docs', 'BRAND-ASSETS.md');
  const mit = existsSync(brand) ? /```\n(MIT License[\s\S]*?)\n```/.exec(readFileSync(brand, 'utf8'))?.[1] : undefined;
  if (!mit) { console.error('CẦN XEM LẠI: không tìm thấy văn bản MIT của Lobe Icons trong docs/BRAND-ASSETS.md'); process.exit(2); }
  out.push(
    browser ? '## Brand logos (vector data bundled in the side panel)' : '## Brand logos (vector data bundled in the Market)',
    '',
    browser
      ? 'The logos shown next to services and providers in the side panel are trademarks of their respective owners and are shown only to identify compatible services; their display does not imply endorsement or affiliation. Their vector data comes from:'
      : 'The logos shown next to services, plugins and skill sources in the Market are trademarks of their respective owners and are shown only to identify compatible services; their display does not imply endorsement or affiliation. Their vector data comes from:',
    '',
    '- **Simple Icons** (https://github.com/simple-icons/simple-icons), version 16.36.0 — CC0-1.0 (public-domain dedication, credited here).',
    '- **Lobe Icons** (https://github.com/lobehub/lobe-icons), version 1.102.0 — MIT License:',
    '',
    '```text',
    mit,
    '```',
    '',
    browser ? 'Complete list, sources and modifications: `docs/BRAND-ASSETS.md` in the source repository (github.com/locaith/locaith-agent).' : 'Complete list, sources and modifications: `docs/BRAND-ASSETS.md`.',
    '',
  );
}
const text = `${out.join('\n')}\n`;
if (check) {
  const have = existsSync(target) ? readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : undefined;
  if (have !== text) {
    console.error(`${path.basename(target)} ${have === undefined ? 'chưa có' : 'LỆCH với các thư viện thực sự nằm trong gói'} — chạy lại \`${browser ? 'npm run notices:browser' : 'npm run notices'}\` rồi commit tệp được sinh ra.`);
    process.exit(3);
  }
  console.log(`${path.basename(target)} khớp với gói thực (${list.length} gói).`);
} else {
  writeFileSync(target, text);
}

const byLic = {};
for (const p of list) byLic[p.license] = (byLic[p.license] ?? 0) + 1;
console.log(`${list.length} gói (${maps} source map) →`, JSON.stringify(byLic));
console.log(list.map((p) => `${p.name}@${p.version}`).join(', '));
const noText = list.filter((p) => p.texts.length === 0).map((p) => p.name);
if (noText.length) console.log('Không có tệp giấy phép:', noText.join(', '));
const bad = list.filter((p) => /\b(A?GPL|LGPL|SSPL|BUSL|CC-BY-NC|UNLICENSED|UNKNOWN)/i.test(p.license) || /SEE LICENSE/i.test(p.license));
if (bad.length) { console.error('CẦN XEM LẠI:', bad.map((p) => `${p.name} (${p.license})`).join(', ')); process.exit(2); }
