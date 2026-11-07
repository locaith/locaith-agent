/**
 * (lane:perm-rules) Luật quyền bền theo mẫu — phần THUẦN (không `vscode`, không `node:*`), dùng chung engine, webview và bản trình duyệt.
 *
 * Cú pháp một luật: `tên_công_cụ(đặc tả)` hoặc `tên_công_cụ` trần (mọi lần gọi công cụ đó).
 *   run_command(npm test:*)        tiền tố lệnh: khớp `npm test` và `npm test -- --watch`, KHÔNG khớp `npm tests`
 *   run_command(git diff*)         mẫu `*` (khớp mọi ký tự)
 *   run_command(pwd)               đúng nguyên văn
 *   edit_file(src/**)              đường dẫn TRONG workspace theo glob (`**` nhiều cấp, `*` một cấp, `?` một ký tự)
 *   read_file(.env*)               mẫu không có `/` khớp theo TÊN TỆP ở mọi cấp (như .gitignore)
 *   fetch_url(domain:github.com)   tên miền đúng; `domain:*.github.com` cho tên miền con
 *   mcp__github__*                 tên công cụ cũng nhận `*`
 *
 * Ưu tiên: deny > ask > allow. Luật được xét TRƯỚC logic chế độ quyền (xem core/engine/permissions.ts).
 *
 * An toàn khi khớp lệnh: lệnh ghép (`a && b`, `a; b`, `a | b`, `a & b`, xuống dòng) được TÁCH và luật allow phải khớp MỌI phần; lệnh có
 * thay thế (`$(…)`, backtick, `${…}`, `<(…)`), chuyển hướng (`>`/`<`), dấu nháy lệch hay ký tự nháy/ngắt Unicode thì KHÔNG BAO GIỜ được allow
 * theo luật (vẫn có thể bị deny/ask). Phần nằm trong dấu nháy không bị tách.
 */

export type RuleAction = 'allow' | 'ask' | 'deny';
export type RuleSource = 'user' | 'workspace';

export interface ParsedRule {
  /** Tên công cụ (có thể chứa `*`). */
  tool: string;
  /** Đặc tả trong ngoặc; thiếu = công cụ trần. */
  spec?: string;
}

export interface Rule extends ParsedRule {
  action: RuleAction;
  source: RuleSource;
  /** Dạng chữ chuẩn `tool(spec)` để hiện và lưu. */
  text: string;
}

export interface RuleHit {
  action: RuleAction;
  /** Dạng chữ của luật đã quyết định, ví dụ `run_command(npm test:*)`. */
  rule: string;
  source: RuleSource;
}

/** Điều cần so với luật, do công cụ/đối số quyết định. */
export type RuleSubject =
  | { kind: 'command'; command: string }
  /** `rel`: đường dẫn tương đối POSIX trong workspace (nếu `inWorkspace`); `abs`: đường dẫn tuyệt đối (dấu `/`). */
  | { kind: 'path'; rel: string; abs: string; inWorkspace: boolean }
  | { kind: 'domain'; host: string }
  | { kind: 'none' };

export interface MatchOptions {
  /** Windows: đường dẫn không phân biệt hoa/thường. */
  caseInsensitivePaths?: boolean;
}

const MAX_TOOL = 80;
const MAX_SPEC = 400;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp(`[\u0000-\u001f\u007f\u0085\u2028\u2029]`);

/** Phân tích chữ một luật; `null` nếu không hợp lệ (tên rỗng, ký tự điều khiển, ngoặc lệch, đặc tả đường dẫn chứa `..`). */
export function parseRule(text: string): ParsedRule | null {
  const s = String(text ?? '').trim();
  if (!s || s.length > MAX_TOOL + MAX_SPEC + 2 || CONTROL_CHARS.test(s)) return null;
  const open = s.indexOf('(');
  if (open < 0) {
    return validTool(s) ? { tool: s } : null;
  }
  if (!s.endsWith(')')) return null;
  const tool = s.slice(0, open).trim();
  const spec = s.slice(open + 1, -1).trim();
  if (!validTool(tool) || !spec || spec.length > MAX_SPEC) return null;
  if (isPathTool(tool) && hasDotDot(spec)) return null;
  return { tool, spec };
}

function validTool(tool: string): boolean {
  return tool.length > 0 && tool.length <= MAX_TOOL && /^[A-Za-z0-9_*][\w.:*-]*$/.test(tool);
}

export function formatRule(r: ParsedRule): string {
  return r.spec ? `${r.tool}(${r.spec})` : r.tool;
}

/** Dựng danh sách luật từ các mảng chuỗi cấu hình (bỏ mục không hợp lệ, trùng). */
export function buildRules(input: { action: RuleAction; source: RuleSource; items: readonly unknown[] }[]): Rule[] {
  const out: Rule[] = [];
  const seen = new Set<string>();
  for (const group of input) {
    for (const raw of group.items.slice(0, 500)) {
      if (typeof raw !== 'string') continue;
      const p = parseRule(raw);
      if (!p) continue;
      const text = formatRule(p);
      const key = `${group.action}|${group.source}|${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...p, action: group.action, source: group.source, text });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Công cụ → chủ thể
// ─────────────────────────────────────────────────────────────────────────────

const PATH_TOOLS = new Set(['read_file', 'edit_file', 'write_file', 'list_dir', 'glob', 'grep']);

export function isPathTool(tool: string): boolean {
  return PATH_TOOLS.has(tool);
}

function hasDotDot(spec: string): boolean {
  return spec.split(/[\\/]+/).some((seg) => seg === '..');
}

/** Đối số thô → chủ thể CHƯA chuẩn hoá đường dẫn (host chuẩn hoá đường dẫn thật rồi thay bằng chủ thể `path` đầy đủ). */
export function rawSubject(tool: string, input: Record<string, unknown> | undefined): RuleSubject | { kind: 'rawPath'; path: string } {
  const a = input ?? {};
  if (tool === 'run_command') return { kind: 'command', command: typeof a.command === 'string' ? a.command : '' };
  if (isPathTool(tool)) {
    const p = typeof a.path === 'string' ? a.path : '.';
    return { kind: 'rawPath', path: p };
  }
  if (tool === 'fetch_url' || tool === 'web_fetch') {
    if (typeof a.url !== 'string') return { kind: 'none' };
    try {
      return { kind: 'domain', host: new URL(a.url).hostname.toLowerCase() };
    } catch {
      return { kind: 'none' };
    }
  }
  return { kind: 'none' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Glob nhỏ (không phụ thuộc)
// ─────────────────────────────────────────────────────────────────────────────

function globToRegex(glob: string, opts: { pathMode: boolean; ci: boolean }): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (opts.pathMode && glob[i + 1] === '*') {
        // `**/` = không hoặc nhiều thư mục; `**` cuối = phần còn lại.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += opts.pathMode ? '[^/]*' : '.*';
    } else if (c === '?') re += opts.pathMode ? '[^/]' : '.';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, opts.ci ? 'i' : '');
}

/** Khớp tên công cụ (cho phép `*`). */
export function matchToolName(pattern: string, tool: string): boolean {
  if (pattern === tool) return true;
  if (!pattern.includes('*')) return false;
  return globToRegex(pattern, { pathMode: false, ci: false }).test(tool);
}

function normPath(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (s.startsWith('./')) s = s.slice(2);
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/** Khớp một đường dẫn (POSIX) với đặc tả glob. Đặc tả không có `/` khớp theo tên tệp ở mọi cấp. */
export function matchPathSpec(spec: string, pathPosix: string, ci: boolean): boolean {
  const s = normPath(spec);
  const p = normPath(pathPosix);
  if (!s || hasDotDot(s) || hasDotDot(p)) return false;
  if (s === '**') return true;
  if (!s.includes('/')) {
    const base = p.slice(p.lastIndexOf('/') + 1);
    return globToRegex(s, { pathMode: true, ci }).test(base);
  }
  if (globToRegex(s, { pathMode: true, ci }).test(p)) return true;
  // `src/**` cũng khớp chính thư mục `src` (liệt kê/tìm trong thư mục đó).
  if (s.endsWith('/**')) {
    const dir = s.slice(0, -3);
    return globToRegex(dir, { pathMode: true, ci }).test(p);
  }
  return false;
}

/** Khớp tên miền: `domain:github.com` (đúng), `domain:*.github.com` (tên miền con), hoặc mẫu không tiền tố. */
export function matchDomainSpec(spec: string, host: string): boolean {
  let s = spec.trim().toLowerCase();
  if (s.startsWith('domain:')) s = s.slice(7).trim();
  if (!s) return false;
  const h = host.toLowerCase().replace(/\.$/, '');
  if (s === h) return true;
  if (s.includes('*')) return globToRegex(s, { pathMode: false, ci: true }).test(h);
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lệnh shell: tách lệnh ghép, chuẩn hoá, khớp
// ─────────────────────────────────────────────────────────────────────────────

/** Ký tự nháy/ngắt Unicode có thể đánh lừa mắt người duyệt hoặc shell — không bao giờ cho allow theo luật. */
const UNSAFE_UNICODE = new RegExp(`[\u0085\u00a0\u2018-\u201f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff\uff01-\uff5e]`);

/**
 * Tách một dòng lệnh thành các lệnh đơn (đã chuẩn hoá khoảng trắng, bỏ dấu nháy quanh token).
 * Trả về `null` nếu KHÔNG THỂ tin kết quả: thay thế lệnh (`$(`, backtick, `${`, `<(`, `>(`), chuyển hướng (`>`, `<`), nháy lệch,
 * phần rỗng (`a &&`), ký tự Unicode đáng ngờ hoặc ký tự điều khiển.
 */
export function splitCommand(command: string): string[] | null {
  const src = String(command ?? '');
  if (!src.trim() || src.length > 8000) return null;
  if (UNSAFE_UNICODE.test(src)) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(src)) return null;

  const segments: string[] = [];
  let tokens: string[] = [];
  let tok = '';
  let inTok = false;
  let quote: '"' | "'" | null = null;

  const endTok = () => {
    if (inTok) tokens.push(tok);
    tok = '';
    inTok = false;
  };
  const endSeg = (): boolean => {
    endTok();
    if (tokens.length === 0) return false;
    segments.push(tokens.join(' '));
    tokens = [];
    return true;
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      if (c === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && c === '\\' && next !== undefined) {
        tok += next;
        i++;
        continue;
      }
      if (quote === '"' && (c === '$' || c === '`')) return null; // mở rộng trong nháy kép
      tok += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      inTok = true;
      continue;
    }
    if (c === '\\') {
      if (next === undefined || next === '\n' || next === '\r') return null;
      tok += next;
      inTok = true;
      i++;
      continue;
    }
    if (c === '`' || c === '$' || c === '<' || c === '>') return null;
    if (c === '(' || c === ')' || c === '{' || c === '}') return null;
    if (c === '\n' || c === '\r') {
      // Dòng trống / `\r\n` không phải phần rỗng — chỉ dấu nối (`;`, `&`, `|`) mới đòi phần trước nó khác rỗng.
      endSeg();
      continue;
    }
    if (c === ';') {
      if (!endSeg()) return null;
      continue;
    }
    if (c === '&' || c === '|') {
      if (!endSeg()) return null;
      if (next === c) i++; // && hoặc ||
      else if (c === '|' && next === '&') i++;
      continue;
    }
    if (c === ' ' || c === '\t') {
      endTok();
      continue;
    }
    tok += c;
    inTok = true;
  }
  if (quote) return null;
  if (!endSeg() && segments.length === 0) return null;
  // Lệnh kết thúc bằng ký tự nối (`a &&`) → phần cuối rỗng: endSeg trả false nhưng đã có segment → vẫn không tin.
  if (/[;&|]\s*$/.test(src)) return null;
  return segments;
}

/** Chuẩn hoá đặc tả lệnh giống như lệnh thật (gộp khoảng trắng). */
function normSpec(spec: string): string {
  return spec.replace(/\s+/g, ' ').trim();
}

/** Khớp MỘT lệnh đơn (đã chuẩn hoá) với đặc tả: `prefix:*`, mẫu `*`, hoặc nguyên văn. */
export function matchCommandSpec(spec: string, segment: string): boolean {
  const s = normSpec(spec);
  const seg = normSpec(segment);
  if (!s || !seg) return false;
  if (s === '*' || s === '**') return true;
  if (s.endsWith(':*')) {
    const prefix = s.slice(0, -2).trim();
    if (!prefix) return false;
    return seg === prefix || seg.startsWith(prefix + ' ');
  }
  if (s.includes('*') || s.includes('?')) return globToRegex(s, { pathMode: false, ci: false }).test(seg);
  return seg === s;
}

/**
 * Khớp một lệnh (có thể ghép) với đặc tả. `strict` (dùng cho allow): mọi phần phải khớp và lệnh phải tách được an toàn.
 * Không strict (deny/ask): khớp nếu BẤT KỲ phần nào khớp, hoặc cả dòng (đã gộp khoảng trắng) khớp.
 */
export function matchCommand(spec: string, command: string, strict: boolean): boolean {
  const segs = splitCommand(command);
  if (strict) return !!segs && segs.length > 0 && segs.every((s) => matchCommandSpec(spec, s));
  if (matchCommandSpec(spec, command)) return true;
  if (segs && segs.some((s) => matchCommandSpec(spec, s))) return true;
  // Không tách được: thử tách thô theo ký tự nối để luật deny vẫn bắt được `x; rm -rf /`.
  return command
    .split(/[;&|\n\r]+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .some((p) => matchCommandSpec(spec, p));
}

// ─────────────────────────────────────────────────────────────────────────────
// Đánh giá
// ─────────────────────────────────────────────────────────────────────────────

/** Một luật có khớp (tên công cụ + chủ thể) không. `strict` = đang xét allow. */
export function ruleMatches(rule: ParsedRule, tool: string, subject: RuleSubject, strict: boolean, opts: MatchOptions = {}): boolean {
  if (!matchToolName(rule.tool, tool)) return false;
  if (rule.spec === undefined) return true;
  const spec = rule.spec.trim();
  if (spec === '**' || spec === '*') return subject.kind !== 'command' || !strict || splitCommand(subject.command) !== null;
  switch (subject.kind) {
    case 'command':
      return matchCommand(spec, subject.command, strict);
    case 'path': {
      const ci = !!opts.caseInsensitivePaths;
      if (subject.inWorkspace && matchPathSpec(spec, subject.rel, ci)) return true;
      // Đường dẫn ngoài workspace: chỉ luật deny/ask (không strict) khớp theo đường dẫn tuyệt đối.
      if (!strict && subject.abs && matchPathSpec(spec, subject.abs, ci)) return true;
      return false;
    }
    case 'domain':
      return matchDomainSpec(spec, subject.host);
    default:
      return false;
  }
}

/** Quyết định theo bộ luật: deny > ask > allow; `null` = không luật nào khớp. */
export function evaluateRules(rules: readonly Rule[], tool: string, subject: RuleSubject, opts: MatchOptions = {}): RuleHit | null {
  const hit = (action: RuleAction): RuleHit | null => {
    for (const r of rules) {
      if (r.action !== action) continue;
      if (ruleMatches(r, tool, subject, action === 'allow', opts)) return { action, rule: r.text, source: r.source };
    }
    return null;
  };
  return hit('deny') ?? hit('ask') ?? hit('allow');
}

// ─────────────────────────────────────────────────────────────────────────────
// Lệnh nguy hiểm & đề xuất luật
// ─────────────────────────────────────────────────────────────────────────────

/** Lệnh có thể xoá dữ liệu, leo thang quyền, ghi vào hệ thống hoặc gửi dữ liệu ra ngoài — không đề xuất luật cho phép. */
const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i,
  /\b(rmdir|rd)\s+\/s\b/i,
  /\bdel\s+\/[sfq]/i,
  /\bremove-item\b[\s\S]*-(recurse|force)/i,
  /\b(format|mkfs|diskpart|fdisk)\b/i,
  /\bdd\s+if=/i,
  /\b(shutdown|reboot|halt|poweroff|restart-computer|stop-computer)\b/i,
  /\b(sudo|doas|runas|su)\b/i,
  /\bchmod\s+(-[a-z]*\s+)*-?[a-z]*r\b|\bchmod\s+[0-7]{3,4}\s+\//i,
  /\bchown\s+-R/i,
  /\bgit\s+(push\b[\s\S]*(--force|-f\b)|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s+\.|branch\s+-D)/i,
  /\b(curl|wget|iwr|invoke-webrequest|invoke-restmethod|irm)\b[\s\S]*\|\s*(sh|bash|zsh|pwsh|powershell|iex|python|node)\b/i,
  // Gửi dữ liệu ra ngoài.
  /\bcurl\b[\s\S]*\s(-d|--data\S*|-F|--form|-T|--upload-file|-X\s*(POST|PUT|PATCH|DELETE)|--request\s*(POST|PUT|PATCH|DELETE))\b/i,
  /\bwget\b[\s\S]*--(post-data|post-file|method=(POST|PUT))/i,
  /\b(invoke-webrequest|invoke-restmethod|iwr|irm)\b[\s\S]*-(method|body|infile)\b/i,
  /\b(scp|sftp|ftp|rsync|ssh|telnet|nc|ncat|netcat|socat)\b/i,
  // Ghi vào vùng hệ thống / registry / thực thi mã mã hoá.
  /(\/etc\/|\/usr\/(bin|lib)|\/boot\/|[a-z]:\\windows\\|\\system32\\|program files)/i,
  /\b(reg\s+(add|delete|import)|regedit|set-itemproperty\s+[\s\S]*hk(lm|cu))/i,
  /-(enc|encodedcommand|e)\s+[A-Za-z0-9+/=]{20,}/i,
  /\b(eval|exec)\s+\$/i,
  /\bbase64\s+(-d|--decode)[\s\S]*\|/i,
  /\b(kill\s+-9\s+-1|killall|taskkill\s+\/f|stop-process\b[\s\S]*-name)/i,
  /\bnpm\s+(publish|unpublish|deprecate)\b|\bpip\s+upload\b|\btwine\s+upload\b|\bcargo\s+publish\b/i,
  /\b(docker\s+(rm|rmi|system\s+prune)|kubectl\s+delete)\b/i,
  /:\(\)\s*\{/,
];

export function isDangerousCommand(command: string): boolean {
  const c = String(command ?? '');
  return DANGEROUS_PATTERNS.some((re) => re.test(c));
}

/** CLI nhiều từ: lệnh con sau tên chương trình là một phần của "việc" (`git diff`, `npm run test`). */
const MULTI_WORD_CLIS = new Set([
  'git', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'cargo', 'dotnet', 'go', 'python', 'python3', 'py', 'pip', 'pip3', 'docker', 'kubectl',
  'node', 'gh', 'make', 'mvn', 'gradle', 'poetry', 'uv', 'composer', 'php', 'ruby', 'bundle', 'rails', 'flutter', 'dart', 'swift', 'az', 'aws',
  'gcloud', 'terraform', 'code', 'tsc', 'vitest', 'jest', 'pytest', 'eslint', 'prettier',
]);
const RUN_SCRIPT = new Set(['npm', 'pnpm', 'yarn', 'bun']);

export interface SuggestInfo {
  /** Đường dẫn tương đối trong workspace (POSIX) nếu có. */
  rel?: string;
  inWorkspace?: boolean;
  /** Yêu cầu nâng cao (ngoài workspace, tệp bí mật, lệnh nguy hiểm) — không đề xuất gì. */
  elevated?: boolean;
  host?: string;
}

/**
 * Đề xuất đặc tả «Luôn cho phép» hợp lý từ lệnh gọi công cụ. Mảng rỗng = không nên đề xuất (lệnh nguy hiểm, lệnh ghép, yêu cầu nâng cao…).
 * Phần tử đầu là đề xuất chính (người dùng sửa được trước khi lưu).
 */
export function suggestRules(tool: string, input: Record<string, unknown> | undefined, info: SuggestInfo = {}): string[] {
  if (info.elevated) return [];
  const a = input ?? {};
  if (tool === 'run_command') {
    const command = typeof a.command === 'string' ? a.command : '';
    const segs = splitCommand(command);
    if (!segs || segs.length !== 1) return [];
    const seg = segs[0];
    if (seg.length > 200 || isDangerousCommand(seg)) return [];
    const tokens = seg.split(' ');
    const t0 = tokens[0];
    if (MULTI_WORD_CLIS.has(t0) && tokens.length >= 2 && !tokens[1].startsWith('-') && !tokens[1].includes('=')) {
      if (RUN_SCRIPT.has(t0) && tokens[1] === 'run' && tokens[2] && !tokens[2].startsWith('-')) return [formatRule({ tool, spec: `${t0} run ${tokens[2]}:*` })];
      return [formatRule({ tool, spec: `${t0} ${tokens[1]}:*` })];
    }
    return [formatRule({ tool, spec: seg })];
  }
  if (tool === 'edit_file' || tool === 'write_file') {
    if (!info.inWorkspace || !info.rel) return [];
    const rel = normPath(info.rel);
    if (hasDotDot(rel) || rel.length > 300) return [];
    const slash = rel.lastIndexOf('/');
    if (slash < 0) return [formatRule({ tool, spec: rel })];
    return [formatRule({ tool, spec: `${rel.slice(0, slash)}/**` })];
  }
  if (tool === 'fetch_url' || tool === 'web_fetch') {
    const host = (info.host ?? (rawSubject(tool, a) as { host?: string }).host ?? '').toLowerCase();
    if (!host || host.length > 253) return [];
    return [formatRule({ tool, spec: `domain:${host}` })];
  }
  if (tool.startsWith('mcp__')) return [tool];
  return [];
}

/** Băm nội dung ổn định (FNV-1a 32 bit, hex) của một danh sách luật — khoá xác nhận luật allow từ workspace. */
export function hashRules(items: readonly string[]): string {
  const text = [...items].map((s) => s.trim()).filter(Boolean).sort().join('\n');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
