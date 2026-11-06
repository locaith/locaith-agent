// Dựng Chợ kỹ năng đóng gói sẵn từ kho AI-Skills.
//   node scripts/build-market.mjs [--src "F:/Locaith-AI-Local-finetune/AI-Skills"]
// Kết quả: market/index.json, market/skills.zip (mỗi kỹ năng một thư mục <id>/…), market/licenses/<repo>/LICENSE, market/NOTICE.md.
//
// Bộ lọc (để phân phối công khai trên Marketplace):
//   • chỉ lấy kỹ năng có giấy phép cho phép phân phối lại (MIT, Apache-2.0, BSD, ISC, MPL-2.0, Unlicense, CC0);
//     giấy phép của chính kỹ năng (frontmatter) thắng; không có thì lấy giấy phép của repo;
//   • loại kỹ năng "proprietary / xem LICENSE.txt / (A)GPL / phi thương mại";
//   • loại ~830 wrapper tự sinh của Composio ("Automate X tasks via Rube MCP") — không phải kỹ năng thật;
//   • chỉ chép tệp văn bản ≤150 KB (SKILL.md, tài liệu, script nhỏ, LICENSE), tối đa 600 KB mỗi kỹ năng; bỏ ảnh/PDF/font/nhị phân.
import { zipSync, strToU8 } from 'fflate';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argSrc = args.indexOf('--src') >= 0 ? args[args.indexOf('--src') + 1] : undefined;
const SRC = path.resolve(argSrc ?? process.env.LOCAITH_SKILLS_SRC ?? 'F:/Locaith-AI-Local-finetune/AI-Skills');
const OUT = path.join(root, 'market');

const PERMISSIVE = /(^|[^a-z])(mit|apache|bsd|isc|mpl|unlicense|cc0|0bsd|zlib)([^a-z]|$)/i;
const RESTRICTED = /proprietary|all rights reserved|agpl|gpl|complete terms in|see license|non-?commercial|cc-by-nc|unlicensed/i;
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.toml', '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.sh', '.ps1', '.bat', '.html', '.css', '.csv', '.xml', '.sql', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.cs', '.php', '.ini', '.cfg', '.tex', '.rst', '.tf', '.dockerfile']);
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', 'dist', 'build', '.venv', 'venv', '.next', 'coverage', '.idea', '.vscode']);
const MAX_FILE = 150 * 1024;
const MAX_SKILL = 600 * 1024;
const GROUP = { 'official-anthropic': 'anthropic', 'official-vendors': 'vendor', community: 'community' };
const GROUP_RANK = { anthropic: 0, vendor: 1, community: 2 };

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') {
        if (src[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur.replace(/\r$/, '')); rows.push(row); }
  const head = rows.shift();
  return rows.filter((r) => r.length >= head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const repoLicCache = new Map();
function repoLicense(repoDir) {
  if (repoLicCache.has(repoDir)) return repoLicCache.get(repoDir);
  let label = 'unknown';
  let file = null;
  for (const n of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'COPYING', 'license', 'License.txt']) {
    const p = path.join(repoDir, n);
    if (existsSync(p) && statSync(p).isFile()) { file = p; break; }
  }
  if (file) {
    const t = readFileSync(file, 'utf8').slice(0, 6000);
    if (/GNU AFFERO/i.test(t)) label = 'AGPL-3.0';
    else if (/GNU GENERAL PUBLIC|GNU LESSER/i.test(t)) label = 'GPL';
    else if (/Apache License/i.test(t)) label = 'Apache-2.0';
    else if (/Mozilla Public License/i.test(t)) label = 'MPL-2.0';
    else if (/Permission is hereby granted, free of charge|MIT License/i.test(t)) label = 'MIT';
    else if (/BSD/i.test(t) && /Redistribution and use/i.test(t)) label = 'BSD';
    else if (/ISC License|Permission to use, copy, modify, and\/or distribute/i.test(t)) label = 'ISC';
    else if (/This is free and unencumbered software/i.test(t)) label = 'Unlicense';
  }
  const v = { label, file, ok: PERMISSIVE.test(label) };
  repoLicCache.set(repoDir, v);
  return v;
}

function collectFiles(skillDir) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        if (existsSync(path.join(abs, 'SKILL.md'))) continue; // kỹ năng lồng nhau: tự nó là một mục riêng
        walk(abs, r);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        const isLicense = /^(license|licence|copying|notice)(\.|$)/i.test(e.name);
        if (!isLicense && !TEXT_EXT.has(ext) && e.name !== 'Dockerfile') continue;
        const size = statSync(abs).size;
        if (size > MAX_FILE || size === 0) continue;
        out.push({ abs, rel: r, size, pri: r === 'SKILL.md' ? 0 : isLicense ? 1 : /\.md$/i.test(r) ? 2 : 3 });
      }
    }
  };
  walk(skillDir, '');
  out.sort((a, b) => a.pri - b.pri || a.size - b.size);
  const keep = [];
  let total = 0;
  for (const f of out) {
    if (f.pri > 0 && total + f.size > MAX_SKILL) continue;
    keep.push(f);
    total += f.size;
  }
  return { keep, total };
}

const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '').slice(0, 100);

// ── chạy ───────────────────────────────────────────────────────────────────────
const manifestPath = path.join(SRC, '_index', 'skills-manifest.csv');
if (!existsSync(manifestPath)) throw new Error(`Không thấy ${manifestPath}. Dùng --src <thư mục AI-Skills>.`);
const rows = parseCsv(readFileSync(manifestPath, 'utf8'));
console.log(`Manifest: ${rows.length} dòng từ ${SRC}`);

const stats = { total: rows.length, noDir: 0, composio: 0, restricted: 0, unlicensed: 0, noLicenseText: 0, dup: 0, ok: 0 };
const picked = [];
for (const r of rows) {
  const parts = r.DuongDan.split(/[\\/]/);
  const skillDir = path.join(SRC, ...parts.slice(0, -1));
  if (!existsSync(path.join(skillDir, 'SKILL.md'))) { stats.noDir++; continue; }
  const desc = String(r.MoTa ?? '').replace(/\s+/g, ' ').trim();
  if (r.Repo === 'awesome-claude-skills-composio' && /Rube MCP|\(Composio\)/i.test(desc)) { stats.composio++; continue; }
  const repoDir = path.join(SRC, parts[0], parts[1]);
  const repo = repoLicense(repoDir);
  const own = String(r.License ?? '').trim();
  let license;
  if (own && RESTRICTED.test(own)) { stats.restricted++; continue; }
  if (own && PERMISSIVE.test(own)) license = own.match(PERMISSIVE)[2].toUpperCase().replace('APACHE', 'Apache-2.0').replace('MPL', 'MPL-2.0');
  else if (repo.ok) license = repo.label;
  else { stats.unlicensed++; continue; }
  // MIT/Apache/BSD yêu cầu đi kèm văn bản giấy phép khi phân phối lại: không có tệp LICENSE (ở repo hoặc ở thư mục kỹ năng) thì không đóng gói.
  const hasLicenseText = !!repo.file || readdirSync(skillDir).some((n) => /^(license|licence|copying)(\.|$)/i.test(n));
  if (!hasLicenseText) { stats.noLicenseText++; continue; }
  const id = slug(r.Ten || parts[parts.length - 2]);
  if (!id) continue;
  picked.push({ id, name: id, description: desc.slice(0, 300), group: GROUP[parts[0]] ?? 'community', repo: r.Repo || parts[1], license, skillDir, repoDir });
}
picked.sort((a, b) => GROUP_RANK[a.group] - GROUP_RANK[b.group] || a.repo.localeCompare(b.repo) || a.id.localeCompare(b.id));
const seen = new Set();
const finalList = [];
for (const p of picked) {
  if (seen.has(p.id)) { stats.dup++; continue; }
  seen.add(p.id);
  finalList.push(p);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const zipEntries = {};
const index = [];
const reposUsed = new Map();
for (const p of finalList) {
  const { keep, total } = collectFiles(p.skillDir);
  if (!keep.some((f) => f.rel === 'SKILL.md')) continue;
  for (const f of keep) zipEntries[`${p.id}/${f.rel}`] = [new Uint8Array(readFileSync(f.abs)), { level: 9, mtime: new Date('2026-01-01T00:00:00Z') }];
  index.push({ id: p.id, name: p.name, description: p.description, group: p.group, repo: p.repo, license: p.license, files: keep.length, bytes: total });
  const u = reposUsed.get(p.repo) ?? { count: 0, license: p.license, file: repoLicense(p.repoDir).file };
  u.count++;
  reposUsed.set(p.repo, u);
  stats.ok++;
}
writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index));
writeFileSync(path.join(OUT, 'skills.zip'), zipSync(zipEntries, { level: 9 }));

const notice = ['# Kỹ năng trong Chợ — nguồn và giấy phép', '', 'Các kỹ năng đóng gói sẵn được tổng hợp từ các kho mã nguồn mở dưới đây. Mỗi kỹ năng giữ nguyên giấy phép của nơi nó đến;', 'bản sao giấy phép của từng kho nằm ở `market/licenses/<kho>/`, và tệp LICENSE/NOTICE riêng của kỹ năng (nếu có) nằm cùng thư mục kỹ năng.', '', '| Kho | Giấy phép | Số kỹ năng |', '| --- | --- | ---: |'];
for (const [repo, u] of [...reposUsed].sort((a, b) => a[0].localeCompare(b[0]))) {
  notice.push(`| ${repo} | ${u.license} | ${u.count} |`);
  if (u.file) {
    const dir = path.join(OUT, 'licenses', repo);
    mkdirSync(dir, { recursive: true });
    copyFileSync(u.file, path.join(dir, 'LICENSE'));
  }
}
writeFileSync(path.join(OUT, 'NOTICE.md'), `${notice.join('\n')}\n`);

const zipSize = statSync(path.join(OUT, 'skills.zip')).size;
console.log(JSON.stringify({ ...stats, packaged: index.length, zipMB: +(zipSize / 1048576).toFixed(2), indexKB: +(statSync(path.join(OUT, 'index.json')).size / 1024).toFixed(0), repos: reposUsed.size }, null, 2));
