import { describe, expect, it } from 'vitest';
import { getPromptStats, recordPromptStats } from '../src/core/engine/promptStats';
import { newSession } from '../src/core/engine/types';
import { parseListPricing, selectGenericModels } from '../src/core/providers/modelFilters';
import type { ChatMessage } from '../src/core/types';
import type { TItem } from '../src/shared/protocol';
import { buildMeter, compactionStats, contextBreakdown, contextReport, costReport, estimateCost, findPricing, formatUsd, meterTone } from '../src/shared/sessionMeter';
import { sanitizeMeter } from '../src/core/remote/sanitize';

const PRICE = { inputPerM: 0.5, outputPerM: 2 };

describe('đồng hồ ngữ cảnh: ngưỡng màu', () => {
  it('≤ 60% xanh · > 60% vàng · > 80% đỏ (đúng tại biên)', () => {
    expect(meterTone(0)).toBe('ok');
    expect(meterTone(0.6)).toBe('ok');
    expect(meterTone(0.61)).toBe('warn');
    expect(meterTone(0.8)).toBe('warn');
    expect(meterTone(0.81)).toBe('danger');
    expect(meterTone(1)).toBe('danger');
  });
});

describe('chi phí ước tính: không có giá thì không bịa', () => {
  it('có giá: (vào × giá vào + ra × giá ra) / 1 triệu', () => {
    expect(estimateCost(2_000_000, 500_000, PRICE)).toBeCloseTo(2.0, 6);
    expect(formatUsd(2)).toBe('$2.00');
    expect(formatUsd(0.004)).toBe('<$0.01');
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(123.4)).toBe('$123.4');
  });

  it('thiếu giá → undefined; buildMeter không có trường costUsd (chip/tooltip ẩn chi phí)', () => {
    expect(estimateCost(1000, 1000, undefined)).toBeUndefined();
    const s = newSession({ id: 's', provider: 'p', model: 'm' });
    s.usageTotals = { input: 1000, output: 500 };
    const m = buildMeter(s, [], undefined);
    expect('costUsd' in m).toBe(false);
    expect(m.inputTokens).toBe(1000);
    expect(buildMeter(s, [], PRICE).costUsd).toBeCloseTo((1000 * 0.5 + 500 * 2) / 1e6, 9);
  });

  it('findPricing tra đúng nhà cung cấp + model, không có thì undefined', () => {
    const providers = [{ id: 'or', models: [{ id: 'm1', pricing: PRICE }, { id: 'm2' }] }] as never;
    expect(findPricing(providers, 'or', 'm1')).toEqual(PRICE);
    expect(findPricing(providers, 'or', 'm2')).toBeUndefined();
    expect(findPricing(providers, 'khac', 'm1')).toBeUndefined();
    expect(findPricing(undefined, 'or', 'm1')).toBeUndefined();
  });

  it('bảng giá từ danh sách model (kiểu OpenRouter, USD/token): đổi sang USD/1 triệu; giá lạ (-1, âm, chữ) bị bỏ', () => {
    expect(parseListPricing({ prompt: '0.0000005', completion: '0.000002' })).toEqual({ inputPerM: 0.5, outputPerM: 2 });
    expect(parseListPricing({ prompt: '-1', completion: '-1' })).toBeUndefined();
    expect(parseListPricing({ prompt: 'abc', completion: '1' })).toBeUndefined();
    expect(parseListPricing({ prompt: '0.000001' })).toBeUndefined();
    expect(parseListPricing(undefined)).toBeUndefined();
    const sel = selectGenericModels([{ id: 'a/b', pricing: { inputPerM: 1, outputPerM: 3 } }, { id: 'a/c' }]);
    expect(sel.find((m) => m.id === 'a/b')?.pricing).toEqual({ inputPerM: 1, outputPerM: 3 });
    expect(sel.find((m) => m.id === 'a/c')?.pricing).toBeUndefined();
  });
});

describe('đếm nén ngữ cảnh', () => {
  it('cộng thông báo nén đứng riêng + trong lượt trả lời, và tổng kết quả công cụ đã lược', () => {
    const tr = [
      { kind: 'notice', id: 'n1', level: 'info', text: 'nén', ts: 1, compact: { mode: 'auto', clearedResults: 4 } },
      { kind: 'assistant', id: 'a', ts: 1, done: true, blocks: [{ type: 'notice', level: 'info', text: 'nén', compact: { mode: 'manual', clearedResults: 3 } }] },
      { kind: 'notice', id: 'n2', level: 'info', text: 'thường', ts: 1 },
    ] as unknown as TItem[];
    expect(compactionStats(tr)).toEqual({ compactions: 2, clearedResults: 7 });
    expect(compactionStats([])).toEqual({ compactions: 0, clearedResults: 0 });
  });
});

const msgs: ChatMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'a'.repeat(400) }] },
  { role: 'assistant', content: [{ type: 'text', text: 'b'.repeat(800) }, { type: 'tool_use', id: 't', name: 'read_file', input: { path: 'x' } }] },
  { role: 'user', content: [{ type: 'tool_result', toolUseId: 't', name: 'read_file', content: 'c'.repeat(4000) }] },
];

describe('/context và /cost', () => {
  it('chia nhỏ: kết quả công cụ lớn nhất; có system/công cụ/ký ức khi engine đã đo', () => {
    const s = newSession({ id: 's', provider: 'p', model: 'm' });
    recordPromptStats(s, 'S'.repeat(4000), [{ name: 'read_file', description: 'đọc', inputSchema: { type: 'object' } }] as never, 'M'.repeat(800));
    const st = getPromptStats(s)!;
    expect(st.toolCount).toBe(1);
    expect(st.memoryTokens).toBeGreaterThan(0);
    const b = contextBreakdown(msgs, st);
    expect(b.toolResults).toBeGreaterThan(b.userText);
    expect(b.system! + b.memory!).toBe(st.systemTokens);
    expect(b.estimated).toBe(st.systemTokens + st.toolsTokens + b.userText + b.assistantText + b.toolCalls + b.toolResults);
  });

  it('báo cáo /context tiếng Việt: có bảng đủ các phần, nhắc nén khi > 60%, ghi rõ "chưa đo" khi engine chưa đo', () => {
    const rep = contextReport({ lang: 'vi', ctx: { usedTokens: 130_000, limitTokens: 200_000 }, messages: msgs, stats: undefined, meter: { inputTokens: 1, outputTokens: 1, compactions: 2, clearedResults: 9 } });
    expect(rep).toContain('Ngữ cảnh của cuộc trò chuyện');
    expect(rep).toContain('65%');
    for (const part of ['System prompt', 'Định nghĩa công cụ', 'Ký ức', 'Tin nhắn của bạn', 'Kết quả công cụ']) expect(rep).toContain(part);
    expect(rep).toContain('chưa đo');
    expect(rep).toContain('Đã nén 2 lần, lược 9');
    expect(rep).toContain('/compact');
  });

  it('báo cáo /context tiếng Anh, không báo nén khi còn thoáng', () => {
    const rep = contextReport({ lang: 'en', ctx: { usedTokens: 10_000, limitTokens: 200_000 }, messages: msgs, stats: undefined, meter: { inputTokens: 0, outputTokens: 0, compactions: 0, clearedResults: 0 } });
    expect(rep).toContain('Conversation context');
    expect(rep).not.toContain('/compact');
  });

  it('/cost: có giá thì in ước tính + giá áp dụng; thiếu giá thì nói thẳng là không ước tính (không in số $)', () => {
    const meter = { inputTokens: 2_000_000, outputTokens: 500_000, compactions: 0, clearedResults: 0, costUsd: 2 };
    const withPrice = costReport({ lang: 'vi', meter, pricing: PRICE, model: 'm1' });
    expect(withPrice).toContain('$2.00');
    expect(withPrice).toContain('$0.5');
    expect(withPrice).toContain('2.000.000');
    const { costUsd: _c, ...noCost } = meter;
    const noPrice = costReport({ lang: 'vi', meter: noCost, pricing: undefined, model: 'm1' });
    expect(noPrice).not.toMatch(/\$\d/);
    expect(noPrice).toContain('không có giá');
    expect(costReport({ lang: 'en', meter: noCost, pricing: undefined, model: 'm1' })).toContain('no price');
  });
});

describe('Remote: đồng hồ qua sanitize', () => {
  it('ép về số nguyên không âm, giữ nguyên "không có chi phí"', () => {
    expect(sanitizeMeter({ inputTokens: -5, outputTokens: 1.9, compactions: NaN as never, clearedResults: 1e15 })).toEqual({ inputTokens: 0, outputTokens: 1, compactions: 0, clearedResults: 1e12 });
    expect(sanitizeMeter({ inputTokens: 1, outputTokens: 1, compactions: 0, clearedResults: 0, costUsd: 0.5 }).costUsd).toBe(0.5);
    expect('costUsd' in sanitizeMeter({ inputTokens: 1, outputTokens: 1, compactions: 0, clearedResults: 0, costUsd: -3 })).toBe(false);
  });
});
