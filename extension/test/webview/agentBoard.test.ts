import { describe, expect, it } from 'vitest';
import type { AgentRunRow, AgentRunState, ToolBlock, WfProgress } from '../../src/shared/protocol';
import { agentsOf, buildBoard, KEEP_DONE, liveCount, matchesFilter, meterSegments, rowElapsedMs, SHOW_ALL_UP_TO, sortRows, summarize, totals } from '../../webview/src/agentBoard';

/** Dòng agent mẫu. */
function row(n: number, state: AgentRunState, extra: Partial<AgentRunRow> = {}): AgentRunRow {
  return { n, label: `agent ${n}`, state, tokens: 0, tools: 0, ...extra };
}

/** Ảnh chụp workflow mẫu: `counts` tự đếm từ các dòng, trừ khi truyền `counts` (workflow lớn hơn số dòng gửi kèm). */
function wfOf(rows: AgentRunRow[], extra: Partial<WfProgress> = {}): WfProgress {
  const c = { queued: 0, running: 0, done: 0, error: 0, stopped: 0, total: rows.length };
  for (const r of rows) c[r.state]++;
  return { rev: 1, counts: c, rows, ...extra };
}

const WORDS = { running: 'chạy', queued: 'chờ', done: 'xong', error: 'lỗi' };

describe('sortRows: đang chạy → lỗi → xếp hàng → xong', () => {
  it('đưa agent đang chạy lên đầu, lỗi kế tiếp, rồi hàng chờ theo thứ tự tới lượt, agent xong mới nhất cuối cùng', () => {
    const rows = [
      row(1, 'done', { endedAt: 100 }),
      row(2, 'queued'),
      row(3, 'error'),
      row(4, 'running'),
      row(5, 'done', { endedAt: 300 }),
      row(6, 'queued'),
      row(7, 'stopped'),
      row(8, 'running'),
      row(9, 'done', { endedAt: 200 }),
    ];
    expect(sortRows(rows).map((r) => r.n)).toEqual([4, 8, 3, 7, 2, 6, 5, 9, 1]);
  });

  it('không sửa mảng đầu vào', () => {
    const rows = [row(2, 'queued'), row(1, 'running')];
    const copy = rows.map((r) => r.n);
    sortRows(rows);
    expect(rows.map((r) => r.n)).toEqual(copy);
  });

  it('agent xong cùng giây kết thúc thì số thứ tự lớn hơn (xong sau) đứng trước', () => {
    const rows = [row(1, 'done', { endedAt: 50 }), row(2, 'done', { endedAt: 50 }), row(3, 'done')];
    expect(sortRows(rows).map((r) => r.n)).toEqual([2, 1, 3]);
  });
});

describe('matchesFilter', () => {
  const all: AgentRunState[] = ['queued', 'running', 'done', 'error', 'stopped'];
  it('all nhận hết; active = chạy + chờ; error = lỗi + đã dừng; done = xong', () => {
    expect(all.filter((s) => matchesFilter(s, 'all'))).toEqual(all);
    expect(all.filter((s) => matchesFilter(s, 'active'))).toEqual(['queued', 'running']);
    expect(all.filter((s) => matchesFilter(s, 'error'))).toEqual(['error', 'stopped']);
    expect(all.filter((s) => matchesFilter(s, 'done'))).toEqual(['done']);
  });
});

describe('buildBoard: ít agent thì hiện hết, nhiều thì gập agent đã xong', () => {
  it(`≤ ${SHOW_ALL_UP_TO} dòng → hiện đủ, không gập`, () => {
    const rows = Array.from({ length: SHOW_ALL_UP_TO }, (_, i) => row(i + 1, i < 8 ? 'done' : 'running', { endedAt: i }));
    const b = buildBoard(wfOf(rows));
    expect(b.shown).toBe(SHOW_ALL_UP_TO);
    expect(b.groups).toHaveLength(1);
    expect(b.groups[0]!.folded).toBe(0);
    expect(b.groups[0]!.name).toBe('');
    expect(b.phased).toBe(false);
  });

  it(`> ${SHOW_ALL_UP_TO} dòng → chỉ giữ ${KEEP_DONE} agent xong MỚI NHẤT, phần còn lại gập (không mất khỏi tổng)`, () => {
    const rows: AgentRunRow[] = [row(1, 'running'), row(2, 'running'), row(3, 'queued')];
    for (let i = 0; i < 12; i++) rows.push(row(10 + i, 'done', { endedAt: 1000 + i }));
    const b = buildBoard(wfOf(rows));
    const g = b.groups[0]!;
    expect(g.folded).toBe(12 - KEEP_DONE);
    expect(g.rows.filter((r) => r.state === 'done').map((r) => r.n)).toEqual([21, 20, 19]);
    expect(g.rows.slice(0, 3).map((r) => r.state)).toEqual(['running', 'running', 'queued']);
    expect(b.shown).toBe(3 + KEEP_DONE);
    expect(b.matched).toBe(15);
    expect(g.done).toBe(12);
  });

  it('showDone = true thì không gập', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(i + 1, 'done', { endedAt: i }));
    const b = buildBoard(wfOf(rows), { showDone: true });
    expect(b.shown).toBe(20);
    expect(b.groups[0]!.folded).toBe(0);
  });

  it('bộ lọc «xong» và «lỗi» luôn hiện đủ dòng khớp (người dùng đã chủ động chọn)', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(i + 1, i < 20 ? 'done' : 'error', { endedAt: i }));
    expect(buildBoard(wfOf(rows), { filter: 'done' }).shown).toBe(20);
    expect(buildBoard(wfOf(rows), { filter: 'error' }).shown).toBe(10);
  });

  it('bộ lọc «đang chạy» chỉ còn chạy + chờ', () => {
    const rows = [row(1, 'running'), row(2, 'queued'), row(3, 'done'), row(4, 'error')];
    const b = buildBoard(wfOf(rows), { filter: 'active' });
    expect(b.groups[0]!.rows.map((r) => r.n)).toEqual([1, 2]);
    expect(b.matched).toBe(2);
  });
});

describe('buildBoard: gom theo pha', () => {
  const rows = [
    row(1, 'done', { phase: 'Trace', endedAt: 10 }),
    row(2, 'running', { phase: 'Trace' }),
    row(3, 'queued', { phase: 'Verify' }),
    row(4, 'queued', { phase: 'Verify' }),
    row(5, 'running'),
  ];

  it('giữ thứ tự pha theo wf.phases, agent không thuộc pha nào ở cuối', () => {
    const phases = [
      { name: 'Trace', total: 2, done: 1, error: 0 },
      { name: 'Verify', total: 2, done: 0, error: 0 },
    ];
    const b = buildBoard(wfOf(rows, { phases }));
    expect(b.phased).toBe(true);
    expect(b.groups.map((g) => g.name)).toEqual(['Trace', 'Verify', '']);
    expect(b.groups[0]!.rows.map((r) => r.n)).toEqual([2, 1]);
    expect(b.groups[0]!.total).toBe(2);
    expect(b.groups[0]!.done).toBe(1);
    expect(b.groups[0]!.running).toBe(1);
    expect(b.groups[2]!.rows.map((r) => r.n)).toEqual([5]);
  });

  it('pha có trong phases nhưng chưa có dòng nào vẫn hiện (total > 0) — pha rỗng thì bỏ', () => {
    const phases = [
      { name: 'Trace', total: 2, done: 1, error: 0 },
      { name: 'Merge', total: 3, done: 0, error: 0 },
      { name: 'Trống', total: 0, done: 0, error: 0 },
    ];
    const b = buildBoard(wfOf(rows.slice(0, 2), { phases }));
    expect(b.groups.map((g) => g.name)).toEqual(['Trace', 'Merge']);
    expect(b.groups[1]!.rows).toEqual([]);
    expect(b.groups[1]!.total).toBe(3);
  });

  it('pha chưa có trong wf.phases (chỉ có trên dòng) vẫn được vẽ, đứng sau các pha đã biết', () => {
    const b = buildBoard(wfOf(rows, { phases: [{ name: 'Verify', total: 2, done: 0, error: 0 }] }));
    expect(b.groups.map((g) => g.name)).toEqual(['Verify', 'Trace', '']);
  });

  it('pha gập tay: chỉ còn tiêu đề, số dòng bị ẩn cộng vào `folded`', () => {
    const phases = [
      { name: 'Trace', total: 2, done: 1, error: 0 },
      { name: 'Verify', total: 2, done: 0, error: 0 },
    ];
    const b = buildBoard(wfOf(rows, { phases }), { collapsed: new Set(['Verify']) });
    const verify = b.groups.find((g) => g.name === 'Verify')!;
    expect(verify.rows).toEqual([]);
    expect(verify.folded).toBe(2);
    expect(b.shown).toBe(3);
  });

  it('chỉ một nhóm không tên → không chia pha', () => {
    expect(buildBoard(wfOf([row(1, 'running'), row(2, 'queued')])).phased).toBe(false);
  });

  it('đang lọc: pha không còn dòng khớp thì biến mất (không để lại tiêu đề trống); xem «Tất cả» thì pha đã khai báo vẫn hiện', () => {
    const phases = [{ name: 'Trace', total: 2, done: 1, error: 0 }];
    const filtered = buildBoard(wfOf(rows.slice(0, 2), { phases }), { filter: 'error' });
    expect(filtered.groups).toEqual([]);
    expect(filtered.shown).toBe(0);
    expect(filtered.matched).toBe(0);
    expect(buildBoard(wfOf([], { phases }), { filter: 'all' }).groups.map((g) => g.name)).toEqual(['Trace']);
  });
});

describe('buildBoard: workflow lớn hơn số dòng gửi kèm', () => {
  it('`unlisted` = tổng agent trừ số dòng đang có', () => {
    const rows = Array.from({ length: 80 }, (_, i) => row(i + 1, 'running'));
    const wf = wfOf(rows, { counts: { queued: 420, running: 80, done: 500, error: 0, stopped: 0, total: 1000 } });
    expect(buildBoard(wf).unlisted).toBe(920);
  });

  it('không bao giờ âm', () => {
    const wf = wfOf([row(1, 'running'), row(2, 'running')], { counts: { queued: 0, running: 1, done: 0, error: 0, stopped: 0, total: 1 } });
    expect(buildBoard(wf).unlisted).toBe(0);
  });
});

describe('summarize', () => {
  it('bỏ vế bằng 0, gộp lỗi + đã dừng', () => {
    expect(summarize({ queued: 12, running: 3, done: 20, error: 1, stopped: 1, total: 37 }, WORDS)).toBe('3 chạy · 12 chờ · 20 xong · 2 lỗi');
    expect(summarize({ queued: 0, running: 0, done: 6, error: 0, stopped: 0, total: 6 }, WORDS)).toBe('6 xong');
  });
  it('chưa có agent nào → chuỗi rỗng', () => {
    expect(summarize({ queued: 0, running: 0, done: 0, error: 0, stopped: 0, total: 0 }, WORDS)).toBe('');
  });
});

describe('rowElapsedMs', () => {
  it('đang chạy → tính tới `now`', () => {
    expect(rowElapsedMs(row(1, 'running', { startedAt: 1_000 }), 4_500)).toBe(3_500);
  });
  it('xong/lỗi → startedAt..endedAt, không dài thêm theo `now`', () => {
    expect(rowElapsedMs(row(1, 'done', { startedAt: 1_000, endedAt: 2_000 }), 99_999)).toBe(1_000);
    expect(rowElapsedMs(row(1, 'error', { startedAt: 1_000, endedAt: 1_500 }), 99_999)).toBe(500);
  });
  it('xếp hàng / chưa có mốc thời gian → không hiện đồng hồ', () => {
    expect(rowElapsedMs(row(1, 'queued'), 10)).toBeUndefined();
    expect(rowElapsedMs(row(1, 'running'), 10)).toBeUndefined();
    expect(rowElapsedMs(row(1, 'done', { startedAt: 5 }), 10)).toBeUndefined();
  });
  it('đồng hồ lệch (now < startedAt) không âm', () => {
    expect(rowElapsedMs(row(1, 'running', { startedAt: 5_000 }), 4_000)).toBe(0);
  });
});

describe('totals', () => {
  it('cộng token và số lệnh của mọi dòng', () => {
    expect(totals([row(1, 'done', { tokens: 1200, tools: 3 }), row(2, 'running', { tokens: 800, tools: 2 })])).toEqual({ tokens: 2000, tools: 5 });
    expect(totals([])).toEqual({ tokens: 0, tools: 0 });
  });
});

describe('meterSegments', () => {
  it('tỉ lệ các đoạn cộng lại bằng 1, thứ tự xong → chạy → lỗi → chờ', () => {
    const segs = meterSegments({ queued: 20, running: 4, done: 14, error: 1, stopped: 1, total: 40 });
    expect(segs.map((s) => s.state)).toEqual(['done', 'running', 'error', 'queued']);
    expect(segs.reduce((n, s) => n + s.frac, 0)).toBeCloseTo(1, 10);
    expect(segs[0]!.frac).toBeCloseTo(14 / 40, 10);
    expect(segs[2]!.frac).toBeCloseTo(2 / 40, 10);
  });
  it('bỏ đoạn rỗng; chưa có agent → không có đoạn nào', () => {
    expect(meterSegments({ queued: 0, running: 0, done: 5, error: 0, stopped: 0, total: 5 }).map((s) => s.state)).toEqual(['done']);
    expect(meterSegments({ queued: 0, running: 0, done: 0, error: 0, stopped: 0, total: 0 })).toEqual([]);
  });
  it('thiếu `total` thì tự cộng từ các phần', () => {
    const segs = meterSegments({ queued: 1, running: 1, done: 2, error: 0, stopped: 0, total: 0 });
    expect(segs.reduce((n, s) => n + s.frac, 0)).toBeCloseTo(1, 10);
  });
});

/** Khối agent mẫu cho `agentsOf` / `liveCount`. */
function toolBlock(id: string, name: string, state: ToolBlock['state'], extra: Partial<ToolBlock> = {}): ToolBlock {
  return { type: 'tool', id, name, args: {}, state, startedAt: 0, ...extra };
}

describe('agentsOf / liveCount', () => {
  it('lấy khối agent của lượt gần nhất có agent, mới nhất trước; bỏ qua công cụ thường', () => {
    const view = {
      transcript: [
        { kind: 'assistant', blocks: [toolBlock('old', 'agent', 'done', { startedAt: 1 })] },
        { kind: 'assistant', blocks: [toolBlock('a', 'agent', 'done', { startedAt: 10 }), toolBlock('r', 'read_file', 'done'), toolBlock('b', 'workflow_run', 'running', { startedAt: 20 })] },
        { kind: 'assistant', blocks: [toolBlock('x', 'read_file', 'done')] },
      ],
    } as unknown as Parameters<typeof agentsOf>[0];
    expect(agentsOf(view).map((b) => b.id)).toEqual(['b', 'a']);
  });

  it('không có agent nào → mảng rỗng', () => {
    expect(agentsOf({ transcript: [] })).toEqual([]);
  });

  it('agent lẻ: tính 1 khi còn chạy / đang chờ cấp quyền, 0 khi xong', () => {
    expect(liveCount([toolBlock('a', 'agent', 'running'), toolBlock('b', 'agent', 'awaiting_permission'), toolBlock('c', 'agent', 'done')])).toBe(2);
  });

  it('workflow: đếm từng agent bên trong (chạy + chờ), không phải 1 khối', () => {
    const wf = wfOf([row(1, 'running'), row(2, 'running'), row(3, 'queued'), row(4, 'done')]);
    const block = toolBlock('w', 'workflow_run', 'running', { agent: { wf } as ToolBlock['agent'] });
    expect(liveCount([block])).toBe(3);
  });

  it('workflow còn chạy nhưng chưa có agent nào bắt đầu → vẫn tính 1 (để chip không biến mất)', () => {
    const wf = wfOf([]);
    expect(liveCount([toolBlock('w', 'workflow_run', 'running', { agent: { wf } as ToolBlock['agent'] })])).toBe(1);
  });

  it('workflow đã xong hết → 0', () => {
    const wf = wfOf([row(1, 'done'), row(2, 'done')]);
    expect(liveCount([toolBlock('w', 'workflow_run', 'done', { agent: { wf } as ToolBlock['agent'] })])).toBe(0);
  });
});
