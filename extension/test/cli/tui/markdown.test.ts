import { describe, expect, it } from 'vitest';
import { MarkdownStream, renderInline, renderMarkdown, renderTable } from '../../../src/cli/tui/markdown';
import { detectCaps, makeTheme } from '../../../src/cli/tui/theme';
import { stringWidth, stripAnsi } from '../../../src/cli/tui/width';

const plainTh = makeTheme(detectCaps({ env: { NO_COLOR: '1', LANG: 'en_US.UTF-8' } as NodeJS.ProcessEnv }));
const colorTh = makeTheme(detectCaps({ env: { COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' } as NodeJS.ProcessEnv }));
const asciiTh = makeTheme(detectCaps({ env: { NO_COLOR: '1', LOCAITH_ASCII: '1' } as NodeJS.ProcessEnv }));

const md = (t: string, width = 60, th = plainTh) => renderMarkdown(t, { width, theme: th }).map(stripAnsi);

describe('inline', () => {
  it('đậm / nghiêng / mã', () => {
    const r = renderInline('a **đậm** và *nghiêng* và `mã`', colorTh);
    expect(stripAnsi(r)).toBe('a đậm và nghiêng và mã');
    expect(r).toContain('\x1b[1m');
    expect(r).toContain('\x1b[3m');
  });
  it('gạch ngang, escape', () => {
    expect(stripAnsi(renderInline('~~x~~ \\*lit\\*', colorTh))).toBe('x *lit*');
  });
  it('dấu * trong từ không thành nghiêng', () => {
    expect(stripAnsi(renderInline('2*3*4 và snake_case_name', colorTh))).toBe('2*3*4 và snake_case_name');
  });
  it('liên kết khi không hỗ trợ OSC 8: chữ (url)', () => {
    expect(stripAnsi(renderInline('[trang](https://locaith.ai)', colorTh))).toBe('trang (https://locaith.ai)');
  });
  it('liên kết OSC 8', () => {
    const th = makeTheme({ ...colorTh.caps, hyperlinks: true });
    const r = renderInline('[trang](https://locaith.ai)', th);
    expect(r).toContain('\x1b]8;;https://locaith.ai');
    expect(stripAnsi(r)).toBe('trang');
  });
  it('URL trần được gạch chân, không dính dấu câu cuối', () => {
    expect(stripAnsi(renderInline('xem https://a.b/c.', colorTh))).toBe('xem https://a.b/c.');
  });
});

describe('block', () => {
  it('đoạn có tiền tố ● và thụt dòng sau', () => {
    const out = renderMarkdown('Xin chào các bạn, đây là một đoạn văn khá dài để kiểm tra ngắt dòng', { width: 30, theme: plainTh, firstPrefix: '● ', prefix: '  ' }).map(stripAnsi);
    expect(out[0].startsWith('● ')).toBe(true);
    expect(out.slice(1).every((l) => l.startsWith('  '))).toBe(true);
    expect(out.every((l) => stringWidth(l) <= 30)).toBe(true);
  });
  it('tiêu đề, đường kẻ, trích dẫn', () => {
    const out = md('# Tiêu đề\n\nnội dung\n\n---\n\n> trích dẫn');
    expect(out[0]).toBe('Tiêu đề');
    expect(out).toContain('nội dung');
    expect(out.some((l) => /^─+$/.test(l))).toBe(true);
    expect(out.some((l) => l.startsWith('▎ trích dẫn'))).toBe(true);
  });
  it('danh sách lồng và số, treo lề', () => {
    const out = md('- một\n  - hai lồng\n1. đầu\n2. thứ hai rất dài rất dài rất dài rất dài rất dài rất dài rất dài', 30);
    expect(out[0]).toBe('• một');
    expect(out[1]).toBe('  • hai lồng');
    expect(out[2]).toBe('1. đầu');
    expect(out[4].startsWith('   ')).toBe(true);
  });
  it('danh sách việc [ ] / [x]', () => {
    const out = md('- [ ] chưa\n- [x] xong');
    expect(out[0]).toBe('☐ chưa');
    expect(out[1]).toBe('☒ xong');
  });
  it('khối mã có đầu/chân, gutter, tên ngôn ngữ', () => {
    const out = md('```ts\nconst a = 1;\nreturn a\n```\nsau');
    expect(out[0]).toContain('╭─ ts');
    expect(out[1]).toBe('│ const a = 1;');
    expect(out[3]).toBe('╰─');
    expect(out[4]).toBe('sau');
  });
  it('khối mã không đóng được đóng khi kết thúc', () => {
    const out = md('```py\nprint(1)');
    expect(out[out.length - 1]).toBe('╰─');
  });
  it('khối mã có màu: từ khoá, chuỗi, số, chú thích', () => {
    const out = renderMarkdown('```js\nconst s = "x"; // ghi chú\nlet n = 42\n```', { width: 60, theme: colorTh });
    const joined = out.join('\n');
    expect(joined).toContain('\x1b[1m'); // keyword đậm
    expect(stripAnsi(out[1])).toBe('│ const s = "x"; // ghi chú');
    expect(out[1]).toMatch(/\x1b\[3m/); // chú thích nghiêng
  });
  it('dòng mã dài được bẻ cứng không vượt độ rộng', () => {
    const out = md('```\n' + 'x'.repeat(100) + '\n```', 40);
    expect(out.every((l) => stringWidth(l) <= 40)).toBe(true);
  });
  it('ASCII: khung mã và bullet', () => {
    const out = md('- a\n```\nb\n```', 40, asciiTh);
    expect(out[0]).toBe('- a');
    expect(out.some((l) => l.startsWith('+-'))).toBe(true);
  });
  it('gộp nhiều dòng trống', () => {
    expect(md('a\n\n\n\nb')).toEqual(['a', '', 'b']);
  });
});

describe('bảng', () => {
  const table = '| Tên | Tuổi | Ghi chú |\n|---|:-:|--:|\n| An | 30 | ok |\n| Bình | 25 | đang làm việc ở Hà Nội |';
  it('vẽ khung, căn cột', () => {
    const out = md(table, 60);
    expect(out[0].startsWith('┌') || out[0].startsWith('╭')).toBe(true);
    expect(out[out.length - 1].startsWith('╰') || out[out.length - 1].startsWith('└')).toBe(true);
    expect(out.some((l) => l.includes('Tên') && l.includes('Tuổi'))).toBe(true);
    const w = stringWidth(out[0]);
    expect(out.every((l) => stringWidth(l) === w)).toBe(true);
  });
  it('co theo chiều rộng hẹp và ngắt ô', () => {
    const out = md(table, 32);
    expect(out.every((l) => stringWidth(l) <= 32)).toBe(true);
    expect(out.join(' ')).toContain('Hà');
  });
  it('rất hẹp → dạng bản ghi', () => {
    const out = md(table, 16);
    expect(out.every((l) => stringWidth(l) <= 16)).toBe(true);
    expect(out.join('\n')).toContain('Tên: An');
  });
  it('hàng có | nhưng không phải bảng thật → đoạn thường', () => {
    const out = md('| chỉ một dòng |\ntiếp');
    expect(out.join('\n')).toContain('chỉ một dòng');
  });
  it('ASCII dùng +-|', () => {
    const out = renderTable(['| a | b |', '|---|---|', '| 1 | 2 |'], 40, asciiTh);
    expect(out[0]).toMatch(/^\+-+\+-+\+$/);
  });
});

describe('MarkdownStream (stream từng đoạn)', () => {
  const feedChars = (text: string, width: number) => {
    const s = new MarkdownStream({ width, theme: plainTh, firstPrefix: '● ', prefix: '  ' });
    const out: string[] = [];
    for (const ch of text) out.push(...s.push(ch));
    out.push(...s.finish());
    return out.map(stripAnsi);
  };
  it('stream từng ký tự cho kết quả giống render một lần', () => {
    const text = '# Tiêu đề\n\nĐoạn một có **đậm** và `mã` khá dài để ngắt dòng ở độ rộng hẹp.\n\n- mục a\n- mục b\n\n```ts\nlet x = 1\n```\n\nKết thúc.\n';
    for (const w of [24, 40, 80]) {
      const whole = renderMarkdown(text, { width: w, theme: plainTh, firstPrefix: '● ', prefix: '  ' }).map(stripAnsi);
      const chars = feedChars(text, w);
      while (chars.length && chars[chars.length - 1] === '') chars.pop();
      expect(chars).toEqual(whole);
    }
  });
  it('dòng dài chưa có \\n được cam kết dần theo hàng, hàng cuối ở partial', () => {
    const s = new MarkdownStream({ width: 20, theme: plainTh, firstPrefix: '● ', prefix: '  ' });
    const committed = s.push('một hai ba bốn năm sáu bảy tám chín mười mười một mười hai');
    expect(committed.length).toBeGreaterThan(0);
    const part = s.partial();
    expect(part.length).toBe(1);
    const tail = s.finish();
    const all = [...committed, ...tail].map(stripAnsi).join(' ');
    expect(all.replace(/\s+/g, ' ')).toContain('● một hai');
    expect(all.replace(/\s+/g, ' ')).toContain('mười hai');
  });
  it('không cam kết khi còn **đậm chưa đóng', () => {
    const s = new MarkdownStream({ width: 20, theme: plainTh });
    expect(s.push('xin chào **các bạn sẽ thấy rằng điều này rất dài và chưa đóng')).toEqual([]);
    expect(s.partial().length).toBeGreaterThan(1);
  });
  it('khối mã đang mở: dòng dở nằm ở partial', () => {
    const s = new MarkdownStream({ width: 40, theme: plainTh });
    s.push('```js\nconst a');
    expect(s.partial().map(stripAnsi)).toEqual(['│ const a']);
  });
  it('bảng đang đến dần được giữ ở partial rồi vẽ khi xong', () => {
    const s = new MarkdownStream({ width: 40, theme: plainTh });
    const o1 = s.push('| a | b |\n|---|---|\n| 1 | 2 |\n');
    expect(o1).toEqual([]);
    expect(s.partial().length).toBe(3);
    const o2 = s.push('hết\n');
    expect(/^[┌╭]/.test(o2.map(stripAnsi)[0])).toBe(true);
  });
  it('không bao giờ vượt độ rộng với tiếng Việt NFD', () => {
    const text = 'Trợ lý đang đọc tệp cấu hình và sửa lại đường dẫn không đúng. '.repeat(5).normalize('NFD');
    const out = feedChars(text + '\n', 33);
    expect(out.every((l) => stringWidth(l) <= 33)).toBe(true);
  });
});
