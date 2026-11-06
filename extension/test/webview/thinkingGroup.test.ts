import { describe, expect, it } from 'vitest';
import { groupThinking } from '../../webview/src/timeline';
import type { ActivityRow } from '../../webview/src/timeline';

const think = (id: string, text = 'đang nghĩ'): ActivityRow =>
  ({ kind: 'thinking', key: id, block: { type: 'thinking', id, text } }) as unknown as ActivityRow;

const tool = (id: string): ActivityRow =>
  ({
    kind: 'tool',
    key: id,
    block: { type: 'tool', id, name: 'read_file', args: {}, state: 'done', startedAt: 0 },
  }) as unknown as ActivityRow;

const pill = (id: string): ActivityRow => ({ kind: 'pill', key: id, block: { type: 'pill', id, text: 'bước', kind: 'status', active: false } }) as unknown as ActivityRow;

describe('groupThinking — gom các khối suy nghĩ liền nhau', () => {
  it('6 khối suy nghĩ liền nhau → MỘT mục (trước đây 6 dòng)', () => {
    const rows = [think('a'), think('b'), think('c'), think('d'), think('e'), think('f')];
    const items = groupThinking(rows, false);
    expect(items).toHaveLength(1);
    expect(items[0].thinking?.map((b) => b.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(items[0].row).toBeUndefined();
  });

  it('có thao tác chen giữa → tách nhóm, thứ tự giữ nguyên', () => {
    const items = groupThinking([think('a'), think('b'), tool('t1'), think('c'), pill('p1')], false);
    expect(items.map((i) => i.key)).toEqual(['think:a', 't1', 'think:c', 'p1']);
    expect(items[0].thinking).toHaveLength(2);
    expect(items[2].thinking).toHaveLength(1);
  });

  it('không có suy nghĩ → giữ nguyên từng dòng', () => {
    const items = groupThinking([tool('t1'), pill('p1')], false);
    expect(items.map((i) => i.row?.key)).toEqual(['t1', 'p1']);
    expect(items.every((i) => i.thinking === undefined)).toBe(true);
  });

  it('đang chạy: chỉ mục CUỐI mang cờ live', () => {
    const items = groupThinking([think('a'), tool('t1'), think('b'), think('c')], true);
    expect(items.map((i) => i.live)).toEqual([false, false, true]);
    expect(items[2].thinking).toHaveLength(2);
  });

  it('không có gì để gom → mảng rỗng', () => {
    expect(groupThinking([], false)).toEqual([]);
  });
});
