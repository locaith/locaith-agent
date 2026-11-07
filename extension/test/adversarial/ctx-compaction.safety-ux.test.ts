/**
 * Test ĐỐI KHÁNG cho lane ctx-compaction (H03) — góc «an toàn, UX, tương thích» (người kiểm chứng độc lập thứ hai).
 * Mỗi test dưới đây ĐỎ trên mã hiện tại của lane (HEAD 69a30c9 + cccfcca); mô tả ở từng `it` nói rõ lỗi gì.
 * Hai test đầu là biến thể ĐƯỜNG TỰ ĐỘNG / ĐƯỜNG TÓM TẮT của hai lỗi mà ctx-compaction.verifier.test.ts đo ở đường thủ công / chỉ lược.
 *
 * Chạy: npx vitest run test/adversarial/ctx-compaction.safety-ux.test.ts
 */
import { describe, expect, it } from 'vitest';
import { compactIfNeeded } from '../../src/core/engine/compaction';
import { compactTuningFrom, DEFAULT_COMPACT_TUNING, effectiveCompactThreshold } from '../../src/core/engine/compactTuning';
import { estimateMessagesTokens, estimateMessageTokens } from '../../src/core/engine/tokens';
import { isClearedResult } from '../../src/core/engine/toolResultClearing';
import { newSession } from '../../src/core/engine/types';
import type { ChatMessage, ContentBlock, ToolResultBlock, ToolUseBlock } from '../../src/core/types';
import { FakeProvider } from '../helpers/fakeProvider';

let seq = 0;
const use = (name: string, input: Record<string, unknown>): ToolUseBlock => ({ type: 'tool_use', id: `c${++seq}`, name, input });
const result = (u: ToolUseBlock, content: string): ToolResultBlock => ({ type: 'tool_result', toolUseId: u.id, name: u.name, content });
const user = (text: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const asst = (...content: ContentBlock[]): ChatMessage => ({ role: 'assistant', content });
const round = (path: string, content: string): ChatMessage[] => {
  const u = use('read_file', { path });
  return [asst(u), { role: 'user', content: [result(u, content)] }];
};
const BIG = 'x'.repeat(4000); // ≈ 1050 token
const RESERVE = 3000; // cùng hằng số dự phòng của compaction.ts

function rig(messages: ChatMessage[]) {
  const session = newSession({ id: 's', provider: 'p', model: 'm' });
  session.messages = messages;
  const provider = new FakeProvider([]);
  provider.completeImpl = async () => '## Quyết định & lý do\n- ok\n## Việc còn lại\n- không';
  return { session, provider, signal: new AbortController().signal };
}

const allResults = (msgs: readonly ChatMessage[]): ToolResultBlock[] => msgs.flatMap((m) => m.content).filter((b): b is ToolResultBlock => b.type === 'tool_result');

describe('ctx-compaction — kiểm chứng đối kháng (an toàn, UX, tương thích)', () => {
  it('[A] đường TÓM TẮT: tokensFreed không được vượt kích thước ước lượng của lịch sử trước khi nén (hiện = max(lastContextTokens, ước lượng) − ước lượng → thổi phồng)', async () => {
    seq = 0;
    const msgs: ChatMessage[] = [user('đọc hết')];
    for (let i = 0; i < 14; i++) msgs.push(...round(`f${i}.ts`, BIG));
    msgs.push(asst({ type: 'text', text: 'xong' }), user('tiếp'), asst({ type: 'text', text: 'ok' }));
    const { session, provider, signal } = rig(msgs);
    const estimatedBefore = estimateMessagesTokens(session.messages) + RESERVE; // ≈ 18k
    // Số token THẬT của lần gọi gần nhất gồm cả system prompt + định nghĩa công cụ (hoặc đã cũ sau khi đổi model) — lớn hơn ước lượng của riêng lịch sử.
    session.lastContextTokens = 150_000;

    const r = await compactIfNeeded({ session, provider, model: 'm', language: 'vi', signal, contextWindow: 200_000, force: true, mode: 'manual' });
    expect(r.summarizedMessages).toBeGreaterThan(0);
    // docs/changes/ctx-compaction.md: «Số token giải phóng = ước lượng trước − sau (cùng một thước đo), không bịa».
    expect(r.tokensFreed).toBeLessThanOrEqual(estimatedBefore);
  });

  it('[B] đường TỰ ĐỘNG: clearToolResultsAtPercent = 0 ("0 = tắt") vẫn lược kết quả cũ khi chạm ngưỡng nén — rồi KHÔNG tóm tắt vì lược xong đã đủ', async () => {
    seq = 0;
    const msgs: ChatMessage[] = [user('đọc hết')];
    for (let i = 0; i < 14; i++) msgs.push(...round(`f${i}.ts`, BIG));
    msgs.push(asst({ type: 'text', text: 'xong' }), user('tiếp'));
    const { session, provider, signal } = rig(msgs);
    const tuning = compactTuningFrom({ clearToolResultsAtPercent: 0 }); // đúng đường cài đặt thật của người dùng
    expect(tuning.clearAtPercent).toBe(0);

    // Cửa sổ 20k: ước lượng ≈ 18k ≥ ngưỡng 16k → nén tự động. Người dùng đã TẮT lược → không một kết quả nào được thay bằng stub.
    const r = await compactIfNeeded({ session, provider, model: 'm', language: 'vi', signal, contextWindow: 20_000, tuning });
    expect(r.pruned).toBe(0);
    expect(allResults(session.messages).some(isClearedResult)).toBe(false);
  });

  it('[C] bản tóm tắt mang 60 yêu cầu × 3000 ký tự NGUYÊN VĂN không có ngân sách theo cửa sổ → tin đầu chiếm ~42% cửa sổ 128k (53k token), nén không gọn', async () => {
    seq = 0;
    // Mỗi tin người dùng ≈ 3000 ký tự (dán log lỗi + câu hỏi) — kiểu tin rất thường gặp; 60 lượt như thế trong một phiên dài.
    const line = 'Lỗi khi chạy npm test: TypeError không đọc được thuộc tính "token" của undefined tại src/auth.ts:42 — sửa giúp mình, giữ nguyên API /auth/login. ';
    const msgs: ChatMessage[] = [];
    for (let i = 0; i < 60; i++) {
      msgs.push(user(`[lượt ${i}] ${line.repeat(30)}`.slice(0, 3000)));
      msgs.push(...round(`f${i}.ts`, 'nội dung ngắn'));
      msgs.push(asst({ type: 'text', text: `đã xử lý lượt ${i}` }));
    }
    const { session, provider, signal } = rig(msgs);
    const contextWindow = 128_000; // DeepSeek / Locaith-v5
    const threshold = effectiveCompactThreshold(contextWindow, 0.8, DEFAULT_COMPACT_TUNING);

    const r = await compactIfNeeded({ session, provider, model: 'm', language: 'vi', signal, contextWindow, compactAt: 0.8, force: true, mode: 'manual' });
    expect(r.summarizedMessages).toBeGreaterThan(0);
    const headTokens = estimateMessageTokens(session.messages[0]);
    // Tin tóm tắt phải nhỏ hơn hẳn ngưỡng nén — nếu không, chỉ cần vài lượt nữa là lại vượt ngưỡng mà lần nén sau cũng
    // không nhỏ hơn được (các yêu cầu cũ được mang đi tiếp nguyên văn, slice(-60)). Mốc 1/4 cửa sổ là mức rộng tay.
    expect(headTokens).toBeLessThan(contextWindow / 4);
    expect(estimateMessagesTokens(session.messages) + RESERVE).toBeLessThan(threshold);
  });
});
