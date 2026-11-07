/**
 * Test ĐỐI KHÁNG cho lane ctx-compaction (H03). Mỗi test ở đây mô tả một hành vi mà ĐẶC TẢ đòi hỏi
 * (hoặc một bất biến hiển nhiên) và được viết để ĐỎ trên mã hiện tại của lane — xem StructuredOutput của người kiểm chứng.
 *
 * Chạy: npx vitest run test/adversarial/ctx-compaction.verifier.test.ts
 */
import { describe, expect, it } from 'vitest';
import { compactIfNeeded, cutIndexKeepingRecent, summarizeHistoryDetailed } from '../../src/core/engine/compaction';
import { compactTuningFrom } from '../../src/core/engine/compactTuning';
import { estimateMessagesTokens } from '../../src/core/engine/tokens';
import { clearOldToolResults, isClearedResult } from '../../src/core/engine/toolResultClearing';
import { newSession } from '../../src/core/engine/types';
import type { ChatMessage, ContentBlock, ToolResultBlock, ToolUseBlock } from '../../src/core/types';
import { migrateSession } from '../../src/shared/sessionMigrate';
import { FakeProvider } from '../helpers/fakeProvider';

const BIG = 'x'.repeat(4000); // ≈ 1050 token
let seq = 0;
const use = (name: string, input: Record<string, unknown>): ToolUseBlock => ({ type: 'tool_use', id: `c${++seq}`, name, input });
const result = (u: ToolUseBlock, content = BIG, isError = false): ToolResultBlock => ({ type: 'tool_result', toolUseId: u.id, name: u.name, content, isError });
const user = (text: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const asst = (...content: ContentBlock[]): ChatMessage => ({ role: 'assistant', content });
const round = (u: ToolUseBlock, content = BIG, isError = false): ChatMessage[] => [asst(u), { role: 'user', content: [result(u, content, isError)] }];
const reads = (n: number, prefix = 'f'): ChatMessage[] => Array.from({ length: n }, (_, i) => round(use('read_file', { path: `${prefix}${i}.ts` }))).flat();
const allResults = (msgs: readonly ChatMessage[]): ToolResultBlock[] => msgs.flatMap((m) => m.content).filter((b): b is ToolResultBlock => b.type === 'tool_result');
const textOf = (m: ChatMessage): string => m.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');

function rig(messages: ChatMessage[]) {
  const session = newSession({ id: 's', provider: 'p', model: 'm' });
  session.messages = messages;
  const provider = new FakeProvider([]);
  // Model tường thuật "quên" mọi tên tệp / lệnh — đúng kịch bản mà phần tất định phải bù.
  provider.completeImpl = async () => '## Quyết định & lý do\n- (model không nhắc tệp nào)\n## Việc còn lại\n- (không rõ)';
  return { session, provider };
}
const sig = () => new AbortController().signal;

describe('[đối kháng] yêu cầu 2 — bản tóm tắt không được làm mất dữ kiện cốt lõi qua NHIỀU lần nén', () => {
  it('tệp đã sửa và lệnh đã chạy của đoạn bị nén lần 1 vẫn phải còn trong lịch sử sau lần nén 2 (hiện chỉ mang yêu cầu đi tiếp)', async () => {
    seq = 0;
    const REQUEST = 'Sửa lỗi đăng nhập: token hết hạn vẫn vào được.';
    const e1 = use('edit_file', { path: 'src/auth.ts', old_string: 'a', new_string: 'b' });
    const c1 = use('run_command', { command: 'npm test -- auth' });
    const { session, provider } = rig([
      user(REQUEST),
      ...round(e1, 'Đã sửa src/auth.ts (1 chỗ, +3 −1).'),
      ...round(c1, 'Mã thoát: 1\nFAIL test/auth.test.ts', true),
      asst({ type: 'text', text: 'Đã sửa, test còn đỏ.' }),
      user('tiếp đi'),
      asst({ type: 'text', text: 'ok' }),
    ]);
    const r1 = await summarizeHistoryDetailed({ session, provider, model: 'm', language: 'vi', signal: sig(), keepRecentMessages: 2 });
    expect(r1.removed).toBeGreaterThan(0);
    expect(r1.summary).toContain('src/auth.ts');
    expect(r1.summary).toContain('`npm test -- auth`');

    // Làm việc tiếp rồi nén lần 2.
    const w1 = use('write_file', { path: 'CHANGELOG.md', content: 'x' });
    session.messages.push(user('Giờ viết CHANGELOG'), ...round(w1, 'Đã tạo CHANGELOG.md (3 dòng).'), asst({ type: 'text', text: 'đã viết' }), user('cảm ơn'), asst({ type: 'text', text: 'ok' }));
    const r2 = await summarizeHistoryDetailed({ session, provider, model: 'm', language: 'vi', signal: sig(), keepRecentMessages: 2 });
    expect(r2.removed).toBeGreaterThan(0);
    // Yêu cầu gốc được mang đi tiếp (đã làm), nhưng…
    expect(r2.summary).toContain(`«${REQUEST}»`);
    // …tệp đã sửa và lệnh đã chạy (kèm mã thoát 1 = test còn đỏ) của đoạn nén lần 1 KHÔNG còn ở bất kỳ đâu trong lịch sử,
    // trong khi prompt tường thuật lại dặn model "KHÔNG lặp lại" các mục đó → mất hẳn, đúng điều đặc tả cấm.
    const wholeHistory = session.messages.map(textOf).join('\n');
    expect(wholeHistory).toContain('src/auth.ts');
    expect(wholeHistory).toContain('npm test -- auth');
  });
});

describe('[đối kháng] yêu cầu 1 — clearToolResultsAtPercent = 0 nghĩa là TẮT', () => {
  it('/compact (force) với clearToolResultsAtPercent=0 không được lược kết quả nào (hiện lược hết về mục tiêu 0%)', async () => {
    seq = 0;
    const { session, provider } = rig([user('đọc hết'), ...reads(30), asst({ type: 'text', text: 'xong' }), user('tiếp'), asst({ type: 'text', text: 'ok' })]);
    const tuning = compactTuningFrom({ clearToolResultsAtPercent: 0 });
    expect(tuning.clearAtPercent).toBe(0);
    const r = await compactIfNeeded({ session, provider, model: 'm', language: 'vi', signal: sig(), contextWindow: 200_000, force: true, mode: 'manual', tuning });
    expect(r.summarizedMessages).toBeGreaterThan(0);
    expect(r.pruned).toBe(0);
    expect(allResults(session.messages).some(isClearedResult)).toBe(false);
    expect(session.contextStats?.clearedResults ?? 0).toBe(0);
  });
});

describe('[đối kháng] yêu cầu 5a — tokensFreed phải "tính thật", cùng một thước đo trước/sau', () => {
  it('chỉ lược (không tóm tắt): tokensFreed không được vượt (ước lượng trước − ước lượng sau); hiện trộn lastContextTokens vào "trước"', async () => {
    seq = 0;
    const { session, provider } = rig([user('đọc hết'), ...reads(40), asst({ type: 'text', text: 'xong' }), user('tiếp')]);
    const estBefore = estimateMessagesTokens(session.messages);
    expect(estBefore).toBeGreaterThan(40_000);
    expect(estBefore).toBeLessThan(80_000);
    // Số thật của lần gọi trước lớn hơn ước lượng (system prompt + định nghĩa công cụ…): ngưỡng 80k bị vượt → bậc 1 lược về 30%.
    session.lastContextTokens = 95_000;
    const r = await compactIfNeeded({ session, provider, model: 'm', language: 'vi', signal: sig(), contextWindow: 100_000, compactAt: 0.8 });
    expect(r.pruned).toBeGreaterThan(0);
    expect(r.summarizedMessages).toBe(0);
    const estAfter = estimateMessagesTokens(session.messages);
    // Dòng «giải phóng N token» đi thẳng lên giao diện: N không thể lớn hơn phần ước lượng thật sự đã giảm.
    expect(r.tokensFreed).toBeLessThanOrEqual(estBefore - estAfter);
  });
});

describe('[đối kháng] yêu cầu 1 — "KHÔNG đụng khối suy luận đang cần cho chữ ký"', () => {
  it('lược giữa vòng công cụ: khối suy luận có chữ ký của tin assistant ĐANG CHỜ kết quả phải còn (hiện stripThinking xoá cả nó)', () => {
    seq = 0;
    const pending = use('read_file', { path: 'pending.ts' });
    const session = newSession({ id: 's', provider: 'anthropic', model: 'm' });
    session.messages = [
      user('đọc hết'),
      ...reads(12),
      asst({ type: 'thinking', text: 'đang nghĩ', provider: 'anthropic', signature: 'sig-live' }, pending),
      { role: 'user', content: [result(pending, 'nội dung pending')] },
    ];
    const r = clearOldToolResults(session, { contextWindow: 20_000, clearAtPercent: 40, targetPercent: 30, keepRecentResults: 8, lang: 'vi' });
    expect(r.cleared).toBeGreaterThan(0);
    const lastAssistant = session.messages[session.messages.length - 2];
    expect(lastAssistant.role).toBe('assistant');
    expect(lastAssistant.content.some((b) => b.type === 'thinking' && b.signature === 'sig-live')).toBe(true);
  });
});

describe('[đối kháng] biên & hồi quy nhỏ', () => {
  it('cutIndexKeepingRecent(msgs, 0) không được ném TypeError', () => {
    seq = 0;
    const msgs = [user('x'), ...reads(3), asst({ type: 'text', text: 'ok' })];
    expect(() => cutIndexKeepingRecent(msgs, 0)).not.toThrow();
  });

  it('kết quả đã rút gọn theo định dạng CŨ (pruneOldToolResults, phiên lưu từ bản trước) không bị lược lại và không bị đếm', () => {
    seq = 0;
    const session = newSession({ id: 's', provider: 'p', model: 'm' });
    const oldStub = (u: ToolUseBlock) => result(u, `[Kết quả cũ của ${u.name} đã được lược bớt để tiết kiệm ngữ cảnh. Đầu nội dung: const x…]`);
    const rs = Array.from({ length: 12 }, (_, i) => use('read_file', { path: `o${i}.ts` }));
    session.messages = [user('đọc'), ...rs.flatMap((u) => [asst(u), { role: 'user' as const, content: [oldStub(u)] }]), ...reads(9), asst({ type: 'text', text: 'xong' }), user('tiếp')];
    const r = clearOldToolResults(session, { contextWindow: 20_000, clearAtPercent: 40, targetPercent: 30, keepRecentResults: 8, lang: 'vi', force: true });
    // 12 stub cũ + 1 kết quả lớn nằm ngoài 8 gần nhất: chỉ kết quả lớn đáng lược; stub cũ đã nhỏ sẵn, lược lại là "Đã lược 13 kết quả…" nói dối.
    expect(r.cleared).toBeLessThanOrEqual(1);
  });

  it('contextStats (clearedResults/compactions) sống sót qua lưu/đọc phiên (migrateSession)', () => {
    const raw = { ...newSession({ id: 'abc', provider: 'p', model: 'm' }), contextStats: { clearedResults: 7, compactions: 2 } };
    const out = migrateSession(JSON.parse(JSON.stringify(raw)));
    expect(out).not.toBeNull();
    expect(out!.session.contextStats).toEqual({ clearedResults: 7, compactions: 2 });
  });
});
