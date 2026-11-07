/** (lane:checkpoints-rewind) Cắt hội thoại tới một tin bất kỳ: tiền tố hợp lệ, ánh xạ từ cuối, trường hợp đã nén. */
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/core/types';
import type { TItem } from '../src/shared/protocol';
import { cutConversation, orphanToolUses } from '../src/shared/rewindConversation';

const user = (text: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const asst = (text: string, tool?: string): ChatMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }, ...(tool ? [{ type: 'tool_use' as const, id: tool, name: 'write_file', input: {} }] : [])],
});
const result = (id: string): ChatMessage => ({ role: 'user', content: [{ type: 'tool_result', toolUseId: id, content: 'ok' }] });
const uItem = (id: string, text: string, steer?: boolean): TItem => ({ kind: 'user', id, text, attachments: [], ts: 1, ...(steer ? { steer: true } : {}) });
const aItem = (id: string): TItem => ({ kind: 'assistant', id, provider: 'p', model: 'm', blocks: [], done: true, ts: 1 }) as unknown as TItem;

const messages: ChatMessage[] = [
  user('một'), asst('đang làm', 't1'), result('t1'), asst('xong một'),
  user('hai'), asst('làm tiếp', 't2'), result('t2'), asst('xong hai'),
  user('ba'), asst('xong ba'),
];
const transcript: TItem[] = [uItem('u1', 'một'), aItem('a1'), uItem('u2', 'hai'), aItem('a2'), uItem('u3', 'ba'), aItem('a3')];

describe('cutConversation', () => {
  it('cắt ngay TRƯỚC tin được chọn; phần còn lại là tiền tố nguyên vẹn (không tool_use mồ côi)', () => {
    const cut = cutConversation(messages, transcript, 'u2');
    expect('error' in cut).toBe(false);
    if ('error' in cut) return;
    expect(cut.messageIndex).toBe(4);
    expect(cut.keptMessages).toEqual(messages.slice(0, 4));
    expect(orphanToolUses(cut.keptMessages)).toEqual([]);
    expect(cut.keptTranscript.map((i) => i.id)).toEqual(['u1', 'a1']);
    expect(cut.removedItems).toBe(4);
    expect(cut.removedTurns).toBe(2);
    expect(cut.item.text).toBe('hai');
    expect(cut.content).toEqual(messages[4].content);
  });

  it('cắt về tin đầu tiên = hội thoại rỗng; tin cuối = bỏ đúng một lượt', () => {
    const first = cutConversation(messages, transcript, 'u1');
    if ('error' in first) throw new Error('lỗi');
    expect(first.keptMessages).toEqual([]);
    const last = cutConversation(messages, transcript, 'u3');
    if ('error' in last) throw new Error('lỗi');
    expect(last.keptMessages).toHaveLength(8);
    expect(last.removedTurns).toBe(1);
  });

  it('tin `steer` (chen giữa vòng công cụ) không được tính là điểm mở lượt và không chọn được', () => {
    const t2: TItem[] = [uItem('u1', 'một'), aItem('a1'), uItem('s1', 'chen vào', true), aItem('a1b'), uItem('u2', 'hai')];
    const msgs = [user('một'), asst('x', 'k'), { role: 'user', content: [{ type: 'tool_result', toolUseId: 'k', content: 'ok' }, { type: 'text', text: 'chen vào' }] } as ChatMessage, asst('y'), user('hai')];
    expect('error' in cutConversation(msgs, t2, 's1')).toBe(true);
    const cut = cutConversation(msgs, t2, 'u2');
    if ('error' in cut) throw new Error('lỗi');
    expect(cut.messageIndex).toBe(4);
    expect(orphanToolUses(cut.keptMessages)).toEqual([]);
  });

  it('đã nén (tin mở lượt cũ không còn trong messages) → "compacted", không cắt bừa', () => {
    const compacted: ChatMessage[] = [{ role: 'user', synthetic: true, content: [{ type: 'text', text: '<tom_tat>' }] }, asst('ok'), ...messages.slice(8)];
    expect(cutConversation(compacted, transcript, 'u1')).toEqual({ error: 'compacted' });
    expect(cutConversation(compacted, transcript, 'u2')).toEqual({ error: 'compacted' });
    const ok = cutConversation(compacted, transcript, 'u3');
    if ('error' in ok) throw new Error('lỗi');
    expect(ok.keptMessages).toHaveLength(2); // tóm tắt + câu xác nhận
    expect(orphanToolUses(ok.keptMessages)).toEqual([]);
  });

  it('id không có → not_found', () => {
    expect(cutConversation(messages, transcript, 'zzz')).toEqual({ error: 'not_found' });
  });

  it('orphanToolUses phát hiện tool_use thiếu kết quả (kiểm chứng chính bộ kiểm)', () => {
    expect(orphanToolUses([user('a'), asst('b', 'x'), user('c')])).toEqual(['x']);
  });
});
