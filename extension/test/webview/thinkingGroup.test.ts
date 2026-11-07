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

describe('groupThinking — gom TOÀN BỘ suy nghĩ của lượt vào một dòng', () => {
  it('6 khối liền nhau → MỘT mục', () => {
    const items = groupThinking([think('a'), think('b'), think('c'), think('d'), think('e'), think('f')], false);
    expect(items).toHaveLength(1);
    expect(items[0].thinking?.map((b) => b.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('LỖI ĐÃ SỬA: suy nghĩ XEN KẼ thao tác vẫn gom hết vào một mục', () => {
    const rows = [think('a'), tool('t1'), think('b'), tool('t2'), think('c'), pill('p1')];
    const items = groupThinking(rows, false);
    expect(items.map((i) => i.key)).toEqual(['think:a', 't1', 't2', 'p1']);
    expect(items[0].thinking?.map((b) => b.id)).toEqual(['a', 'b', 'c']);
    // chỉ còn ĐÚNG một dòng suy nghĩ trong cả lượt
    expect(items.filter((i) => i.thinking).length).toBe(1);
  });

  it('mục suy nghĩ đứng ở vị trí khối nghĩ ĐẦU TIÊN', () => {
    const items = groupThinking([tool('t0'), think('a'), tool('t1')], false);
    expect(items.map((i) => i.key)).toEqual(['t0', 'think:a', 't1']);
  });

  it('không có suy nghĩ → giữ nguyên từng dòng', () => {
    const items = groupThinking([tool('t1'), pill('p1')], false);
    expect(items.map((i) => i.row?.key)).toEqual(['t1', 'p1']);
  });

  it('đang chạy và khối cuối là suy nghĩ → nhóm mang cờ live', () => {
    const items = groupThinking([tool('t1'), think('a'), think('b')], true);
    expect(items.map((i) => i.key)).toEqual(['t1', 'think:a']);
    expect(items[0].live).toBe(false);
    expect(items[1].live).toBe(true);
  });

  it('đang chạy nhưng khối cuối là thao tác → nhóm không live', () => {
    const items = groupThinking([think('a'), tool('t1')], true);
    expect(items.map((i) => i.live)).toEqual([false, true]);
  });

  it('rỗng → rỗng', () => {
    expect(groupThinking([], false)).toEqual([]);
  });
});
