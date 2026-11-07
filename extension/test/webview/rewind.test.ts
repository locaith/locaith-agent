/** (lane:checkpoints-rewind) Giao diện Quay lại: phần tính thuần, chuỗi hai ngôn ngữ, đường lui của CSS, nối vào ChatView. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CheckpointTurn } from '../../src/shared/checkpoints';
import { tOpt } from '../../webview/src/i18n';
import { filesFrom } from '../../webview/src/rewindMath';

const SRC = path.resolve(__dirname, '../../webview/src');
const css = fs.readFileSync(path.join(SRC, 'styles/rewind.css'), 'utf8');
const chatView = fs.readFileSync(path.join(SRC, 'components/ChatView.tsx'), 'utf8');
const component = fs.readFileSync(path.join(SRC, 'components/timeline/Rewind.tsx'), 'utf8');
const f = (rel: string) => ({ rel, kind: 'edit' as const, added: 1, removed: 0 });

describe('filesFrom', () => {
  const cps: CheckpointTurn[] = [
    { promptId: 'p1', files: [f('a.ts'), f('b.ts')] },
    { promptId: 'p2', files: [f('a.ts')] },
    { promptId: 'p3', files: [f('c.ts')] },
  ];
  it('đếm tệp KHÁC NHAU từ điểm được chọn về sau', () => {
    expect(filesFrom(cps, 'p1')).toBe(3);
    expect(filesFrom(cps, 'p2')).toBe(2);
    expect(filesFrom(cps, 'p3')).toBe(1);
  });
  it('điểm không có checkpoint (cuộc trò chuyện cũ) → 0, không lỗi', () => {
    expect(filesFrom(cps, 'zzz')).toBe(0);
    expect(filesFrom([], 'p1')).toBe(0);
  });
});

describe('chuỗi', () => {
  const used = [...component.matchAll(/t\(\s*'((?:rw|cp)\.[\w.]+)'/g)].map((m) => m[1]);
  const dynamic = ['rw.act.restore', 'rw.act.recreate', 'rw.act.delete', 'rw.act.skip', 'rw.skip.too_large', 'rw.skip.binary', 'rw.skip.outside', 'rw.skip.missing_blob', 'rw.skip.unreadable'];
  it('mọi khoá component dùng (kể cả khoá ghép động) có đủ vi và en, không trùng chữ giữa hai ngôn ngữ ở nhãn chính', () => {
    expect(used.length).toBeGreaterThan(20);
    for (const k of new Set([...used, ...dynamic])) {
      const vi = tOpt('vi', k, { n: 2, files: 'x' });
      const en = tOpt('en', k, { n: 2, files: 'x' });
      expect(vi, `thiếu vi: ${k}`).toBeTruthy();
      expect(en, `thiếu en: ${k}`).toBeTruthy();
    }
    expect(tOpt('vi', 'rw.menu.code')).toBe('Khôi phục mã');
    expect(tOpt('en', 'rw.menu.code')).toBe('Restore code');
    expect(tOpt('vi', 'rw.menu.conv')).toBe('Khôi phục hội thoại');
    expect(tOpt('vi', 'rw.menu.both')).toBe('Cả hai');
    expect(tOpt('vi', 'rw.trigger')).toBe('Quay lại điểm này');
  });
  it('nội suy tham số và không có dấu «…» thừa ở nhãn', () => {
    expect(tOpt('vi', 'cp.bar', { files: '3 tệp' })).toBe('3 tệp đã đổi');
    expect(tOpt('en', 'rw.files.other', { n: 3 })).toBe('3 files');
    for (const k of new Set([...used, ...dynamic])) {
      expect(tOpt('vi', k) ?? '').not.toMatch(/…|\.\.\./);
      expect(tOpt('en', k) ?? '').not.toMatch(/…|\.\.\./);
    }
  });
});

describe('CSS', () => {
  it('không tô nền kín khối: thanh thay đổi và thẻ Quay lại không có background đặc', () => {
    for (const sel of ['.cp-bar', '.rw-card', '.cp-list', '.cp-line']) {
      const m = css.match(new RegExp(`${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`));
      expect(m, sel).toBeTruthy();
      expect(m![1]).not.toMatch(/background(-color)?\s*:/);
    }
  });
  it('giảm chuyển động tắt chấm nhấp nháy; tương phản cao có đường lui', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.cp-dot\.is-busy\s*\{[^}]*animation:\s*none/);
    expect(css).toMatch(/@media \(forced-colors: active\)/);
  });
  it('nút Quay lại hiện luôn trên thiết bị cảm ứng (không có hover)', () => {
    expect(css).toMatch(/@media \(hover: none\)\s*\{[^}]*\.rw-trigger\s*\{[^}]*opacity:\s*0\.8/);
  });
  it('stylesheet được nạp vào main.css', () => {
    expect(fs.readFileSync(path.join(SRC, 'styles/main.css'), 'utf8')).toContain("./rewind.css");
  });
});

describe('nối vào ChatView', () => {
  it('có nút ở tin người dùng, thanh thay đổi cuối lượt, và thẻ ở cuối khi /rewind (recent)', () => {
    expect(chatView).toContain('<RewindTrigger');
    expect(chatView).toContain('<ChangeBar');
    expect(chatView).toMatch(/rw\?\.recent && <RewindCard/);
  });
  it('mọi khối mở ra có nút Thu gọn ở cuối (thanh thay đổi, danh sách kế hoạch)', () => {
    expect((component.match(/<CollapseFoot/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
  it('nút chỉ hiện khi host có checkpoint cho tin đó và trợ lý không đang chạy', () => {
    expect(component).toMatch(/!view\.checkpoints\?\.some\(\(c\) => c\.promptId === promptId\) \|\| view\.running\) return null/);
  });
});
