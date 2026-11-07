import { describe, expect, it } from 'vitest';
import type { QueuedMessage } from '../src/core/engine/engine';
import { newSession } from '../src/core/engine/types';
import type { ProviderEvent } from '../src/core/types';
import { makeBackup, parseBackup } from '../src/shared/sessionBackup';
import type { TItem, UiEvent, ViewState } from '../src/shared/protocol';
import { applyEvent, reduceView } from '../src/shared/transcript';
import { FakeProvider, textTurn, toolTurn } from './helpers/fakeProvider';
import { eventsOf, makeHarness } from './helpers/harness';

const msg = (id: string, text: string): QueuedMessage => ({ id, text, display: [], content: [{ type: 'text', text }], ts: 1000 });
const LIST = { name: 'list_dir', input: { path: '.' } };
const opts = { files: { 'a.txt': 'x' }, settings: { language: 'vi' as const } };

/** Vòng đời các đoạn trả lời + tin người dùng, theo thứ tự phát ra. */
function lifecycle(events: UiEvent[]) {
  return events.filter((e): e is Extract<UiEvent, { t: 'assistant_start' | 'assistant_end' | 'user' }> => e.t === 'assistant_start' || e.t === 'assistant_end' || e.t === 'user');
}

describe('hàng đợi tin nhắn — engine', () => {
  it('chèn SAU lượt công cụ: tin đi chung tin nhắn kết quả (tool_result đứng trước), có dòng báo cho model biết', async () => {
    let calls = 0;
    // Tin chèn giữa chừng được ghi vào danh sách tác vụ (trạng thái chờ) nên khi model dừng, cổng hoàn thành nhắc một lần ([nhắc lần 1]);
    // model đáp lại bằng todo_write đánh dấu xong rồi kết thúc. (0.6.31: việc dở còn nguyên sau lời nhắc thì bị nhắc lại — xem gateFinal.test.ts —
    // nên bước cuối phải là cập nhật tác vụ thật, không còn là một câu chữ suông.)
    const done = () => toolTurn([{ name: 'todo_write', input: { todos: [{ id: 't1', title: 'Dùng TypeScript nhé', status: 'completed' }] } }]);
    const h = makeHarness([() => toolTurn([LIST]), () => textTurn('Đã làm theo TypeScript'), done, () => textTurn('Xong cả hai việc.')], {
      ...opts,
      takeQueued: () => (calls++ === 0 ? [msg('q1', 'Dùng TypeScript nhé')] : []),
    });
    const r = await h.run('Liệt kê thư mục');
    expect(r.stopReason).toBe('end_turn');
    expect(h.provider.requests).toHaveLength(4); // lượt 3 = đáp lại lời nhắc hoàn thành tác vụ còn chờ

    const last = h.provider.requests[1].messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(last.content.map((b) => b.type)).toEqual(['tool_result', 'text', 'text']);
    expect(last.content[1]).toMatchObject({ type: 'text', text: expect.stringContaining('trong lúc bạn đang làm việc') });
    expect(last.content[2]).toMatchObject({ type: 'text', text: 'Dùng TypeScript nhé' });
    // lời nhắc hoàn thành có nhãn đếm và đứng SAU câu trả lời của model (vẫn xen kẽ vai trò)
    const nudge = h.provider.requests[2].messages.at(-1)!;
    expect(nudge).toMatchObject({ role: 'user', synthetic: true });
    expect((nudge.content[0] as { text: string }).text).toMatch(/^\[nhắc lần 1\] /);
    // hội thoại vẫn xen kẽ vai trò: user, assistant(tool_use), user(kết quả + tin chèn), assistant, user(nhắc), assistant(todo_write), user(kết quả), assistant
    expect(h.session.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  });

  it('giao diện: đóng đoạn trả lời hiện tại → tin người dùng (steer) → mở đoạn mới; cùng một lần chạy', async () => {
    let calls = 0;
    const h = makeHarness([() => toolTurn([LIST]), () => textTurn('xong')], { ...opts, takeQueued: () => (calls++ === 0 ? [msg('q1', 'thêm yêu cầu')] : []) });
    const r = await h.run('bắt đầu');
    const lc = lifecycle(h.events);
    expect(lc.map((e) => e.t)).toEqual(['assistant_start', 'assistant_end', 'user', 'assistant_start', 'assistant_end']);
    const [s1, e1, u, s2, e2] = lc as [Extract<UiEvent, { t: 'assistant_start' }>, Extract<UiEvent, { t: 'assistant_end' }>, Extract<UiEvent, { t: 'user' }>, Extract<UiEvent, { t: 'assistant_start' }>, Extract<UiEvent, { t: 'assistant_end' }>];
    expect(e1.id).toBe(s1.id);
    expect(e2.id).toBe(s2.id);
    expect(s2.id).not.toBe(s1.id);
    expect(u).toMatchObject({ id: 'q1', text: 'thêm yêu cầu', steer: true });
    expect(r.assistantId).toBe(s2.id);
    // công cụ thuộc đoạn 1, chữ trả lời thuộc đoạn 2
    expect(eventsOf(h.events, 'tool_start')[0].id).toBe(s1.id);
    expect(eventsOf(h.events, 'text').at(-1)!.id).toBe(s2.id);

    // transcript dựng từ chính các sự kiện đó: assistant (xong) → user (steer) → assistant (xong)
    const items = h.events.reduce<TItem[]>((acc, ev) => applyEvent(acc, ev), []);
    expect(items.map((i) => i.kind)).toEqual(['assistant', 'user', 'assistant']);
    expect(items[0]).toMatchObject({ done: true });
    expect(items[1]).toMatchObject({ kind: 'user', steer: true });
    expect(items[2]).toMatchObject({ done: true });
  });

  it('model dừng mà không gọi công cụ: tin chờ thành lượt kế tiếp của CÙNG lần chạy (không có dòng báo steer)', async () => {
    let calls = 0;
    const h = makeHarness([() => textTurn('Xong phần 1'), () => textTurn('Đây là trả lời cho tin chờ')], { ...opts, takeQueued: () => (calls++ === 0 ? [msg('q1', 'Giờ làm phần 2')] : []) });
    const r = await h.run('Làm phần 1');
    expect(r.stopReason).toBe('end_turn');
    expect(r.turns).toBe(2);
    const req2 = h.provider.requests[1].messages;
    expect(req2.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(req2[2].content).toEqual([{ type: 'text', text: 'Giờ làm phần 2' }]);
    const lc = lifecycle(h.events);
    expect(lc.map((e) => e.t)).toEqual(['assistant_start', 'assistant_end', 'user', 'assistant_start', 'assistant_end']);
    const user = lc.find((e): e is Extract<UiEvent, { t: 'user' }> => e.t === 'user')!;
    expect(user.steer).toBeUndefined();
    expect(eventsOf(h.events, 'run_state')).toHaveLength(0); // engine không tự bật/tắt trạng thái chạy
  });

  it('nhiều tin cùng chờ: giao một lần theo đúng thứ tự, mỗi tin một bong bóng riêng, chỉ một lần tách đoạn', async () => {
    let calls = 0;
    const h = makeHarness([() => toolTurn([LIST]), () => textTurn('ok')], {
      ...opts,
      takeQueued: () => (calls++ === 0 ? [msg('q1', 'Một'), msg('q2', 'Hai')] : []),
    });
    await h.run('đi');
    const last = h.provider.requests[1].messages.at(-1)!;
    expect(last.content.map((b) => (b.type === 'text' ? b.text : b.type)).slice(0, 1)).toEqual(['tool_result']);
    // dòng báo đầu tiên + mỗi việc mới có nhãn thứ tự để model làm lần lượt, không bỏ việc nào
    expect((last.content[1] as { text: string }).text).toContain('2 tin nhắn');
    expect(last.content.slice(2).map((b) => (b.type === 'text' ? b.text : ''))).toEqual(['[Việc mới 1/2]', 'Một', '[Việc mới 2/2]', 'Hai']);
    // hai việc mới được ghi vào danh sách tác vụ ngay khi nhận (trạng thái chờ), để không bị bỏ quên
    const tasks = eventsOf(h.events, 'tasks');
    expect(tasks.at(-1)!.todos.map((x) => `${x.status}:${x.title}`)).toEqual(['pending:Một', 'pending:Hai']);
    expect(tasks.at(-1)!.added).toEqual(['Một', 'Hai']);
    expect(h.session.todos.map((x) => x.status)).toEqual(['pending', 'pending']);
    const lc = lifecycle(h.events);
    expect(lc.map((e) => e.t)).toEqual(['assistant_start', 'assistant_end', 'user', 'user', 'assistant_start', 'assistant_end']);
    expect(lc.filter((e): e is Extract<UiEvent, { t: 'user' }> => e.t === 'user').map((e) => e.id)).toEqual(['q1', 'q2']);
  });

  it('không có tin chờ: hành vi y như cũ (một đoạn trả lời, không sự kiện user)', async () => {
    const h = makeHarness([() => toolTurn([LIST]), () => textTurn('ok')], { ...opts, takeQueued: () => [] });
    await h.run('đi');
    expect(lifecycle(h.events).map((e) => e.t)).toEqual(['assistant_start', 'assistant_end']);
    expect(h.session.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(h.provider.requests[1].messages.at(-1)!.content.map((b) => b.type)).toEqual(['tool_result']);
  });

  it('người dùng đã bấm Dừng: engine KHÔNG lấy hàng đợi (host trả tin về ô nhập)', async () => {
    const ac = new AbortController();
    let taken = 0;
    const h = makeHarness([() => { ac.abort(); return toolTurn([LIST]); }], {
      ...opts,
      takeQueued: () => {
        taken++;
        return [msg('q1', 'x')];
      },
    });
    const r = await h.run('đi', ac.signal);
    expect(r.stopReason).toBe('aborted');
    expect(taken).toBe(0);
  });

  it('hàng đợi lỗi (ném ngoại lệ) không làm hỏng lần chạy', async () => {
    const h = makeHarness([() => toolTurn([LIST]), () => textTurn('ok')], {
      ...opts,
      takeQueued: () => {
        throw new Error('hỏng');
      },
    });
    const r = await h.run('đi');
    expect(r.stopReason).toBe('end_turn');
    expect(h.provider.requests[1].messages.at(-1)!.content.map((b) => b.type)).toEqual(['tool_result']);
  });

  it('chèn giữa vòng công cụ KHÔNG làm mất khối suy luận của model (kể cả khi system/công cụ vừa đổi)', async () => {
    // Nạp kỹ năng `artifacts` mở thêm công cụ → "tiền tố" prompt đổi. Trước đây tin user có chữ bị coi là ranh giới lượt và xoá suy luận
    // của tin assistant đang chờ kết quả công cụ → Anthropic trả 400. Tin chèn giữa chừng phải giữ nguyên khối suy luận.
    const t1 = toolTurn([{ name: 'load_skill', input: { skill_name: 'artifacts' } }]);
    (t1.at(-1) as Extract<ProviderEvent, { type: 'done' }>).message.content.unshift({ type: 'thinking', text: 'cần nạp kỹ năng', provider: 'fake', signature: 'sig' });
    // (0.6.31) Việc chèn giữa chừng vẫn "chờ" nên cổng nhắc hai lần rồi mới chốt: đủ bước để lượt chạy kết thúc êm, không rơi vào "hết kịch bản".
    const provider = new FakeProvider([() => t1, () => textTurn('xong'), () => textTurn('xong cả việc mới'), () => textTurn('đã xong hết')]);
    (provider.capabilities as { thinkingBoundToPrefix?: boolean }).thinkingBoundToPrefix = true;
    let calls = 0;
    const h = makeHarness([], { ...opts, provider, takeQueued: () => (calls++ === 0 ? [msg('q1', 'nhớ dùng tiếng Việt')] : []) });
    await h.run('tạo báo cáo');
    // Khối suy luận phải được GIỮ trong yêu cầu gửi đi (trước đây bị xoá → Anthropic trả 400).
    // (Sau đó engine còn nhắc hoàn thành tác vụ mới và có thể bỏ suy luận cũ ở ranh giới kế tiếp — đúng thiết kế.)
    const sent = provider.requests[1].messages.find((m) => m.role === 'assistant');
    expect(sent?.content.some((b) => b.type === 'thinking')).toBe(true);
    expect(provider.requests[1].historyEdited).toBeFalsy();
  });
});

describe('hàng đợi tin nhắn — giao diện dùng chung', () => {
  const base = { running: true, transcript: [] as TItem[] } as unknown as ViewState;

  it('tách đoạn giữa chừng không tắt trạng thái chạy (run_state là sự kiện riêng)', () => {
    const evs: UiEvent[] = [
      { t: 'run_state', running: true },
      { t: 'assistant_start', id: 'a1', provider: 'p', model: 'm', ts: 1 },
      { t: 'assistant_end', id: 'a1', stopReason: 'end_turn' },
      { t: 'user', id: 'q1', text: 'thêm', attachments: [], ts: 2, steer: true },
      { t: 'assistant_start', id: 'a2', provider: 'p', model: 'm', ts: 3 },
    ];
    const v = evs.reduce((s, e) => reduceView(s, e), base);
    expect(v.running).toBe(true);
    expect(v.transcript.map((i) => i.kind)).toEqual(['assistant', 'user', 'assistant']);
    expect((v.transcript[1] as { steer?: boolean }).steer).toBe(true);
    expect((v.transcript[2] as { done: boolean }).done).toBe(false);
  });

  it('tin không phải steer không mang cờ steer', () => {
    const items = applyEvent([], { t: 'user', id: 'u', text: 'x', attachments: [], ts: 1 });
    expect('steer' in items[0]).toBe(false);
  });

  it('sao lưu → khôi phục giữ nguyên cờ steer (thử lại/sửa tin cuối dựa vào nó)', () => {
    const session = newSession({ id: 's_1', provider: 'p', model: 'm' });
    const transcript: TItem[] = [
      { kind: 'user', id: 'u1', text: 'bắt đầu', attachments: [], ts: 1 },
      { kind: 'user', id: 'u2', text: 'chen giữa', attachments: [], ts: 2, steer: true },
    ];
    const file = makeBackup([{ workspace: 'ws', session, transcript }], { version: '0', platform: 'vscode' } as never);
    const parsed = parseBackup(JSON.stringify(file), 'ws');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const items = parsed.sessions[0].transcript;
    expect(items[0]).not.toHaveProperty('steer');
    expect(items[1]).toMatchObject({ kind: 'user', steer: true });
  });
});
