/**
 * Cổng hoàn thành ở mức ENGINE (0.6.31): model dừng khi còn việc dở → nhắc có nhãn đếm "[nhắc lần N]"; tới lần THỨ BA thì engine
 * thôi nhắc, báo người dùng và dừng. Điều cần chứng minh là số lần gọi model BỊ CHẶN TRÊN — kịch bản của FakeProvider chỉ có đủ
 * số bước cần thiết, nên một lần gọi thừa sẽ nổ "hết kịch bản" và làm hỏng test.
 *
 * (Bảng "Tasks" cuối khung chat đã bỏ: thông báo cuối này là CÁCH DUY NHẤT người dùng biết còn việc dở, nên nó phải thật sự chạy tới.)
 */
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/core/types';
import { eventsOf, makeHarness } from './helpers/harness';
import { textTurn, toolTurn } from './helpers/fakeProvider';

const textOf = (m: ChatMessage): string => m.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
const todo = (status: 'pending' | 'in_progress' | 'completed') => toolTurn([{ id: `td_${status}`, name: 'todo_write', input: { todos: [{ id: 't1', title: 'Chạy bộ kiểm thử', status }] } }]);
const synthetic = (msgs: readonly ChatMessage[]): string[] => msgs.filter((m) => m.role === 'user' && m.synthetic).map(textOf);
const warns = (events: ReturnType<typeof makeHarness>['events']) => eventsOf(events, 'notice').filter((n) => n.level === 'warn');

describe('cổng hoàn thành — nhắc có nhãn, lần 3 thì chốt', () => {
  it('model lờ MỌI lời nhắc: nhắc lần 1, nhắc lần 2, rồi lần 3 KHÔNG nhắc mà báo người dùng — đúng 4 lần gọi model, không hơn', async () => {
    // 1) ghi việc dở  2) "Xong rồi" (lần can thiệp 1)  3) "Xong rồi" (lần 2)  4) "Xong rồi" (lần 3 = chốt)  → không còn bước nào nữa
    const h = makeHarness([() => todo('pending'), () => textTurn('Xong rồi.'), () => textTurn('Xong rồi.'), () => textTurn('Xong rồi.')], { settings: { language: 'vi' } });
    const r = await h.run('chạy kiểm thử');

    expect(r.stopReason).toBe('end_turn');
    expect(h.provider.requests).toHaveLength(4); // chặn trên: không có lần gọi thứ 5 (FakeProvider sẽ ném "hết kịch bản")

    const nudges = synthetic(h.session.messages);
    expect(nudges).toHaveLength(2); // chỉ HAI tin nhắc thật được chèn vào hội thoại
    expect(nudges[0]).toMatch(/^\[nhắc lần 1\] /);
    expect(nudges[1]).toMatch(/^\[nhắc lần 2\] /);
    expect(nudges.join('\n')).not.toContain('[nhắc lần 3]');
    expect(nudges[0]).toContain('Chạy bộ kiểm thử'); // nhắc CỤ THỂ: nêu đúng tên việc

    // lần 3: báo người dùng một lần, nêu đúng việc còn dở, số lần ĐÃ nhắc thật (2)
    const w = warns(h.events);
    expect(w).toHaveLength(1);
    expect(w[0].text).toContain('Đã nhắc 2 lần');
    expect(w[0].text).toContain('Chạy bộ kiểm thử');
    // việc dở vẫn nằm nguyên trong phiên (không bị engine tự đóng giùm)
    expect(h.session.todos.map((x) => x.status)).toEqual(['pending']);
  });

  it('lần gọi thứ 4 là lần CHỐT: lịch sử gửi đi kết thúc bằng lời nhắc lần 2, không có lời nhắc lần 3', async () => {
    const h = makeHarness([() => todo('in_progress'), () => textTurn('ok'), () => textTurn('ok'), () => textTurn('ok')]);
    await h.run('x');
    const last = h.provider.requests[3].messages.at(-1)!;
    expect(last.synthetic).toBe(true);
    expect(textOf(last)).toMatch(/^\[nhắc lần 2\]/);
  });

  it('làm xong việc ngay sau lời nhắc đầu: chỉ MỘT lần nhắc, không có thông báo chốt', async () => {
    const h = makeHarness([() => todo('pending'), () => textTurn('Xong rồi.'), () => todo('completed'), () => textTurn('Đã cập nhật.')]);
    const r = await h.run('x');
    expect(r.stopReason).toBe('end_turn');
    expect(h.provider.requests).toHaveLength(4);
    expect(synthetic(h.session.messages)).toHaveLength(1);
    expect(warns(h.events)).toHaveLength(0);
  });

  it('làm xong việc sau lời nhắc THỨ HAI: hai lần nhắc, vẫn không có thông báo chốt', async () => {
    const h = makeHarness([() => todo('pending'), () => textTurn('ok'), () => textTurn('ok'), () => todo('completed'), () => textTurn('Xong.')]);
    await h.run('x');
    expect(h.provider.requests).toHaveLength(5);
    expect(synthetic(h.session.messages).map((s) => /^\[nhắc lần \d\]/.exec(s)?.[0])).toEqual(['[nhắc lần 1]', '[nhắc lần 2]']);
    expect(warns(h.events)).toHaveLength(0);
  });

  it('tiếng Anh: nhãn và thông báo chốt bằng tiếng Anh', async () => {
    const h = makeHarness([() => todo('pending'), () => textTurn('Done.'), () => textTurn('Done.'), () => textTurn('Done.')], { settings: { language: 'en' } });
    await h.run('run the tests');
    const nudges = synthetic(h.session.messages);
    expect(nudges[0]).toMatch(/^\[reminder 1\] /);
    expect(nudges[1]).toMatch(/^\[reminder 2\] /);
    const w = warns(h.events);
    expect(w).toHaveLength(1);
    expect(w[0].text).toContain('Reminded 2 time(s)');
    expect(w[0].text).toContain('Chạy bộ kiểm thử');
  });

  it('không có việc dở, không sửa tệp: không nhắc gì và không tốn thêm lần gọi', async () => {
    const h = makeHarness([() => textTurn('Xin chào!')]);
    await h.run('chào');
    expect(h.provider.requests).toHaveLength(1);
    expect(synthetic(h.session.messages)).toHaveLength(0);
    expect(warns(h.events)).toHaveLength(0);
  });

  it('đã sửa tệp mà không chạy gì: nhắc kiểm chứng ĐÚNG MỘT lần (kiểm chứng không lặp lại)', async () => {
    const h = makeHarness(
      [
        () => toolTurn([{ id: 'w1', name: 'write_file', input: { path: 'out.txt', content: 'x\n' } }]),
        () => textTurn('Đã ghi.'), // → nhắc kiểm chứng
        () => textTurn('Vẫn chưa chạy gì.'), // không còn lý do nào → cho kết thúc
      ],
      {},
    );
    const r = await h.run('ghi tệp');
    expect(r.stopReason).toBe('end_turn');
    expect(h.provider.requests).toHaveLength(3);
    const nudges = synthetic(h.session.messages);
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toMatch(/^\[nhắc lần 1\] .*kiểm chứng/);
    expect(warns(h.events)).toHaveLength(0);
  });

  it('việc dở + chưa kiểm chứng + model lờ tất cả: lý do mới được nói trước khi lặp, tổng vẫn đúng 3 lần can thiệp (2 nhắc + 1 chốt)', async () => {
    const h = makeHarness(
      [
        () => toolTurn([{ id: 'w1', name: 'write_file', input: { path: 'out.txt', content: 'x\n' } }]),
        () => todo('pending'),
        () => textTurn('ok'), // lần 1: việc dở
        () => textTurn('ok'), // lần 2: kiểm chứng (lý do CHƯA nói) — không phải lặp việc dở
        () => textTurn('ok'), // lần 3: chốt
      ],
      {},
    );
    await h.run('x');
    expect(h.provider.requests).toHaveLength(5);
    const nudges = synthetic(h.session.messages);
    expect(nudges).toHaveLength(2);
    expect(nudges[0]).toContain('Chạy bộ kiểm thử'); // việc dở
    expect(nudges[1]).toMatch(/^\[nhắc lần 2\] .*kiểm chứng/); // kiểm chứng
    expect(warns(h.events)).toHaveLength(1);
  });

  it('chế độ lập kế hoạch: các bước là KẾ HOẠCH chờ duyệt (chưa được phép làm) → cổng không nhắc, không báo "còn việc dở"', async () => {
    const h = makeHarness([() => todo('pending'), () => textTurn('Đây là kế hoạch, chờ bạn duyệt.')]);
    h.session.mode = 'plan';
    const r = await h.run('lập kế hoạch');
    expect(r.stopReason).toBe('end_turn');
    expect(h.provider.requests).toHaveLength(2);
    expect(synthetic(h.session.messages)).toHaveLength(0);
    expect(warns(h.events)).toHaveLength(0);
    expect(h.session.todos.map((x) => x.status)).toEqual(['pending']); // kế hoạch còn nguyên chờ duyệt
  });

  it('người dùng bấm Dừng: cổng không nhắc, không báo gì', async () => {
    const ac = new AbortController();
    const h = makeHarness([() => todo('pending'), () => { ac.abort(); return textTurn('ok'); }]);
    const r = await h.run('x', ac.signal);
    expect(r.stopReason).toBe('aborted');
    expect(synthetic(h.session.messages)).toHaveLength(0);
    expect(warns(h.events).filter((n) => /Đã nhắc/.test(n.text))).toHaveLength(0);
  });
});
