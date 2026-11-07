/**
 * `repairOrphanToolCalls` — lượt bị Dừng / bị lỗi giữa vòng công cụ để lại tin assistant có `tool_use` mà không có `tool_result`.
 * Engine vá lịch sử ĐÃ LƯU (chứ không chỉ payload) trước khi thêm tin mới, để tin "tiếp tục" không phát lại các lệnh cũ.
 *
 * Điều cần bảo vệ (ngoài việc "có chèn kết quả huỷ"):
 *   • idempotent, đúng với nhiều lệnh song song, với kết quả thiếu một phần, với lệnh mồ côi nằm GIỮA lịch sử;
 *   • KHÔNG BAO GIỜ gộp kết quả huỷ vào tin người dùng thật kế tiếp — làm vậy biến lượt mới của họ thành "tin kết quả"
 *     (`isTurnStart` = false, "Thử lại/Sửa tin cuối" nhắm sai chỗ, transcript dựng lại hiện nó như tin chen giữa);
 *   • sống sót qua lưu → mở lại phiên (migrateSession không được coi tin kết quả huỷ là "tin nhắc cũ" mà xoá);
 *   • sau khi vá, lịch sử đã hợp lệ với MỌI hãng ngay từ dữ liệu lưu (adapter không còn gì để vá thêm).
 */
import { describe, expect, it } from 'vitest';
import { repairOrphanToolCalls } from '../src/core/engine/engine';
import { newSession } from '../src/core/engine/types';
import { normalizeHistory } from '../src/core/providers/history';
import type { ChatMessage, ToolResultBlock, ToolUseBlock } from '../src/core/types';
import { migrateSession } from '../src/shared/sessionMigrate';
import { isTurnStart, rebuildTranscript, userTurnCount } from '../src/shared/transcriptRebuild';
import { textTurn, toolTurn } from './helpers/fakeProvider';
import { makeHarness } from './helpers/harness';

const use = (id: string, name = 'run_command'): ToolUseBlock => ({ type: 'tool_use', id, name, input: { command: 'echo ' + id } });
const res = (id: string, content = 'ok', isError = false): ToolResultBlock => ({ type: 'tool_result', toolUseId: id, name: 'run_command', content, isError });
const text = (role: 'user' | 'assistant', t: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role, content: [{ type: 'text', text: t }], ...extra });
const session = (messages: ChatMessage[]) => {
  const s = newSession({ id: 's1', provider: 'fake', model: 'm' });
  s.messages = messages;
  return s;
};
const resultsOf = (m: ChatMessage): ToolResultBlock[] => m.content.filter((b): b is ToolResultBlock => b.type === 'tool_result');

/** Mọi tool_use của assistant phải được trả lời bởi tool_result ở tin user NGAY SAU nó (hợp đồng của Anthropic/Gemini). */
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

describe('repairOrphanToolCalls — các ca', () => {
  it('tin assistant cuối có tool_use, chưa có kết quả → chèn MỘT tin tổng hợp riêng chứa kết quả "đã huỷ"', () => {
    const s = session([text('user', 'chạy đi'), { role: 'assistant', content: [use('c1')] }]);
    expect(repairOrphanToolCalls(s)).toBe(1);
    expect(s.messages).toHaveLength(3);
    expect(s.messages[2]).toMatchObject({ role: 'user', synthetic: true });
    const [r] = resultsOf(s.messages[2]);
    expect(r).toMatchObject({ toolUseId: 'c1', name: 'run_command', isError: true });
    expect(r.content).toMatch(/đã dừng|Đừng chạy lại/);
    expect(s.historyEdited).toBe(true);
    expect(orphansOf(s.messages)).toEqual([]);
  });

  it('NHIỀU lệnh song song cùng mồ côi → một tin, đủ kết quả, đúng thứ tự gọi', () => {
    const s = session([text('user', 'x'), { role: 'assistant', content: [{ type: 'text', text: 'Làm ba việc.' }, use('a'), use('b'), use('c')] }]);
    expect(repairOrphanToolCalls(s)).toBe(3);
    expect(s.messages).toHaveLength(3);
    expect(resultsOf(s.messages[2]).map((r) => r.toolUseId)).toEqual(['a', 'b', 'c']);
    expect(orphansOf(s.messages)).toEqual([]);
  });

  it('kết quả thiếu MỘT PHẦN (đã có a, c; thiếu b) → bổ sung vào chính tin kết quả đó, giữ thứ tự gọi, kết quả thật không bị đụng', () => {
    const s = session([
      text('user', 'x'),
      { role: 'assistant', content: [use('a'), use('b'), use('c')] },
      { role: 'user', content: [res('a', 'kết quả thật của a'), res('c', 'kết quả thật của c')] },
    ]);
    expect(repairOrphanToolCalls(s)).toBe(1);
    expect(s.messages).toHaveLength(3); // không thêm tin nào
    const rs = resultsOf(s.messages[2]);
    expect(rs.map((r) => r.toolUseId)).toEqual(['a', 'b', 'c']);
    expect(rs[0]).toMatchObject({ content: 'kết quả thật của a', isError: false });
    expect(rs[1].isError).toBe(true);
    expect(rs[2]).toMatchObject({ content: 'kết quả thật của c', isError: false });
    expect(orphansOf(s.messages)).toEqual([]);
  });

  it('kết quả thiếu một phần mà tin đó còn có chữ chen giữa (steer) → chữ vẫn đứng SAU các tool_result', () => {
    const s = session([
      text('user', 'x'),
      { role: 'assistant', content: [use('a'), use('b')] },
      { role: 'user', content: [res('a'), { type: 'text', text: 'làm thêm việc này' }] },
    ]);
    repairOrphanToolCalls(s);
    expect(s.messages[2].content.map((b) => b.type)).toEqual(['tool_result', 'tool_result', 'text']);
  });

  it('lệnh mồ côi nằm GIỮA lịch sử, ngay trước tin người dùng THẬT → chèn tin riêng TRƯỚC nó, không gộp vào nó', () => {
    const userB = text('user', 'tiếp tục');
    const s = session([text('user', 'chạy đi'), { role: 'assistant', content: [use('c1')] }, userB, text('assistant', 'Đã rõ.')]);
    const turnsBefore = userTurnCount(s.messages);
    expect(repairOrphanToolCalls(s)).toBe(1);
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user', 'assistant']);
    expect(s.messages[2]).toMatchObject({ synthetic: true });
    expect(resultsOf(s.messages[2]).map((r) => r.toolUseId)).toEqual(['c1']);
    // tin người dùng thật còn NGUYÊN: không có tool_result nào chui vào, vẫn là điểm bắt đầu của một lượt
    expect(s.messages[3]).toBe(userB);
    expect(s.messages[3].content.map((b) => b.type)).toEqual(['text']);
    expect(isTurnStart(s.messages[3])).toBe(true);
    expect(userTurnCount(s.messages)).toBe(turnsBefore);
    expect(orphansOf(s.messages)).toEqual([]);
  });

  it('nhiều chỗ mồ côi rải rác → vá hết trong một lần, chỉ số dịch chuyển không làm sót', () => {
    const s = session([
      text('user', 'một'),
      { role: 'assistant', content: [use('a')] },
      text('user', 'hai'),
      { role: 'assistant', content: [use('b'), use('c')] },
      text('user', 'ba'),
      { role: 'assistant', content: [use('d')] },
    ]);
    expect(repairOrphanToolCalls(s)).toBe(4);
    expect(orphansOf(s.messages)).toEqual([]);
    expect(userTurnCount(s.messages)).toBe(3);
  });

  it('idempotent: chạy lần hai không đổi gì (kể cả khi tin tổng hợp đã nằm đó)', () => {
    const s = session([text('user', 'x'), { role: 'assistant', content: [use('a'), use('b')] }, text('user', 'y')]);
    expect(repairOrphanToolCalls(s)).toBe(2);
    const snapshot = JSON.stringify(s.messages);
    s.historyEdited = false;
    expect(repairOrphanToolCalls(s)).toBe(0);
    expect(JSON.stringify(s.messages)).toBe(snapshot);
    expect(s.historyEdited).toBe(false); // không vá gì thì không báo "lịch sử đã sửa" (sẽ làm mất khối suy luận vô cớ)
  });

  it('lịch sử sạch (đủ kết quả / không có công cụ) → không đụng gì, không đặt cờ', () => {
    const msgs: ChatMessage[] = [text('user', 'x'), { role: 'assistant', content: [use('a')] }, { role: 'user', content: [res('a')] }, text('assistant', 'xong')];
    const s = session(msgs);
    const before = JSON.stringify(s.messages);
    expect(repairOrphanToolCalls(s)).toBe(0);
    expect(JSON.stringify(s.messages)).toBe(before);
    expect(s.historyEdited).toBe(false);
    expect(repairOrphanToolCalls(session([]))).toBe(0);
  });

  it('hai tin assistant liền nhau, tin trước còn tool_use → chèn tin kết quả GIỮA hai tin đó', () => {
    const s = session([text('user', 'x'), { role: 'assistant', content: [use('a')] }, text('assistant', 'Tôi tiếp tục.')]);
    expect(repairOrphanToolCalls(s)).toBe(1);
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(orphansOf(s.messages)).toEqual([]);
  });

  it('không đụng khối suy luận hay nội dung của chính tin assistant', () => {
    const asst: ChatMessage = { role: 'assistant', content: [{ type: 'thinking', text: 'nghĩ', signature: 'sig', provider: 'anthropic' }, use('a')] };
    const s = session([text('user', 'x'), asst]);
    const before = JSON.stringify(asst);
    repairOrphanToolCalls(s);
    expect(JSON.stringify(s.messages[1])).toBe(before);
  });

  it('sau khi vá, adapter không còn gì để vá thêm: normalizeHistory là phép đồng nhất trên lịch sử đã lưu', () => {
    const s = session([
      text('user', 'một'),
      { role: 'assistant', content: [use('a'), use('b')] },
      text('user', 'hai'),
      { role: 'assistant', content: [use('c')] },
    ]);
    repairOrphanToolCalls(s);
    expect(normalizeHistory(s.messages)).toEqual(s.messages);
  });
});

describe('lưu → mở lại phiên', () => {
  it('migrateSession GIỮ tin kết quả "đã huỷ" (nó là một nửa cặp tool_use/tool_result, không phải tin nhắc cũ) — nhưng vẫn bỏ các tin nhắc thật', () => {
    const s = session([
      text('user', 'chạy đi'),
      { role: 'assistant', content: [use('c1')] },
      text('user', 'tiếp tục'),
      text('assistant', 'Đã rõ.'),
      text('user', '[nhắc lần 1] Bạn còn 1 việc chưa xong', { synthetic: true }),
      text('assistant', 'ok'),
    ]);
    repairOrphanToolCalls(s);
    const reloaded = migrateSession(JSON.parse(JSON.stringify(s)), { appVersion: '0.6.31', storedAppVersion: '0.6.31' })!;
    expect(orphansOf(reloaded.session.messages)).toEqual([]); // cặp còn nguyên sau khi mở lại
    expect(reloaded.session.messages.some((m) => resultsOf(m).length > 0 && m.synthetic)).toBe(true);
    expect(reloaded.session.messages.some((m) => m.content.some((b) => b.type === 'text' && b.text.startsWith('[nhắc lần 1]')))).toBe(false); // tin nhắc bị bỏ như thiết kế
    expect(reloaded.droppedNudges).toBe(1);
  });

  it('phiên CŨ (trước 0.6.31) đã có lệnh mồ côi rồi người dùng gõ tiếp: vá không biến tin của họ thành "tin kết quả"', () => {
    const legacy = JSON.parse(JSON.stringify(session([text('user', 'chạy đi'), { role: 'assistant', content: [use('c1')] }, text('user', 'tiếp tục'), text('assistant', 'Đã rõ.')])));
    const s = migrateSession(legacy, { appVersion: '0.6.31', storedAppVersion: '0.6.30' })!.session;
    repairOrphanToolCalls(s);
    expect(userTurnCount(s.messages)).toBe(2);
    const items = rebuildTranscript(s.messages);
    const users = items.filter((i) => i.kind === 'user');
    expect(users.map((u) => (u as { text: string }).text)).toEqual(['chạy đi', 'tiếp tục']);
    expect(users.some((u) => (u as { steer?: boolean }).steer)).toBe(false); // không hiện như tin "chen giữa"
  });

  it('giao diện dựng lại từ lịch sử: công cụ bị huỷ hiện đúng trạng thái "cancelled", không phải "done"', () => {
    const s = session([text('user', 'chạy đi'), { role: 'assistant', content: [use('c1')] }]);
    repairOrphanToolCalls(s);
    const items = rebuildTranscript(s.messages);
    const tool = items.flatMap((i) => (i.kind === 'assistant' ? i.blocks : [])).find((b) => b.type === 'tool');
    expect(tool).toMatchObject({ type: 'tool', id: 'c1', state: 'cancelled' });
  });
});

describe('engine: lịch sử gửi cho model sau khi Dừng', () => {
  it('bắt đầu một lượt mới trên lịch sử có lệnh mồ côi → model KHÔNG thấy tool_use nào thiếu kết quả, và tin "tiếp tục" còn nguyên', async () => {
    const h = makeHarness([() => textTurn('Tôi làm tiếp, không chạy lại lệnh đã huỷ.')]);
    h.session.messages = [text('user', 'build giúp tôi'), { role: 'assistant', content: [{ type: 'text', text: 'Chạy build.' }, use('c1'), use('c2')] }];
    const r = await h.run('tiếp tục');
    expect(r.stopReason).toBe('end_turn');
    const sent = h.provider.requests[0].messages;
    expect(orphansOf(sent)).toEqual([]);
    expect(normalizeHistory(sent)).toEqual(sent); // adapter không phải vá gì
    expect(sent.at(-1)).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'tiếp tục' }] });
    // lệnh bị huỷ được nói rõ cho model là ĐÃ HUỶ, đừng chạy lại
    const cancelled = sent.flatMap(resultsOf);
    expect(cancelled.map((c) => c.toolUseId)).toEqual(['c1', 'c2']);
    expect(cancelled.every((c) => c.isError === true && /Đừng chạy lại/.test(c.content))).toBe(true);
    // và lịch sử LƯU cũng sạch (không chỉ payload)
    expect(orphansOf(h.session.messages)).toEqual([]);
  });

  it('lệnh mồ côi do chính lượt trước tạo ra: hết vòng, model vẫn gọi công cụ bất chấp toolChoice=none → lượt sau vá được', async () => {
    // maxTurns=1: lượt 1 chạy công cụ; vòng 2 là lượt TỔNG KẾT cấm công cụ — nhưng model (mô phỏng) vẫn phát tool_use → nó nằm lại không có kết quả.
    const h = makeHarness([() => toolTurn([{ id: 'c1', name: 'list_dir', input: { path: '.' } }]), () => toolTurn([{ id: 'c2', name: 'list_dir', input: { path: '.' } }]), () => textTurn('Xong, làm tiếp đúng chỗ.')], {
      files: { 'a.txt': '1' },
      settings: { maxTurns: 1 },
    });
    await h.run('đi');
    expect(orphansOf(h.session.messages)).toEqual(['c2']); // đúng hiện tượng: lượt tổng kết để lại tool_use không kết quả
    const r = await h.run('tiếp tục');
    expect(r.stopReason).toBe('end_turn');
    const sent = h.provider.requests.at(-1)!.messages;
    expect(orphansOf(sent)).toEqual([]);
    expect(orphansOf(h.session.messages)).toEqual([]);
    expect(userTurnCount(h.session.messages)).toBe(2); // "tiếp tục" vẫn là một lượt người dùng thật
  });
});
