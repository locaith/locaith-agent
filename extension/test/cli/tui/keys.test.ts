import { describe, expect, it } from 'vitest';
import { KeyParser, describeKey, normalizePaste, type KeyEvent } from '../../../src/cli/tui/keys';

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

describe('normalizePaste', () => {
  it('chuẩn hoá', () => expect(normalizePaste('a\r\nb\rc\td\x00')).toBe('a\nb\nc    d'));
});
