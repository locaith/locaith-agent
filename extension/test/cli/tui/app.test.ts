import { afterEach, describe, expect, it } from 'vitest';
import { stringWidth } from '../../../src/cli/tui/width';
import { KEY, boot, type Booted } from './helpers/boot';

let b: Booted | null = null;
afterEach(async () => {
  if (b) {
    b.app.exit(0);
    await b.done.catch(() => undefined);
    b = null;
  }
});

describe('TuiApp + MockRuntime + xterm headless', () => {
  it('khung chào + ô nhập + dải trạng thái; con trỏ thật ở cuối vùng sống', async () => {
    b = await boot();
    const t = b.screenText();
    expect(t).toContain('Locaith CLI');
    expect(t).toContain('v0.4.0');
    expect(t).toContain('locaith-v5-flash');
    expect(t).toContain('╭');
    expect(t).toContain('Nhập việc cần làm');
    expect(t).toContain('? phím tắt');
    expect(t).toContain('ngữ cảnh 4%');
    b.dump('welcome');
    // dòng cuối là dải trạng thái; không dòng nào vượt 80 cột
    expect(b.vt.all().every((l) => stringWidth(l) <= 80)).toBe(true);
    // dùng khối nửa ô của logo
    expect(t).toMatch(/[▀▄█]/);
  });

  it('gõ chữ tiếng Việt, Enter gửi, trợ lý trả lời markdown + công cụ in vào scrollback', async () => {
    b = await boot();
    await b.type('Chào bạn, hãy xem dự án giúp mình');
    expect(b.screenText()).toContain('Chào bạn, hãy xem dự án giúp mình');
    await b.type(KEY.enter);
    await b.until(() => !b!.rt.status().running && b!.screenText().includes('Bạn muốn mình làm luôn không?'));
    const t = b.screenText();
    expect(t).toContain('> Chào bạn, hãy xem dự án giúp mình'); // dòng người dùng
    expect(t).toContain('● List(.)');
    expect(t).toContain('● Read(tsconfig.json)');
    expect(t).toContain('⎿ Đọc 5 dòng');
    expect(t).toContain('## Kết quả'.replace('## ', '')); // tiêu đề đã bỏ ##
    expect(t).toContain('╭─ ts');
    expect(t).toContain('│ export interface Options {');
    expect(t).toMatch(/┌|╭─+┬/); // bảng
    expect(t).toContain('src/a.ts');
    b.dump('conversation');
    // vùng sống không để lại rác: spinner đã biến mất
    expect(t).not.toContain('Đang xử lý');
    expect(b.vt.all().every((l) => stringWidth(l) <= 80)).toBe(true);
  });

  it('/ mở menu lệnh, lọc, Tab điền, Enter chạy', async () => {
    b = await boot();
    await b.type('/co');
    let t = b.screenText();
    expect(t).toContain('/compact');
    expect(t).toContain('/context');
    expect(t.split('\n').filter((l) => l.includes('/help ')).length).toBe(1); // chỉ ở dòng mẹo của khung chào, không có trong menu
    await b.type(KEY.tab);
    expect(b.screenText()).toContain('/compact');
    expect(b.app.editor.text).toBe('/compact ');
    // xoá và chạy /help bằng Enter khi đang chọn
    b.app.editor.clear();
    await b.type(KEY.ctrl('u'));
    await b.type('/hel');
    await b.type(KEY.enter);
    await b.until(() => b!.screenText().includes('Locaith — trợ giúp'));
    t = b.screenText();
    expect(t).toContain('/compact');
    expect(b.rt.calls.some((c) => c.fn === 'submit' && c.args[0] === '/help')).toBe(true);
  });

  it('@ mở menu tệp qua rt.complete và chèn', async () => {
    b = await boot();
    await b.type('xem @cli');
    await b.until(() => b!.screenText().includes('src/cli.ts'));
    await b.type(KEY.tab);
    expect(b.app.editor.text).toBe('xem @src/cli.ts ');
  });

  it('! đổi sang chế độ shell (không chèn !), gửi kèm !', async () => {
    b = await boot();
    await b.type('!');
    expect(b.app.editor.text).toBe('');
    expect(b.screenText()).toContain('Lệnh shell');
    await b.type('git status');
    await b.type(KEY.enter);
    await b.until(() => b!.rt.calls.some((c) => c.fn === 'submit'));
    expect(b.rt.calls.find((c) => c.fn === 'submit')!.args[0]).toBe('!git status');
    await b.until(() => b!.screenText().includes('nothing to commit'));
  });

  it('nhiều dòng: Ctrl+J, Alt+Enter, \\ + Enter, dán nhiều dòng giữ nguyên', async () => {
    b = await boot();
    await b.type('a');
    await b.type('\n');
    await b.type('b');
    await b.type(KEY.altEnter);
    await b.type('c\\');
    await b.type(KEY.enter);
    await b.type('d');
    expect(b.app.editor.text).toBe('a\nb\nc\nd');
    await b.type(KEY.ctrl('u'));
    b.app.editor.clear();
    await b.type(KEY.paste('dòng 1\r\ndòng 2\r\ndòng 3'));
    expect(b.app.editor.text).toBe('dòng 1\ndòng 2\ndòng 3');
    const t = b.screenText();
    expect(t).toContain('> dòng 1');
    expect(t).toContain('dòng 3');
  });

  it('ô nhập cao tối đa 8 dòng rồi cuộn', async () => {
    b = await boot({ rows: 40 });
    await b.type(KEY.paste(Array.from({ length: 20 }, (_, i) => `hàng ${i + 1}`).join('\n')));
    const lines = b.vt.all().filter((l) => l.startsWith('│') && /hàng \d+/.test(l));
    expect(lines.length).toBe(8);
    expect(b.screenText()).toContain('hàng 20');
  });

  it('lịch sử ↑/↓ giữ bản nháp; Ctrl+R tìm ngược', async () => {
    b = await boot();
    for (const m of ['một', 'hai', 'ba']) {
      await b.type(m);
      await b.type(KEY.enter);
      await b.until(() => !b!.rt.status().running);
    }
    await b.type('nháp');
    await b.type(KEY.up);
    expect(b.app.editor.text).toBe('ba');
    await b.type(KEY.up);
    expect(b.app.editor.text).toBe('hai');
    await b.type(KEY.down);
    await b.type(KEY.down);
    expect(b.app.editor.text).toBe('nháp');
    await b.type(KEY.ctrl('u'));
    await b.type(KEY.ctrl('r'));
    await b.type('ha');
    expect(b.screenText()).toContain('Tìm ngược');
    expect(b.screenText()).toContain('hai');
    await b.type(KEY.enter);
    expect(b.app.editor.text).toBe('hai');
  });

  it('Ctrl+C: có chữ → xoá; rảnh+trống → nhắc; lần hai thoát', async () => {
    b = await boot();
    await b.type('abc');
    await b.type(KEY.ctrl('c'));
    expect(b.app.editor.text).toBe('');
    await b.type(KEY.ctrl('c'));
    expect(b.screenText()).toContain('nhấn Ctrl+C lần nữa để thoát');
    await b.type(KEY.ctrl('c'));
    expect(await b.done).toBe(0);
    const t = b.screenText();
    expect(t).toContain('Hẹn gặp lại');
    // terminal được khôi phục: con trỏ hiện, bracketed paste tắt
    const raw = b.vt.raw.join('');
    expect(raw.endsWith('\x1b[0m\x1b[?25h\x1b[?2004l\x1b[?2026l')).toBe(true);
    expect(b.inp.raw).toBe(false);
    b = null;
  });

  it('Ctrl+D thoát khi trống; có chữ thì xoá ký tự', async () => {
    b = await boot();
    await b.type('ab');
    await b.type(KEY.left);
    await b.type(KEY.ctrl('d'));
    expect(b.app.editor.text).toBe('a');
    await b.type(KEY.ctrl('u'));
    await b.type(KEY.ctrl('d'));
    expect(await b.done).toBe(0);
    b = null;
  });

  it('Esc: đang chạy thì dừng lượt; rảnh thì xoá ô', async () => {
    b = await boot({ mock: { speed: 1 } });
    await b.type('viết một câu trả lời dài giúp mình');
    await b.type(KEY.enter);
    await b.until(() => b!.rt.status().running);
    await b.type('chờ');
    await b.type(KEY.esc);
    await b.until(() => b!.rt.calls.some((c) => c.fn === 'interrupt'));
    await b.until(() => !b!.rt.status().running);
    expect(b.app.editor.text).toBe('chờ');
    await b.type(KEY.esc, 120);
    expect(b.app.editor.text).toBe('');
  });

  it('gõ khi đang chạy → xếp hàng, hiện trên ô nhập, rồi được gửi', async () => {
    b = await boot({ mock: { speed: 1 } });
    await b.type('xin chào');
    await b.type(KEY.enter);
    await b.until(() => b!.rt.status().running);
    await b.type('tin tiếp theo');
    await b.type(KEY.enter);
    await b.until(() => b!.rt.status().queued.length === 1);
    expect(b.screenText()).toContain('đang chờ');
    expect(b.screenText()).toContain('tin tiếp theo');
    await b.until(() => b!.rt.status().queued.length === 0 && !b!.rt.status().running, 20000);
    expect(b.screenText()).toContain('> tin tiếp theo');
  }, 30000);

  // (0.7.6) Gõ `/model` giữa lúc trợ lý đang trả lời: trước đây dòng `> /model` bị in chen vào giữa đoạn đang stream, lệnh KHÔNG chạy (runtime chỉ báo thoáng 4 giây)
  // và chữ đã gõ bị nuốt. Giờ: chữ ở nguyên trong ô nhập, không in dòng lệnh vào hội thoại, không gọi runtime, và có thông báo nói rõ phải làm gì.
  it('lệnh chỉ chạy khi rảnh, gõ lúc đang bận → giữ chữ trong ô nhập, KHÔNG in chen vào hội thoại, KHÔNG gọi runtime, báo rõ', async () => {
    b = await boot({ mock: { speed: 1 } });
    await b.type('viết một câu trả lời dài giúp mình');
    await b.type(KEY.enter);
    await b.until(() => b!.rt.status().running);
    const submitsBefore = b.rt.calls.filter((c) => c.fn === 'submit').length;
    await b.type('/model');
    await b.type(KEY.enter, 150);
    expect(b.app.editor.text).toBe('/model'); // chữ không bị nuốt
    expect(b.rt.calls.filter((c) => c.fn === 'submit').length).toBe(submitsBefore); // runtime không nhận lệnh
    // không có dòng lệnh (kiểu dòng người dùng, bắt đầu ngay ở lề trái) chen vào hội thoại — `> /model` duy nhất còn lại là chữ trong ô nhập (có viền │)
    expect(b.screenText().split('\n').some((l) => l.startsWith('> /model'))).toBe(false);
    expect(b.screenText()).toMatch(/chỉ chạy khi trợ lý rảnh — bấm Esc để dừng, hoặc đợi xong/);
    await b.type(KEY.esc);
    await b.until(() => !b!.rt.status().running);
    // Thông báo «chỉ chạy khi rảnh» sống tới 8 giây nhưng hết nghĩa ngay khi lượt dừng: phải biến mất, không để người dùng đọc nhầm lúc trợ lý đã rảnh.
    await b.until(() => !/chỉ chạy khi trợ lý rảnh/.test(b!.screenText()));
    expect(b.app.editor.text).toBe('/model'); // chữ vẫn còn trong ô nhập để bấm Enter chạy luôn
  }, 30000);

  it('lệnh chạy được cả lúc bận (needsIdle=false) vẫn chạy ngay khi gõ giữa lúc trợ lý đang làm việc', async () => {
    b = await boot({ mock: { speed: 1 } });
    await b.type('viết một câu trả lời dài giúp mình');
    await b.type(KEY.enter);
    await b.until(() => b!.rt.status().running);
    // mô phỏng `/context`: chạy được lúc bận
    const orig = b.rt.slashCommands.bind(b.rt);
    b.rt.slashCommands = () => orig().map((c) => (c.name === 'help' ? { ...c, needsIdle: false as const } : c));
    await b.type('/help');
    await b.type(KEY.enter, 200);
    await b.until(() => b!.rt.calls.some((c) => c.fn === 'submit' && c.args[0] === '/help'));
    expect(b.app.editor.text).toBe('');
    await b.type(KEY.esc);
    await b.until(() => !b!.rt.status().running);
  }, 30000);

  // (0.4.9) Báo cáo: «gõ tiếng Việt có dấu trên một vài laptop là mất chữ». Nguyên nhân tìm ra: ở console cổ điển của Windows (conhost) Backspace THƯỜNG gửi 0x08, mà CLI coi 0x08 là
  // «Ctrl+Backspace = xoá cả từ» → bộ gõ (UniKey/EVKey… gõ «ê» bằng Backspace rồi chèn lại chữ có dấu) nuốt cả từ đứng trước mỗi khi gõ một dấu.
  it('bộ gõ kiểu «Backspace + chữ có dấu» ở conhost (0x08): chỉ xoá MỘT chữ, từ đã gõ còn nguyên', async () => {
    const b = await boot({ app: { ctrlH: 'backspace' } });
    await b.type('tiếng vie');
    await b.type('\x08'); // IME xoá chữ «e» cuối…
    await b.type('ê'); // …rồi chèn «ê»
    expect(b.app.editor.text).toBe('tiếng viê');
    await b.type('\x08');
    await b.type('ế');
    await b.type('t');
    expect(b.app.editor.text).toBe('tiếng viết');
    await b.type(KEY.ctrl('c'));
  });

  it('cùng chuỗi đó nhưng terminal coi 0x08 là Ctrl+Backspace (Windows Terminal/Unix): vẫn xoá cả từ như người dùng ở đó mong đợi', async () => {
    const b = await boot({ app: { ctrlH: 'ctrl-backspace' } });
    await b.type('tiếng viet');
    await b.type('\x08');
    expect(b.app.editor.text).toBe('tiếng ');
    await b.type(KEY.ctrl('c'));
  });

  it('Alt + chữ có dấu (ESC + ê) được CHÈN như chữ thường thay vì bị nuốt; Alt+b vẫn là phím tắt nhảy từ', async () => {
    const b = await boot();
    await b.type('xin chào');
    await b.type('\x1bê');
    expect(b.app.editor.text).toBe('xin chàoê');
    await b.type('\x1b̂'); // ESC + dấu mũ rời (U+0302): ghép vào chữ trước nó
    await b.type('\x1bb'); // Alt+b: nhảy về đầu từ
    expect(b.app.editor.cursor).toBe(4);
    await b.type(KEY.ctrl('c'));
  });

  it('Alt + chữ ASCII không phải phím tắt vẫn bị bỏ qua (không chèn ký tự lạ)', async () => {
    const b = await boot();
    await b.type('ab');
    await b.type('\x1bz');
    expect(b.app.editor.text).toBe('ab');
    await b.type(KEY.ctrl('c'));
  });

  it('Shift+Tab đổi chế độ quyền và hiện ở dải trạng thái', async () => {
    b = await boot();
    await b.type(KEY.shiftTab);
    expect(b.screenText()).toContain('tự nhận chỉnh sửa');
    expect(b.screenText()).toContain('shift+tab đổi');
    await b.type(KEY.shiftTab);
    expect(b.screenText()).toContain('chế độ lập kế hoạch');
  });

  it('? hiện phím tắt', async () => {
    b = await boot();
    await b.type('?');
    expect(b.screenText()).toContain('Phím tắt');
    expect(b.app.editor.text).toBe('');
    await b.type('x');
    expect(b.screenText()).not.toContain('Phím tắt');
  });

  it('hộp xin quyền: diff + lựa chọn; Enter = Có; phản hồi tới runtime', async () => {
    b = await boot();
    await b.type('hãy sửa parseArgs');
    await b.type(KEY.enter);
    await b.until(() => b!.screenText().includes('Cho phép sửa src/cli.ts?'));
    const t = b.screenText();
    expect(t).toContain('Sửa tệp');
    expect(t).toContain('--no-color');
    expect(t).toContain('1. Có');
    expect(t).toContain('2. Có, và không hỏi lại cho');
    expect(t).toContain('3. Không, và nói Locaith làm khác đi');
    b.dump('permission');
    expect(b.vt.all().every((l) => stringWidth(l) <= 80)).toBe(true);
    await b.type(KEY.enter);
    await b.until(() => b!.screenText().includes('Đã cập nhật.'));
    expect(b.rt.calls.find((c) => c.fn === 'respondPermission')!.args[1]).toEqual({ decision: 'allow' });
    const out = b.screenText();
    expect(out).toContain('● Update(src/cli.ts)');
    expect(out).toContain('Thêm 4 dòng, xoá 1 dòng');
    expect(out).toContain('+     if (a ===');
  });

  it('hộp xin quyền: chọn 3 → nhập lý do → gửi feedback', async () => {
    b = await boot();
    await b.type('chạy test giúp mình');
    await b.type(KEY.enter);
    await b.until(() => b!.screenText().includes('Cho phép chạy lệnh?'));
    await b.type('3');
    expect(b.screenText()).toContain('Bạn muốn Locaith làm khác đi thế nào?');
    await b.type('đừng chạy, hãy đọc log trước');
    await b.type(KEY.enter);
    await b.until(() => b!.rt.calls.some((c) => c.fn === 'respondPermission'));
    expect(b.rt.calls.find((c) => c.fn === 'respondPermission')!.args[1]).toEqual({ decision: 'deny', feedback: 'đừng chạy, hãy đọc log trước' });
    await b.until(() => !b!.rt.status().running);
    expect(b.screenText()).toContain('Đã từ chối');
  });

  it('hộp xin quyền: Esc = từ chối; y = cho phép; a = cho phép trong phiên', async () => {
    b = await boot();
    await b.type('sửa file');
    await b.type(KEY.enter);
    await b.until(() => b!.screenText().includes('Cho phép sửa'));
    await b.type(KEY.esc);
    await b.until(() => b!.rt.calls.some((c) => c.fn === 'respondPermission'));
    expect(b.rt.calls.find((c) => c.fn === 'respondPermission')!.args[1]).toEqual({ decision: 'deny' });
    await b.until(() => !b!.rt.status().running);
    await b.type('sửa file nữa');
    await b.type(KEY.enter);
    await b.until(() => b!.screenText().includes('Cho phép sửa') && b!.rt.status().running);
    await b.type('a');
    await b.until(() => b!.rt.calls.filter((c) => c.fn === 'respondPermission').length === 2);
    expect(b.rt.calls.filter((c) => c.fn === 'respondPermission')[1].args[1]).toEqual({ decision: 'allow_session' });
  });

  it('/resume: picker có tìm kiếm → chọn → replay in lại hội thoại', async () => {
    b = await boot();
    await b.type('/resume');
    await b.type(KEY.enter);
    await b.until(() => b!.screenText().includes('Mở lại phiên'));
    let t = b.screenText();
    expect(t).toContain('Sửa lỗi đăng nhập trên trang quản trị');
    expect(t).toContain('Hôm nay');
    expect(t).toContain('Tìm:');
    b.dump('picker');
    await b.type('thanh toan'); // tìm không dấu
    t = b.screenText();
    expect(t).toContain('Viết test cho module thanh toán');
    expect(t).not.toContain('Dựng workflow');
    await b.type(KEY.enter);
    await b.until(() => b!.screenText().includes('Phiên đã khôi phục'));
    t = b.screenText();
    expect(t).toContain('> Trang quản trị không đăng nhập được');
    expect(t).toContain('● Read(src/auth/login.ts)');
    expect(t).toContain('verifyToken');
    expect(t).toContain('Đã nén cuộc trò chuyện');
  });

  it('picker: Esc huỷ → answer(null)', async () => {
    b = await boot();
    await b.type('/model');
    await b.type(KEY.enter);
    await b.until(() => b!.screenText().includes('locaith-v5-si'));
    await b.type(KEY.down);
    await b.type(KEY.esc);
    await b.until(() => b!.rt.calls.some((c) => c.fn === 'answer'));
    expect(b.rt.calls.find((c) => c.fn === 'answer')!.args[1]).toBe(null);
  });

  it('picker: chọn mục → answer(id) và đổi model ở dải trạng thái', async () => {
    b = await boot();
    await b.type('/model');
    await b.type(KEY.enter);
    await b.until(() => b!.screenText().includes('locaith-v5-si'));
    await b.type(KEY.down);
    await b.type(KEY.enter);
    await b.until(() => b!.screenText().includes('locaith-v5-si') && !b!.screenText().includes('Siêu Trí tuệ'));
    expect(b.rt.status().model).toBe('locaith-v5-si');
  });

  it('todos, nén ngữ cảnh, kiểm chứng, lỗi, agent con hiển thị đúng', async () => {
    b = await boot();
    await b.type('lập kế hoạch với todo');
    await b.type(KEY.enter);
    await b.until(() => !b!.rt.status().running, 8000);
    expect(b.screenText()).toContain('Đã thêm tác vụ: Đọc cấu hình TypeScript');
    await b.type('nén ngữ cảnh đi');
    await b.type(KEY.enter);
    await b.until(() => !b!.rt.status().running && b!.screenText().includes('Tiếp tục công việc'));
    expect(b.screenText()).toContain('Đã nén cuộc trò chuyện · tự động · giải phóng 968k token');
    expect(b.screenText()).toContain('Kiểm tra độc lập: đạt');
    await b.type('có lỗi');
    await b.type(KEY.enter);
    await b.until(() => !b!.rt.status().running);
    expect(b.screenText()).toContain('Lỗi: getaddrinfo ENOTFOUND example.invalid');
    expect(b.screenText()).toContain('ECONNRESET');
    await b.type('agent song song');
    await b.type(KEY.enter);
    await b.until(() => !b!.rt.status().running);
    expect(b.screenText()).toContain('● Agent(khảo sát vòng import)');
    expect(b.screenText()).toContain('Xong (12 lệnh');
  });

  it('≥ 3 lệnh đọc liền nhau được gom một dòng', async () => {
    b = await boot();
    await b.type('đọc nhiều tệp');
    await b.type(KEY.enter);
    await b.until(() => !b!.rt.status().running);
    expect(b.screenText()).toContain('● Đã đọc 5 tệp');
    expect(b.screenText()).toContain('src/cli.ts, src/app.ts');
    expect(b.screenText()).toContain('● Search("parseArgs" in src)');
  });

  it('Ctrl+O mở rộng kết quả bị rút gọn gần nhất', async () => {
    b = await boot();
    await b.type('chạy test');
    await b.type(KEY.enter);
    await b.until(() => b!.screenText().includes('Cho phép chạy lệnh?'));
    await b.type('y');
    await b.until(() => !b!.rt.status().running);
    expect(b.screenText()).toContain('… +17 dòng');
    expect(b.screenText()).not.toContain('case 10');
    await b.type(KEY.ctrl('o'));
    expect(b.screenText()).toContain('case 10');
  });

  it('đổi cỡ cửa sổ: vẽ lại vùng sống theo chiều rộng mới, không rác', async () => {
    b = await boot({ cols: 100 });
    await b.type('xin chào');
    await b.vt.resize(50);
    await b.tick();
    let t = b.vt.all();
    const box = t.filter((l) => l.startsWith('│') || l.startsWith('╰') || l.startsWith('╭'));
    expect(t.join('\n')).toContain('xin chào');
    expect(t[t.length - 1]).toContain('locaith-v5-flash');
    await b.vt.resize(120);
    await b.tick();
    t = b.vt.all();
    expect(t.join('\n')).toContain('xin chào');
    // chỉ MỘT ô nhập (không bị lặp do vẽ lại sai chỗ)
    expect(t.filter((l) => l.includes('Nhập việc cần làm') || l.startsWith('│ > xin chào')).length).toBe(1);
    void box;
  });

  it('thoát bằng /exit: phản hồi action exit, dispose được gọi, terminal khôi phục', async () => {
    b = await boot();
    await b.type('/exit');
    await b.type(KEY.enter);
    expect(await b.done).toBe(0);
    expect(b.rt.disposed).toBe(true);
    expect(b.vt.raw.join('')).toContain('\x1b[?2004l');
    b = null;
  });

  it('Unicode: tiếng Việt NFD, CJK, emoji trong ô nhập không lệch khung', async () => {
    b = await boot();
    await b.type('Việt Nam '.normalize('NFD') + '日本語 ế');
    const rows = b.vt.all().filter((l) => l.startsWith('│') || l.startsWith('╭') || l.startsWith('╰'));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.some((l) => l.includes('日本語 ế'))).toBe(true);
    const w = rows.map((r) => stringWidth(r));
    expect(new Set(w).size).toBe(1);
  });
});
