import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SuggestionOption } from '../../src/shared/protocol';
import { t } from '../../webview/src/i18n';
import { ALL_PROMPT_TOTAL_MAX, buildAllPrompt, shouldOfferAll } from '../../webview/src/optionsModel';

const ROOT = path.resolve(__dirname, '..', '..');
const src = (f: string): string => fs.readFileSync(path.join(ROOT, f), 'utf8');
const opt = (id: string, label: string, prompt: string, kind?: 'continue'): SuggestionOption => ({ id, label, prompt, ...(kind ? { kind } : {}) });

/** (0.7.2) Bảng lựa chọn cuối hội thoại + chip «Tất cả». */
describe('chip «Tất cả»: khi nào có', () => {
  it('cần ≥ 2 lựa chọn «hướng đi»', () => {
    expect(shouldOfferAll(undefined)).toBe(false);
    expect(shouldOfferAll([])).toBe(false);
    expect(shouldOfferAll([opt('a', 'A', 'làm A')])).toBe(false);
    expect(shouldOfferAll([opt('a', 'A', 'làm A'), opt('b', 'B', 'làm B')])).toBe(true);
  });
  it('không áp cho kiểu «Chạy tiếp»', () => {
    expect(shouldOfferAll([opt('c', 'Chạy tiếp phần 2', 'x', 'continue')])).toBe(false);
    expect(shouldOfferAll([opt('c1', 'Chạy tiếp', 'x', 'continue'), opt('c2', 'Chạy tiếp 2', 'y', 'continue')])).toBe(false);
    expect(shouldOfferAll([opt('a', 'A', 'x'), opt('c', 'Chạy tiếp', 'y', 'continue')])).toBe(false);
  });
});

describe('buildAllPrompt: MỘT tin liệt kê đủ các hướng', () => {
  const two = [opt('a', 'Dừng Retarget', 'Tạm dừng chiến dịch Retarget 30 ngày.'), opt('b', 'Loại trùng', 'Loại đối tượng trùng giữa hai chiến dịch.')];

  it('đúng khuôn «Làm tất cả các hướng sau, theo thứ tự hợp lý, rồi báo kết quả từng hướng: 1) … 2) …»', () => {
    expect(buildAllPrompt(two, 'vi')).toBe(
      'Làm tất cả các hướng sau, theo thứ tự hợp lý, rồi báo kết quả từng hướng: 1) Dừng Retarget — Tạm dừng chiến dịch Retarget 30 ngày. 2) Loại trùng — Loại đối tượng trùng giữa hai chiến dịch.',
    );
  });
  it('bản tiếng Anh', () => {
    expect(buildAllPrompt(two, 'en')).toMatch(/^Do all of the following directions, in a sensible order, then report the result of each one: 1\) Dừng Retarget — /);
  });
  it('nhãn trùng prompt không lặp; xuống dòng gộp thành một dòng', () => {
    const s = buildAllPrompt([opt('a', 'Làm A', 'Làm A'), opt('b', 'B', 'dòng 1\n\ndòng 2')], 'vi');
    expect(s).toContain('1) Làm A 2) B — dòng 1 dòng 2');
  });
  it('giới hạn độ dài: nhiều hướng với prompt dài vẫn ≤ trần, hướng cuối không bị mất', () => {
    const many = Array.from({ length: 8 }, (_, i) => opt(`o${i}`, `Hướng số ${i + 1}`, 'x '.repeat(900)));
    const s = buildAllPrompt(many, 'vi');
    expect(s.length).toBeLessThanOrEqual(ALL_PROMPT_TOTAL_MAX + 200);
    for (let i = 1; i <= 8; i++) expect(s).toContain(`${i}) Hướng số ${i}`);
    expect(s).toContain('…');
  });
});

describe('bảng lựa chọn nằm trong dòng hội thoại', () => {
  it('ChatView vẽ OptionsBar sau lượt cuối; App không còn vẽ ở chân khung', () => {
    expect(src('webview/src/components/ChatView.tsx')).toMatch(/<OptionsBar options=\{view\.options\} running=\{view\.running\} \/>/);
    const app = src('webview/src/App.tsx');
    expect(app).not.toContain('<OptionsBar');
    expect(app).not.toMatch(/import \{ OptionsBar \}/);
  });
  it('chip «Tất cả» chỉ vẽ khi shouldOfferAll và gửi MỘT tin qua `send` (không đổi giao thức)', () => {
    const bar = src('webview/src/components/OptionsBar.tsx');
    expect(bar).toContain('shouldOfferAll(options)');
    expect(bar).toContain("post({ type: 'send', text: buildAllPrompt(options, lang), attachments: [] })");
    expect(bar).toMatch(/\{all && \(/);
    expect(bar).toMatch(/setHidden\(sig\)/); // vẫn ẩn được («×»)
  });
  it('luật PHẲNG: biến thể trong hội thoại không viền kín/nền, không viền trái một bên', () => {
    const css = src('webview/src/styles/components.css');
    const block = /\.options-inline \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(block).toMatch(/border:\s*0/);
    expect(block).toMatch(/background:\s*transparent/);
    expect(css.slice(css.indexOf('.options-inline'), css.indexOf('/* ── Nút «Thu gọn»'))).not.toMatch(/border-left:\s*\d+px\s+solid/);
  });
  it('chuỗi vi/en', () => {
    expect(t('vi', 'options.all')).toBe('Tất cả');
    expect(t('en', 'options.all')).toBe('All');
    expect(t('vi', 'options.allHint')).toMatch(/tất cả các hướng/);
  });
});
