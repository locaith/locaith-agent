import { describe, expect, it } from 'vitest';
import type { ABlock, ToolBlock } from '../../src/shared/protocol';
import { activityStats, buildSegments, groupActivityRuns, latestRunningTool } from '../../webview/src/timeline';

/** Khối công cụ tối thiểu để dựng dòng thời gian. */
function tool(id: string, name: string, state: ToolBlock['state'] = 'done', args: Record<string, unknown> = {}, extra: Partial<ToolBlock> = {}): ToolBlock {
  return { type: 'tool', id, name, args, state, startedAt: 1, durationMs: 10, ...extra } as ToolBlock;
}

const text = (id: string, t: string): ABlock => ({ type: 'text', id, text: t });
const think = (id: string, t = 'suy nghĩ'): ABlock => ({ type: 'thinking', id, text: t });
const pill = (id: string, t = 'đang đọc'): ABlock => ({ type: 'pill', id, text: t, kind: 'working', active: false });

describe('groupActivityRuns — cả quá trình thành MỘT dòng, không bỏ gì', () => {
  it('nhiều dòng hoạt động liền nhau → một cụm, bung ra đủ các đoạn gốc', () => {
    const segs = buildSegments([think('k1'), tool('a', 'read_file'), tool('b', 'run_command')], false, true);
    const runs = groupActivityRuns(segs);
    expect(runs).toHaveLength(1);
    expect(runs[0].kind).toBe('run');
    const run = runs[0] as Extract<(typeof runs)[number], { kind: 'run' }>;
    expect(run.items).toHaveLength(1);
    expect(run.items[0].kind === 'activity' && run.items[0].rows.length).toBe(3);
  });

  it('chữ ở giữa tách cụm: thứ tự đọc không bị đảo', () => {
    const segs = buildSegments(
      [tool('a', 'read_file'), tool('b', 'grep'), text('t1', 'giải thích ngắn'), tool('c', 'read_file'), tool('d', 'grep')],
      false,
      true,
    );
    const runs = groupActivityRuns(segs);
    expect(runs.map((r) => r.kind)).toEqual(['run', 'one', 'run']);
    expect(runs[1].kind === 'one' && runs[1].seg.kind).toBe('text');
  });

  it('chỉ một dòng thì không gộp (thêm lớp bấm mà không gọn hơn)', () => {
    const segs = buildSegments([tool('a', 'read_file')], false, true);
    expect(groupActivityRuns(segs).map((r) => r.kind)).toEqual(['one']);
  });

  it('không mất dòng nào: bung cụm ra đúng số dòng như trước khi gộp', () => {
    const blocks: ABlock[] = [think('k1'), pill('p1'), pill('p2'), tool('a', 'read_file'), tool('b', 'run_command', 'running')];
    const before = buildSegments(blocks, false, true).flatMap((s) => (s.kind === 'activity' ? s.rows : []));
    const runs = groupActivityRuns(buildSegments(blocks, false, true));
    const after = runs.flatMap((r) => (r.kind === 'run' ? r.items.flatMap((s) => (s.kind === 'activity' ? s.rows : [])) : r.seg.kind === 'activity' ? r.seg.rows : []));
    expect(after).toEqual(before);
  });

  it('thống kê cụm đếm cả lệnh, lượt sửa tệp và lỗi (đi xuyên vào nhóm)', () => {
    const segs = buildSegments(
      [tool('a', 'read_file'), tool('b', 'grep'), tool('c', 'write_file', 'done', { path: 'a.ts' }, { diff: { path: 'a.ts', added: 3, removed: 1, hunks: [] } }), tool('d', 'run_command', 'error')],
      false,
      true,
    );
    const rows = segs.flatMap((s) => (s.kind === 'activity' ? s.rows : []));
    const stats = activityStats(rows);
    expect(stats.calls).toBe(4);
    expect(stats.edits).toBe(1);
    expect(stats.failed).toBe(1);
  });

  it('lấy được lệnh đang chạy để dòng gộp vẫn nói «đang làm gì»', () => {
    const segs = buildSegments([tool('a', 'read_file'), tool('b', 'run_command', 'running', { command: 'npm test' })], false, true);
    const rows = segs.flatMap((s) => (s.kind === 'activity' ? s.rows : []));
    const latest = latestRunningTool(rows);
    expect(latest?.id).toBe('b');
    expect(latestRunningTool(segs.flatMap((s) => (s.kind === 'activity' ? s.rows : []).filter((r) => r.kind !== 'tool')))).toBeNull();
  });
});
