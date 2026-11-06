/**
 * Đường dẫn do model đưa ra là đầu vào KHÔNG đáng tin: phải chuẩn hoá, kiểm tra nằm trong vùng cho phép
 * (kể cả khi đi qua symlink) và phát hiện đường dẫn nhạy cảm trước khi đọc/ghi.
 *
 * Mọi phép kiểm tra "bí mật/nhạy cảm" chạy trên cả dạng người dùng gõ LẪN đường dẫn THẬT trên đĩa (`real`), vì các
 * dạng khác nhau trỏ tới cùng một tệp: symlink, tên ngắn 8.3 (`ENV~1`), luồng dữ liệu thay thế NTFS (`.env::$DATA`),
 * dấu chấm/khoảng trắng cuối tên (Windows bỏ đi), hoa/thường và NFC/NFD.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolHost } from '../engine/types';

export const IS_WINDOWS = process.platform === 'win32';

export function normalizeForCompare(p: string): string {
  const n = path.resolve(p);
  return IS_WINDOWS ? n.toLowerCase() : n;
}

/** Khoá để nhận ra "cùng một tệp" trong `session.readFiles` dù đường dẫn được viết khác hoa/thường (Windows). */
export function readKey(abs: string): string {
  return normalizeForCompare(abs);
}

/** `target` có nằm trong (hoặc bằng) thư mục `root` không — so sánh theo chuỗi đã chuẩn hoá. */
export function isInside(root: string, target: string): boolean {
  const r = normalizeForCompare(root);
  const t = normalizeForCompare(target);
  if (r === t) return true;
  const rel = path.relative(r, t);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export type PathZone = 'workspace' | 'extra' | 'outside';

export interface ResolvedPath {
  /** Dạng đã chuẩn hoá của đường dẫn người dùng/model đưa ra. */
  abs: string;
  /** Đường dẫn tương đối theo workspace (dấu '/') nếu nằm trong workspace, ngược lại là đường dẫn tuyệt đối. */
  rel: string;
  zone: PathZone;
  root?: string;
  /** Đường dẫn THẬT trên đĩa (đã qua symlink, tên ngắn, NFC/NFD, hoa/thường). Dùng để kiểm tra bí mật/nhạy cảm. */
  real: string;
  /** Dạng đường dẫn đáng ngờ (luồng dữ liệu thay thế NTFS, dấu chấm cuối…) — luôn xếp vào 'outside' để buộc hỏi. */
  suspicious?: boolean;
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Chuẩn hoá về một dạng duy nhất rồi phân loại vùng. Không đụng đĩa. */
export function resolveUserPath(host: Pick<ToolHost, 'workspaceRoots' | 'extraReadRoots'>, input: string): ResolvedPath {
  let p = input.trim().replace(/^["']+|["']+$/g, '');
  if (p.startsWith('file://')) {
    try {
      p = fileURLToPath(p);
    } catch {
      /* giữ nguyên */
    }
  }
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(1));
  const roots = host.workspaceRoots();
  const base = roots[0] ?? process.cwd();
  const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(base, p);

  for (const root of roots) {
    if (isInside(root, abs)) return { abs, rel: toPosix(path.relative(root, abs)) || '.', zone: 'workspace', root, real: abs };
  }
  for (const root of host.extraReadRoots()) {
    if (isInside(root, abs)) return { abs, rel: abs, zone: 'extra', root, real: abs };
  }
  return { abs, rel: abs, zone: 'outside', real: abs };
}

/** Windows: luồng dữ liệu thay thế (`.env::$DATA`) hoặc đoạn kết thúc bằng dấu chấm/khoảng trắng (bị hệ điều hành bỏ đi). */
export function isSuspiciousWindowsPath(abs: string): boolean {
  if (!IS_WINDOWS) return false;
  const body = abs.replace(/^\\\\\?\\/, '').replace(/^[A-Za-z]:/, '');
  if (body.includes(':')) return true;
  return body.split(/[\\/]+/).some((seg) => seg.length > 1 && seg !== '..' && /[. ]$/.test(seg));
}

/**
 * Tìm đường dẫn THẬT khi tên chỉ khác nhau ở dạng chuẩn hoá Unicode (NFC ↔ NFD) hoặc hoa/thường (trên Windows).
 * Rất hay gặp với tiếng Việt: tệp tải từ Zalo/Drive/macOS lưu tên dạng NFD (dấu tách rời) trong khi model luôn viết
 * NFC, và NTFS coi hai dạng là hai tên khác nhau. Phần chưa tồn tại (tệp sắp tạo) được giữ nguyên, nhưng các thư mục
 * cha đã có thì được ánh xạ về tên thật để không tạo ra thư mục trùng.
 */
export async function matchExistingName(abs: string): Promise<string> {
  try {
    await fs.promises.access(abs);
    return abs;
  } catch {
    /* thử khớp từng đoạn */
  }
  const parsed = path.parse(abs);
  const segments = abs.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean);
  let cur = parsed.root;
  for (let i = 0; i < segments.length; i++) {
    const direct = path.join(cur, segments[i]);
    try {
      await fs.promises.access(direct);
      cur = direct;
      continue;
    } catch {
      /* tìm theo dạng chuẩn hoá */
    }
    let entries: string[];
    try {
      entries = await fs.promises.readdir(cur);
    } catch {
      return path.join(cur, ...segments.slice(i));
    }
    const fold = (s: string) => (IS_WINDOWS ? s.normalize('NFC').toLowerCase() : s.normalize('NFC'));
    const want = fold(segments[i]);
    const found = entries.find((e) => fold(e) === want);
    if (!found) return path.join(cur, ...segments.slice(i));
    cur = path.join(cur, found);
  }
  return cur;
}

/**
 * Đường dẫn thật của `abs`: realpath (gốc `libuv`, đổi cả tên ngắn 8.3 trên Windows) của tổ tiên gần nhất đang tồn tại,
 * cộng phần còn lại. Symlink TREO (đích chưa tồn tại) được đi theo bằng readlink — nếu không, ghi vào `ws/link` (→ tệp ngoài
 * workspace chưa có) bị coi là "tạo tệp trong workspace" và POSIX sẽ ghi xuyên qua liên kết.
 */
export async function canonicalize(abs: string, depth = 0): Promise<string> {
  let probe = abs;
  const rest: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      const real = await fs.promises.realpath(probe);
      return rest.length ? path.join(real, ...[...rest].reverse()) : real;
    } catch {
      try {
        const st = await fs.promises.lstat(probe);
        if (st.isSymbolicLink() && depth < 8) {
          const target = path.resolve(path.dirname(probe), await fs.promises.readlink(probe));
          return canonicalize(rest.length ? path.join(target, ...[...rest].reverse()) : target, depth + 1);
        }
      } catch {
        /* không tồn tại → lên cấp trên */
      }
      const parent = path.dirname(probe);
      if (parent === probe) return abs;
      rest.push(path.basename(probe));
      probe = parent;
    }
  }
  return abs;
}

async function realRoots(roots: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const r of roots) {
    out.push(r);
    try {
      const real = await fs.promises.realpath(r);
      if (normalizeForCompare(real) !== normalizeForCompare(r)) out.push(real);
    } catch {
      /* thư mục gốc không còn */
    }
  }
  return out;
}

/**
 * Như `resolveUserPath` nhưng đi qua đĩa: ánh xạ tên NFC/NFD về tên thật, đi theo symlink (kể cả symlink treo) và tên ngắn,
 * rồi phân vùng theo đường dẫn THẬT — đường dẫn nằm trong workspace về mặt chữ nhưng trỏ ra ngoài bị xếp vào 'outside'.
 */
export async function resolveUserPathReal(
  host: Pick<ToolHost, 'workspaceRoots' | 'extraReadRoots'>,
  input: string,
): Promise<ResolvedPath> {
  let r = resolveUserPath(host, input);
  if (isSuspiciousWindowsPath(r.abs)) return { ...r, zone: 'outside', rel: r.abs, suspicious: true };
  if (r.zone === 'outside') {
    return { ...r, real: await canonicalize(r.abs).catch(() => r.abs) };
  }

  const matched = await matchExistingName(r.abs);
  if (matched !== r.abs) {
    const again = resolveUserPath(host, matched);
    if (again.zone === r.zone) r = again;
  }
  const real = await canonicalize(r.abs).catch(() => r.abs);

  const wsRoots = await realRoots(host.workspaceRoots());
  const exRoots = await realRoots(host.extraReadRoots());
  const zone: PathZone = wsRoots.some((x) => isInside(x, real)) ? 'workspace' : exRoots.some((x) => isInside(x, real)) ? 'extra' : 'outside';
  if (zone === r.zone) return { ...r, real };
  return { ...r, real, zone, rel: zone === 'workspace' ? r.rel : r.abs };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bí mật và vị trí ghi nhạy cảm
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bỏ luồng dữ liệu thay thế và dấu chấm/khoảng trắng cuối (Windows bỏ đi khi mở tệp) rồi đưa về chữ thường.
 * Luôn hạ chữ thường, kể cả trên Linux/macOS: tên chuẩn như `Makefile`, `Dockerfile` viết hoa chữ đầu, và hỏi thừa
 * một lần cho `MAKEFILE` còn hơn bỏ lọt tệp có thể chạy mã.
 */
function canonicalSegment(seg: string): string {
  let s = seg;
  if (IS_WINDOWS) s = s.replace(/:.*$/, '').replace(/[. ]+$/, '');
  return s.toLowerCase();
}

const SECRET_NAME = /^(\.env(\..*)?|\.npmrc|\.netrc|\.pgpass|credentials(\.json)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|pfx|p12|jks|keystore|kdbx))$/i;

/** Tệp thường chứa khoá/mật khẩu: nội dung sẽ được gửi cho nhà cung cấp AI nên phải hỏi trước. */
export function isSecretFile(abs: string): boolean {
  const base = canonicalSegment(path.basename(abs));
  if (/\.(example|sample|template)$/i.test(base)) return false;
  // Tên ngắn 8.3 (`ENV~1`, `CREDEN~1.JSO`) không thể đoán gốc → coi là đáng ngờ; đường dẫn THẬT (`real`) mới là căn cứ chính.
  if (IS_WINDOWS && /~\d/.test(base)) return true;
  return SECRET_NAME.test(base);
}

const SENSITIVE_DIRS = ['.git', '.ssh', '.aws', '.gnupg', '.kube', '.husky', '.idea', '.devcontainer', '.claude', '.cursor'];
const SENSITIVE_VSCODE = new Set(['settings.json', 'tasks.json', 'launch.json', 'extensions.json', 'mcp.json']);
const SHELL_RC = new Set(['.bashrc', '.zshrc', '.profile', '.bash_profile', '.zprofile', '.zshenv', '.gitconfig', '.npmrc', 'profile.ps1', 'microsoft.powershell_profile.ps1']);
/**
 * Tệp cấu hình/kịch bản mà việc sửa chúng biến một lệnh VÔ HẠI đã được duyệt (`npm test`, `make`) thành thực thi mã tuỳ ý
 * (sửa `scripts.test` rồi chạy lại lệnh đã duyệt) → luôn hỏi khi sửa, kể cả ở chế độ "tự nhận chỉnh sửa".
 */
const EXEC_CONFIG = new Set([
  'package.json',
  'makefile',
  'gnumakefile',
  'justfile',
  'taskfile.yml',
  'taskfile.yaml',
  '.envrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.pre-commit-config.yaml',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'composer.json',
  'build.rs',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'pom.xml',
  'cargo.toml',
  'cmakelists.txt',
  'rakefile',
  'gemfile',
  'conftest.py',
  'noxfile.py',
  'tox.ini',
  'dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
  'lefthook.yml',
  '.lefthook.yml',
  'mise.toml',
  '.mise.toml',
  '.gitmodules',
  '.gitattributes',
  'bunfig.toml',
]);
/** Cấu hình công cụ build/test dạng mã (`vitest.config.ts`, `webpack.config.js`, `.eslintrc.js`…): chạy ngay khi `npm test`/`npm run build`. */
const EXEC_CONFIG_RE =
  /^(?:\.?(?:vitest|jest|vite|webpack|rollup|babel|eslint|prettier|postcss|tailwind|next|nuxt|astro|svelte|karma|playwright|cypress|esbuild|tsup)(?:\.config|\.setup|\.workspace|rc)(?:\.[a-z0-9-]+)*\.[cm]?[jt]s|(?:gulp|grunt)file\.[cm]?[jt]s)$/;

/** Ghi vào những nơi có thể dẫn tới thực thi mã ngầm (hook git, task VS Code, workflow CI, rc shell, kịch bản build) → luôn hỏi. */
export function isSensitiveWritePath(abs: string): boolean {
  const parts = abs.split(/[\\/]+/).map(canonicalSegment);
  const base = parts[parts.length - 1];
  if (parts.some((s) => SENSITIVE_DIRS.includes(s))) return true;
  const vs = parts.lastIndexOf('.vscode');
  if (vs >= 0 && SENSITIVE_VSCODE.has(base)) return true;
  if (base.endsWith('.code-workspace')) return true;
  const gh = parts.lastIndexOf('.github');
  if (gh >= 0 && parts[gh + 1] === 'workflows') return true;
  if (SHELL_RC.has(base) || EXEC_CONFIG.has(base) || EXEC_CONFIG_RE.test(base)) return true;
  if (IS_WINDOWS && /~\d/.test(base)) return true; // tên ngắn 8.3 có thể là .git/.env… — không thể đoán, nên hỏi
  return false;
}
