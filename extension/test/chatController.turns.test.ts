/**
 * ChatController THẬT (deps giả) — lỗi người dùng báo: «Dừng rồi gõ "tiếp tục" thì chạy ở cả 2 chỗ».
 * Ba lớp phòng thủ cần được chứng minh, mỗi lớp một ca:
 *   (i)   hai lượt KHÔNG BAO GIỜ chạy chồng nhau (turnLock) — kể cả khi gửi "tiếp tục" ngay sau Dừng, và một lượt hỏng không làm kẹt các lượt sau;
 *   (ii)  sau Dừng giữa vòng công cụ (hay sau sự cố để lại lệnh mồ côi) lịch sử gửi cho model KHÔNG có tool_use thiếu kết quả;
 *   (iii) câu "tiếp tục" trần trụi được mở rộng thành chỉ dẫn (liệt kê việc còn tồn, cấm chạy lại lệnh đã huỷ) NHƯNG ô hiển thị giữ nguyên chữ gốc.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage, ProviderEvent, StreamRequest, ToolResultBlock } from '../src/core/types';
import { rebuildTranscript, userTurnCount } from '../src/shared/transcriptRebuild';
import { textTurn, toolTurn } from './helpers/fakeProvider';
import { makeControllerHarness, type ControllerHarness } from './helpers/controllerHarness';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
async function until(cond: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`quá hạn chờ: ${what}`);
    await sleep(10);
  }
}
const textOf = (m: ChatMessage): string => m.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
const resultsOf = (m: ChatMessage): ToolResultBlock[] => m.content.filter((b): b is ToolResultBlock => b.type === 'tool_result');
/** Mọi tool_use phải được trả lời ở tin user NGAY SAU nó. */
function orphansOf(messages: readonly ChatMessage[]): string[] {
  const out: string[] = [];
  messages.forEach((m, i) => {
    if (m.role !== 'assistant') return;
    const next = messages[i + 1];
    const answered = new Set(next && next.role === 'user' ? resultsOf(next).map((r) => r.toolUseId) : []);
    for (const b of m.content) if (b.type === 'tool_use' && !answered.has(b.id)) out.push(b.id);
  });
  return out;
}

/** Đo độ chồng lấn của các lần gọi model: số lần `stream()` đang chạy đồng thời tối đa. */
function trackConcurrency(h: ControllerHarness): { max: () => number } {
  let active = 0;
  let max = 0;
  const orig = h.provider.stream.bind(h.provider);
  h.provider.stream = async function* (req: StreamRequest): AsyncGenerator<ProviderEvent, void, void> {
    active++;
    max = Math.max(max, active);
    try {
      yield* orig(req);
    } finally {
      active--;
    }
  };
  return { max: () => max };
}

const harnesses: ControllerHarness[] = [];
const make = (...a: Parameters<typeof makeControllerHarness>): ControllerHarness => {
  const h = makeControllerHarness(...a);
  harnesses.push(h);
  return h;
};
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.dispose();
});

const PLAN = [
  { id: 't1', title: 'Vá lỗi chạy hai chỗ', status: 'in_progress' },
  { id: 't2', title: 'Bỏ bảng Tasks', status: 'completed' },
  { id: 't3', title: 'Phát hành 0.6.31', status: 'pending' },
];

describe('(i) turnLock — các lượt chạy tuần tự tuyệt đối', () => {
  it('nhiều lượt gọi runAgentTurn chồng nhau (cố tình bỏ qua chốt "bận") vẫn chạy lần lượt, đúng thứ tự gọi', async () => {
    const h = make({ script: [] });
    const run = (h.ctl as unknown as { runAgentTurn(fn: () => Promise<void>): Promise<void> }).runAgentTurn.bind(h.ctl);
    const order: string[] = [];
    let active = 0;
    let max = 0;
    const turn = (name: string, ms: number) => async () => {
      active++;
      max = Math.max(max, active);
      order.push(`${name}:bắt đầu`);
      await sleep(ms);
      order.push(`${name}:xong`);
      active--;
    };
    await Promise.all([run(turn('A', 60)), run(turn('B', 15)), run(turn('C', 0))]);
    expect(max).toBe(1);
    expect(order).toEqual(['A:bắt đầu', 'A:xong', 'B:bắt đầu', 'B:xong', 'C:bắt đầu', 'C:xong']);
    // và hết lượt thì controller rảnh trở lại
    expect((h.ctl as unknown as { starting: boolean; agentBusy: boolean }).starting).toBe(false);
    expect((h.ctl as unknown as { starting: boolean; agentBusy: boolean }).agentBusy).toBe(false);
  });

  it('một lượt NÉM LỖI không làm kẹt các lượt sau (chuỗi khoá không bị "đầu độc" bởi lời hứa bị từ chối)', async () => {
    const h = make({ script: [() => textTurn('Xin chào, tôi vẫn chạy được.')] });
    const run = (h.ctl as unknown as { runAgentTurn(fn: () => Promise<void>): Promise<void> }).runAgentTurn.bind(h.ctl);
    await expect(run(async () => Promise.reject(new Error('hỏng giữa chừng')))).rejects.toThrow('hỏng giữa chừng');
    // cờ bận phải được trả về, nếu không tin kế tiếp bị xếp hàng mãi
    expect((h.ctl as unknown as { starting: boolean }).starting).toBe(false);
    await h.send('chào');
    await h.idle();
    expect(h.provider.requests).toHaveLength(1);
    expect(h.shownUserTexts()).toEqual(['chào']);
    expect(textOf(h.provider.requests[0].messages[0])).toContain('chào');
  });

  it('hai lượt chồng nhau mà lượt đầu lỗi: lượt hai vẫn chạy, và vẫn sau khi lượt đầu nhả hẳn', async () => {
    const h = make({ script: [] });
    const run = (h.ctl as unknown as { runAgentTurn(fn: () => Promise<void>): Promise<void> }).runAgentTurn.bind(h.ctl);
    const order: string[] = [];
    const first = run(async () => {
      order.push('1:bắt đầu');
      await sleep(40);
      order.push('1:lỗi');
      throw new Error('x');
    });
    const second = run(async () => {
      order.push('2:bắt đầu');
    });
    await expect(first).rejects.toThrow('x');
    await second;
    expect(order).toEqual(['1:bắt đầu', '1:lỗi', '2:bắt đầu']);
  });

  it('Dừng rồi gõ "tiếp tục" NGAY khi lượt cũ còn đang nhả: không có hai lần gọi model chồng nhau, và tin không bị mất (trả về ô nhập)', async () => {
    const gate = deferred();
    const h = make({
      script: [
        () => toolTurn([{ id: 'c1', name: 'list_dir', input: { path: '.' } }]),
        async () => {
          await gate.promise; // lần gọi model đang treo — mô phỏng lượt cũ chưa kịp nhả sau khi bấm Dừng
          return textTurn('trả lời muộn');
        },
      ],
      files: { 'a.txt': '1' },
    });
    const conc = trackConcurrency(h);
    const first = h.send('làm việc dài');
    await until(() => h.provider.requests.length === 2, 'lần gọi model thứ hai đã bắt đầu');

    h.stop();
    await h.send('tiếp tục'); // gõ ngay sau Dừng
    expect(h.ctl.isRunning).toBe(true); // lượt cũ vẫn đang nhả
    expect(h.provider.requests).toHaveLength(2); // KHÔNG có lần gọi thứ ba chạy chen vào

    gate.resolve();
    await first;
    await h.idle();

    expect(conc.max()).toBe(1);
    expect(h.provider.requests).toHaveLength(2); // "tiếp tục" không tự chạy sau Dừng…
    expect(h.posted.some((m) => m.type === 'insert' && m.text === 'tiếp tục')).toBe(true); // …mà quay về ô nhập, không mất
    expect(h.shownUserTexts()).toEqual(['làm việc dài']);
    expect(h.view().queued ?? []).toHaveLength(0);
  });
});

describe('(ii) sau Dừng, lịch sử gửi cho model không có tool_use mồ côi', () => {
  it('Dừng giữa vòng công cụ thật → "tiếp tục" chạy tiếp trên lịch sử hợp lệ, KHÔNG có hai lần gọi model chồng nhau', async () => {
    const gate = deferred();
    const h = make({
      script: [
        () => toolTurn([{ id: 'c1', name: 'list_dir', input: { path: '.' } }]),
        async () => {
          await gate.promise;
          return textTurn('muộn');
        },
        () => textTurn('Đã làm tiếp đúng chỗ dừng.'),
      ],
      files: { 'a.txt': '1' },
    });
    const conc = trackConcurrency(h);
    const first = h.send('làm việc dài');
    await until(() => h.provider.requests.length === 2, 'model đang suy nghĩ ở vòng thứ hai');
    h.stop();
    gate.resolve();
    await first;
    await h.idle();
    expect(h.session().messages.at(-1)).toMatchObject({ role: 'user' }); // kết quả công cụ đã được ghi (engine không bỏ rơi tool_use khi Dừng)
    expect(orphansOf(h.session().messages)).toEqual([]);

    await h.send('tiếp tục');
    await h.idle();
    expect(h.provider.requests).toHaveLength(3);
    const sent = h.provider.requests[2].messages;
    expect(orphansOf(sent)).toEqual([]);
    expect(sent.at(-1)).toMatchObject({ role: 'user' });
    expect(conc.max()).toBe(1);
  });

  it('lịch sử lưu CÓ lệnh mồ côi (tiến trình sập giữa chừng / phiên bản cũ) → "tiếp tục" không phát lại lệnh cũ, model được báo rõ là ĐÃ HUỶ', async () => {
    const h = make({ script: [() => textTurn('Đã làm tiếp, không chạy lại build.')] });
    h.session().messages.push(
      { role: 'user', content: [{ type: 'text', text: 'build giúp tôi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Chạy build.' }, { type: 'tool_use', id: 'run1', name: 'run_command', input: { command: 'npm run build' } }] },
    );
    await h.send('tiếp tục');
    await h.idle();
    const sent = h.provider.requests[0].messages;
    expect(orphansOf(sent)).toEqual([]);
    const cancelled = sent.flatMap(resultsOf);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({ toolUseId: 'run1', isError: true });
    expect(cancelled[0].content).toMatch(/Đừng chạy lại/);
    expect(orphansOf(h.session().messages)).toEqual([]); // vá cả lịch sử LƯU, không chỉ payload
    // lệnh KHÔNG hề được chạy lại
    expect(h.provider.requests).toHaveLength(1);
  });
});

describe('(iii) "tiếp tục" trần trụi', () => {
  it('model nhận chỉ dẫn làm tiếp + danh sách việc còn tồn; người dùng vẫn chỉ thấy đúng chữ họ gõ', async () => {
    const h = make({
      script: [
        () => toolTurn([{ id: 'p1', name: 'todo_write', input: { todos: PLAN } }]),
        () => textTurn('Tạm xong bước 1.'), // → bị nhắc việc dở
        () => textTurn('Vẫn chưa xong hết.'),
        () => textTurn('Dừng ở đây.'), // lần chốt (không nhắc nữa, báo người dùng)
        // lượt "tiếp tục": việc dở vẫn còn nguyên nên cổng lại nhắc 2 lần rồi chốt — chỉ cần đủ bước để lượt chạy kết thúc êm
        () => textTurn('Đã làm tiếp.'),
        () => textTurn('Đã làm tiếp, còn việc.'),
        () => textTurn('Hết khả năng.'),
      ],
    });
    await h.send('lên kế hoạch rồi làm');
    await h.idle();
    expect(h.session().todos.filter((x) => x.status !== 'completed')).toHaveLength(2);
    const before = h.provider.requests.length;

    await h.send('Tiếp tục');
    await h.idle();
    expect(h.provider.requests.length).toBe(before + 3);

    const last = h.provider.requests[before].messages.at(-1)!; // yêu cầu ĐẦU TIÊN của lượt "tiếp tục"
    expect(last.role).toBe('user');
    // chữ người dùng gõ nằm NGUYÊN VẸN ở khối thứ nhất; chỉ dẫn là một khối riêng đứng sau
    expect(last.content.map((b) => b.type)).toEqual(['text', 'text']);
    expect((last.content[0] as { text: string }).text).toBe('Tiếp tục');
    const sentText = (last.content[1] as { text: string }).text;
    expect(sentText).toContain('không làm lại từ đầu');
    expect(sentText).toContain('Còn tồn (2)');
    expect(sentText).toContain('Vá lỗi chạy hai chỗ');
    expect(sentText).toContain('Phát hành 0.6.31');
    expect(sentText).not.toContain('Bỏ bảng Tasks'); // việc đã xong không bị liệt kê
    expect(sentText).toContain('đã huỷ');

    // HIỂN THỊ: đúng chữ gốc, không rò chỉ dẫn
    expect(h.shownUserTexts()).toEqual(['lên kế hoạch rồi làm', 'Tiếp tục']);
    expect(JSON.stringify(h.view().transcript)).not.toContain('Tiếp tục sau khi dừng');
    expect(h.posted.filter((m) => m.type === 'events').flatMap((m) => (m.type === 'events' ? m.events : [])).filter((e) => e.t === 'user').map((e) => (e.t === 'user' ? e.text : ''))).toEqual(['lên kế hoạch rồi làm', 'Tiếp tục']);

    // Cả khi transcript phải dựng lại từ lịch sử gửi model (transcript bị mất / ngắn hơn), chỉ dẫn cũng không hiện ra
    const rebuilt = rebuildTranscript(h.session().messages).filter((i) => i.kind === 'user').map((i) => (i as { text: string }).text);
    expect(rebuilt).toEqual(['lên kế hoạch rồi làm', 'Tiếp tục']);
    expect(userTurnCount(h.session().messages)).toBe(2);
    // tiêu đề cuộc trò chuyện lấy từ tin ĐẦU, không phải chỉ dẫn
    expect(h.session().title).toBe('lên kế hoạch rồi làm');
  });

  it('câu có yêu cầu mới ("tiếp tục và sửa lỗi build") KHÔNG bị gắn chỉ dẫn', async () => {
    const h = make({ script: [() => textTurn('Ok.')] });
    await h.send('tiếp tục và sửa lỗi build');
    await h.idle();
    expect(textOf(h.provider.requests[0].messages.at(-1)!)).toBe('tiếp tục và sửa lỗi build');
  });

  it('không còn việc nào tồn → vẫn gắn chỉ dẫn "làm nốt bước cuối, kiểm chứng, báo kết quả" (không bịa danh sách)', async () => {
    const h = make({ script: [() => textTurn('Xin chào.'), () => textTurn('Đã làm nốt.')] });
    await h.send('chào');
    await h.idle();
    await h.send('tiếp tục');
    await h.idle();
    const sentText = textOf(h.provider.requests[1].messages.at(-1)!);
    expect(sentText).toContain('Không còn việc nào đang mở');
    expect(sentText).not.toContain('Còn tồn');
    expect(h.shownUserTexts()).toEqual(['chào', 'tiếp tục']);
  });
});

describe('Thử lại / Sửa tin cuối sau khi engine vá lệnh mồ côi', () => {
  const pushOrphan = (h: ControllerHarness) =>
    h.session().messages.push(
      { role: 'user', content: [{ type: 'text', text: 'build giúp tôi' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'run1', name: 'run_command', input: { command: 'npm run build' } }] },
    );
  const shape = (h: ControllerHarness) => h.session().messages.map((m) => `${m.role}${m.synthetic ? '*' : ''}`);

  it('Thử lại cắt ĐÚNG tại tin người dùng thật ("tiếp tục"), không phải tại tin kết quả huỷ; tiền tố còn hợp lệ; không nhân đôi tin', async () => {
    const h = make({ script: [() => textTurn('Đã làm tiếp.'), () => textTurn('Làm lại xong.')] });
    pushOrphan(h);
    await h.send('tiếp tục');
    await h.idle();
    expect(shape(h)).toEqual(['user', 'assistant', 'user*', 'user', 'assistant']); // user* = kết quả huỷ do engine vá

    await h.ctl.handleRemote({ type: 'retry' });
    await h.idle();
    expect(h.provider.requests).toHaveLength(2);
    const retried = h.provider.requests[1].messages;
    expect(orphansOf(retried)).toEqual([]);
    expect(retried.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user']);
    expect(retried[2].content[0]).toMatchObject({ type: 'tool_result', toolUseId: 'run1', isError: true });
    // tin chạy lại vẫn mang chỉ dẫn "tiếp tục" như lần đầu (nó là một phần nội dung gửi đi của tin đó)
    expect(retried[3].content.map((b) => b.type)).toEqual(['text', 'text']);
    expect(shape(h)).toEqual(['user', 'assistant', 'user*', 'user', 'assistant']);
    // (controller tự hàn gắn transcript từ lịch sử nên có thể hiện thêm lượt 'build giúp tôi' đã có sẵn trong phiên) — 'tiếp tục' đúng MỘT lần, chữ gốc
    expect(h.shownUserTexts().filter((x) => x === 'tiếp tục')).toHaveLength(1);
    expect(h.shownUserTexts().some((x) => x.includes('Tiếp tục sau khi dừng'))).toBe(false);
  });

  it('Sửa tin cuối đưa chữ GỐC về ô nhập (không kèm chỉ dẫn) và để lại đúng tiền tố hợp lệ', async () => {
    const h = make({ script: [() => textTurn('Đã làm tiếp.')] });
    pushOrphan(h);
    await h.send('Tiếp tục đi');
    await h.idle();
    await h.ctl.handleRemote({ type: 'edit_last' });
    const draft = h.posted.filter((m) => m.type === 'draft').at(-1);
    expect(draft).toMatchObject({ type: 'draft', text: 'Tiếp tục đi' });
    expect(shape(h)).toEqual(['user', 'assistant', 'user*']); // tiền tố hợp lệ: tool_use + kết quả huỷ
    expect(orphansOf(h.session().messages)).toEqual([]);
  });
});

describe('hàng đợi tin nhắn vẫn đúng khi qua khoá lượt', () => {
  it('tin gửi lúc trợ lý đang chạy → thành lượt kế tiếp của CÙNG lần chạy, đúng thứ tự, không mất', async () => {
    const gate = deferred();
    const h = make({
      script: [
        async () => {
          await gate.promise;
          return textTurn('Xong A.');
        },
        () => textTurn('Xong B.'),
      ],
    });
    const conc = trackConcurrency(h);
    const first = h.send('việc A');
    await until(() => h.provider.requests.length === 1, 'lần gọi model đầu');
    await h.send('việc B'); // gửi lúc đang chạy → xếp hàng
    expect(h.view().queued ?? []).toHaveLength(1);
    gate.resolve();
    await first;
    await h.idle();
    expect(h.provider.requests).toHaveLength(2);
    expect(textOf(h.provider.requests[1].messages.at(-1)!)).toContain('việc B');
    expect(h.shownUserTexts()).toEqual(['việc A', 'việc B']);
    expect(conc.max()).toBe(1);
    expect(h.view().queued ?? []).toHaveLength(0);
  });
});
