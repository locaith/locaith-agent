import { describe, expect, it } from 'vitest';
import type { ABlock, ToolBlock } from '../src/shared/protocol';
import { buildSegments, splitWork } from '../webview/src/timeline';

const edit = (i: number, state: ToolBlock['state'] = 'done'): ToolBlock => ({ type: 'tool', id: `e${i}`, name: 'edit_file', args: { path: `a${i}.ts` }, state, startedAt: 1000 + i, diff: { path: `a${i}.ts`, added: 2, removed: 1, hunks: [] } });
const call = (i: number): ToolBlock => ({ type: 'tool', id: `t${i}`, name: 'read_file', args: { path: `a${i}.ts` }, state: 'done', startedAt: 1000 + i });
const rowsOf = (blocks: ABlock[], done = false) => buildSegments(blocks, done, true).flatMap((s) => (s.kind === 'activity' ? s.rows : []));

describe('gộp cụm sửa tệp cho gọn', () => {
  it('5 lần sửa tệp liên tiếp → MỘT dòng (mở ra vẫn đủ từng tệp kèm diff)', () => {
    const rows = rowsOf([edit(1), edit(2), edit(3), edit(4), edit(5)]);
    const g = rows.filter((r) => r.kind === 'editgroup');
    expect(g).toHaveLength(1);
    expect((g[0] as { blocks: ToolBlock[] }).blocks.map((b) => b.id)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
    expect(rows.filter((r) => r.kind === 'tool')).toHaveLength(0);
  });

  it('lần sửa đang chạy vẫn hiện riêng (thấy tiến độ); phần đã xong vẫn gộp', () => {
    const rows = rowsOf([edit(1), edit(2), edit(3, 'running')]);
    expect(rows.filter((r) => r.kind === 'tool').map((r) => (r as { block: ToolBlock }).block.state)).toEqual(['running']);
    expect(rows.filter((r) => r.kind === 'editgroup')).toHaveLength(1);
  });

  it('một lần sửa duy nhất giữ nguyên dòng riêng (không gộp vô ích)', () => {
    expect(rowsOf([edit(1)]).map((r) => r.kind)).toEqual(['tool']);
  });

  it('cụm sửa tệp vẫn được tính vào thống kê (số tệp sửa, số lệnh) và hiện preview thay đổi', () => {
    const segs = buildSegments([ { type: 'text', id: 'k', text: 'làm' } as ABlock, edit(1), edit(2), edit(3), { type: 'text', id: 'ans', text: 'xong' } as ABlock], true, true, false);
    const w = splitWork(segs, [], 1000);
    expect(w).not.toBeNull();
    expect(w!.stats.edits).toBe(3);
    expect(w!.stats.calls).toBe(3);
    expect(w!.changes).not.toBeNull();
    expect((w!.changes as { rows: unknown[] }).rows).toHaveLength(3);
  });

  it('không đổi hành vi cũ: chuỗi lệnh đọc vẫn gộp như trước, lệnh lỗi vẫn hiện', () => {
    const rows = rowsOf([call(1), call(2), call(3)]);
    expect(rows.some((r) => r.kind === 'toolgroup' || r.kind === 'toolsum')).toBe(true);
  });
});
