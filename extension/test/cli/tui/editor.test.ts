import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Editor, layoutRows } from '../../../src/cli/tui/editor';
import { History } from '../../../src/cli/tui/history';
import { Menu, applyCompletion, fileContext, filterSlash, slashContext } from '../../../src/cli/tui/suggest';
import { stringWidth } from '../../../src/cli/tui/width';

const ed = (s: string, c = s.length): Editor => {
  const e = new Editor();
  e.setText(s, c);
  return e;
};

describe('Editor — chỉnh sửa', () => {
  it('chèn, xoá lùi, Del theo cụm chữ (dấu kết hợp)', () => {
    const e = ed('');
    e.insert('Việt');
    expect(e.text).toBe('Việt');
    e.backspace();
    expect(e.text).toBe('Việ');
    const n = ed('êx', 2); // ê dạng NFD + x; con trỏ sau ê
    n.backspace();
    expect(n.text).toBe('x');
    const d = ed('êx', 0);
    d.del();
    expect(d.text).toBe('x');
  });
  it('bộ gõ «Unicode tổ hợp»: dấu kết hợp gõ RỜI sau chữ gốc được ghép thành chữ dựng sẵn (e + ̂ → ê, + ́ → ế); một Backspace xoá đúng một chữ', () => {
    const e = ed('vi');
    e.insert('e');
    e.insert('̂'); // U+0302 (mũ)
    expect(e.text).toBe('viê');
    e.insert('́'); // U+0301 (sắc)
    expect(e.text).toBe('viế');
    expect(e.cursor).toBe(3);
    expect([...e.text].length).toBe(3); // không còn dấu rời
    e.insert('t');
    e.backspace(); // t
    expect(e.text).toBe('viế');
    e.backspace(); // bộ gõ tổ hợp còn nhớ ế gồm e + mũ + sắc (gõ liền): bỏ dấu sắc
    expect(e.text).toBe('viê');
    e.backspace(); // bỏ mũ
    expect(e.text).toBe('vie');
    e.backspace(); // chữ gốc
    expect(e.text).toBe('vi');
  });
  // (0.4.10) Bộ gõ «Unicode tổ hợp» đổi dấu bằng cách xoá ĐÚNG dấu cuối rồi gõ dấu mới; Backspace xoá cả chữ ở đây nuốt chữ đứng trước («Việt» → «Vị̂t»).
  it('chữ vừa ghép từ dấu gõ RỜI: mỗi Backspace bỏ đúng MỘT dấu bộ gõ đã gửi (theo thứ tự gõ), rồi mới tới chữ gốc', () => {
    const e = ed('vi');
    e.insert('e');
    e.insert('̂'); // mũ
    e.insert('́'); // sắc → ế
    expect(e.text).toBe('viế');
    e.backspace(); // bỏ dấu sắc
    expect(e.text).toBe('viê');
    e.insert('̀'); // huyền → ề
    expect(e.text).toBe('viề');
    e.backspace();
    e.backspace(); // bỏ mũ → e
    expect(e.text).toBe('vie');
    e.backspace(); // chữ gốc
    expect(e.text).toBe('vi');
  });
  it('thứ tự gõ ≠ thứ tự NFD: e + mũ + chấm dưới (ệ) — Backspace bỏ CHẤM trước, không bỏ mũ', () => {
    const e = ed('');
    e.insert('Vie');
    e.insert('̂'); // mũ
    e.insert('̣'); // nặng (U+0323) — NFD sẽ xếp nó TRƯỚC mũ
    expect(e.text).toBe('Việ');
    e.backspace();
    expect(e.text).toBe('Viê'); // mũ còn, chấm mất
    e.insert('̣'); // gõ lại dấu nặng
    expect(e.text).toBe('Việ');
  });
  it('dấu và chữ gõ cùng một gói: dấu ghép vào chữ trước, phần chữ còn lại chèn sau; Backspace chữ cuối vẫn xoá một chữ', () => {
    const e = ed('vie');
    e.insert('̂t'); // mũ + t trong một gói
    expect(e.text).toBe('viêt');
    e.backspace(); // t
    expect(e.text).toBe('viê');
    e.backspace(); // ê ghép từ e + mũ (gõ liền): bỏ mũ
    expect(e.text).toBe('vie');
    e.backspace();
    expect(e.text).toBe('vi');
  });
  // (0.4.11) Bộ gõ «Unicode tổ hợp» KHÔNG chỉ xoá/sửa chữ cuối: khi người dùng nhấn Backspace trên chữ có dấu, bộ gõ nuốt phím rồi gửi N Backspace (N = số điểm mã của chữ ấy).
  // Chữ nằm trước vài chữ khác vẫn phải mất đúng N điểm mã — không phải N CHỮ («một lần nhấn mất cả cụm»).
  it('chữ có dấu rời không phải chữ cuối: N Backspace (N = số điểm mã bộ gõ đã gửi cho chữ ấy) xoá đúng chữ đó, không xoá thừa chữ đứng trước', () => {
    const e = ed('');
    e.insert('Vi');
    e.insert('e');
    e.insert('̂'); // mũ
    e.insert('̣'); // nặng → ệ (3 điểm mã: e + mũ + chấm)
    e.insert('tn'); // gõ tiếp: ệ không còn là chữ cuối
    expect(e.text).toBe('Việtn');
    e.backspace(); // n
    e.backspace(); // t
    expect(e.text).toBe('Việ');
    e.backspace();
    e.backspace();
    e.backspace(); // bộ gõ bù 3 Backspace cho ệ
    expect(e.text).toBe('Vi');
  });
  it('«Unicode tổ hợp chỉ dấu thanh» (UniKey): ê dựng sẵn + dấu sắc rời — chữ ế là 2 điểm mã nên 2 Backspace xoá đúng ế, giữ nguyên chữ đứng trước', () => {
    const e = ed('');
    e.insert('ti');
    e.insert('ê'); // dựng sẵn
    e.insert('́'); // sắc rời
    e.insert('ng');
    expect(e.text).toBe('tiếng');
    e.backspace();
    e.backspace(); // ng
    e.backspace();
    e.backspace(); // bù 2 Backspace cho ế = ê + ◌́
    expect(e.text).toBe('ti');
    const f = ed('');
    f.insert('tiê'); // ê dựng sẵn, bộ gõ gửi dấu sắc rời
    f.insert('́');
    f.backspace(); // chỉ bỏ dấu sắc: còn ê dựng sẵn (KHÔNG tụt về e)
    expect(f.text).toBe('tiê');
    f.backspace();
    expect(f.text).toBe('ti');
  });
  it('bất biến khi gõ/xoá/di chuyển ngẫu nhiên với dấu rời: không ném lỗi, con trỏ hợp lệ, bản ghi cách gõ luôn khớp đúng chữ trong văn bản', () => {
    let seed = 20261110;
    const rnd = (): number => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const pieces = ['a', 'e', 'ê', 'ư', 't', 'n', ' ', 'Việt', 'ế', '̂', '́', '̣', '̀', '̃', '😀', '\n', 'x', 'ng'];
    for (let run = 0; run < 3000; run++) {
      if (run % 500 === 0) seed = 20261110 + run * 7919; // vài hạt giống khác nhau
      const e = ed('');
      for (let step = 0; step < 50; step++) {
        const r = rnd();
        if (r < 0.5) e.insert(pieces[Math.floor(rnd() * pieces.length)]);
        else if (r < 0.74) e.backspace();
        else if (r < 0.79) e.left();
        else if (r < 0.84) e.right();
        else if (r < 0.87) e.home();
        else if (r < 0.9) e.end();
        else if (r < 0.93) e.del();
        else if (r < 0.96) e.deleteWordBack();
        else if (r < 0.98) e.killToEnd();
        else e.yank();
        expect(e.cursor).toBeGreaterThanOrEqual(0);
        expect(e.cursor).toBeLessThanOrEqual(e.text.length);
        const live = (e as unknown as { live(): Array<{ start: number; seq: string[] }> }).live();
        let prevEnd = 0;
        for (const rec of live) {
          const letter = rec.seq.join('').normalize('NFC');
          expect(rec.seq.length).toBeGreaterThanOrEqual(2);
          expect(rec.start).toBeGreaterThanOrEqual(prevEnd);
          expect(e.text.slice(rec.start, rec.start + letter.length)).toBe(letter);
          prevEnd = rec.start + letter.length;
        }
      }
    }
  });
  it('cách gõ chỉ nhớ khi gõ liền: nhảy con trỏ, nạp lại hay sửa kiểu khác thì Backspace xoá cả chữ như thường', () => {
    const e = ed('');
    e.insert('Vie');
    e.insert('̂');
    e.insert('̣');
    e.insert('t');
    e.home();
    e.end(); // con trỏ nhảy → bộ gõ cũng đã bỏ bộ đệm
    e.backspace(); // t
    e.backspace(); // ệ cả chữ
    expect(e.text).toBe('Vi');
  });
  it('tail hết hiệu lực khi con trỏ rời đi / văn bản đổi: Backspace quay về xoá cả chữ (không bỏ dấu "ma")', () => {
    const e = ed('');
    e.insert('Vie');
    e.insert('̂');
    e.insert('́');
    expect(e.text).toBe('Viế');
    e.left();
    e.right();
    e.backspace();
    expect(e.text).toBe('Vi');
    const f = ed('');
    f.insert('Vie');
    f.insert('̂');
    f.setText(f.text); // nạp lại (lịch sử): không còn biết thứ tự gõ
    f.backspace();
    expect(f.text).toBe('Vi');
  });
  it('chữ dựng sẵn (bộ gõ dựng sẵn, không dấu rời) vẫn xoá nguyên chữ mỗi Backspace', () => {
    const e = ed('');
    e.insert('Việt');
    e.backspace();
    e.backspace();
    expect(e.text).toBe('Vi');
  });
  it('gõ nhanh cả cụm dạng NFD một lần (tie + ̂ + ́ + ng) → NFC; chữ không có dấu kết hợp giữ NGUYÊN (không đụng nội dung dán)', () => {
    const e = ed('');
    e.insert('tiếng'); // t i e ̂ ́ n g (NFD)
    expect(e.text).toBe('tiếng'.normalize('NFC'));
    expect(e.text.length).toBe(5);
    const p = ed('');
    const raw = 'e‍́x'; // có ZWJ + dấu: không phải việc của ô nhập; chỉ kiểm không ném và không mất chữ
    p.insert(raw);
    expect(p.text.includes('x')).toBe(true);
    const plain = ed('');
    plain.insert('hello wörld ✓');
    expect(plain.text).toBe('hello wörld ✓');
  });
  it('dấu kết hợp đứng ĐẦU ô trống (không có chữ gốc) vẫn được chèn, không ném lỗi', () => {
    const e = ed('');
    e.insert('̂');
    expect(e.text).toBe('̂');
  });
  it('emoji ZWJ là một cụm', () => {
    const e = ed('a👨‍👩‍👧b', 'a👨‍👩‍👧'.length);
    e.backspace();
    expect(e.text).toBe('ab');
  });
  it('trái/phải', () => {
    const e = ed('ab', 1);
    e.left();
    expect(e.cursor).toBe(0);
    e.right();
    e.right();
    e.right();
    expect(e.cursor).toBe(2);
  });
  it('nhảy từ / xoá từ (tiếng Việt)', () => {
    const e = ed('xin chào  các bạn');
    e.wordLeft();
    expect(e.text.slice(e.cursor)).toBe('bạn');
    e.wordLeft();
    expect(e.text.slice(e.cursor)).toBe('các bạn');
    e.wordRight();
    expect(e.text.slice(0, e.cursor)).toBe('xin chào  các');
    const w = ed('xin chào  các bạn');
    w.deleteWordBack();
    expect(w.text).toBe('xin chào  các ');
    expect(w.killed).toBe('bạn');
    w.yank();
    expect(w.text).toBe('xin chào  các bạn');
  });
  it('Ctrl+A/E/K/U theo dòng logic', () => {
    const e = ed('dòng một\ndòng hai', 'dòng một\ndòng'.length);
    e.home();
    expect(e.cursor).toBe('dòng một\n'.length);
    e.end();
    expect(e.cursor).toBe(e.text.length);
    e.setText('dòng một\ndòng hai', 'dòng một\ndòng'.length);
    e.killToEnd();
    expect(e.text).toBe('dòng một\ndòng');
    e.killToStart();
    expect(e.text).toBe('dòng một\n');
    e.killToStart(); // ở đầu dòng: xoá dấu xuống dòng
    expect(e.text).toBe('dòng một');
  });
  it('Ctrl+K ở cuối dòng xoá dấu xuống dòng', () => {
    const e = ed('a\nb', 1);
    e.killToEnd();
    expect(e.text).toBe('ab');
  });
});

describe('layoutRows', () => {
  it('ngắt theo từ, không vượt độ rộng', () => {
    const t = 'xin chào các bạn rất vui được gặp';
    const rows = layoutRows(t, 10);
    for (const r of rows) expect(stringWidth(t.slice(r.start, r.end))).toBeLessThanOrEqual(10);
    expect(rows.map((r) => t.slice(r.start, r.end))).toEqual(['xin chào ', 'các bạn ', 'rất vui ', 'được gặp']);
  });
  it('bẻ cứng từ dài', () => {
    const rows = layoutRows('a'.repeat(25), 10);
    expect(rows).toHaveLength(3);
  });
  it('dòng logic và dòng trống', () => {
    const rows = layoutRows('a\n\nb', 10);
    expect(rows.map((r) => [r.line, r.start, r.end])).toEqual([[0, 0, 1], [1, 2, 2], [2, 3, 4]]);
  });
  it('phủ kín văn bản (không mất ký tự)', () => {
    const t = 'Tiếng Việt có dấu: ế ợ ữ — và 日本語 😀 nữa nhé!';
    const rows = layoutRows(t, 7);
    expect(rows.map((r) => t.slice(r.start, r.end)).join('')).toBe(t);
  });
});

describe('Editor — con trỏ và di chuyển dọc', () => {
  it('cursorPos', () => {
    const e = ed('abc def ghi', 6);
    expect(e.cursorPos(80)).toEqual({ row: 0, col: 6 });
    const e2 = ed('abc def ghi', 9);
    expect(e2.cursorPos(5)).toEqual({ row: 2, col: 1 });
  });
  it('lên/xuống giữ cột mong muốn; false ở biên', () => {
    const e = ed('hello world\nhi\nhello again', 'hello world\nhi\nhello'.length);
    expect(e.moveVertical(-1, 80)).toBe(true); // → dòng "hi"
    expect(e.cursor).toBe('hello world\nhi'.length);
    expect(e.moveVertical(-1, 80)).toBe(true); // → quay về cột 5 của dòng đầu
    expect(e.cursor).toBe(5);
    expect(e.moveVertical(-1, 80)).toBe(false);
    e.setText('x', 1);
    expect(e.moveVertical(1, 80)).toBe(false);
  });
  it('renderRows: con trỏ giả đảo màu, kể cả ở cuối', () => {
    const e = ed('ab', 1);
    expect(e.renderRows(10, (s) => `[${s}]`).rows).toEqual(['a[b]']);
    const f = ed('ab');
    expect(f.renderRows(10, (s) => `[${s}]`).rows).toEqual(['ab[ ]']);
    expect(f.renderRows(10, (s) => `[${s}]`, false).rows).toEqual(['ab']);
  });
  it('con trỏ giả trên chữ kết hợp lấy cả cụm', () => {
    const e = ed('êx', 0);
    expect(e.renderRows(10, (s) => `[${s}]`).rows).toEqual(['[ê]x']);
  });
});

describe('History', () => {
  const tmp = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-hist-')), 'sub', 'history');
  it('thêm, bỏ trùng liền kề, bỏ rỗng, duyệt giữ nháp', () => {
    const h = new History(null);
    h.add('a');
    h.add('a');
    h.add('   ');
    h.add('b');
    expect(h.entries).toEqual(['a', 'b']);
    expect(h.prev('đang gõ')).toBe('b');
    expect(h.prev('')).toBe('a');
    expect(h.prev('')).toBeUndefined();
    expect(h.next()).toBe('b');
    expect(h.next()).toBe('đang gõ');
    expect(h.next()).toBeUndefined();
  });
  it('lưu đĩa nhiều dòng, giới hạn 300, đọc lại', () => {
    const f = tmp();
    const h = new History(f, 300);
    h.add('dòng 1\ndòng 2');
    for (let i = 0; i < 305; i++) h.add('m' + i);
    const h2 = new History(f, 300);
    expect(h2.entries).toHaveLength(300);
    expect(h2.entries[299]).toBe('m304');
    const h3 = new History(f, 300);
    expect(h3.entries.includes('dòng 1\ndòng 2')).toBe(false); // đã bị đẩy ra
    const g = new History(tmp());
    g.add('đa\ndòng');
    expect(new History((g as unknown as { file: string }).file).entries).toEqual(['đa\ndòng']);
  });
  it('tệp thô / hỏng không làm hỏng', () => {
    const f = tmp();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'thô 1\n"json 2"\n"hỏng\n\n');
    const h = new History(f);
    expect(h.entries).toEqual(['thô 1', 'json 2']);
  });
  it('đường dẫn không ghi được → không ném', () => {
    const h = new History(path.join(os.tmpdir(), 'lc-no', '\0bad', 'history'));
    expect(() => h.add('x')).not.toThrow();
  });
  it('tìm ngược', () => {
    const h = new History(null);
    ['git status', 'npm test', 'git push'].forEach((x) => h.add(x));
    expect(h.search('GIT')).toBe(2);
    expect(h.search('git', 1)).toBe(0);
    expect(h.search('zzz')).toBe(-1);
  });
});

describe('suggest', () => {
  const cmds = [
    { name: 'help', description: 'Trợ giúp' },
    { name: 'clear', description: 'Xoá hội thoại' },
    { name: 'compact', description: 'Nén ngữ cảnh' },
    { name: 'model', description: 'Chọn model' },
    { name: 'resume', description: 'Mở lại phiên (compact history)' },
  ];
  it('ngữ cảnh /', () => {
    expect(slashContext('/co', 3)).toEqual({ query: 'co', range: { start: 0, end: 3 } });
    expect(slashContext('/co arg', 7)).toBeNull();
    expect(slashContext('xin /co', 7)).toBeNull();
  });
  it('ngữ cảnh @', () => {
    expect(fileContext('xem @src/a', 10)).toEqual({ query: 'src/a', range: { start: 4, end: 10 } });
    expect(fileContext('mail a@b', 8)).toBeNull();
  });
  it('lọc: tiền tố trước, rồi chứa', () => {
    expect(filterSlash(cmds, 'co').map((x) => x.label)).toEqual(['/compact', '/resume']);
    expect(filterSlash(cmds, '').map((x) => x.label)[0]).toBe('/clear');
    expect(filterSlash(cmds, 'zz')).toEqual([]);
  });
  it('áp dụng gợi ý', () => {
    expect(applyCompletion('xem @sr rồi', { start: 4, end: 7 }, '@src/a.ts ')).toEqual({ text: 'xem @src/a.ts  rồi', cursor: 14 });
  });
  it('Menu: chọn vòng tròn và cuộn cửa sổ', () => {
    const m = new Menu(3);
    m.set('slash', Array.from({ length: 6 }, (_, i) => ({ label: '/c' + i, insert: '/c' + i + ' ' })), { start: 0, end: 1 });
    expect(m.visible.map((v) => v.index)).toEqual([0, 1, 2]);
    m.move(-1);
    expect(m.sel).toBe(5);
    expect(m.visible.map((v) => v.index)).toEqual([3, 4, 5]);
    m.move(1);
    expect(m.sel).toBe(0);
    expect(m.top).toBe(0);
  });
  it('Menu giữ lựa chọn khi gõ thêm', () => {
    const m = new Menu();
    m.set('slash', [{ label: '/a', insert: '' }, { label: '/b', insert: '' }], { start: 0, end: 1 });
    m.move(1);
    m.set('slash', [{ label: '/b', insert: '' }, { label: '/c', insert: '' }], { start: 0, end: 2 });
    expect(m.current?.label).toBe('/b');
  });
});
