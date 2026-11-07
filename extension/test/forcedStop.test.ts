import { describe, expect, it } from 'vitest';
import { claimsAllDone, forcedStopSummary, hasRemainingWork, stopFacts, wrapUpPrompt, type StopFacts } from '../src/core/engine/forcedStop';
import { newTrace } from '../src/core/engine/seams';
import { newSession } from '../src/core/engine/types';

/** (lane:output-timeouts · B08) Bị buộc dừng thì nói thật: ba phần tất định dựng từ vết thật; lời nhắc tổng kết đính kèm vết. */
const facts = (over: Partial<StopFacts> = {}): StopFacts => ({
  reason: 'max_turns',
  turns: 12,
  writtenPaths: [],
  execs: 0,
  toolCalls: 0,
  doneTodos: [],
  pendingTodos: [],
  ...over,
});

describe('forcedStop — tổng kết ba phần', () => {
  it('stopFacts đọc từ vết thật + danh sách việc của phiên (chế độ plan: việc là kế hoạch, không tính)', () => {
    const trace = newTrace();
    trace.calls.push(
      { callId: 'c1', name: 'write_file', risk: 'write', input: { path: 'src/a.ts' }, turn: 1, ts: 1, ok: true, resultHead: '' },
      { callId: 'c2', name: 'write_file', risk: 'write', input: { path: 'src/a.ts' }, turn: 2, ts: 2, ok: true, resultHead: '' },
      { callId: 'c3', name: 'run_command', risk: 'exec', input: { command: 'npm test' }, turn: 3, ts: 3, ok: false, resultHead: '' },
    );
    trace.execs = 1;
    const session = newSession({ id: 's', provider: 'p', model: 'm', todos: [{ id: 't1', title: 'A', status: 'completed' }, { id: 't2', title: 'B', status: 'in_progress' }] });
    const f = stopFacts({ reason: 'max_turns', turns: 5, trace, session });
    expect(f).toMatchObject({ writtenPaths: ['src/a.ts'], execs: 1, toolCalls: 3, turns: 5 });
    expect(f.doneTodos.map((x) => x.title)).toEqual(['A']);
    expect(f.pendingTodos.map((x) => x.title)).toEqual(['B']);
    expect(stopFacts({ reason: 'max_turns', turns: 5, trace, session: { ...session, mode: 'plan' } }).pendingTodos).toEqual([]);
  });

  it('ĐÚNG BA PHẦN «Đã làm» / «Còn lại» / «Chạy tiếp», mỗi phần một dòng, số liệu từ vết thật (vi)', () => {
    const s = forcedStopSummary(
      'vi',
      facts({ writtenPaths: ['src/a.ts', 'src/b.ts'], execs: 2, doneTodos: [{ id: '1', title: 'Đọc mã', status: 'completed' }], pendingTodos: [{ id: '2', title: 'Viết test', status: 'pending' }] }),
      200,
    );
    const lines = s.split('\n');
    expect(lines[0]).toBe('Đã dừng vì hết số vòng cho phép (200).');
    expect(lines[1]).toBe('• Đã làm: đã sửa 2 tệp (a.ts, b.ts), đã chạy 2 lệnh, xong 1/2 việc.');
    expect(lines[2]).toBe('• Còn lại: Viết test.');
    expect(lines[3]).toMatch(/^• Chạy tiếp: bấm «Chạy tiếp»/);
    expect(lines).toHaveLength(4);
  });

  it('không có vết, không có danh sách → nói rõ "chưa có thay đổi nào", không bịa; tiếng Anh đủ ba phần', () => {
    const s = forcedStopSummary('en', facts({ reason: 'stall' }));
    expect(s).toContain('Stopped: the model did not respond.');
    expect(s).toContain('• Done: no recorded changes yet');
    expect(s).toContain('• Remaining: nothing left in the task list.');
    expect(s).toMatch(/• How to continue: press "Continue"/); // bị cắt ngang khi chưa có danh sách → vẫn coi là còn việc
  });

  it('đã xong hết (có danh sách, không còn việc) → phần Chạy tiếp nói "không cần"; không có nút', () => {
    const f = facts({ doneTodos: [{ id: '1', title: 'A', status: 'completed' }] });
    expect(hasRemainingWork(f)).toBe(false);
    expect(forcedStopSummary('vi', f)).toContain('• Chạy tiếp: không cần');
    expect(hasRemainingWork(facts({ pendingTodos: [{ id: '2', title: 'B', status: 'pending' }] }))).toBe(true);
    expect(hasRemainingWork(facts({ reason: 'error' }))).toBe(false); // lỗi khi chưa có danh sách: không biết → không ép nút
  });

  it('model nói "đã hoàn thành toàn bộ" khi còn việc → bị chỉ ra ở dòng cuối', () => {
    const s = forcedStopSummary('vi', facts({ contradiction: true, pendingTodos: [{ id: '2', title: 'B', status: 'pending' }, { id: '3', title: 'C', status: 'pending' }] }));
    expect(s.split('\n').at(-1)).toBe('Lưu ý: trợ lý nói đã hoàn thành toàn bộ nhưng danh sách còn 2 việc chưa xong — hãy tin danh sách.');
    // không còn việc thì không có gì để mâu thuẫn
    expect(forcedStopSummary('vi', facts({ contradiction: true }))).not.toContain('Lưu ý');
  });

  it('claimsAllDone: bắt câu khẳng định xong toàn bộ (vi có dấu/không dấu, en); không bắt câu bình thường', () => {
    for (const s of ['Đã hoàn thành toàn bộ công việc.', 'Toàn bộ các mục đã hoàn thành', 'da xong tat ca roi', 'All tasks are complete.', 'Everything is now done!', 'I completed all the items', 'Fully completed.']) {
      expect(claimsAllDone(s), s).toBe(true);
    }
    for (const s of ['Đã xong việc A, còn B và C.', 'Done with A; B remains.', 'Hoàn thành mục 1/3.', '']) expect(claimsAllDone(s), s).toBe(false);
  });

  it('wrapUpPrompt đòi ba phần, cấm "hoàn thành toàn bộ", và ĐÍNH KÈM vết thật (vi + en)', () => {
    const f = facts({ writtenPaths: ['x/y/z.md'], execs: 3, pendingTodos: [{ id: '2', title: 'Việc còn dở', status: 'pending' }] });
    const vi = wrapUpPrompt('vi', f);
    expect(vi).toContain('«Đã làm»');
    expect(vi).toContain('«Còn lại»');
    expect(vi).toContain('«Chạy tiếp bằng cách nào»');
    expect(vi).toContain('CẤM');
    expect(vi).toContain('đã sửa 1 tệp (z.md); đã chạy 3 lệnh; việc chưa xong trong danh sách: Việc còn dở.');
    const en = wrapUpPrompt('en', facts());
    expect(en).toContain('"Done"');
    expect(en).toContain('"Remaining"');
    expect(en).toContain('"How to continue"');
    expect(en).toContain('no files changed; no commands run; unfinished tasks in the list: none.');
  });
});
