import { describe, expect, it } from 'vitest';
import { sanitizeEvents, sanitizeItem, sanitizeRule } from '../src/core/remote/sanitize';
import type { AssistantItem, PermissionRequest, ToolBlock, UiEvent } from '../src/shared/protocol';
import { applyEvent } from '../src/shared/transcript';

const req = (extra: Partial<PermissionRequest>): PermissionRequest => ({ id: 'p1', callId: 'c1', tool: 'run_command', kind: 'command', title: 'Chạy?', canAllowSession: true, ...extra });

describe('(lane:perm-rules) trường luật đi qua Remote và transcript', () => {
  it('sanitizeRule: một dòng, cắt 200 ký tự, bỏ ký tự điều khiển; không phải chuỗi → undefined', () => {
    expect(sanitizeRule('run_command(npm test:*)')).toBe('run_command(npm test:*)');
    expect(sanitizeRule('a\nb\u0000c')).toBe('a b c');
    expect(sanitizeRule('x'.repeat(300))!.length).toBeLessThan(230);
    expect(sanitizeRule(42)).toBeUndefined();
    expect(sanitizeRule('')).toBeUndefined();
  });

  it('tool_permission: rule/suggest được cắt và lọc (tối đa 3 đề xuất, bỏ mục không hợp lệ)', () => {
    const ev: UiEvent = { t: 'tool_permission', id: 'a1', callId: 'c1', request: req({ rule: 'r'.repeat(500), suggest: ['a(b)', 7 as unknown as string, 'c', 'd', 'e'] }) };
    const [out] = sanitizeEvents([ev]) as Extract<UiEvent, { t: 'tool_permission' }>[];
    expect(out.request.rule!.length).toBeLessThan(230);
    expect(out.request.suggest).toEqual(['a(b)', 'c', 'd']);
    const none = sanitizeEvents([{ t: 'tool_permission', id: 'a1', callId: 'c1', request: req({}) }])[0] as Extract<UiEvent, { t: 'tool_permission' }>;
    expect('rule' in none.request).toBe(false);
    expect('suggest' in none.request).toBe(false);
  });

  it('tool_start.rule và ToolBlock.rule được cắt; vẫn là loại sự kiện/khối ĐÃ CÓ (không có loại mới)', () => {
    const ev: UiEvent = { t: 'tool_start', id: 'a1', callId: 'c1', name: 'run_command', args: { command: 'npm test' }, rule: 'run_command(npm test:*)' };
    const [out] = sanitizeEvents([ev]);
    expect(out.t).toBe('tool_start');
    expect((out as typeof ev).rule).toBe('run_command(npm test:*)');
    const block: ToolBlock = { type: 'tool', id: 'c1', name: 'run_command', args: {}, state: 'done', startedAt: 0, rule: 'z'.repeat(400) };
    const item: AssistantItem = { kind: 'assistant', id: 'a1', provider: 'p', model: 'm', ts: 0, blocks: [block], done: true };
    const san = sanitizeItem(item) as AssistantItem;
    expect(((san.blocks[0] as ToolBlock).rule ?? '').length).toBeLessThan(230);
  });

  it('transcript: tool_start mang rule → ToolBlock.rule; tool_start không rule giữ nguyên hành vi cũ', () => {
    const items = applyEvent([], { t: 'assistant_start', id: 'a1', provider: 'p', model: 'm', ts: 0 });
    const withRule = applyEvent(items, { t: 'tool_start', id: 'a1', callId: 'c1', name: 'run_command', args: { command: 'npm test' }, rule: 'run_command(npm test:*)' });
    const a = withRule[0] as AssistantItem;
    expect((a.blocks[0] as ToolBlock).rule).toBe('run_command(npm test:*)');
    const plain = applyEvent(items, { t: 'tool_start', id: 'a1', callId: 'c2', name: 'read_file', args: {} });
    expect('rule' in ((plain[0] as AssistantItem).blocks[0] as ToolBlock)).toBe(false);
  });
});
