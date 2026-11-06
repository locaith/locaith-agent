import { describe, expect, it } from 'vitest';
import { DemoProvider } from '../src/core/providers/demo';
import { reduceView } from '../src/shared/transcript';
import type { ViewState } from '../src/shared/protocol';
import { eventsOf, makeHarness } from './helpers/harness';
import { FakeProvider } from './helpers/fakeProvider';

describe('chế độ demo chạy trọn kịch bản của tài liệu kiến trúc bằng engine thật', () => {
  it('kế hoạch → nạp kỹ năng → công cụ song song → dòng trạng thái → artifact → câu trả lời', async () => {
    const demo = new DemoProvider({ speed: 3 });
    const h = makeHarness([], { provider: demo as unknown as FakeProvider, summarizer: true });
    const r = await h.run('So sánh điểm các model AI và dựng bảng thang điểm');
    expect(r.stopReason).toBe('end_turn');
    expect(r.turns).toBe(6);

    // 1. kế hoạch
    const tasks = eventsOf(h.events, 'tasks');
    expect(tasks[0].added).toHaveLength(3);
    // 2. nạp kỹ năng đúng lúc
    expect(eventsOf(h.events, 'skill')[0].skill).toBe('artifacts');
    // 3. công cụ thật chạy: artifact được tạo, hợp lệ với bộ kiểm tra CSP
    const art = Object.values(h.session.artifacts);
    expect(art).toHaveLength(1);
    expect(art[0].type).toBe('html');
    expect(art[0].content).toContain('Be Vietnam Pro');
    // 4. dòng trạng thái do bộ tóm tắt nền tạo ra (cả suy nghĩ lẫn viết mã)
    const pills = eventsOf(h.events, 'pill');
    expect(pills.some((p) => p.kind === 'thinking' && /đối chiếu|chọn|quy đổi|cân nhắc/i.test(p.text))).toBe(true);
    expect(pills.some((p) => p.kind === 'writing')).toBe(true);
    // 5. kết quả cuối
    const last = h.session.messages.at(-1)!;
    expect(JSON.stringify(last.content)).toContain('chế độ demo');
    expect(h.session.todos.every((t) => t.status === 'completed')).toBe(true);

    // Dựng lại giao diện từ chuỗi sự kiện: thứ tự khối đúng như tài liệu mô tả
    let view = { transcript: [], todos: [], running: false, mode: 'default' } as unknown as ViewState;
    for (const e of h.events) view = reduceView(view, e);
    const a = view.transcript[0];
    const kinds = a.kind === 'assistant' ? a.blocks.map((b) => b.type) : [];
    expect(kinds.indexOf('tasks')).toBeLessThan(kinds.indexOf('skill'));
    expect(kinds.indexOf('skill')).toBeLessThan(kinds.indexOf('artifact'));
    expect(kinds.at(-1)).toBe('text');
    expect(kinds.filter((k) => k === 'tool').length).toBeGreaterThanOrEqual(5);
    // không còn dòng trạng thái nào ở trạng thái "đang chạy" sau khi kết thúc
    expect(a.kind === 'assistant' && a.blocks.some((b) => b.type === 'pill' && b.active)).toBe(false);
  }, 30_000);

  it('câu hỏi thường nhận lời giới thiệu thay vì chạy kịch bản', async () => {
    const h = makeHarness([], { provider: new DemoProvider({ speed: 40 }) as unknown as FakeProvider });
    const r = await h.run('xin chào');
    expect(r.turns).toBe(1);
    expect(JSON.stringify(h.session.messages.at(-1))).toContain('chế độ demo');
  });
});

