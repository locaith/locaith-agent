/**
 * (0.7.2) Người dùng BẤM một liên kết tệp trong chat (`docs/bản giao.md:12`, `C:\Users\anh\Desktop\ghi-chu.md`, `~/x.md`) —
 * mở được tệp thật kể cả ngoài workspace. Trước đây mọi tệp ngoài workspace đều bị từ chối («Chỉ mở được tệp trong workspace»),
 * nên khách báo «không mở được file .md dù trong VS Code».
 *
 * Hai hàm THUẦN (không đụng đĩa; host lstat/đọc đầu tệp rồi đưa kết quả vào):
 *  - `openCandidates`: từ chữ trên liên kết ra các đường dẫn tuyệt đối để thử, theo thứ tự (hỗ trợ `file://`, `~`, tương đối
 *    tính theo mọi gốc workspace rồi thư mục nhà);
 *  - `classifyOpenTarget`: quyết định mở thế nào.
 *
 * Khác với xem trước media của model (mediaPaths.ts), đây là HÀNH ĐỘNG CHỦ ĐỘNG của người dùng nên không giới hạn vùng; nhưng
 * vẫn không bao giờ chạm đường dẫn mạng (UNC) hay dạng đường dẫn đáng ngờ của Windows, và tệp nhạy cảm ngoài workspace phải được
 * xác nhận trước khi mở.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSecretFile, isSuspiciousWindowsPath, normalizeForCompare, isInside } from './paths';

export type OpenAction =
  /** Mở trong VS Code (`vscode.open`, xem trước). */
  | 'open'
  /** Tệp tài liệu / media: mở bằng ứng dụng của hệ điều hành. */
  | 'external'
  /** Tệp nhị phân không nên chạy (zip, exe, dll…): chỉ hiện trong thư mục chứa nó. */
  | 'reveal'
  /** Không thấy tệp. */
  | 'missing'
  /** Là thư mục, không phải tệp. */
  | 'directory';

export interface OpenProbe {
  exists: boolean;
  isFile: boolean;
  isDirectory: boolean;
  /** Vài KB đầu tệp (chỉ cần khi đuôi tệp không cho biết loại) — để nhận ra tệp nhị phân qua byte NUL. */
  head?: Uint8Array;
}

export interface OpenDecision {
  action: OpenAction;
  zone: 'workspace' | 'extra' | 'outside';
  /** Tệp bí mật / nằm trong thư mục khoá (`.ssh`, `.aws`…). */
  sensitive: boolean;
  /** Phải hỏi xác nhận (modal) trước khi làm `action`: tệp nhạy cảm NGOÀI workspace. */
  confirm: boolean;
}

// Mở được ngay trong VS Code: văn bản/mã (kể cả đuôi lạ → xác định bằng nội dung) và ảnh (VS Code có trình xem ảnh sẵn).
const EDITOR_IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif']);
// Tài liệu/media: ứng dụng hệ thống mở đúng hơn VS Code.
const EXTERNAL_EXT = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'pages', 'numbers', 'key',
  'mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac', 'psd', 'ai', 'fig', 'sketch', 'heic', 'tif', 'tiff',
]);
// Nhị phân/thực thi/nén: không bao giờ tự mở (có thể chạy mã) → chỉ hiện trong thư mục.
const REVEAL_EXT = new Set([
  'exe', 'dll', 'msi', 'bat', 'cmd', 'com', 'scr', 'lnk', 'jar', 'apk', 'app', 'dmg', 'iso', 'bin', 'so', 'dylib', 'sys', 'vbs', 'ps1xml',
  'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'cab', 'db', 'sqlite', 'sqlite3', 'pyc', 'class', 'o', 'obj', 'wasm', 'node', 'vsix',
]);
// Đường dẫn chứa thư mục khoá → nhạy cảm (ngoài tệp bí mật theo tên).
const LOCKED_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.azure', '.docker']);

const extOf = (p: string): string => path.extname(p).replace(/^\./, '').toLowerCase();

/** Tệp bí mật theo tên, hoặc nằm trong thư mục khoá. Kiểm cả dạng người dùng gõ lẫn đường dẫn thật. */
export function isSensitiveOpenTarget(...paths: string[]): boolean {
  for (const p of paths) {
    if (isSecretFile(p)) return true;
    const parts = p.split(/[\\/]+/).map((s) => s.toLowerCase());
    if (parts.some((s) => LOCKED_DIRS.has(s))) return true;
    if (/[\\/]\.config[\\/]gcloud[\\/]/i.test(p)) return true;
  }
  return false;
}

const isNetworkPath = (p: string): boolean => /^[\\/]{2}/.test(p);

/**
 * Các đường dẫn tuyệt đối để thử, theo thứ tự ưu tiên. Rỗng = từ chối (đường dẫn mạng, thiết bị, rỗng…).
 * `home` truyền vào (không gọi os.homedir) để hàm thuần và test được.
 */
export function openCandidates(
  input: string,
  roots: readonly string[],
  home: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  let p = String(input ?? '').trim().replace(/^["'`]+|["'`]+$/g, '');
  if (!p || p.length > 1024 || /[\u0000-\u001f]/.test(p)) return [];
  if (/^file:/i.test(p)) {
    try {
      p = fileURLToPath(p);
    } catch {
      return [];
    }
  } else if (/^[a-z][a-z0-9+.-]{1,}:\/\//i.test(p)) {
    return []; // http:, vscode:… không phải tệp
  }
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(home, p.slice(1));
  // Git Bash trên Windows: /c/Users/… → C:\Users\…
  const gb = platform === 'win32' ? /^\/([a-zA-Z])\/(.*)$/.exec(p) : null;
  if (gb) p = `${gb[1].toUpperCase()}:\\${gb[2].replace(/\//g, '\\')}`;
  if (isNetworkPath(p) || /^\\\\[?.]\\/.test(p)) return [];
  const out: string[] = [];
  const add = (abs: string): void => {
    const n = path.normalize(abs);
    if (isNetworkPath(n)) return;
    if (platform === 'win32' && isSuspiciousWindowsPath(n)) return;
    if (!out.some((o) => normalizeForCompare(o) === normalizeForCompare(n))) out.push(n);
  };
  const isAbs = path.isAbsolute(p) || (platform === 'win32' && /^[A-Za-z]:[\\/]/.test(p));
  if (isAbs) add(p);
  else {
    for (const r of roots) add(path.resolve(r, p));
    if (home) add(path.resolve(home, p));
  }
  return out;
}

/** Quyết định cách mở một ứng viên đã được host dò đĩa (`probe`). `real` = đường dẫn thật sau symlink nếu khác. */
export function classifyOpenTarget(args: {
  abs: string;
  real?: string;
  roots: readonly string[];
  extraRoots?: readonly string[];
  probe: OpenProbe;
}): OpenDecision {
  const { abs, probe } = args;
  const real = args.real ?? abs;
  const inRoot = (list: readonly string[] | undefined): boolean => (list ?? []).some((r) => isInside(r, abs) && isInside(r, real));
  const zone: OpenDecision['zone'] = inRoot(args.roots) ? 'workspace' : inRoot(args.extraRoots) ? 'extra' : 'outside';
  const sensitive = isSensitiveOpenTarget(abs, real);
  // Nhạy cảm ngoài workspace → hỏi trước (trong workspace thì VS Code vốn mở được, như Explorer).
  const confirm = sensitive && zone === 'outside';
  const base = { zone, sensitive, confirm: false };
  if (!probe.exists) return { ...base, action: 'missing' };
  if (probe.isDirectory) return { ...base, action: 'directory' };
  if (!probe.isFile) return { ...base, action: 'missing' }; // thiết bị, socket…
  const ext = extOf(real) || extOf(abs);
  if (REVEAL_EXT.has(ext)) return { ...base, action: 'reveal' }; // không mở nội dung nên khỏi hỏi
  if (EXTERNAL_EXT.has(ext)) return { ...base, confirm, action: 'external' };
  if (EDITOR_IMAGE.has(ext)) return { ...base, confirm, action: 'open' };
  // Đuôi lạ hoặc không đuôi: nhìn nội dung — có byte NUL = nhị phân.
  if (probe.head && probe.head.includes(0)) return { ...base, action: 'reveal' };
  return { ...base, confirm, action: 'open' };
}
