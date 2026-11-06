import { describe, expect, it } from 'vitest';
import {
  MISSING_TOOL_RESULT_TEXT,
  makeToolUse,
  normalizeHistory,
  parseToolArgs,
} from '../../src/core/providers/history';
import { userText, type ChatMessage } from '../../src/core/types';

const assistantCall = (id: string, name = 'web_search'): ChatMessage => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id, name, input: { query: 'x' } }],
});
const result = (id: string, name = 'web_search', content = 'kết quả'): ChatMessage => ({
  role: 'user',
  content: [{ type: 'tool_result', toolUseId: id, name, content }],
});

describe('parseToolArgs', () => {
  it('chuỗi rỗng → {}', () => {
    const p = parseToolArgs('');
    expect(p.input).toEqual({});
    expect(p.error).toBeUndefined();
  });
  it('JSON hợp lệ', () => expect(parseToolArgs('{"a":"Đặng Thị"}').input).toEqual({ a: 'Đặng Thị' }));
  it('JSON cụt → error', () => {
    const p = parseToolArgs('{"path":"a.ts","content":"abc');
    expect(p.error).toMatch(/hỏng hoặc bị cắt cụt/);
    expect(p.rawArgs).toBe('{"path":"a.ts","content":"abc');
  });
  it('không phải đối tượng → error', () => expect(parseToolArgs('[1,2]').error).toMatch(/đối tượng JSON/));
  it('nhận sẵn đối tượng', () => expect(parseToolArgs({ q: 1 }).input).toEqual({ q: 1 }));
});

describe('makeToolUse', () => {
  it('đối số lỗi → parseError + rawArgs, input rỗng', () => {
    const b = makeToolUse('p', 'id1', 'edit_file', '{"a":');
    expect(b.parseError).toBeTruthy();
    expect(b.rawArgs).toBe('{"a":');
    expect(b.input).toEqual({});
    expect(b.provider).toBe('p');
  });
  it('đối số tốt → không có parseError', () => {
    expect(makeToolUse('p', 'id1', 't', '{"a":1}', { raw: true })).toMatchObject({ input: { a: 1 }, raw: { raw: true } });
    expect(makeToolUse('p', 'id1', 't', '{"a":1}').parseError).toBeUndefined();
  });
});

describe('normalizeHistory', () => {
  it('lịch sử hợp lệ giữ nguyên', () => {
    const h = [userText('hỏi'), assistantCall('a'), result('a'), { role: 'assistant', content: [{ type: 'text', text: 'xong' }] } as ChatMessage];
    expect(normalizeHistory(h)).toEqual(h);
  });

  it('tool_use thiếu kết quả → chèn kết quả lỗi ngay sau', () => {
    const out = normalizeHistory([userText('hỏi'), assistantCall('a'), userText('tiếp')]);
    expect(out).toHaveLength(3);
    const fixed = out[2].content;
    expect(fixed[0]).toMatchObject({ type: 'tool_result', toolUseId: 'a', isError: true, content: MISSING_TOOL_RESULT_TEXT });
    expect(fixed[1]).toMatchObject({ type: 'text', text: 'tiếp' });
  });

  it('tool_use ở cuối lịch sử → thêm tin nhắn user chứa kết quả lỗi', () => {
    const out = normalizeHistory([userText('hỏi'), assistantCall('a')]);
    expect(out[out.length - 1]).toMatchObject({ role: 'user', synthetic: true });
  });

  it('assistant liền assistant mà có tool_use → chèn user giữa hai tin', () => {
    const out = normalizeHistory([userText('q'), assistantCall('a'), { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }]);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('kết quả mồ côi bị bỏ', () => {
    const out = normalizeHistory([userText('q'), result('khong-ton-tai')]);
    expect(out).toHaveLength(1);
  });

  it('gọi song song: đủ kết quả giữ nguyên thứ tự, thiếu một cái thì bù', () => {
    const calls: ChatMessage = {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'a', name: 't', input: {} },
        { type: 'tool_use', id: 'b', name: 't', input: {} },
      ],
    };
    const out = normalizeHistory([userText('q'), calls, result('a', 't', 'A')]);
    const ids = out[2].content.map((b) => (b.type === 'tool_result' ? `${b.toolUseId}:${b.isError ? 'lỗi' : 'ok'}` : ''));
    expect(ids).toEqual(['a:ok', 'b:lỗi']);
  });

  it('bỏ tin nhắn rỗng và không sửa mảng đầu vào', () => {
    const input: ChatMessage[] = [userText('q'), { role: 'assistant', content: [] }];
    const copy = JSON.parse(JSON.stringify(input));
    expect(normalizeHistory(input)).toHaveLength(1);
    expect(input).toEqual(copy);
  });
});
