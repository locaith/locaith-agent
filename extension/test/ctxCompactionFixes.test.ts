/** Hồi quy cho các lỗi do người kiểm chứng tìm ra ở lane ctx-compaction (ngoài test đối kháng trong test/adversarial/). */
import { describe, expect, it } from 'vitest';
import { compactIfNeeded, stripThinking } from '../src/core/engine/compaction';
import { fitRequests, requestBudgetChars } from '../src/core/engine/compactSummary';
import { newSession } from '../src/core/engine/types';
import { contextStatsOf } from '../src/shared/sessionMigrate';
import type { ChatMessage, ContentBlock, ToolResultBlock, ToolUseBlock } from '../src/core/types';
import { FakeProvider } from './helpers/fakeProvider';

let seq = 0;
const use = (path: string): ToolUseBlock => ({ type: 'tool_use', id: `u${++seq}`, name: 'read_file', input: { path } });
const res = (u: ToolUseBlock, content: string): ToolResultBlock => ({ type: 'tool_result', toolUseId: u.id, name: u.name, content });
const asst = (...content: ContentBlock[]): ChatMessage => ({ role: 'assistant', content });
const BIG = 'x'.repeat(4000);

function midLoopSession(): ReturnType<typeof newSession> {
  const s = newSession({ id: 's', provider: 'p', model: 'm' });
  const msgs: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'đọc hết' }] }];
  for (let i = 0; i < 14; i++) {
    const u = use(`f${i}.ts`);
    msgs.push(asst(u), { role: 'user', content: [res(u, BIG)] });
  }
  const pending = use('p.ts');
  msgs.push(asst({ type: 'thinking', text: 't', provider: 'anthropic', signature: 'sig' }, pending), { role: 'user', content: [res(pending, 'x')] });
  s.messages = msgs;
  return s;
}

describe('ctx-compaction — sửa lỗi sau kiểm chứng', () => {
  it('nhà cung cấp ràng buộc suy luận vào tiền tố: KHÔNG lược giữa vòng công cụ khi chưa tới ngưỡng nén (hoãn tới ranh giới lượt)', async () => {
    const provider = new FakeProvider([]);
    (provider as { capabilities: unknown }).capabilities = { ...provider.capabilities, thinkingBoundToPrefix: true };
    const s = midLoopSession();
    const r = await compactIfNeeded({ session: s, provider, model: 'm', language: 'vi', signal: new AbortController().signal, contextWindow: 20_000, compactAt: 0.95 });
    expect(r.pruned).toBe(0);
    expect(s.historyEdited).toBe(false);
    // nhà cung cấp thường thì lược ngay (đối chứng: test có thể đỏ)
    const s2 = midLoopSession();
    const r2 = await compactIfNeeded({ session: s2, provider: new FakeProvider([]), model: 'm', language: 'vi', signal: new AbortController().signal, contextWindow: 20_000, compactAt: 0.95 });
    expect(r2.pruned).toBeGreaterThan(0);
  });

  it('stripThinking(keepPending) giữ suy luận của tin assistant đang chờ kết quả, bỏ phần còn lại', () => {
    const s = midLoopSession();
    s.messages[1].content.unshift({ type: 'thinking', text: 'cũ', provider: 'anthropic', signature: 'old' });
    stripThinking(s, true);
    expect(s.messages[1].content.some((b) => b.type === 'thinking')).toBe(false);
    expect(s.messages[s.messages.length - 2].content.some((b) => b.type === 'thinking')).toBe(true);
    stripThinking(s);
    expect(s.messages[s.messages.length - 2].content.some((b) => b.type === 'thinking')).toBe(false);
  });

  it('fitRequests: giữ yêu cầu đầu + mới nhất nguyên văn, rút gọn đoạn giữa, và KHÔNG phình/đổi khi áp lại', () => {
    const reqs = Array.from({ length: 30 }, (_, i) => `#${i} ${'a'.repeat(2500)}`);
    const budget = 20_000;
    const once = fitRequests(reqs, budget);
    expect(once.reduce((n, r) => n + r.length, 0)).toBeLessThanOrEqual(budget);
    expect(once[0]).toBe(reqs[0]);
    expect(once[29]).toBe(reqs[29]);
    expect(once[15].length).toBeLessThan(260);
    expect(fitRequests(once, budget)).toEqual(once);
  });

  it('requestBudgetChars: 10% cửa sổ, không dưới 8k; không biết cửa sổ thì không đặt trần', () => {
    expect(requestBudgetChars(128_000)).toBe(44_800);
    expect(requestBudgetChars(1000)).toBe(8000);
    expect(requestBudgetChars(undefined)).toBeUndefined();
  });

  it('contextStatsOf: chỉ nhận số hợp lệ, làm tròn xuống, không âm', () => {
    expect(contextStatsOf({ clearedResults: 7.9, compactions: 2 })).toEqual({ contextStats: { clearedResults: 7, compactions: 2 } });
    expect(contextStatsOf({ clearedResults: -3, compactions: 'x' })).toEqual({ contextStats: { clearedResults: 0, compactions: 0 } });
    expect(contextStatsOf(null)).toEqual({});
    expect(contextStatsOf({ foo: 1 })).toEqual({});
  });
});
