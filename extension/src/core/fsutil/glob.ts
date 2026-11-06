/**
 * Glob tối giản (đủ cho công cụ glob/grep và .gitignore): `*`, `**`, `?`, `[abc]`, `{a,b}`.
 * Khớp trên đường dẫn tương đối dạng POSIX ('/').
 *
 * Mẫu glob được dịch sang biểu thức chính quy, và mẫu có thể do model — hoặc một `.gitignore` trong kho mã không tin cậy —
 * đưa ra. Vì vậy độ phức tạp bị giới hạn chặt để không thể dựng ra mẫu backtrack theo hàm mũ (`a*a*a*a*a*b`, `{a,a}{a,a}…`).
 */

const REGEX_SPECIAL = /[.+^$()|\\]/g;

const MAX_GLOB_LENGTH = 400;
const MAX_DEEP_STARS = 2; // số `**` / `**/` (khớp xuyên thư mục)
const MAX_STARS_PER_SEGMENT = 2; // số `*` trong cùng một đoạn đường dẫn
const MAX_BRACE_GROUPS = 3;
const MAX_ALTERNATIVES = 24;
/** Đường dẫn dài bất thường (kho mã cố ý tạo) không đem so khớp: chi phí backtrack tăng theo độ dài. */
const MAX_TESTED_PATH = 2048;

export class GlobTooComplexError extends Error {
  constructor(glob: string) {
    super(`Mẫu glob quá phức tạp (rút gọn bớt dấu * / ** / {…}): ${glob.slice(0, 80)}`);
    this.name = 'GlobTooComplexError';
  }
}

export function globToRegExp(glob: string): RegExp {
  if (glob.length > MAX_GLOB_LENGTH) throw new GlobTooComplexError(glob);
  // `**/**/**` ≡ `**/`; chuỗi dấu sao dài vô nghĩa hơn `**`.
  glob = glob.replace(/(?:\*\*\/){2,}/g, '**/').replace(/\*{3,}/g, '**');

  let re = '';
  let i = 0;
  let braceDepth = 0;
  let braceGroups = 0;
  let alternatives = 0;
  let deepStars = 0;
  let segStars = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (++deepStars > MAX_DEEP_STARS) throw new GlobTooComplexError(glob);
        // `**/` = không hoặc nhiều thư mục; `**` ở cuối = mọi thứ.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
          segStars = 0;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        if (++segStars > MAX_STARS_PER_SEGMENT) throw new GlobTooComplexError(glob);
        re += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) {
        re += '\\[';
        i++;
      } else {
        let cls = glob.slice(i + 1, end);
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        re += `[${cls.replace(/\\/g, '\\\\')}]`;
        i = end + 1;
      }
    } else if (c === '{') {
      if (++braceGroups > MAX_BRACE_GROUPS || braceDepth >= 2) throw new GlobTooComplexError(glob);
      braceDepth++;
      re += '(?:';
      i++;
    } else if (c === '}' && braceDepth > 0) {
      braceDepth--;
      re += ')';
      i++;
    } else if (c === ',' && braceDepth > 0) {
      if (++alternatives > MAX_ALTERNATIVES) throw new GlobTooComplexError(glob);
      re += '|';
      i++;
    } else {
      if (c === '/') segStars = 0;
      re += c.replace(REGEX_SPECIAL, '\\$&');
      i++;
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

export interface GlobMatcher {
  test(relPath: string): boolean;
}

/**
 * @param anyDepthIfBare mẫu không chứa '/' (ví dụ `*.ts`) khớp tên tệp ở mọi độ sâu — kiểu ripgrep/.gitignore.
 */
export function compileGlob(pattern: string, anyDepthIfBare = true): GlobMatcher {
  const p = pattern.trim().replace(/^\.\//, '').replace(/\\/g, '/');
  const re = globToRegExp(p);
  const bare = anyDepthIfBare && !p.includes('/');
  return {
    test(rel: string) {
      if (rel.length > MAX_TESTED_PATH) return false;
      const r = rel.replace(/\\/g, '/');
      if (bare) {
        const base = r.slice(r.lastIndexOf('/') + 1);
        return re.test(base);
      }
      return re.test(r);
    },
  };
}
