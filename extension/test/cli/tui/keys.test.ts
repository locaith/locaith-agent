import { describe, expect, it } from 'vitest';
import { KeyParser, ctrlHMode, describeKey, normalizePaste, type KeyEvent } from '../../../src/cli/tui/keys';
import { TerminalSession } from '../../../src/cli/tui/terminal';

const names = (evs: KeyEvent[]): string[] => evs.map((e) => (e.type === 'paste' ? `paste:${e.text.replace(/\n/g, '⏎')}` : describeKey(e.key)));
const parse = (...chunks: string[]): string[] => {
  const p = new KeyParser();
  const out: KeyEvent[] = [];
  for (const c of chunks) out.push(...p.feed(c));
  out.push(...p.flush());
  return names(out);
};

describe('KeyParser', () => {
  it('ký tự thường và tiếng Việt', () => expect(parse('xin chào ế')).toEqual(['xin chào ế']));
  it('Enter, Tab, Backspace, Esc đơn', () => expect(parse('\r', '\t', '\x7f', '\x1b')).toEqual(['enter', 'tab', 'backspace', 'escape']));
  it('Ctrl+chữ', () => expect(parse('\x01\x05\x0b\x15\x17\x03\x04\x0f\x12\x0c\x14')).toEqual(['ctrl+a', 'ctrl+e', 'ctrl+k', 'ctrl+u', 'ctrl+w', 'ctrl+c', 'ctrl+d', 'ctrl+o', 'ctrl+r', 'ctrl+l', 'ctrl+t']));
  it('\n là Ctrl+J', () => expect(parse('\n')).toEqual(['ctrl+j']));
  it('Ctrl+H (Ctrl+Backspace trên Windows)', () => expect(parse('\x08')).toEqual(['ctrl+backspace']));
  it('mũi tên CSI và SS3', () => expect(parse('\x1b[A\x1b[B\x1b[C\x1b[D', '\x1bOA\x1bOH\x1bOF')).toEqual(['up', 'down', 'right', 'left', 'up', 'home', 'end']));
  it('Home/End/Del/PgUp/PgDn dạng ~', () => expect(parse('\x1b[1~\x1b[4~\x1b[3~\x1b[5~\x1b[6~\x1b[2~')).toEqual(['home', 'end', 'delete', 'pageup', 'pagedown', 'insert']));
  it('phím bổ trợ', () => {
    expect(parse('\x1b[1;5C\x1b[1;3D\x1b[1;2A\x1b[3;5~')).toEqual(['ctrl+right', 'alt+left', 'shift+up', 'ctrl+delete']);
  });
  it('Shift+Tab', () => expect(parse('\x1b[Z')).toEqual(['shift+tab']));
  it('Alt+phím', () => expect(parse('\x1bb\x1bf\x1b\r\x1b\x7f')).toEqual(['alt+b', 'alt+f', 'alt+enter', 'alt+backspace']));
  it('kitty CSI-u và modifyOtherKeys', () => {
    expect(parse('\x1b[13;2u')).toEqual(['shift+enter']);
    expect(parse('\x1b[27;2;13~')).toEqual(['shift+enter']);
    expect(parse('\x1b[97;5u')).toEqual(['ctrl+a']);
  });
  it('F-keys', () => expect(parse('\x1bOP\x1b[15~\x1b[24~')).toEqual(['f1', 'f5', 'f12']));
  it('chuỗi thoát bị cắt giữa hai gói', () => {
    expect(parse('\x1b', '[', 'A')).toEqual(['up']);
    expect(parse('\x1b[1', ';5C')).toEqual(['ctrl+right']);
  });
  it('ESC đơn chỉ thành Esc sau flush', () => {
    const p = new KeyParser();
    expect(p.feed('\x1b')).toEqual([]);
    expect(p.pending).toBe(true);
    expect(names(p.flush())).toEqual(['escape']);
  });
  it('bracketed paste một gói', () => expect(parse('\x1b[200~dòng 1\ndòng 2\x1b[201~')).toEqual(['paste:dòng 1⏎dòng 2']));
  it('bracketed paste nhiều gói, mã kết thúc bị cắt đôi', () => {
    expect(parse('\x1b[200~ab', 'c\r\nde\x1b[2', '01~', 'x')).toEqual(['paste:abc⏎de', 'x']);
  });
  it('mã bắt đầu dán bị cắt đôi', () => expect(parse('\x1b[20', '0~hi\x1b[201~')).toEqual(['paste:hi']));
  it('dán KHÔNG có bracketed paste (ConPTY): đoán theo cụm có xuống dòng', () => {
    expect(parse('dòng 1\r\ndòng 2\r\n')).toEqual(['dòng 1', 'paste:⏎dòng 2⏎']);
  });
  it('Enter đứng một mình vẫn là Enter', () => expect(parse('abc', '\r')).toEqual(['abc', 'enter']));
  it('bỏ qua báo cáo vị trí con trỏ và focus', () => expect(parse('\x1b[12;40R\x1b[I\x1b[Ox')).toEqual(['x']));
  it('bỏ qua trả lời OSC', () => expect(parse('\x1b]11;rgb:0000/0000/0000\x07a')).toEqual(['a']));
  it('emoji nhiều byte không bị vỡ', () => expect(parse('a😀b')).toEqual(['a😀b']));
});

describe('byte 0x08: Backspace thường (conhost của Windows) hay Ctrl+Backspace (Windows Terminal, VS Code, Unix)? — lỗi «gõ tiếng Việt có dấu là mất chữ»', () => {
  const parseWith = (ctrlH: 'backspace' | 'ctrl-backspace', ...chunks: string[]): string[] => {
    const p = new KeyParser({ ctrlH });
    const out: KeyEvent[] = [];
    for (const c of chunks) out.push(...p.feed(c));
    out.push(...p.flush());
    return names(out);
  };

  it('ở conhost, 0x08 là Backspace THƯỜNG (không còn «ctrl+backspace» xoá cả từ)', () => {
    expect(parseWith('backspace', '\x08')).toEqual(['backspace']);
    expect(parseWith('ctrl-backspace', '\x08')).toEqual(['ctrl+backspace']);
    expect(parse('\x08')).toEqual(['ctrl+backspace']); // mặc định giữ hành vi cũ (test + terminal Unix)
  });

  it('0x7f luôn là Backspace thường', () => {
    expect(parseWith('backspace', '\x7f')).toEqual(['backspace']);
    expect(parseWith('ctrl-backspace', '\x7f')).toEqual(['backspace']);
  });

  it('bộ gõ kiểu «Backspace + chữ mới» (UniKey/EVKey gõ ê): dù đến CÙNG MỘT gói hay tách gói, ra đúng [chữ, backspace thường, chữ có dấu]', () => {
    expect(parseWith('backspace', 'vie', '\x08', 'ê')).toEqual(['vie', 'backspace', 'ê']);
    expect(parseWith('backspace', 'vie\x08ê')).toEqual(['vie', 'backspace', 'ê']);
    expect(parseWith('backspace', 'vie\x7fê')).toEqual(['vie', 'backspace', 'ê']);
    expect(parseWith('backspace', 'a\x08á\x08ấ')).toEqual(['a', 'backspace', 'á', 'backspace', 'ấ']);
  });

  it('ctrlHMode: Windows không có Windows Terminal/VS Code → backspace; có WT_SESSION hoặc TERM_PROGRAM=vscode → ctrl-backspace; hệ khác → ctrl-backspace', () => {
    expect(ctrlHMode({}, 'win32')).toBe('backspace');
    expect(ctrlHMode({ WT_SESSION: 'abc' }, 'win32')).toBe('ctrl-backspace');
    expect(ctrlHMode({ TERM_PROGRAM: 'vscode' }, 'win32')).toBe('ctrl-backspace');
    expect(ctrlHMode({}, 'linux')).toBe('ctrl-backspace');
    expect(ctrlHMode({}, 'darwin')).toBe('ctrl-backspace');
  });

  it('LOCAITH_CTRL_H ép cách hiểu (lối thoát cho terminal lạ), không phân biệt hoa thường', () => {
    expect(ctrlHMode({ LOCAITH_CTRL_H: 'backspace' }, 'linux')).toBe('backspace');
    expect(ctrlHMode({ LOCAITH_CTRL_H: 'CTRL-BACKSPACE' }, 'win32')).toBe('ctrl-backspace');
    expect(ctrlHMode({ LOCAITH_CTRL_H: 'linh tinh' }, 'win32')).toBe('backspace'); // giá trị lạ: bỏ qua, dùng đoán theo môi trường
  });

  // (0.4.10) Laptop cài Vietkey VẪN mất chữ sau 0.4.9: bộ gõ có thể đẩy Backspace thành 0x08 ngay cả khi terminal gửi 0x7f cho Backspace thường (Windows Terminal, VS Code),
  // nên 'ctrl-backspace' nuốt cả từ. Chống bằng cách nhìn thứ ĐI SAU 0x08 (xem KeyParserOptions.deferCtrlH).
  describe('chống bộ gõ tiếng Việt ở chế độ ctrl-backspace (deferCtrlH)', () => {
    const defer = (...chunks: string[]): string[] => {
      const p = new KeyParser({ ctrlH: 'ctrl-backspace', deferCtrlH: true });
      const out: KeyEvent[] = [];
      for (const c of chunks) out.push(...p.feed(c));
      out.push(...p.flush());
      return names(out);
    };

    it('0x08 liền trước chữ trong CÙNG gói → Backspace thường', () => {
      expect(defer('vie\x08ê')).toEqual(['vie', 'backspace', 'ê']);
      expect(defer('a\x08á\x08ấ')).toEqual(['a', 'backspace', 'á', 'backspace', 'ấ']);
      expect(defer('\x08\x08ế')).toEqual(['backspace', 'backspace', 'ế']);
    });

    it('0x08 đứng một mình rồi chữ đến ở gói kế (bộ gõ tách gói) → Backspace thường', () => {
      expect(defer('vie', '\x08', 'ê')).toEqual(['vie', 'backspace', 'ê']);
      expect(defer('\x08', '\x08', 'ế')).toEqual(['backspace', 'backspace', 'ế']);
    });

    it('giữ Ctrl+Backspace (nhiều 0x08 liền nhau, KHÔNG có gì khác) → mọi cái đều là Ctrl+Backspace sau thời gian chờ', () => {
      const p = new KeyParser({ ctrlH: 'ctrl-backspace', deferCtrlH: true });
      expect(p.feed('\x08\x08')).toEqual([]);
      expect(names(p.feed('\x08'))).toEqual([]);
      expect(p.pending).toBe(true);
      expect(names(p.flush())).toEqual(['ctrl+backspace', 'ctrl+backspace', 'ctrl+backspace']);
    });

    it('0x08 đứng một mình tới hết hạn chờ → vẫn là Ctrl+Backspace thật (xoá cả từ)', () => {
      const p = new KeyParser({ ctrlH: 'ctrl-backspace', deferCtrlH: true });
      expect(p.feed('\x08')).toEqual([]); // chưa quyết
      expect(p.pending).toBe(true);
      expect(names(p.flush())).toEqual(['ctrl+backspace']);
    });

    it('chế độ backspace (conhost) không chờ gì: 0x08 là Backspace thường ngay', () => {
      const p = new KeyParser({ ctrlH: 'backspace', deferCtrlH: true });
      expect(names(p.feed('\x08'))).toEqual(['backspace']);
      expect(p.pending).toBe(false);
    });

    it('pendingMs: 0x08 đứng một mình chờ lâu hơn ESC đơn', () => {
      const p = new KeyParser({ ctrlH: 'ctrl-backspace', deferCtrlH: true });
      p.feed('\x1b');
      expect(p.pendingMs(30)).toBe(30);
      p.flush();
      p.feed('\x08');
      expect(p.pendingMs(30)).toBeGreaterThanOrEqual(60);
    });

    it('TerminalSession: 0x08 đơn độc thành Ctrl+Backspace sau thời gian chờ, còn "0x08 rồi chữ" không bao giờ', async () => {
      const got: string[] = [];
      const handlers: Array<(d: string) => void> = [];
      const stdin = { isTTY: false, on: (_e: string, f: (d: string) => void) => void handlers.push(f), resume: () => undefined, setEncoding: () => undefined };
      const s = new TerminalSession({ stdin: stdin as never, stdout: { write: () => true }, onEvent: (e) => void got.push(...names([e])), ctrlH: 'ctrl-backspace' });
      s.start();
      handlers[0]('\x08');
      handlers[0]('ê');
      expect(got).toEqual(['backspace', 'ê']);
      got.length = 0;
      handlers[0]('\x08');
      expect(got).toEqual([]);
      await new Promise((r) => setTimeout(r, 140));
      expect(got).toEqual(['ctrl+backspace']);
      s.stop();
    });
  });

  it('TerminalSession dùng tuỳ chọn ctrlH cho bộ phân tích phím của nó', () => {
    const got: string[] = [];
    const handlers: Array<(d: string) => void> = [];
    const stdin = { isTTY: false, on: (_e: string, f: (d: string) => void) => void handlers.push(f), resume: () => undefined, setEncoding: () => undefined };
    const s = new TerminalSession({ stdin: stdin as never, stdout: { write: () => true }, onEvent: (e) => void got.push(...names([e])), ctrlH: 'backspace' });
    s.start();
    handlers[0]('\x08');
    s.stop();
    expect(got).toEqual(['backspace']);
  });
});

describe('normalizePaste', () => {
  it('chuẩn hoá', () => expect(normalizePaste('a\r\nb\rc\td\x00')).toBe('a\nb\nc    d'));
});
