import { describe, expect, it } from 'vitest';
import { compactIfNeeded } from '../src/core/engine/compaction';
import { AUTO_CAP_TOKENS, autoClearTarget, CLEAR_TO_RATIO, DEFAULT_COMPACT_TUNING, effectiveCompactThreshold } from '../src/core/engine/compactTuning';
import { estimateMessagesTokens } from '../src/core/engine/tokens';
import { clearOldToolResults, isClearedResult } from '../src/core/engine/toolResultClearing';
import { newSession } from '../src/core/engine/types';
import type { ChatMessage, ContentBlock, ToolResultBlock, ToolUseBlock } from '../src/core/types';
import { FakeProvider } from './helpers/fakeProvider';

/**
 * (0.7.7) Độ trễ khi lược kết quả công cụ ở ngưỡng nén bị TRẦN chặn (cửa sổ 1M, trần 400k). Trước đó: lược xuống đích 30% cửa sổ (300k ƯỚC LƯỢNG ≈ 340k THẬT) — cao hơn ngưỡng 300k
 * THẬT — nên lượt nào cũng lại chạm ngưỡng và lược tiếp: lịch sử đổi ở đầu hội thoại mỗi lượt, cả tiền tố mất bộ nhớ đệm (51% chi phí của client mới theo nhật ký cổng Locaith).
 */
const WINDOW = 1_000_000;
const ROUND = 'x'.repeat(8000); // ≈ 2,1k token ước lượng mỗi kết quả
const REAL_PER_EST = 1.13; // token THẬT / ước lượng tin nhắn (đo trên nhật ký cổng Locaith)
const REAL_FIXED = 12_000; // system + công cụ

let seq = 0;
const use = (path: string): ToolUseBlock => ({ type: 'tool_use', id: `h${++seq}`, name: 'read_file', input: { path } });
const res = (u: ToolUseBlock, content: string): ToolResultBlock => ({ type: 'tool_result', toolUseId: u.id, name: u.name, content });
const asst = (...content: ContentBlock[]): ChatMessage => ({ role: 'assistant', content });
const round = (i: number): ChatMessage[] => {
  const u = use(`f${i}.ts`);
  return [asst(u), { role: 'user', content: [res(u, ROUND)] }];
};
const realOf = (s: ReturnType<typeof newSession>): number => Math.round((estimateMessagesTokens(s.messages) + 3000) * REAL_PER_EST + REAL_FIXED);
const resultsOf = (s: ReturnType<typeof newSession>): ToolResultBlock[] => s.messages.flatMap((m) => m.content).filter((b): b is ToolResultBlock => b.type === 'tool_result');

function sessionUpTo(realTokens: number) {
  const s = newSession({ id: 's', provider: 'p', model: 'm' });
  s.messages = [{ role: 'user', content: [{ type: 'text', text: 'đọc hết' }] }];
  let i = 0;
  while (realOf(s) < realTokens) s.messages.push(...round(i++));
  s.lastContextTokens = realOf(s);
  return { s, next: i };
}

describe('autoClearTarget', () => {
  const base = { contextWindow: WINDOW, compactAt: 0.8, threshold: AUTO_CAP_TOKENS, estimated: 400_000, before: 400_000, force: false };

  it('trần 400k + hệ số 0,93', () => {
    expect(AUTO_CAP_TOKENS).toBe(400_000);
    expect(CLEAR_TO_RATIO).toBe(0.93);
  });

  it('ngưỡng bị trần chặn: đích = ngưỡng × 0,93 (cùng thước khi chưa có số thật)', () => {
    expect(autoClearTarget(base)).toBe(372_000);
  });

  it('quy về thước ƯỚC LƯỢNG: token thật lớn hơn ước lượng 13% → đích ước lượng nhỏ đi tương ứng', () => {
    const t = autoClearTarget({ ...base, estimated: 400_000, before: 452_000 })!;
    expect(t).toBe(Math.floor(372_000 * (400_000 / 452_000)));
    expect(t * REAL_PER_EST).toBeLessThan(372_000 * 1.001);
  });

  it('số thật nhỏ hơn ước lượng (hiếm) thì không nâng đích quá 0,93 × ngưỡng', () => {
    expect(autoClearTarget({ ...base, estimated: 400_000, before: 300_000 })).toBe(372_000);
  });

  it('force (/compact, tràn ngữ cảnh) → để đích theo phần trăm cửa sổ như cũ', () => {
    expect(autoClearTarget({ ...base, force: true })).toBeUndefined();
  });

  it('ngưỡng KHÔNG bị trần chặn (cửa sổ ≤ 400k, hoặc người dùng tự đặt compactAtPercent) → hành vi cũ', () => {
    expect(autoClearTarget({ ...base, contextWindow: 200_000, threshold: effectiveCompactThreshold(200_000, 0.8) })).toBeUndefined();
    expect(autoClearTarget({ ...base, threshold: effectiveCompactThreshold(WINDOW, 0.8, { ...DEFAULT_COMPACT_TUNING, compactAtUserSet: true }) })).toBeUndefined();
  });

  it('compactAtTokens đặt tay thấp hơn phần trăm cũng là «bị trần chặn»', () => {
    expect(autoClearTarget({ ...base, contextWindow: 200_000, threshold: effectiveCompactThreshold(200_000, 0.8, { ...DEFAULT_COMPACT_TUNING, compactAtTokens: 100_000 }), estimated: 100_000, before: 100_000 })).toBe(93_000);
  });
});

describe('clearOldToolResults: targetTokens thay đích theo phần trăm', () => {
  it('lược tới ≤ đích tuyệt đối rồi dừng (không lược thêm)', () => {
    const { s } = sessionUpTo(150_000);
    const est = estimateMessagesTokens(s.messages) + 3000;
    const target = Math.floor(est * 0.9);
    const r = clearOldToolResults(s, { contextWindow: WINDOW, clearAtPercent: 10, targetPercent: 5, targetTokens: target, keepRecentResults: 8, lang: 'vi', force: true });
    expect(r.cleared).toBeGreaterThan(0);
    expect(r.tokensAfter).toBeLessThanOrEqual(target);
    // dừng ngay khi đạt đích: kết quả kế tiếp còn nguyên văn
    const rs = resultsOf(s);
    const firstIntact = rs.findIndex((b) => !isClearedResult(b));
    expect(firstIntact).toBe(r.cleared);
    expect(estimateMessagesTokens(s.messages) + 3000 + 600).toBeGreaterThan(target); // thêm một kết quả nữa sẽ lược dư
  });

  it('không có targetTokens → đích theo phần trăm như cũ', () => {
    const { s } = sessionUpTo(150_000);
    const r = clearOldToolResults(s, { contextWindow: 200_000, clearAtPercent: 40, targetPercent: 30, keepRecentResults: 8, lang: 'vi' });
    expect(r.tokensAfter).toBeLessThanOrEqual(60_000);
  });
});

describe('compactIfNeeded: lược theo ĐỢT ở trần 400k, không lược mỗi lượt', () => {
  const run = (s: ReturnType<typeof newSession>, extra: Record<string, unknown> = {}) =>
    compactIfNeeded({ session: s, provider: new FakeProvider([]), model: 'm', language: 'vi', signal: new AbortController().signal, contextWindow: WINDOW, ...extra });

  it('dưới ngưỡng 400k thật: không lược gì (ngưỡng cũ 300k đã không còn)', async () => {
    const { s } = sessionUpTo(380_000);
    const r = await run(s);
    expect(r.pruned).toBe(0);
    expect(s.historyEdited).toBe(false);
  });

  it('chạm ngưỡng → lược xuống ~93% ngưỡng (chừa khoảng trống), không phải sát ngưỡng', async () => {
    const { s } = sessionUpTo(404_000);
    const r = await run(s);
    expect(r.pruned).toBeGreaterThan(0);
    expect(r.summarizedMessages).toBe(0);
    const after = realOf(s);
    expect(after).toBeLessThanOrEqual(AUTO_CAP_TOKENS * CLEAR_TO_RATIO * 1.01);
    expect(after).toBeGreaterThan(AUTO_CAP_TOKENS * CLEAR_TO_RATIO - 12_000); // không lược dư quá một vài kết quả
  });

  it('chuỗi 120 lượt: số lần lược ≤ 1/6 số lượt (trước đó: gần như MỖI lượt), ngữ cảnh thật không bao giờ vượt ngưỡng quá một vòng', async () => {
    const { s, next } = sessionUpTo(399_000);
    let events = 0;
    let peak = 0;
    for (let t = 0; t < 120; t++) {
      s.messages.push(...round(next + t));
      s.lastContextTokens = realOf(s); // số token thật mà nhà cung cấp báo sau lần gọi
      peak = Math.max(peak, s.lastContextTokens);
      const r = await run(s);
      if (r.pruned > 0) {
        events++;
        expect(realOf(s)).toBeLessThanOrEqual(AUTO_CAP_TOKENS * 0.95); // luôn để lại khoảng trống, không bám sát ngưỡng
        s.lastContextTokens = 0; // lược xong, lượt sau mới có số thật mới
      }
    }
    expect(events).toBeGreaterThan(0);
    expect(events).toBeLessThanOrEqual(20);
    expect(peak).toBeLessThan(AUTO_CAP_TOKENS + 8_000);
  });

  it('kết quả mới nhất và bước đang chờ không bao giờ bị lược; kết quả bị lược là một dải liền từ đầu', async () => {
    const { s } = sessionUpTo(420_000);
    await run(s);
    const rs = resultsOf(s);
    expect(rs.slice(-8).every((b) => !isClearedResult(b))).toBe(true);
    const idx = rs.map((b, i) => (isClearedResult(b) ? i : -1)).filter((i) => i >= 0);
    expect(idx).toEqual(idx.map((_, i) => i));
  });

  it('/compact (force) vẫn nén mạnh như cũ — người dùng chủ động nén, không áp độ trễ', async () => {
    const { s } = sessionUpTo(450_000);
    const r = await run(s, { force: true, mode: 'manual' });
    expect(r.mode).toBe('manual');
    expect(r.pruned).toBeGreaterThan(0);
    expect(r.summarizedMessages).toBeGreaterThan(0);
    expect(r.tokensAfter).toBeLessThan(r.tokensBefore);
  });
});
