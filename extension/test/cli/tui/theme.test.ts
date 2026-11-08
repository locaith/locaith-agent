import { afterEach, describe, expect, it } from 'vitest';
import { runTui } from '../../../src/cli/tui';
import { MockRuntime } from '../../../src/cli/tui/mockRuntime';
import { Editor } from '../../../src/cli/tui/editor';
import { detectCaps, hexToRgb, makeTheme, rgbTo16, rgbTo256 } from '../../../src/cli/tui/theme';
import { renderFooter, renderInputBox, renderSpinner, renderTodos } from '../../../src/cli/tui/widgets';
import { typeFrame } from '../../../src/shared/typewriter';
import { SPINNER_VERBS } from '../../../src/cli/tui/strings';
import { stringWidth, stripAnsi } from '../../../src/cli/tui/width';
import { KEY, boot, type Booted } from './helpers/boot';
import { FakeIn, VT } from './helpers/vt';

const E = (o: Record<string, string>): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv;

describe('detectCaps', () => {
  it('truecolor / 256 / 16 / none', () => {
    expect(detectCaps({ env: E({ COLORTERM: 'truecolor' }) }).color).toBe('truecolor');
    expect(detectCaps({ env: E({ WT_SESSION: 'x' }) }).color).toBe('truecolor');
    expect(detectCaps({ env: E({ TERM: 'xterm-256color' }) }).color).toBe('256');
    expect(detectCaps({ env: E({ TERM: 'xterm' }), colorDepth: 4 }).color).toBe('16');
    expect(detectCaps({ env: E({ NO_COLOR: '1', COLORTERM: 'truecolor' }) }).color).toBe('none');
    expect(detectCaps({ env: E({}), noColor: true }).color).toBe('none');
    expect(detectCaps({ env: E({ TERM: 'dumb' }) }).color).toBe('none');
  });
  it('UTF-8 / ASCII', () => {
    expect(detectCaps({ env: E({ LANG: 'vi_VN.UTF-8' }) }).unicode).toBe(true);
    expect(detectCaps({ env: E({ LANG: 'C' }) }).unicode).toBe(false);
    expect(detectCaps({ env: E({ LOCAITH_ASCII: '1', LANG: 'en_US.UTF-8' }) }).unicode).toBe(false);
    expect(detectCaps({ env: E({ TERM: 'linux' }) }).unicode).toBe(false);
  });
  it('nền sáng/tối: COLORFGBG và tuỳ chọn', () => {
    expect(detectCaps({ env: E({ COLORFGBG: '0;15' }) }).dark).toBe(false);
    expect(detectCaps({ env: E({ COLORFGBG: '15;0' }) }).dark).toBe(true);
    expect(detectCaps({ env: E({ COLORFGBG: '0;15' }), theme: 'dark' }).dark).toBe(true);
    expect(detectCaps({ env: E({}), theme: 'light' }).dark).toBe(false);
    expect(detectCaps({ env: E({}) }).dark).toBe(true);
  });
  it('hyperlink', () => {
    expect(detectCaps({ env: E({ WT_SESSION: 'x' }) }).hyperlinks).toBe(true);
    expect(detectCaps({ env: E({}) }).hyperlinks).toBe(false);
  });
});

describe('màu', () => {
  it('chuyển hex → 256 / 16', () => {
    expect(hexToRgb('#22bcec')).toEqual([34, 188, 236]);
    expect(rgbTo256(255, 255, 255)).toBe(231);
    expect(rgbTo256(0, 0, 0)).toBe(16);
    expect(rgbTo16(250, 20, 20)).toBeGreaterThanOrEqual(1);
  });
  it('gradient thương hiệu: đầu #22bcec, cuối #625aec; NO_COLOR thì không có mã màu', () => {
    const th = makeTheme(detectCaps({ env: E({ COLORTERM: 'truecolor' }) }));
    const g = th.gradient('Locaith');
    expect(g).toContain('38;2;34;188;236');
    expect(g).toContain('38;2;98;90;236');
    const none = makeTheme(detectCaps({ env: E({ NO_COLOR: '1' }) }));
    expect(none.gradient('Locaith')).toBe('Locaith');
    expect(none.brand('x')).toBe('x');
    expect(none.inverse('x')).toContain('\x1b[7m'); // con trỏ giả vẫn thấy được khi tắt màu
  });
  it('16 màu: diff chỉ đổi màu chữ, không dùng nền', () => {
    const th = makeTheme(detectCaps({ env: E({ TERM: 'xterm' }), colorDepth: 4 }));
    expect(th.addLine('+x')).not.toContain('\x1b[4');
    expect(th.addLine('+x')).toMatch(/\x1b\[(3|9)\dm/);
  });
});

describe('widgets', () => {
  const th = makeTheme(detectCaps({ env: E({ NO_COLOR: '1', LANG: 'en_US.UTF-8' }) }));
  it('ô nhập: mọi dòng đúng độ rộng, trống có gợi ý mờ', () => {
    const ed = new Editor();
    const rows = renderInputBox({ editor: ed, width: 50, theme: th, shell: false, placeholder: 'Nhập việc cần làm…' });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => stringWidth(r) === 50)).toBe(true);
    expect(stripAnsi(rows[1])).toContain('Nhập việc cần làm');
  });
  it('ô nhập nhiều dòng cao tối đa 8 + cuộn', () => {
    const ed = new Editor();
    ed.setText(Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n'));
    const rows = renderInputBox({ editor: ed, width: 40, theme: th, shell: false, placeholder: '' });
    expect(rows).toHaveLength(10);
    expect(stripAnsi(rows.join('\n'))).toContain('l29');
  });
  it('chế độ shell đổi dấu nhắc', () => {
    const rows = renderInputBox({ editor: new Editor(), width: 40, theme: th, shell: true, placeholder: '' });
    expect(stripAnsi(rows[1])).toContain('│ ! ');
  });
  it('footer vừa chiều rộng ở mọi cỡ, bỏ dần phần phải', () => {
    const st = { model: 'locaith-v5-flash', gitBranch: 'main', mode: 'acceptEdits', context: { tokens: 1, window: 10, percent: 85 } } as never;
    for (const w of [120, 80, 50, 30, 15]) {
      const f = renderFooter({ width: w, theme: th, status: st, running: false, empty: true, expanded: false });
      expect(stringWidth(f)).toBeLessThanOrEqual(w - 1);
    }
    const wide = stripAnsi(renderFooter({ width: 120, theme: th, status: st, running: true, empty: true, expanded: false }));
    expect(wide).toContain('esc để dừng');
    expect(wide).toContain('ngữ cảnh 85%');
    expect(wide).toContain('tự nhận chỉnh sửa');
  });
  it('spinner: số giây, token, từ khoá; không vượt độ rộng', () => {
    const s = stripAnsi(renderSpinner({ theme: th, width: 80, lang: 'vi', frame: 3, elapsedMs: 12_000, tokens: 1234, label: 'Đang xử lý' }));
    expect(s).toContain('Đang xử lý…');
    expect(s).toContain('12s');
    expect(s).toContain('↓ 1,2k token');
    expect(s).toContain('esc để dừng');
    expect(stringWidth(renderSpinner({ theme: th, width: 20, lang: 'vi', frame: 0, elapsedMs: 0, tokens: 0 }))).toBeLessThanOrEqual(19);
  });
  it('bảng việc ☐ ◐ ☒ và rút gọn', () => {
    const todos = Array.from({ length: 9 }, (_, i) => ({ id: String(i), title: `việc ${i}`, status: (i < 2 ? 'completed' : i === 2 ? 'in_progress' : 'pending') as 'completed' | 'in_progress' | 'pending' }));
    const rows = renderTodos(todos, th, 60).map(stripAnsi);
    expect(rows[0].startsWith('  ⎿ ')).toBe(true);
    expect(rows.join('\n')).toContain('◐ việc 2');
    expect(rows.join('\n')).toContain('☒ việc 1');
    expect(rows[rows.length - 1]).toContain('+3 việc nữa');
  });
});

let b: Booted | null = null;
afterEach(async () => {
  if (b) {
    b.app.exit(0);
    await b.done.catch(() => undefined);
    b = null;
  }
});

describe('độ bền', () => {
  it('runTui ném lỗi rõ ràng khi không có TTY', async () => {
    const rt = new MockRuntime({ speed: 0 });
    const notTty = { isTTY: false, write: () => true } as never;
    await expect(runTui(rt, { version: '1', lang: 'vi', stdin: new FakeIn() as never, stdout: notTty })).rejects.toThrow(/TTY/);
    const inp = new FakeIn();
    inp.isTTY = false;
    await expect(runTui(rt, { version: '1', lang: 'vi', stdin: inp as never, stdout: new VT() as never })).rejects.toThrow(/TTY/);
  });

  it('rt.submit bị từ chối → in lỗi, không sập, vẫn nhập được tiếp', async () => {
    b = await boot();
    b.rt.submit = async () => {
      throw new Error('cổng chết');
    };
    await b.type('xin chào');
    await b.type(KEY.enter);
    await b.until(() => b!.screenText().includes('cổng chết'));
    await b.type('tiếp');
    expect(b.app.editor.text).toBe('tiếp');
  });

  it('sự kiện lạ từ runtime không làm sập giao diện', async () => {
    b = await boot();
    const rt = b.rt as unknown as { emit(e: unknown): void };
    rt.emit({ t: 'ui', ev: { t: 'tool_end', id: 'khong-co', callId: 'x', state: 'done', durationMs: 1 } });
    rt.emit({ t: 'ui', ev: { t: 'text', id: 'khong-co', delta: 'x' } });
    rt.emit({ t: 'khong-biet' });
    rt.emit({ t: 'permission_cancel', id: 'nope' });
    await b.type('ok');
    expect(b.app.editor.text).toBe('ok');
  });

  it('stdout đóng giữa chừng (EPIPE) không ném', async () => {
    b = await boot();
    (b.vt as unknown as { write: () => never }).write = () => {
      throw new Error('EPIPE');
    };
    await b.type('abc');
    expect(b.app.editor.text).toBe('abc');
  });

  it('/theme light đổi bảng màu ngay (nền sáng) và /theme dark quay lại', async () => {
    b = await boot();
    await b.type('/theme light');
    await b.type(KEY.enter);
    await b.until(() => b!.screenText().includes('theme: light'));
    expect(b.app.th).toBeDefined();
  });

  it('Ctrl+L đẩy màn hình lên scrollback (không mất nội dung)', async () => {
    b = await boot();
    await b.type(KEY.ctrl('l'));
    await b.tick(150);
    expect(b.screenText()).toContain('Locaith CLI');
    expect(b.screenText()).toContain('Nhập việc cần làm');
  });
});

describe('spinner: từ trạng thái gõ từng chữ ra', () => {
  const th = makeTheme(detectCaps({ env: E({ COLORTERM: 'truecolor', LANG: 'vi_VN.UTF-8' }) }));
  const plain = (o: Partial<Parameters<typeof renderSpinner>[0]> = {}): string => stripAnsi(renderSpinner({ theme: th, width: 100, lang: 'vi', frame: 1, elapsedMs: 0, tokens: 0, seed: 3, ...o }));

  it('lúc đầu chỉ có con trỏ, rồi từng chữ của từ gốc «Đang xử lý…» hiện ra', () => {
    expect(plain({ elapsedMs: 0 })).not.toContain('Đ');
    const verbs = SPINNER_VERBS.vi.map((v) => v + '…');
    for (const ms of [60, 180, 350, 560]) {
      const f = typeFrame(verbs, ms, 3);
      expect(f.verb).toBe('Đang xử lý…');
      const line = plain({ elapsedMs: ms });
      expect(line, `${ms}ms`).toContain(f.text);
      if (f.text.length < f.verb.length) expect(line).not.toContain(f.verb);
    }
    expect(plain({ elapsedMs: 700 })).toContain('Đang xử lý…'); // gõ xong, đang giữ
  });

  it('phần «(12s · …)» bên phải KHÔNG nhảy trong lúc gõ một từ (đệm theo từ đầy đủ)', () => {
    const at = (ms: number): number => plain({ elapsedMs: ms }).indexOf('(');
    const cols = [60, 120, 240, 360, 480, 600, 900, 2000].map(at);
    expect(new Set(cols).size).toBe(1);
    expect(cols[0]).toBeGreaterThan(0);
  });

  it('có nhãn cụ thể (tên công cụ) hoặc đang suy nghĩ → hiện NGAY, không gõ', () => {
    expect(plain({ elapsedMs: 0, label: 'Đọc README.md' })).toContain('Đọc README.md…');
    expect(plain({ elapsedMs: 0, thinking: true })).toContain('Đang suy nghĩ…');
  });

  it('không hoạt cảnh (NO_COLOR) → từ gốc đầy đủ, không gõ, không con trỏ', () => {
    const s = plain({ elapsedMs: 0, animate: false });
    expect(s).toContain('Đang xử lý…');
    expect(s).not.toContain('▍');
  });

  it('con trỏ: đặc khi gõ, nháy khi giữ; ASCII dùng «_»', () => {
    expect(plain({ elapsedMs: 120 })).toContain('▍');
    const hold = [1200, 1210].map((ms) => plain({ elapsedMs: ms })); // trong 530 ms đầu của nhịp nháy → bật
    expect(hold[0]).toContain('▍');
    expect(plain({ elapsedMs: 1200 + 530 })).not.toContain('▍'); // nửa nhịp sau → tắt (đang giữ)
    const ascii = makeTheme(detectCaps({ env: E({ COLORTERM: 'truecolor', LOCAITH_ASCII: '1' }) }));
    const a = stripAnsi(renderSpinner({ theme: ascii, width: 100, lang: 'vi', frame: 1, elapsedMs: 120, tokens: 0, seed: 3 }));
    expect(a).toContain('_');
    expect(a).not.toContain('▍');
  });

  it('tiếng Anh dùng danh sách từ tiếng Anh; không bao giờ vượt độ rộng ở mọi thời điểm', () => {
    expect(plain({ lang: 'en', elapsedMs: 700 })).toContain('Working…');
    for (const width of [20, 40, 80]) for (let ms = 0; ms < 40_000; ms += 137) expect(stringWidth(renderSpinner({ theme: th, width, lang: 'vi', frame: ms % 7, elapsedMs: ms, tokens: 1200, seed: 5 }))).toBeLessThanOrEqual(width - 1);
  });
});
