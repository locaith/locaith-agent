/**
 * Chọn phiên để mở lại: mã, đầu mã, SỐ thứ tự, từ khoá trong tiêu đề (không phân biệt dấu) — và thông báo khi không ra đúng một phiên.
 * Lý do tồn tại: người dùng chỉ biết gõ /sessions rồi nhìn một bảng mã, không biết «chọn» thế nào (phải hỏi AI dạy `locaith -r cli_xxxx`).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { registerStrings, setLang } from '../../../src/cli/i18n';
import { foldText, formatAgo, matchSessions, sessionMissMessage } from '../../../src/cli/runtime/sessions';
import { RUNTIME_STRINGS } from '../../../src/cli/runtime/strings';
import type { SessionSummary } from '../../../src/shared/protocol';

// Chuỗi `runtime.*` do runtime.ts đăng ký khi nạp; các hàm thuần ở đây dùng chúng nên phải tự đăng ký.
registerStrings('runtime', RUNTIME_STRINGS);
beforeEach(() => setLang('vi'));

const S = (id: string, title: string, other = false): SessionSummary => ({ id, title, updatedAt: 0, provider: 'locaith', model: 'm', messageCount: 2, ...(other ? { other: true, workspaceName: 'du-an-khac' } : {}) });

const here = [S('cli_mw7yd9w31u', 'Sửa lỗi đăng nhập trang quản trị'), S('cli_mw7yb2k4zz', 'Sửa lỗi build trên CI'), S('cli_mw7xk2p8qa', 'Viết test cho module thanh toán'), S('cli_mw6zt4h1bc', 'Khảo sát vì sao build chậm')];
const elsewhere = [S('cli_mw4ww1n7ee', 'Thiết kế logo cho Locaith', true), S('cli_mw3aa0000b', 'Sửa lỗi đăng nhập ở dự án khác', true)];
const all = [...here, ...elsewhere];

/** Id nếu ra đúng một phiên, ngược lại kiểu kết quả. */
const pick = (q: string, h = here, a = all): string => {
  const m = matchSessions(q, h, a);
  return m.kind === 'one' ? m.session.id : m.kind;
};
const ids = (q: string): string[] => {
  const m = matchSessions(q, here, all);
  return m.kind === 'many' ? m.list.map((s) => s.id) : [];
};

describe('matchSessions', () => {
  it('mã đầy đủ (kể cả gõ hoa/thường lẫn lộn) và đầu mã duy nhất', () => {
    expect(pick('cli_mw7yd9w31u')).toBe('cli_mw7yd9w31u');
    expect(pick('CLI_MW7YD9W31U')).toBe('cli_mw7yd9w31u');
    expect(pick('cli_mw7yd')).toBe('cli_mw7yd9w31u');
    expect(pick('cli_mw7x')).toBe('cli_mw7xk2p8qa');
    expect(pick('  cli_mw4ww  ')).toBe('cli_mw4ww1n7ee'); // phiên ở thư mục khác vẫn mở được bằng mã
  });

  it('đầu mã dùng chung (cli_mw7y — hai phiên tạo gần nhau) KHÔNG đoán bừa: trả về nhiều phiên, phiên của thư mục này', () => {
    expect(ids('cli_mw7y')).toEqual(['cli_mw7yd9w31u', 'cli_mw7yb2k4zz']);
    // đầu mã chung cả thư mục này lẫn thư mục khác: chỉ khi trong thư mục này duy nhất một phiên mới chọn luôn phiên đó
    const h = [S('cli_ab111', 'A')];
    const a = [S('cli_ab111', 'A'), S('cli_ab222', 'B', true)];
    expect(pick('cli_ab', h, a)).toBe('cli_ab111');
    expect(pick('cli_ab', [], [S('cli_ab111', 'A', true), S('cli_ab222', 'B', true)])).toBe('many');
  });

  it('SỐ thứ tự trong danh sách đang hiện: `2`, `#3`, khoảng trắng thừa', () => {
    expect(pick('1')).toBe('cli_mw7yd9w31u');
    expect(pick('2')).toBe('cli_mw7yb2k4zz');
    expect(pick('#3')).toBe('cli_mw7xk2p8qa');
    expect(pick(' 4 ')).toBe('cli_mw6zt4h1bc');
  });

  it('số vượt danh sách → none/index kèm số phiên hiện có; số 0 cũng không hợp lệ', () => {
    expect(matchSessions('5', here, all)).toEqual({ kind: 'none', reason: 'index', max: 4 });
    expect(matchSessions('0', here, all)).toEqual({ kind: 'none', reason: 'index', max: 4 });
    expect(matchSessions('#99', here, all)).toEqual({ kind: 'none', reason: 'index', max: 4 });
  });

  it('thư mục này chưa có phiên nào: số chỉ vào danh sách mọi thư mục (đúng danh sách đang hiện)', () => {
    expect(pick('1', [], all)).toBe('cli_mw7yd9w31u');
    expect(pick('6', [], all)).toBe('cli_mw3aa0000b');
    expect(matchSessions('7', [], all)).toEqual({ kind: 'none', reason: 'index', max: 6 });
  });

  it('từ khoá trong tiêu đề: không phân biệt dấu, hoa/thường, thứ tự từ', () => {
    expect(pick('thanh toan')).toBe('cli_mw7xk2p8qa');
    expect(pick('THANH TOÁN')).toBe('cli_mw7xk2p8qa');
    expect(pick('đăng nhập trang')).toBe('cli_mw7yd9w31u');
    expect(pick('ci build')).toBe('cli_mw7yb2k4zz');
    expect(pick('logo')).toBe('cli_mw4ww1n7ee'); // chỉ có ở thư mục khác vẫn tìm ra
  });

  it('từ khoá khớp nhiều phiên → danh sách, phiên của thư mục này lên trước, mới nhất trước', () => {
    expect(ids('build')).toEqual(['cli_mw7yb2k4zz', 'cli_mw6zt4h1bc']);
    expect(ids('lỗi')).toEqual(['cli_mw7yd9w31u', 'cli_mw7yb2k4zz', 'cli_mw3aa0000b']);
    expect(ids('dang nhap')).toEqual(['cli_mw7yd9w31u', 'cli_mw3aa0000b']);
  });

  it('không khớp gì / chuỗi rỗng', () => {
    expect(matchSessions('khong-co-phien-nay', here, all)).toEqual({ kind: 'none', reason: 'text' });
    expect(matchSessions('zzz qqq', here, all)).toEqual({ kind: 'none', reason: 'text' });
    expect(matchSessions('   ', here, all)).toEqual({ kind: 'none', reason: 'empty' });
  });

  it('mã khớp đầu mã được ưu tiên hơn cách hiểu «số» (mã cũ bắt đầu bằng chữ số)', () => {
    const a = [S('2024-old', 'Phiên cũ'), S('cli_mw7yd9w31u', 'Mới')];
    expect(pick('2024', a, a)).toBe('2024-old');
    expect(pick('2', a, a)).toBe('2024-old'); // «2» là đầu mã duy nhất nên thắng số thứ tự
  });
});

describe('foldText', () => {
  it('bỏ dấu tiếng Việt, đ/Đ, hạ chữ thường', () => {
    expect(foldText('ĐĂNG NHẬP Trang Quản Trị')).toBe('dang nhap trang quan tri');
    expect(foldText('đường dẫn')).toBe('duong dan');
  });
});

describe('sessionMissMessage', () => {
  it('không thấy: nói rõ từ khoá và chỉ cách xem danh sách', () => {
    const m = matchSessions('khong-co', here, all);
    if (m.kind === 'one') throw new Error('phải không khớp');
    const msg = sessionMissMessage('khong-co', m);
    expect(msg).toContain('Không thấy phiên «khong-co»');
    expect(msg).toContain('/sessions');
    expect(msg).toContain('locaith sessions');
  });

  it('số không có: nêu số và số phiên hiện có', () => {
    const m = matchSessions('9', here, all);
    if (m.kind === 'one') throw new Error('phải không khớp');
    expect(sessionMissMessage('9', m)).toMatch(/Không có phiên số 9 — danh sách chỉ có 4 phiên/);
  });

  it('nhiều phiên khớp: liệt kê tối đa 5 mã kèm tiêu đề và chỉ cách chọn', () => {
    const m = matchSessions('cli_mw7y', here, all);
    if (m.kind === 'one') throw new Error('phải không khớp');
    const msg = sessionMissMessage('cli_mw7y', m);
    expect(msg).toContain('Có 2 phiên khớp «cli_mw7y»');
    expect(msg).toContain('cli_mw7yd9w31u (Sửa lỗi đăng nhập trang quản trị)');
    expect(msg).toContain('cli_mw7yb2k4zz (Sửa lỗi build trên CI)');
    expect(msg).toContain('locaith -r');
    const many = matchSessions('a', [], Array.from({ length: 9 }, (_, i) => S(`a${i}`, `Phiên ${i}`)));
    if (many.kind !== 'many') throw new Error('phải nhiều');
    expect(sessionMissMessage('a', many).match(/a\d \(/g)).toHaveLength(5);
  });

  it('có bản tiếng Anh', () => {
    setLang('en');
    const m = matchSessions('khong-co', here, all);
    if (m.kind === 'one') throw new Error('phải không khớp');
    expect(sessionMissMessage('khong-co', m)).toContain('No session matches “khong-co”');
  });
});

describe('formatAgo', () => {
  const NOW = 1_800_000_000_000;
  const abs = (ts: number): string => `NGÀY(${ts})`;
  const ago = (ms: number, lang: 'vi' | 'en' = 'vi'): string => formatAgo(NOW - ms, NOW, lang, abs);
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it('tiếng Việt: vừa xong → phút → giờ → hôm qua → ngày; từ 7 ngày dùng ngày giờ đầy đủ', () => {
    expect(ago(20_000)).toBe('vừa xong');
    expect(ago(1 * MIN)).toBe('1 phút trước');
    expect(ago(59 * MIN)).toBe('59 phút trước');
    expect(ago(60 * MIN)).toBe('1 giờ trước');
    expect(ago(23 * HOUR + 59 * MIN)).toBe('23 giờ trước');
    expect(ago(24 * HOUR)).toBe('hôm qua');
    expect(ago(47 * HOUR)).toBe('hôm qua');
    expect(ago(2 * DAY)).toBe('2 ngày trước');
    expect(ago(6 * DAY + 23 * HOUR)).toBe('6 ngày trước');
    expect(ago(7 * DAY)).toBe(`NGÀY(${NOW - 7 * DAY})`);
  });

  it('tiếng Anh', () => {
    expect(ago(10_000, 'en')).toBe('just now');
    expect(ago(5 * MIN, 'en')).toBe('5 min ago');
    expect(ago(3 * HOUR, 'en')).toBe('3 h ago');
    expect(ago(30 * HOUR, 'en')).toBe('yesterday');
    expect(ago(4 * DAY, 'en')).toBe('4 days ago');
  });

  it('thời điểm ở tương lai (đồng hồ lệch) không ra số âm', () => {
    expect(formatAgo(NOW + 5 * HOUR, NOW, 'vi', abs)).toBe('vừa xong');
  });
});
