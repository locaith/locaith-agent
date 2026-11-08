import { describe, expect, it } from 'vitest';
import { graphemes, stringWidth, stripAnsi, truncateAnsi, truncatePlain, wrapAnsi, padCenter } from '../../../src/cli/tui/width';

describe('stringWidth', () => {
  it('ASCII', () => expect(stringWidth('hello')).toBe(5));
  it('chữ dựng sẵn tiếng Việt rộng 1', () => {
    expect(stringWidth('Tiếng Việt: ếợữ ƯƠ đ')).toBe([...'Tiếng Việt: ếợữ ƯƠ đ'].length);
  });
  it('dạng NFD (dấu kết hợp) rộng bằng dạng NFC', () => {
    const nfc = 'Việt Nam, người, được';
    expect(stringWidth(nfc.normalize('NFD'))).toBe(stringWidth(nfc));
  });
  it('CJK và emoji rộng 2', () => {
    expect(stringWidth('日本語')).toBe(6);
    expect(stringWidth('한글')).toBe(4);
    expect(stringWidth('😀')).toBe(2);
    expect(stringWidth('✅')).toBe(2);
    expect(stringWidth('👨‍👩‍👧')).toBe(2);
  });
  it('ký hiệu giao diện rộng 1', () => {
    for (const c of ['●', '⎿', '✻', '❯', '╭', '│', '─', '▀', '█', '⏵', '…']) expect(stringWidth(c), c).toBe(1);
  });
  it('bỏ qua mã ANSI và OSC 8', () => {
    expect(stringWidth('\x1b[31mđỏ\x1b[0m')).toBe(2);
    expect(stringWidth('\x1b]8;;https://a.b\x1b\\liên kết\x1b]8;;\x1b\\')).toBe(8);
  });
  it('ký tự điều khiển rộng 0', () => expect(stringWidth('a\x07b')).toBe(2));
});

describe('graphemes', () => {
  it('giữ dấu kết hợp cùng chữ gốc', () => expect(graphemes('ếx')).toEqual(['ế', 'x']));
  it('không tách cặp thay thế', () => expect(graphemes('a😀b')).toEqual(['a', '😀', 'b']));
});

describe('truncate', () => {
  it('thuần', () => expect(truncatePlain('abcdefgh', 5)).toBe('abcd…'));
  it('không cắt nếu vừa', () => expect(truncatePlain('abc', 5)).toBe('abc'));
  it('không cắt đôi chữ rộng 2', () => expect(stringWidth(truncatePlain('日本語日本語', 5))).toBeLessThanOrEqual(5));
  it('ANSI: đóng kiểu trước dấu …', () => {
    const r = truncateAnsi('\x1b[31mabcdefghij\x1b[0m', 5);
    expect(stripAnsi(r)).toBe('abcd…');
    expect(r).toContain('\x1b[0m');
  });
});

describe('wrapAnsi', () => {
  it('ngắt theo từ', () => {
    expect(wrapAnsi('xin chào các bạn rất vui', 10)).toEqual(['xin chào', 'các bạn', 'rất vui']);
  });
  it('mọi dòng không vượt độ rộng (tiếng Việt, NFD)', () => {
    const text = 'Trợ lý đang đọc tệp cấu hình và sửa lại đường dẫn không đúng trong dự án của bạn'.normalize('NFD');
    for (const w of [12, 20, 33, 60]) for (const l of wrapAnsi(text, w)) expect(stringWidth(l)).toBeLessThanOrEqual(w);
  });
  it('bẻ cứng từ quá dài', () => {
    const r = wrapAnsi('a'.repeat(25), 10);
    expect(r).toEqual(['a'.repeat(10), 'a'.repeat(10), 'aaaaa']);
  });
  it('giữ kiểu qua chỗ ngắt dòng và đóng ở cuối dòng', () => {
    const r = wrapAnsi('\x1b[1mmột hai ba bốn năm sáu\x1b[0m', 10);
    expect(r.length).toBeGreaterThan(1);
    for (const l of r) {
      expect(l.startsWith('\x1b[1m')).toBe(true);
      expect(l.endsWith('\x1b[0m')).toBe(true);
    }
    expect(r.map(stripAnsi)).toEqual(['một hai ba', 'bốn năm', 'sáu']);
  });
  it('liên kết OSC 8 được đóng/mở lại ở mỗi dòng', () => {
    const r = wrapAnsi('\x1b]8;;https://x.y\x1b\\hai từ dài\x1b]8;;\x1b\\', 5);
    for (const l of r) {
      expect(l).toContain('\x1b]8;;https://x.y');
      expect(l.endsWith('\x1b]8;;\x1b\\')).toBe(true);
    }
  });
  it('tiền tố dòng đầu / dòng sau', () => {
    expect(wrapAnsi('aa bb cc dd', 8, { first: '● ', rest: '  ' })).toEqual(['● aa bb', '  cc dd']);
  });
  it('xuống dòng trong đầu vào được giữ', () => {
    expect(wrapAnsi('a\n\nb', 10)).toEqual(['a', '', 'b']);
  });
  it('thụt lề đầu dòng được giữ ở dòng đầu', () => {
    expect(wrapAnsi('    thụt lề', 20)).toEqual(['    thụt lề']);
  });
  it('chế độ pre giữ khoảng trắng', () => {
    expect(wrapAnsi('  a  b', 20, { pre: true })).toEqual(['  a  b']);
    expect(wrapAnsi('abcdefgh', 3, { pre: true })).toEqual(['abc', 'def', 'gh']);
  });
  it('CJK ngắt giữa chữ', () => {
    const r = wrapAnsi('日本語のテキスト', 6);
    for (const l of r) expect(stringWidth(l)).toBeLessThanOrEqual(6);
    expect(r.join('')).toBe('日本語のテキスト');
  });
});

describe('padCenter', () => {
  it('căn giữa', () => expect(padCenter('ab', 6)).toBe('  ab  '));
});
