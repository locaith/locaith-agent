/**
 * Hộp chọn phiên trong giao diện: `/sessions` giờ mở cùng hộp chọn với `/resume` (↑↓ chọn, gõ để lọc, Enter mở),
 * và `locaith -r` (không mã) mở hộp chọn ngay khi khởi động qua `initialPrompt: '/resume'`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { KEY, boot, type Booted } from './helpers/boot';

let b: Booted | null = null;
afterEach(async () => {
  if (b) {
    b.app.exit(0);
    await b.done.catch(() => undefined);
    b = null;
  }
});

const resumeCalls = (x: Booted) => x.rt.calls.filter((c) => c.fn === 'resume');

describe('hộp chọn phiên', () => {
  it('gõ /sessions rồi Enter → hộp chọn có ô «Tìm», các phiên và dòng phím tắt; ↓ + Enter mở lại phiên thứ hai', async () => {
    b = await boot();
    await b.type('/sessions');
    await b.type(KEY.enter);
    await b.until(() => b!.screenText().includes('Mở lại phiên'));
    const t = b.screenText();
    expect(t).toContain('Tìm:');
    expect(t).toContain('Sửa lỗi đăng nhập trên trang quản trị'); // phiên mẫu của MockRuntime
    expect(t).toContain('↑↓ chọn · Enter xác nhận · Esc huỷ');
    await b.type(KEY.down);
    await b.type(KEY.enter);
    await b.until(() => resumeCalls(b!).length === 1);
    expect(resumeCalls(b)[0].args[0]).toBe('sess_2abcdef');
    await b.until(() => b!.screenText().includes('Phiên đã khôi phục'));
    expect(b.screenText()).not.toContain('Tìm:'); // hộp chọn đã đóng
  });

  it('gõ chữ trong hộp chọn lọc theo tiêu đề (không cần biết mã); Enter mở phiên đang chọn', async () => {
    b = await boot();
    await b.type('/sessions');
    await b.type(KEY.enter);
    await b.until(() => b!.screenText().includes('Mở lại phiên'));
    await b.type('thanh toan'); // không dấu cũng khớp «thanh toán»
    await b.type(KEY.enter);
    await b.until(() => resumeCalls(b!).length === 1);
    expect(resumeCalls(b)[0].args[0]).toBe('sess_2abcdef');
  });

  it('Esc đóng hộp chọn mà không mở gì', async () => {
    b = await boot();
    await b.type('/sessions');
    await b.type(KEY.enter);
    await b.until(() => b!.screenText().includes('Tìm:'));
    await b.type(KEY.esc, 200);
    await b.until(() => !b!.screenText().includes('Tìm:'));
    expect(resumeCalls(b)).toHaveLength(0);
  });

  it('menu gợi ý lệnh liệt kê /sessions cùng /resume khi gõ /ses', async () => {
    b = await boot();
    await b.type('/ses');
    expect(b.screenText()).toContain('/sessions');
  });

  it('`locaith -r` (không mã) = giao diện tự gửi /resume lúc khởi động → hộp chọn hiện ngay, dòng lệnh được in ra để người dùng thấy', async () => {
    b = await boot({ app: { initialPrompt: '/resume' } });
    await b.until(() => b!.screenText().includes('Tìm:'));
    const t = b.screenText();
    expect(t).toContain('> /resume');
    expect(t).toContain('Mở lại phiên');
    expect(resumeCalls(b)).toHaveLength(0); // chưa mở gì cho tới khi người dùng chọn
    await b.type(KEY.enter);
    await b.until(() => resumeCalls(b!).length === 1);
    expect(resumeCalls(b)[0].args[0]).toBe('sess_1abcdef'); // phiên đầu danh sách (mới nhất)
  });
});
