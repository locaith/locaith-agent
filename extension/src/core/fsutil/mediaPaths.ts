/**
 * (0.6.3) Xem trước kết quả ngay trong khung chat: từ một đường dẫn câu trả lời nhắc tới (`out/demo.mp4`, `C:\…\anh.png`)
 * ra danh sách đường dẫn tuyệt đối ĐƯỢC PHÉP thử. Hàm thuần — không đụng đĩa; host stat các ứng viên theo thứ tự.
 *
 * Đầu vào là chữ do model viết, KHÔNG đáng tin:
 *  - chỉ nhận đuôi ảnh / video / âm thanh / tài liệu đã biết (shared/mediaKinds.ts — không bao giờ .exe, .env, mã nguồn…);
 *  - từ chối đường dẫn mạng (UNC `\\máy\chia-sẻ`, `//máy/…`): chỉ cần stat là Windows đã gửi thông tin đăng nhập NTLM tới máy đó;
 *  - từ chối thiết bị (`\\?\`, `\\.\`), luồng dữ liệu thay thế NTFS, ký tự điều khiển, URL không phải `file:`;
 *  - chỉ trong VÙNG: thư mục workspace, thư mục người dùng, thư mục tạm. Ngoài vùng thì không đụng tới đĩa — ổ mạng, ổ ngoài,
 *    ổ đang hỏng… không bị đọc chỉ vì câu trả lời có nhắc tới một đường dẫn ở đó.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mediaKindOf } from '../../shared/mediaKinds';
import { isInside, isSuspiciousWindowsPath, normalizeForCompare } from './paths';

export { imageMime, mediaKindOf } from '../../shared/mediaKinds';

export interface MediaZones {
  workspaceRoots: readonly string[];
  home: string;
  tmp: string;
}

/** Ảnh nằm ngoài các thư mục webview đọc được thì gửi dạng data: — chỉ khi nhỏ hơn mức này. */
export const MEDIA_DATA_URI_MAX = 8 * 1024 * 1024;
/** Mỗi lần hỏi tối đa bấy nhiêu đường dẫn (thừa thì bỏ). */
export const MEDIA_MAX_PATHS = 16;

const isNetworkPath = (p: string): boolean => /^[\\/]{2}/.test(p);

const zoneRoots = (z: MediaZones): string[] => [...z.workspaceRoots, z.home, z.tmp].filter((r) => typeof r === 'string' && r.length > 0);

/**
 * ĐỤNG ĐĨA (chỉ lstat, không đi theo liên kết): tệp `abs` — hoặc bất kỳ thư mục nào giữa gốc vùng xem sâu nhất chứa nó và nó — có phải
 * liên kết (symlink, junction) không. true = bỏ qua tệp: một liên kết trong workspace có thể trỏ ra ổ mạng hay ổ khác, và đọc qua nó là
 * đụng tới nơi đó. Không xác định được (lỗi lstat, không nằm trong vùng nào) cũng coi là true.
 */
export async function viaLink(abs: string, z: MediaZones): Promise<boolean> {
  const roots = zoneRoots(z).filter((r) => isInside(r, abs));
  if (roots.length === 0) return true;
  const stop = normalizeForCompare(roots.sort((a, b) => normalizeForCompare(b).length - normalizeForCompare(a).length)[0]);
  for (let p = abs; normalizeForCompare(p) !== stop; p = path.dirname(p)) {
    if (path.dirname(p) === p) return true;
    try {
      if ((await fs.promises.lstat(p)).isSymbolicLink()) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * Các đường dẫn tuyệt đối để thử, theo thứ tự ưu tiên. Rỗng = từ chối (host không đụng đĩa).
 * `platform` chỉ để kiểm thử dạng Git Bash (`/c/Users/…`).
 */
export function mediaCandidates(input: string, z: MediaZones, platform: NodeJS.Platform = process.platform): string[] {
  let p = String(input ?? '')
    .trim()
    .replace(/^["'`<]+|["'`>]+$/g, '');
  if (!p || p.length > 600 || /[\u0000-\u001f\u007f]/.test(p)) return [];
  if (/^file:/i.test(p)) {
    try {
      p = fileURLToPath(p);
    } catch {
      return [];
    }
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p) || /^(?:data|blob|javascript|mailto|vscode[a-z-]*):/i.test(p)) {
    return [];
  }
  if (isNetworkPath(p)) return [];
  if (p === '~' || /^~[\\/]/.test(p)) p = path.join(z.home, p.slice(1));
  // Git Bash / MSYS trên Windows: /c/Users/… → C:\Users\…
  if (platform === 'win32' && /^\/[a-zA-Z](?:\/|$)/.test(p)) p = `${p[1].toUpperCase()}:${p.slice(2) || '/'}`;
  if (!mediaKindOf(p)) return [];

  // Liên kết Markdown hay mã hoá dấu cách (`my%20video.mp4`): thử cả dạng đã giải mã.
  const forms = [p];
  if (/%[0-9a-f]{2}/i.test(p)) {
    try {
      const d = decodeURIComponent(p);
      if (d !== p) forms.push(d);
    } catch {
      /* giữ nguyên */
    }
  }

  const zones = zoneRoots(z);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of forms) {
    const abs = path.isAbsolute(f) ? [path.normalize(f)] : z.workspaceRoots.map((r) => path.resolve(r, f));
    for (const a of abs) {
      if (isNetworkPath(a) || isSuspiciousWindowsPath(a) || !mediaKindOf(a)) continue;
      if (!zones.some((root) => isInside(root, a))) continue;
      const k = platform === 'win32' ? a.toLowerCase() : a;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(a);
    }
  }
  return out;
}
