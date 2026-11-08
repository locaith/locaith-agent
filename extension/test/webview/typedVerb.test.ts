import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * (0.7.3) Từ trạng thái ở dòng đang chạy GÕ TỪNG CHỮ RA. Lịch thuần được test bằng số ở test/typewriter.test.ts; phần nhìn (ảnh chụp, đo DOM thật)
 * ở webview/dev/shoot.mjs (`node webview/dev/shoot.mjs typed`). Ở đây khoá các bất biến của nguồn: i18n vi/en, nối dây vào dòng chờ, CSS giữ chỗ/giảm chuyển động.
 */
const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const i18n = read('webview/src/i18n.ts');
const val = (key: string, nth: 0 | 1): string => {
  const re = new RegExp(`^  '${key.replace(/\./g, '\\.')}': '((?:[^'\\\\]|\\\\.)*)',$`, 'gm');
  const all = [...i18n.matchAll(re)].map((m) => m[1]!);
  return all[nth] ?? '';
};

describe('từ xoay vòng (act.verbs) vi/en', () => {
  const vi = val('act.verbs', 0).split('|');
  const en = val('act.verbs', 1).split('|');
  it('đủ nhiều để xoay vòng và có cùng số lượng ở hai ngôn ngữ', () => {
    expect(vi.length).toBeGreaterThanOrEqual(6);
    expect(en.length).toBe(vi.length);
  });
  it('mỗi từ ngắn (≤ 20 ký tự, vừa khung hẹp), không trùng, không dấu «…», không rỗng, không trùng nhãn gốc', () => {
    for (const [list, base] of [[vi, val('act.working', 0)], [en, val('act.working', 1)]] as const) {
      expect(base.length).toBeGreaterThan(0);
      expect(new Set(list).size).toBe(list.length);
      for (const v of list) {
        expect(v.trim(), v).toBe(v);
        expect(v.length, v).toBeGreaterThan(2);
        expect(Array.from(v.normalize('NFC')).length, v).toBeLessThanOrEqual(20);
        expect(v, v).not.toMatch(/…|\.\.\./);
      }
      expect(list).not.toContain(base);
    }
  });
  it('tiếng Việt toàn «Đang …», tiếng Anh toàn từ -ing/viết hoa chữ đầu', () => {
    for (const v of vi) expect(v).toMatch(/^Đang /);
    for (const v of en) expect(v).toMatch(/^[A-Z]/);
  });
});

describe('nối dây vào dòng đang chạy', () => {
  const turn = read('webview/src/components/timeline/AssistantTurn.tsx');
  it('WorkingIndicator dùng TypedVerb: nhãn gốc + danh sách từ; chỉ gõ một lần ở trạng thái «chuẩn bị»', () => {
    expect(turn).toContain("import { TypedVerb } from '../TypedVerb';");
    expect(turn).toMatch(/<TypedVerb label=\{empty \? t\('turn\.preparing'\) : t\('act\.working'\)\} verbs=\{verbs\} seed=\{seed\} animate=\{lively\} once=\{empty\} \/>/);
    expect(turn).toMatch(/\[t\('act\.working'\), \.\.\.t\('act\.verbs'\)\.split\('\|'\)\.filter\(Boolean\)\]/);
  });
  it('cùng công tắc và chế độ nhẹ với nhân vật chờ', () => {
    expect(turn).toMatch(/const lively = settings\.workingCharacters !== false && settings\.liteMode !== true;/);
  });
  it('mô tả cài đặt nói rõ cả hiệu ứng gõ chữ (webview vi/en + package.nls vi/en)', () => {
    expect(val('set.workingCharacters', 0)).toMatch(/gõ từng chữ/);
    expect(val('set.workingCharacters', 1)).toMatch(/typed out letter by letter/);
    expect(JSON.parse(read('package.nls.json'))['cfg.workingCharacters']).toMatch(/gõ từng chữ/);
    expect(JSON.parse(read('package.nls.en.json'))['cfg.workingCharacters']).toMatch(/typed out letter by letter/);
  });
});

describe('TypedVerb.tsx', () => {
  const src = read('webview/src/components/TypedVerb.tsx');
  it('chữ đang gõ và bản giữ chỗ là aria-hidden; chỉ nhãn gốc (sr-only) cho trình đọc màn hình', () => {
    expect(src).toMatch(/<span class="sr-only">\{label\}<\/span>/);
    expect(src).toMatch(/class="tw-ghost" aria-hidden="true"/);
    expect(src).toMatch(/class="tw-live cc-shimmer" aria-hidden="true"/);
  });
  it('giảm chuyển động / tắt hiệu ứng → nhãn tĩnh như cũ, không timer', () => {
    expect(src).toContain('useReducedMotion()');
    expect(src).toMatch(/const live = animate && !reduced && verbs\.length > 0;/);
    expect(src).toMatch(/if \(!live\) return <span class="cc-working-label">\{label\}<\/span>;/);
    expect(src).toMatch(/if \(!live\) return;/);
  });
  it('MỘT timer hẹn đúng lúc chữ đổi (không quét theo khung hình) và được huỷ khi gỡ', () => {
    expect(src).toContain('window.setTimeout(step');
    expect(src).toContain('window.clearTimeout(timer)');
    expect(src).not.toMatch(/setInterval|requestAnimationFrame/);
    expect(src).toMatch(/Number\.isFinite\(f\.nextMs\)/); // `once`: dừng hẳn khi nextMs = Infinity
  });
  it('lịch lấy từ hàm thuần dùng chung với CLI', () => {
    expect(src).toContain("from '../../../src/shared/typewriter'");
  });
});

describe('typewriter.ts thuần', () => {
  it('không import gì (không DOM, không Node, không vscode) → dùng được cho cả webview lẫn CLI', () => {
    const src = read('src/shared/typewriter.ts');
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\b(document|window|process|require|setTimeout|Date\.now|performance)\b/);
  });
  it('CLI và webview cùng dùng nó', () => {
    expect(read('src/cli/tui/widgets.ts')).toContain("from '../../shared/typewriter'");
    expect(read('webview/src/components/TypedVerb.tsx')).toContain('src/shared/typewriter');
  });
});

describe('CSS', () => {
  const css = read('webview/src/styles/timeline-cc.css');
  it('bản ẩn giữ chỗ bề ngang, chữ đang gõ phủ lên (không làm đổi bố cục)', () => {
    expect(css).toMatch(/\.tw-ghost\s*\{\s*visibility:\s*hidden;/);
    expect(css).toMatch(/\.tw-live\s*\{[^}]*position:\s*absolute;[^}]*left:\s*0;[^}]*top:\s*0;/s);
    expect(css).toMatch(/\.cc-working-label\.tw\s*\{[^}]*position:\s*relative;[^}]*display:\s*inline-block;/s);
  });
  it('con trỏ: nháy CHỈ khi giữ/nghỉ (đặc khi gõ/xoá); có nhánh giảm chuyển động, tương phản cao, forced-colors', () => {
    expect(css).toMatch(/\.tw\[data-phase='hold'\] \.tw-caret,\s*\.tw\[data-phase='gap'\] \.tw-caret\s*\{\s*animation:\s*tw-blink/);
    expect(css).toMatch(/@keyframes tw-blink/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.tw-caret\s*\{\s*animation:\s*none;/);
    expect(css).toMatch(/body\.vscode-high-contrast \.tw-caret/);
    expect(css).toMatch(/@media \(forced-colors: active\)\s*\{\s*\.tw-caret\s*\{\s*background:\s*CanvasText;/);
  });
  it('dùng lại .cc-shimmer (đã có nhánh giảm chuyển động / chế độ nhẹ / tương phản cao); dòng chờ được xuống dòng ở khung hẹp', () => {
    expect(css).toMatch(/\.cc-working\s*\{\s*flex-wrap:\s*wrap;/);
    const base = read('webview/src/styles/base.css');
    expect(base).toMatch(/:root\.lite \.app \.cc-shimmer\s*\{\s*animation:\s*none !important;/);
    expect(css).toMatch(/body\.vscode-high-contrast \.cc-shimmer/);
  });
});
