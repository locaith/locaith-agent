/**
 * Chợ plugin kiểu Claude Code: đọc một `marketplace.json` (mặc định: marketplace chính thức của Anthropic, hơn 300 plugin) và CÀI THẬT từng plugin
 * vào `~/.locaith/plugins/<tên>`. Không cần git: tải zip từ codeload.github.com rồi giải nén đúng thư mục con cần thiết.
 * Plugin mới cài mặc định TẮT; kỹ năng/agent/lệnh/MCP của nó chỉ có hiệu lực khi người dùng bật (và server MCP của plugin còn phải được duyệt riêng).
 * Locaith dùng được: skills, agents, commands, MCP. KHÔNG chạy: hooks, LSP, output styles — kết quả cài đặt nói rõ điều này.
 */

import { unzipSync } from 'fflate';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { loadPlugin, type PluginInfo } from './loader';

export const OFFICIAL_MARKETPLACE = { owner: 'anthropics', repo: 'claude-plugins-official', ref: 'main' } as const;
export const MARKER = '.locaith-plugin.json';

/** Độ tin cậy của một nguồn chợ: `official` = Anthropic; `vendor` = hãng làm ra sản phẩm (Microsoft, AWS…); `community` = cộng đồng, CHƯA ai kiểm định. */
export type MarketTrust = 'official' | 'vendor' | 'community';

export interface MarketplaceSource {
  /** Mã ngắn, ổn định (dùng làm hậu tố khi trùng tên plugin giữa các nguồn). */
  id: string;
  owner: string;
  repo: string;
  ref: string;
  /** Tên hiển thị trên bộ lọc nguồn. */
  label: string;
  trust: MarketTrust;
}

/**
 * (0.7.7) Các nguồn chợ plugin, theo thứ tự ưu tiên khi trùng tên (nguồn đứng trước giữ tên gốc, nguồn sau thêm hậu tố `-<id nguồn>`).
 * Mỗi nguồn đã được kiểm 10/11/2026: có `.claude-plugin/marketplace.json`, đọc được bằng `parseMarketplace` (0 mục bị bỏ), kho còn cập nhật, giấy phép cho phép người dùng tự cài.
 * Chỉ TẢI KHI NGƯỜI DÙNG BẤM CÀI (không đóng gói lại). Nguồn cộng đồng có nhãn riêng; plugin cài về luôn TẮT cho tới khi bật.
 * `anthropics/skills` và `coreyhaines31/marketingskills` dùng `source: "./"` (cả gốc kho là plugin; xem `PluginSource` kind `repo-root`).
 */
export const MARKETPLACES: readonly MarketplaceSource[] = [
  { id: 'claude-plugins-official', ...OFFICIAL_MARKETPLACE, label: 'Anthropic · chính thức', trust: 'official' },
  { id: 'knowledge-work-plugins', owner: 'anthropics', repo: 'knowledge-work-plugins', ref: 'main', label: 'Anthropic · công việc tri thức', trust: 'official' },
  { id: 'financial-services-plugins', owner: 'anthropics', repo: 'financial-services-plugins', ref: 'main', label: 'Anthropic · tài chính', trust: 'official' },
  { id: 'claude-code', owner: 'anthropics', repo: 'claude-code', ref: 'main', label: 'Anthropic · Claude Code', trust: 'official' },
  { id: 'anthropic-skills', owner: 'anthropics', repo: 'skills', ref: 'main', label: 'Anthropic · kỹ năng mẫu (Word, Excel, PDF…)', trust: 'official' },
  { id: 'microsoft-skills', owner: 'microsoft', repo: 'skills', ref: 'main', label: 'Microsoft', trust: 'vendor' },
  { id: 'azure-skills', owner: 'microsoft', repo: 'azure-skills', ref: 'main', label: 'Microsoft · Azure', trust: 'vendor' },
  { id: 'aws-agent-plugins', owner: 'awslabs', repo: 'agent-plugins', ref: 'main', label: 'AWS Labs', trust: 'vendor' },
  { id: 'superpowers', owner: 'obra', repo: 'superpowers-marketplace', ref: 'main', label: 'Superpowers (cộng đồng)', trust: 'community' },
  { id: 'wshobson-agents', owner: 'wshobson', repo: 'agents', ref: 'main', label: 'wshobson/agents (cộng đồng)', trust: 'community' },
  { id: 'marketing-skills', owner: 'coreyhaines31', repo: 'marketingskills', ref: 'main', label: 'Marketing skills (cộng đồng)', trust: 'community' },
];

const MAX_ZIP_BYTES = 120 * 1024 * 1024;
const MAX_FILES = 8000;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

export type PluginSource =
  | { kind: 'repo-path'; path: string }
  /** (0.7.7) `source: "./"` — chính gốc kho của chợ là plugin; `skills` (nếu có) là các thư mục kỹ năng cần lấy (kho `anthropics/skills`), thiếu = lấy phần plugin ở gốc kho (skills/, agents/, commands/, .mcp.json…). */
  | { kind: 'repo-root'; skills?: string[] }
  | { kind: 'github'; owner: string; repo: string; ref?: string; subdir?: string }
  | { kind: 'other'; url: string };

export interface MarketplaceEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  source: PluginSource;
  homepage?: string;
  /** (0.7.7) Nguồn chợ chứa plugin này (`MarketplaceSource.id`); thiếu = chợ chính thức. Cần để biết tải `repo-path` từ kho nào. */
  market?: string;
}

export interface ParsedMarketplace {
  name: string;
  entries: MarketplaceEntry[];
  skipped: number;
}

const safeName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

/** `https://github.com/o/r(.git)` hoặc `o/r` → { owner, repo }; không phải GitHub → null. */
export function githubRepo(u: string): { owner: string; repo: string } | null {
  const m = /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(u.trim());
  return m && !/^https?:\/\/(?!(?:www\.)?github\.com)/.test(u) ? { owner: m[1], repo: m[2] } : null;
}

const cleanRel = (p: unknown): string | undefined => {
  if (typeof p !== 'string') return undefined;
  const n = path.posix.normalize(p.replace(/\\/g, '/').replace(/^\.\//, '')).replace(/^\/+|\/+$/g, '');
  return n && n !== '.' && !n.startsWith('..') && !n.includes('/../') ? n : undefined;
};

export function parseSource(raw: unknown): PluginSource | null {
  if (typeof raw === 'string') {
    const p = cleanRel(raw);
    return p ? { kind: 'repo-path', path: p } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const ref = typeof s.sha === 'string' && /^[0-9a-f]{7,40}$/i.test(s.sha) ? s.sha : typeof s.ref === 'string' && /^[\w./-]{1,100}$/.test(s.ref) ? s.ref : undefined;
  const kind = s.source;
  if (kind === 'github' && typeof s.repo === 'string') {
    const r = githubRepo(s.repo);
    return r ? { kind: 'github', ...r, ref, subdir: cleanRel(s.path) } : null;
  }
  if ((kind === 'url' || kind === 'git-subdir') && typeof s.url === 'string') {
    const r = githubRepo(s.url);
    return r ? { kind: 'github', ...r, ref, subdir: kind === 'git-subdir' ? cleanRel(s.path) : undefined } : { kind: 'other', url: s.url };
  }
  return null;
}

export function parseMarketplace(json: unknown): ParsedMarketplace {
  const j = json as { name?: unknown; plugins?: unknown };
  const out: MarketplaceEntry[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const p of Array.isArray(j?.plugins) ? (j.plugins as Record<string, unknown>[]) : []) {
    const name = typeof p?.name === 'string' ? safeName(p.name) : '';
    const source = parseSource(p?.source) ?? parseRootSource(p);
    if (!name || !source || seen.has(name)) {
      skipped++;
      continue;
    }
    seen.add(name);
    out.push({
      id: name,
      name,
      description: typeof p.description === 'string' ? p.description.slice(0, 400) : '',
      category: typeof p.category === 'string' && p.category ? p.category.slice(0, 30) : 'other',
      source,
      ...(typeof p.homepage === 'string' && /^https:\/\//.test(p.homepage) ? { homepage: p.homepage } : {}),
    });
  }
  return { name: typeof j?.name === 'string' ? j.name : 'marketplace', entries: out, skipped };
}

/** `source: "./"` (hoặc ".") → cả gốc kho là plugin; mảng `skills` (đường dẫn thư mục kỹ năng) được làm sạch, đường dẫn thoát bị bỏ. */
function parseRootSource(p: Record<string, unknown> | undefined): PluginSource | null {
  const s = p?.source;
  if (typeof s !== 'string' || !/^\.\/?$/.test(s.trim())) return null;
  const skills = Array.isArray(p?.skills) ? p.skills.map(cleanRel).filter((x): x is string => !!x) : [];
  return skills.length > 0 ? { kind: 'repo-root', skills: [...new Set(skills)] } : { kind: 'repo-root' };
}

export type FetchLike = typeof fetch;
const zipCache = new Map<string, Uint8Array>();

/** Tải zip một repo GitHub (giới hạn kích thước; có bộ nhớ đệm trong phiên để cài nhiều plugin cùng repo không tải lại). */
export async function downloadZip(owner: string, repo: string, ref: string | undefined, f: FetchLike = fetch, base = 'https://codeload.github.com'): Promise<Uint8Array> {
  const url = `${base}/${owner}/${repo}/zip/${ref ?? 'HEAD'}`;
  const hit = zipCache.get(url);
  if (hit) return hit;
  const r = await f(url, { signal: AbortSignal.timeout(180_000) });
  if (!r.ok) throw new Error(`Không tải được ${owner}/${repo} (HTTP ${r.status}).`);
  const len = Number(r.headers.get('content-length') ?? 0);
  if (len > MAX_ZIP_BYTES) throw new Error(`Kho ${owner}/${repo} quá lớn (${Math.round(len / 1048576)} MB).`);
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.length > MAX_ZIP_BYTES) throw new Error(`Kho ${owner}/${repo} quá lớn.`);
  if (zipCache.size >= 2) zipCache.clear();
  zipCache.set(url, buf);
  return buf;
}

export const clearZipCache = (): void => zipCache.clear();

/**
 * Giải nén chỉ phần `subdir` (bỏ thư mục gốc `<repo>-<ref>/` của zip GitHub) vào `dest`. Chặn `..`, giới hạn số tệp/dung lượng.
 * `keep` (tuỳ chọn) lọc theo đường dẫn TƯƠNG ĐỐI so với `subdir` — dùng khi plugin là cả gốc kho và chỉ cần vài thư mục (xem `ROOT_PLUGIN_PART`).
 */
export async function extractSubdir(zip: Uint8Array, subdir: string | undefined, dest: string, keep?: (rel: string) => boolean): Promise<number> {
  const prefix = subdir ? `${subdir}/` : '';
  const strip = (name: string): string => name.split('/').slice(1).join('/');
  const files = unzipSync(zip, { filter: (f) => !f.name.endsWith('/') && strip(f.name).startsWith(prefix) && !/(^|\/)\.git(\/|$)/.test(strip(f.name)) && (!keep || keep(strip(f.name).slice(prefix.length))) });
  const names = Object.keys(files);
  if (names.length === 0) throw new Error(subdir ? `Không thấy thư mục "${subdir}" trong kho.` : 'Kho rỗng.');
  if (names.length > MAX_FILES) throw new Error(`Plugin có quá nhiều tệp (${names.length}).`);
  let total = 0;
  let written = 0;
  const root = path.resolve(dest);
  for (const n of names) {
    const rel = strip(n).slice(prefix.length);
    const abs = path.resolve(root, rel);
    if (!rel || path.isAbsolute(rel) || (abs !== root && !abs.startsWith(root + path.sep))) continue; // chặn zip-slip
    total += files[n].length;
    if (total > MAX_TOTAL_BYTES) throw new Error('Plugin quá lớn.');
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, files[n]);
    written++;
  }
  if (written === 0) throw new Error('Không có tệp hợp lệ nào để giải nén.');
  return written;
}

/** Khi plugin là CẢ GỐC kho (không có danh sách kỹ năng): chỉ chép các phần plugin — không kéo theo mã nguồn, thử nghiệm, ảnh… của kho. */
const ROOT_PLUGIN_PART = (rel: string): boolean => /^(skills|agents|commands|\.claude-plugin|hooks)\//.test(rel) || /^(\.mcp\.json|plugin\.json|LICENSE[^/]*|NOTICE[^/]*)$/i.test(rel);

/** Những phần plugin khai báo nhưng Locaith không chạy. */
export async function unsupportedParts(dir: string): Promise<string[]> {
  const out: string[] = [];
  const has = (p: string) => stat(path.join(dir, p)).then(() => true, () => false);
  if (await has('hooks')) out.push('hooks');
  for (const m of ['plugin.json', '.claude-plugin/plugin.json']) {
    try {
      const j = JSON.parse((await readFile(path.join(dir, m), 'utf8')).replace(/^﻿/, ''));
      if (j.hooks && !out.includes('hooks')) out.push('hooks');
      if (j.lspServers) out.push('LSP');
      if (j.outputStyles) out.push('output styles');
    } catch {
      /* không có manifest này */
    }
  }
  if (await has('.lsp.json')) out.push('LSP');
  return [...new Set(out)];
}

export interface InstallOutcome {
  ok: boolean;
  message: string;
  plugin?: PluginInfo;
  unsupported?: string[];
}

export interface InstallContext {
  /** `~/.locaith/plugins` */
  userRoot: string;
  fetchImpl?: FetchLike;
  codeloadBase?: string;
  marketplace?: { owner: string; repo: string; ref: string };
}

export async function installPlugin(e: MarketplaceEntry, c: InstallContext): Promise<InstallOutcome> {
  const mk = c.marketplace ?? OFFICIAL_MARKETPLACE;
  if (e.source.kind === 'other') return { ok: false, message: `Plugin "${e.name}" nằm ngoài GitHub (${new URL(e.source.url).host}). Dùng "Cài từ Git…" nếu bạn tin tưởng nguồn này.` };
  const dest = path.join(c.userRoot, e.id);
  try {
    const m = JSON.parse(await readFile(path.join(dest, MARKER), 'utf8')) as { name?: string };
    if (m.name !== e.id) throw new Error('khác');
  } catch (err) {
    if (await stat(dest).then(() => true, () => false)) return { ok: false, message: `Đã có thư mục "${e.id}" trong ${c.userRoot} không do chợ cài. Đổi tên hoặc xoá nó trước.` };
  }
  const { owner, repo, ref, subdir } =
    e.source.kind === 'repo-path' ? { owner: mk.owner, repo: mk.repo, ref: mk.ref, subdir: e.source.path } : e.source.kind === 'repo-root' ? { owner: mk.owner, repo: mk.repo, ref: mk.ref, subdir: undefined } : e.source;
  const stage = `${dest}.tmp-${process.pid}`;
  try {
    const zip = await downloadZip(owner, repo, ref, c.fetchImpl, c.codeloadBase);
    await rm(stage, { recursive: true, force: true });
    await mkdir(stage, { recursive: true });
    let n: number;
    if (e.source.kind === 'repo-root' && e.source.skills?.length) {
      // Chợ liệt kê đúng những thư mục kỹ năng cần lấy (anthropics/skills): mỗi thư mục thành skills/<tên>/ của plugin.
      n = 0;
      for (const dir of e.source.skills) n += await extractSubdir(zip, dir, path.join(stage, 'skills', path.posix.basename(dir)));
    } else n = await extractSubdir(zip, subdir, stage, e.source.kind === 'repo-root' ? ROOT_PLUGIN_PART : undefined);
    const plugin = await loadPlugin(stage);
    if (!plugin) throw new Error('Thư mục tải về không có kỹ năng, agent, lệnh hay MCP nào để Locaith dùng.');
    const unsupported = await unsupportedParts(stage);
    await writeFile(path.join(stage, MARKER), JSON.stringify({ name: e.id, source: `${owner}/${repo}${subdir ? `/${subdir}` : ''}${e.source.kind === 'repo-root' && e.source.skills?.length ? ` (${e.source.skills.length} kỹ năng)` : ''}`, ref: ref ?? 'HEAD', installedAt: Date.now() }, null, 2));
    await rm(dest, { recursive: true, force: true });
    await mkdir(c.userRoot, { recursive: true });
    await rename(stage, dest);
    const installed = (await loadPlugin(dest)) ?? plugin;
    return { ok: true, message: `Đã cài "${e.name}" (${n} tệp). Plugin đang TẮT — bật nó trong danh sách để dùng.${unsupported.length ? ` Lưu ý: Locaith không chạy ${unsupported.join(', ')}.` : ''}`, plugin: installed, unsupported };
  } catch (err) {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Gỡ plugin do chợ cài (có tệp đánh dấu); không bao giờ xoá thư mục của người dùng. */
export async function uninstallPlugin(id: string, userRoot: string): Promise<{ ok: boolean; message: string }> {
  const name = safeName(id);
  const dir = path.join(userRoot, name);
  try {
    const m = JSON.parse(await readFile(path.join(dir, MARKER), 'utf8')) as { name?: string };
    if (m.name !== name) throw new Error('khác');
  } catch {
    return { ok: false, message: 'Plugin này không do chợ cài nên không gỡ tại đây (xoá thủ công thư mục của nó nếu muốn).' };
  }
  await rm(dir, { recursive: true, force: true });
  return { ok: true, message: `Đã gỡ plugin "${name}".` };
}

export async function installedByMarket(userRoot: string): Promise<Set<string>> {
  const out = new Set<string>();
  let names: string[] = [];
  try {
    names = await readdir(userRoot);
  } catch {
    return out;
  }
  for (const n of names) {
    try {
      const m = JSON.parse(await readFile(path.join(userRoot, n, MARKER), 'utf8')) as { name?: string };
      if (m.name === n) out.add(n);
    } catch {
      /* không phải thư mục của chợ */
    }
  }
  return out;
}

export async function fetchMarketplace(f: FetchLike = fetch, base = 'https://raw.githubusercontent.com', mk: { owner: string; repo: string; ref: string } = OFFICIAL_MARKETPLACE): Promise<ParsedMarketplace> {
  const r = await f(`${base}/${mk.owner}/${mk.repo}/${mk.ref}/.claude-plugin/marketplace.json`, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`Không tải được danh sách plugin (HTTP ${r.status}).`);
  const p = parseMarketplace(JSON.parse(await r.text()));
  if (p.entries.length === 0) throw new Error('Danh sách plugin rỗng hoặc sai định dạng.');
  return p;
}

/** Kết quả đã gộp của nhiều nguồn chợ. */
export interface MergedMarketplace {
  /** Mọi plugin, đã gắn `market`; `id` duy nhất toàn cục (trùng tên → nguồn sau thêm hậu tố `-<id nguồn>`). */
  entries: MarketplaceEntry[];
  /** Từng nguồn: bao nhiêu plugin (0 nếu lỗi) và lỗi nếu có. */
  sources: Array<{ source: MarketplaceSource; count: number; error?: string }>;
}

/**
 * Gộp danh sách của nhiều nguồn chợ theo thứ tự ưu tiên (thuần: nhận kết quả đã tải). Plugin trùng tên với nguồn đứng trước được đổi id thành `<tên>-<id nguồn>` để cả hai cùng cài được
 * (thư mục cài mang tên id). Nguồn lỗi chỉ làm nguồn đó biến mất — các nguồn khác vẫn dùng được.
 */
export function mergeMarketplaces(parts: ReadonlyArray<{ source: MarketplaceSource; parsed?: ParsedMarketplace; error?: string }>): MergedMarketplace {
  const entries: MarketplaceEntry[] = [];
  const taken = new Set<string>();
  const firstSeenIn = new Map<string, string>();
  const sources: MergedMarketplace['sources'] = [];
  for (const { source, parsed, error } of parts) {
    if (!parsed) {
      sources.push({ source, count: 0, error: error ?? 'không rõ lỗi' });
      continue;
    }
    let count = 0;
    for (const e of parsed.entries) {
      // Cùng MỘT plugin (cùng kho + thư mục con) được NHIỀU chợ cùng liệt kê (105/120 mục trùng tên giữa chợ chính thức và knowledge-work-plugins là như vậy): chỉ giữ ở nguồn đứng trước.
      // Trong cùng một chợ thì giữ nguyên danh sách như chủ chợ viết (vài tên khác nhau trỏ cùng một kho là chủ ý của họ).
      const origin = originKey(source, e.source);
      const first = firstSeenIn.get(origin);
      if (first !== undefined && first !== source.id) continue;
      firstSeenIn.set(origin, source.id);
      let id = e.id;
      if (taken.has(id)) id = safeName(`${e.id}-${source.id}`); // cùng tên nhưng là plugin KHÁC
      if (taken.has(id)) continue; // vẫn trùng (hiếm): bỏ
      taken.add(id);
      entries.push({ ...e, id, market: source.id });
      count++;
    }
    sources.push({ source, count });
  }
  return { entries, sources };
}

/** Định danh «plugin này nằm ở đâu»: kho + thư mục con (không tính ref), chữ thường. */
function originKey(source: MarketplaceSource, s: PluginSource): string {
  const k = s.kind === 'repo-path' ? `${source.owner}/${source.repo}/${s.path}` : s.kind === 'repo-root' ? `${source.owner}/${source.repo}/@root:${[...(s.skills ?? [])].sort().join(',')}` : s.kind === 'github' ? `${s.owner}/${s.repo}/${s.subdir ?? ''}` : s.url;
  return k.toLowerCase().replace(/\/+$/, '');
}

/** Tải song song mọi nguồn chợ (mỗi nguồn tối đa 30 giây); một nguồn lỗi không làm hỏng các nguồn khác. */
export async function fetchAllMarketplaces(f: FetchLike = fetch, base = 'https://raw.githubusercontent.com', list: readonly MarketplaceSource[] = MARKETPLACES): Promise<MergedMarketplace> {
  const parts = await Promise.all(
    list.map(async (source) => {
      try {
        return { source, parsed: await fetchMarketplace(f, base, source) };
      } catch (err) {
        return { source, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
  return mergeMarketplaces(parts);
}
