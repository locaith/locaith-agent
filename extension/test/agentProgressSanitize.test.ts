import { describe, expect, it } from 'vitest';
import { sanitizeAgent, sanitizeEvent, sanitizeEvents, sanitizeItem, sanitizeTranscript } from '../src/core/remote/sanitize';
import type { AssistantItem, TItem, ToolBlock, UiEvent } from '../src/shared/protocol';

const blockWith = (agent: unknown): ToolBlock => ({ type: 'tool', id: 'c1', name: 'agent', args: { description: 'x' }, state: 'running', startedAt: 1, agent: agent as ToolBlock['agent'] });
const turn = (b: ToolBlock): AssistantItem => ({ kind: 'assistant', id: 'A', provider: 'p', model: 'm', ts: 1, blocks: [b], done: false });

describe('sanitizeAgent — tiến độ agent con gửi ra ngoài máy', () => {
  it('chỉ số nguyên không âm; activity một dòng ≤ 120 ký tự, bỏ ký tự điều khiển', () => {
    expect(sanitizeAgent({ tokens: 1234.9, tools: 3, failed: 0, activity: 'Đang đọc\n a.ts\u0000' })).toEqual({ tokens: 1234, tools: 3, activity: 'Đang đọc a.ts' });
    const long = sanitizeAgent({ tokens: 1, tools: 1, activity: 'x'.repeat(500) });
    expect(long.activity!.length).toBe(120);
    expect(long.activity!.endsWith('…')).toBe(true);
  });

  it('dữ liệu sai kiểu/âm/NaN/vô cực không lọt qua', () => {
    const bad = sanitizeAgent({ tokens: -5, tools: Number.NaN, failed: Number.POSITIVE_INFINITY, activity: 42 } as unknown as Parameters<typeof sanitizeAgent>[0]);
    expect(bad).toEqual({ tokens: 0, tools: 0 });
    expect(sanitizeAgent({ tokens: 1e20, tools: 1 }).tokens).toBe(1e12);
  });
});

describe('khối công cụ và sự kiện', () => {
  it('khối `agent` được làm sạch trong transcript gửi ra ngoài; khối hỏng bị bỏ trường chứ không làm vỡ cả khối', () => {
    const ok = sanitizeItem(turn(blockWith({ tokens: 10, tools: 2, activity: 'Đang đọc a.ts' }))) as AssistantItem;
    expect((ok.blocks[0] as ToolBlock).agent).toEqual({ tokens: 10, tools: 2, activity: 'Đang đọc a.ts' });
    const garbage = sanitizeItem(turn(blockWith('rác'))) as AssistantItem;
    const b = garbage.blocks[0] as ToolBlock;
    expect(b.agent).toBeUndefined();
    expect(b.id).toBe('c1');
    const none = sanitizeItem(turn({ ...blockWith(undefined), agent: undefined })) as AssistantItem;
    expect('agent' in (none.blocks[0] as ToolBlock) && (none.blocks[0] as ToolBlock).agent !== undefined).toBe(false);
    expect(sanitizeTranscript([turn(blockWith({ tokens: 1, tools: 1 }))] as TItem[]).transcript).toHaveLength(1);
  });

  it('sanitizeEvent làm sạch agent_progress', () => {
    const ev: UiEvent = { t: 'agent_progress', id: 'A', callId: 'c1', tokens: 5.5, tools: 2, failed: 1, activity: `${'y'.repeat(300)}` };
    const out = sanitizeEvent(ev) as Extract<UiEvent, { t: 'agent_progress' }>;
    expect(out).toMatchObject({ t: 'agent_progress', id: 'A', callId: 'c1', tokens: 5, tools: 2, failed: 1 });
    expect(out.activity!.length).toBe(120);
  });

  it('sanitizeEvents BỎ agent_progress (bộ giảm trạng thái của máy khách Remote cũ sẽ hỏng khi gặp loại sự kiện lạ) và vẫn rút gọn các sự kiện khác', () => {
    const evs: UiEvent[] = [
      { t: 'agent_progress', id: 'A', callId: 'c1', tokens: 1, tools: 1 },
      { t: 'tool_progress', id: 'A', callId: 'c1', output: 'z'.repeat(9000) },
      { t: 'text', id: 'A', delta: 'xin chào' },
    ];
    const out = sanitizeEvents(evs);
    expect(out.map((e) => e.t)).toEqual(['tool_progress', 'text']);
    expect((out[0] as Extract<UiEvent, { t: 'tool_progress' }>).output.length).toBeLessThan(9000);
    expect(sanitizeEvents([{ t: 'agent_progress', id: 'A', callId: 'c1', tokens: 1, tools: 1 }])).toEqual([]);
  });
});
