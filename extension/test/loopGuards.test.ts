/**
 * Chốt chặn vòng lặp bằng máy (lane:loop-guards) — kịch bản chạy ENGINE THẬT qua FakeProvider:
 *   B01/B02 cạn vòng → chặn khám phá (một lần đọc ân hạn);  B03/B10 nhắc todo: lần 1 trạng thái thật, lần 2 làm khác, lần 3 tự đóng;
 *   B05 câu trả lời cuối tự đứng (tính chung ngân sách nhắc);  B06 kiểm tra shell qua toolBefore;  B07 phá vòng lặp theo kết quả;
 *   B09 sửa JSON đối số;  skill ky-luat-agent đóng gói sẵn;  Remote hạ cấp trạng thái 'blocked'.
 * FakeProvider ném "hết kịch bản" khi engine gọi thừa → mọi test đều là chặn trên số lần gọi model.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatMessage, ToolResultBlock } from '../src/core/types';
import { newTrace } from '../src/core/engine/seams';
import { budgetGuardDecision } from '../src/core/engine/guards/budgetGuard';
import { finalAnswerProblem } from '../src/core/engine/guards/finalAnswer';
import { closeOpenBrackets, escapeRawControlChars, repairJsonArgs, repairToolArgs, stripTrailingCommas } from '../src/core/engine/guards/jsonRepair';
import { LoopTracker, normalizeOutput, similarity } from '../src/core/engine/guards/loopBreaker';
import { autoCloseTodos, hasEvidence, evidenceTokens } from '../src/core/engine/guards/todoClose';
import { sanitizeEvent, sanitizeTodos, toRemoteState } from '../src/core/remote/sanitize';
import { builtinSkills } from '../src/core/skills/builtin';
import { SkillRegistry } from '../src/core/skills/registry';
import { migrateSession } from '../src/shared/sessionMigrate';
import type { TodoItem, ViewState } from '../src/shared/protocol';
import { eventsOf, makeHarness } from './helpers/harness';
import { textTurn, toolTurn } from './helpers/fakeProvider';

const textOf = (m: ChatMessage): string => m.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
const synthetic = (msgs: readonly ChatMessage[]): string[] => msgs.filter((m) => m.role === 'user' && m.synthetic).map(textOf);
/** Kết quả công cụ của VÒNG VỪA XONG = các tool_result trong tin người dùng cuối của yêu cầu thứ `reqIndex`. */
const results = (h: ReturnType<typeof makeHarness>, reqIndex: number): ToolResultBlock[] => {
  const msgs = h.provider.requests[reqIndex].messages;
  const last = [...msgs].reverse().find((m) => m.role === 'user' && m.content.some((b) => b.type === 'tool_result'));
  return last ? last.content.filter((b): b is ToolResultBlock => b.type === 'tool_result') : [];
};
const read = (p: string, id?: string) => ({ ...(id ? { id } : {}), name: 'read_file', input: { path: p } });
const write = (p: string, content: string, id?: string) => ({ ...(id ? { id } : {}), name: 'write_file', input: { path: p, content } });
const todo = (items: Array<Partial<TodoItem> & { title: string; status: TodoItem['status'] }>, id = 'td') => toolTurn([{ id, name: 'todo_write', input: { todos: items } }]);

// ─────────────────────────────────────────────────────────────────────────────
// B01/B02 — cạn vòng
// ─────────────────────────────────────────────────────────────────────────────

describe('B01/B02 — còn ≤ 3 vòng thì công cụ khám phá không chạy', () => {
  const FILES = { 'a.txt': 'AAA', 'b.txt': 'BBB', 'c.txt': 'CCC' };

  it('vòng còn 4: đọc được; còn 3 (chưa ghi/chạy gì): một lần đọc ÂN HẠN; còn 2: đọc bị chặn, ghi vẫn được', async () => {
    const h = makeHarness(
      [
        () => toolTurn([read('a.txt', 'r1')]), //           vòng 1 → còn 4
        () => toolTurn([read('b.txt', 'r2')]), //           vòng 2 → còn 3 → ân hạn
        () => toolTurn([read('c.txt', 'r3'), write('out.txt', 'x', 'w1')]), // vòng 3 → còn 2 → đọc chặn, ghi được
        () => textTurn('Đã ghi out.txt. Còn lại: không. Chạy tiếp: không cần.'), // → cổng nhắc kiểm chứng (đã ghi mà chưa chạy gì)
        () => textTurn('Không chạy được kiểm chứng vì hết vòng; tệp out.txt đã ghi, nội dung "x".'),
      ],
      { files: FILES, settings: { maxTurns: 5 } },
    );
    const r = await h.run('làm việc');
    expect(r.stopReason).toBe('end_turn');

    const r1 = results(h, 1)[0];
    expect(r1.isError).toBeFalsy();
    expect(r1.content).toContain('AAA');
    expect(r1.content).not.toContain('[sắp hết ngân sách]');

    const r2 = results(h, 2)[0];
    expect(r2.isError).toBeFalsy();
    expect(r2.content).toContain('BBB');
    expect(r2.content).toContain('[sắp hết ngân sách]'); // ân hạn: vẫn đọc, kèm lời dặn chốt

    const [r3, w1] = results(h, 3);
    expect(r3.isError).toBe(true);
    expect(r3.content).toContain('[hết ngân sách vòng]');
    expect(r3.content).toContain('read_file');
    expect(r3.content).not.toContain('CCC'); // công cụ KHÔNG chạy
    expect(w1.isError).toBeFalsy();
    expect(fs.existsSync(path.join(h.dir, 'out.txt'))).toBe(true);
    // dòng thời gian: lệnh bị chặn hiện là một dòng lỗi (không có kênh riêng)
    expect(eventsOf(h.events, 'tool_end').find((e) => e.callId === 'r3')?.state).toBe('error');
  });

  it('đã ghi/chạy rồi thì không có ân hạn: còn 3 vòng là chặn ngay', async () => {
    const h = makeHarness(
      [() => toolTurn([write('o.txt', 'x', 'w1')]), () => toolTurn([read('a.txt', 'r2')]), () => textTurn('xong')],
      { files: FILES, settings: { maxTurns: 5 } },
    );
    await h.run('x');
    const r2 = results(h, 2)[0];
    expect(r2.isError).toBe(true);
    expect(r2.content).toContain('[hết ngân sách vòng]');
  });

  it('cài đặt agent.budgetGuard = false → không chặn gì', async () => {
    const h = makeHarness([() => toolTurn([read('a.txt', 'r1')]), () => toolTurn([read('b.txt', 'r2')]), () => toolTurn([read('c.txt', 'r3')]), () => textTurn('xong')], {
      files: FILES,
      settings: { maxTurns: 5 },
      hostSettings: { 'agent.budgetGuard': false },
    });
    await h.run('x');
    expect(results(h, 3)[0].content).toContain('CCC');
    expect(JSON.stringify(h.provider.requests)).not.toContain('[hết ngân sách vòng]');
  });

  it('todo_write / remember (không phải khám phá) vẫn chạy khi cạn vòng', async () => {
    const h = makeHarness([() => toolTurn([read('a.txt', 'r1')]), () => toolTurn([read('b.txt', 'r2')]), () => todo([{ title: 'A', status: 'completed' }]), () => textTurn('xong')], {
      files: FILES,
      settings: { maxTurns: 5 },
    });
    await h.run('x');
    expect(results(h, 3)[0].isError).toBeFalsy();
  });

  it('quyết định thuần: ranh giới đúng ở 3, chỉ risk read/network, wrapUp không chặn', () => {
    const base = { enabled: true, wrapUp: false, hasActed: true, graceUsed: false } as const;
    expect(budgetGuardDecision({ ...base, turnsLeft: 4, risk: 'read' })).toBe('allow');
    expect(budgetGuardDecision({ ...base, turnsLeft: 3, risk: 'read' })).toBe('block');
    expect(budgetGuardDecision({ ...base, turnsLeft: 0, risk: 'network' })).toBe('block');
    expect(budgetGuardDecision({ ...base, turnsLeft: 0, risk: 'write' })).toBe('allow');
    expect(budgetGuardDecision({ ...base, turnsLeft: 0, risk: 'exec' })).toBe('allow');
    expect(budgetGuardDecision({ ...base, turnsLeft: 0, risk: 'meta' })).toBe('allow');
    expect(budgetGuardDecision({ ...base, turnsLeft: 0, risk: 'read', wrapUp: true })).toBe('allow');
    expect(budgetGuardDecision({ ...base, turnsLeft: 0, risk: 'read', enabled: false })).toBe('allow');
    expect(budgetGuardDecision({ ...base, turnsLeft: 1, risk: 'read', hasActed: false })).toBe('grace');
    expect(budgetGuardDecision({ ...base, turnsLeft: 1, risk: 'read', hasActed: false, graceUsed: true })).toBe('block');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B03/B10 — nhắc todo: lần 1 trạng thái thật, lần 2 làm khác, lần 3 tự đóng rồi thôi
// ─────────────────────────────────────────────────────────────────────────────

describe('B03/B10 — nhắc todo tối đa 3 lần, lần 3 tự đóng theo vết chạy', () => {
  it('lần 1 kèm trạng thái THẬT ([~]/[ ]); lần 2 yêu cầu làm KHÁC (không lặp lời); lần 3 KHÔNG nhắc mà chốt — đúng 4 lần gọi model', async () => {
    const h = makeHarness([
      () => todo([{ id: 't1', title: 'Viết báo cáo', status: 'in_progress' }, { id: 't2', title: 'Gửi email cho khách', status: 'pending' }]),
      () => textTurn('Xong rồi.'),
      () => textTurn('Xong rồi.'),
      () => textTurn('Xong rồi.'),
    ]);
    const r = await h.run('làm báo cáo và gửi email');
    expect(r.stopReason).toBe('end_turn');
    expect(h.provider.requests).toHaveLength(4);

    const nudges = synthetic(h.session.messages);
    expect(nudges).toHaveLength(2);
    expect(nudges[0]).toMatch(/^\[nhắc lần 1\]/);
    expect(nudges[0]).toContain('[~] Viết báo cáo');
    expect(nudges[0]).toContain('[ ] Gửi email cho khách');
    expect(nudges[1]).toMatch(/^\[nhắc lần 2\]/);
    expect(nudges[1]).toContain('KHÔNG lặp lại câu cũ');
    expect(nudges[1]).toContain('todo_write');
    expect(nudges[1].replace(/^\[nhắc lần 2\]/, '')).not.toBe(nudges[0].replace(/^\[nhắc lần 1\]/, '')); // thật sự khác lời
    // không có vết làm gì → cả hai bị chặn, không đóng giả
    expect(h.session.todos.map((x) => x.status)).toEqual(['blocked', 'blocked']);
    const warns = eventsOf(h.events, 'notice').filter((n) => n.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].text).toContain('Đã nhắc 2 lần');
    expect(warns[0].text).toContain('bị chặn');
  });

  it('lần 3 tự ĐÓNG theo vết chạy: việc có tệp ghi khớp tên → completed, việc không có vết → blocked; giao diện nhận ảnh chụp mới', async () => {
    const h = makeHarness([
      () => todo([{ id: 't1', title: 'Viết báo cáo report.md', status: 'in_progress' }, { id: 't2', title: 'Gửi email cho khách', status: 'pending' }]),
      () => toolTurn([write('report.md', '# Báo cáo\n', 'w1')]),
      () => textTurn('Xong rồi.'), // 1: việc dở
      () => textTurn('Xong rồi.'), // 2: kiểm chứng (đã ghi mà chưa chạy gì)
      () => textTurn('Xong rồi.'), // 3: chốt → tự đóng
    ]);
    const r = await h.run('làm báo cáo và gửi email');
    expect(r.stopReason).toBe('end_turn');
    expect(h.provider.requests).toHaveLength(5);
    expect(synthetic(h.session.messages)).toHaveLength(2);

    // tự đóng: việc có vết ghi tệp khớp tên → completed; việc không có vết → blocked kèm lý do
    const byId = Object.fromEntries(h.session.todos.map((x) => [x.id, x]));
    expect(byId.t1.status).toBe('completed');
    expect(byId.t2.status).toBe('blocked');
    expect(byId.t2.note).toBeTruthy();
    // giao diện nhận ảnh chụp danh sách mới (sự kiện có sẵn, không kênh riêng)
    const tasks = eventsOf(h.events, 'tasks');
    expect(tasks.at(-1)!.todos.map((x) => x.status)).toEqual(['completed', 'blocked']);
    // báo người dùng một lần, nêu đúng việc bị chặn và việc đã đóng
    const warns = eventsOf(h.events, 'notice').filter((n) => n.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].text).toContain('Đã nhắc 2 lần');
    expect(warns[0].text).toContain('Gửi email cho khách');
    expect(warns[0].text).toContain('bị chặn');
    expect(warns[0].text).toContain('Viết báo cáo report.md');
  });

  it('model đặt blocked kèm note qua todo_write: "blocked" là trạng thái thật, cổng KHÔNG nhắc thêm', async () => {
    const h = makeHarness([
      () => todo([{ id: 't1', title: 'Đẩy lên server', status: 'pending' }]),
      () => textTurn('Không đẩy được.'),
      () => todo([{ id: 't1', title: 'Đẩy lên server', status: 'blocked', note: 'thiếu khoá SSH' }], 'td2'),
      () => textTurn('Bị chặn vì thiếu khoá SSH, bạn cấp khoá rồi nhắn tiếp.'),
      () => textTurn('Đã nói rõ ở trên: thiếu khoá SSH.'),
      () => textTurn('Dừng.'),
    ]);
    await h.run('deploy');
    const nudges = synthetic(h.session.messages);
    expect(nudges).toHaveLength(1); // chỉ lần nhắc đầu (lúc còn pending); sau khi blocked thì cổng im
    expect(h.provider.requests).toHaveLength(4);
    expect(h.session.todos[0]).toMatchObject({ status: 'blocked', note: 'thiếu khoá SSH' });
    expect(results(h, 3)[0].content).toContain('1 bị chặn');
  });

  it('autoCloseTodos: khớp bằng chứng qua tên tệp, lệnh đã chạy và từ đồng nghĩa; lệnh lỗi không tính', () => {
    const trace = newTrace();
    trace.calls.push(
      { callId: '1', name: 'write_file', risk: 'write', input: { path: 'docs/huong-dan.md' }, turn: 1, ts: 0, ok: true, resultHead: '' },
      { callId: '2', name: 'run_command', risk: 'exec', input: { command: 'npx vitest run test/a.test.ts' }, turn: 2, ts: 0, ok: true, resultHead: '' },
      { callId: '3', name: 'run_command', risk: 'exec', input: { command: 'npm run build' }, turn: 3, ts: 0, ok: false, resultHead: '' },
    );
    const ev = evidenceTokens(trace);
    expect(hasEvidence('Viết hướng dẫn sử dụng', ev)).toBe(true); // huong-dan ↔ "hướng dẫn" (bỏ dấu)
    expect(hasEvidence('Chạy bộ kiểm thử', ev)).toBe(true); // kiểm thử ↔ vitest/test
    expect(hasEvidence('Dựng bản build', ev)).toBe(false); // lệnh build LỖI → không phải bằng chứng
    expect(hasEvidence('Gửi email khách hàng', ev)).toBe(false);

    const out = autoCloseTodos(
      [
        { id: 'a', title: 'Viết hướng dẫn sử dụng', status: 'in_progress' },
        { id: 'b', title: 'Gửi email khách hàng', status: 'pending' },
        { id: 'c', title: 'Đã xong từ trước', status: 'completed' },
      ],
      trace,
      'vi',
    );
    expect(out.completed).toEqual(['Viết hướng dẫn sử dụng']);
    expect(out.blocked).toEqual(['Gửi email khách hàng']);
    expect(out.todos.map((x) => x.status)).toEqual(['completed', 'blocked', 'completed']);
    expect(out.todos[1].note).toContain('chưa có vết');
  });

  it('phiên cũ (JSON đã lưu) mở được: blocked + note giữ nguyên; trạng thái lạ → pending', () => {
    const raw = { id: 's1', provider: 'fake', model: 'm', messages: [], todos: [{ id: 't1', title: 'A', status: 'blocked', note: 'lý do' }, { id: 't2', title: 'B', status: 'weird' }, { id: 't3', title: 'C', status: 'completed', note: 'bỏ' }] };
    const s = migrateSession(raw)!.session;
    expect(s.todos).toEqual([
      { id: 't1', title: 'A', status: 'blocked', note: 'lý do' },
      { id: 't2', title: 'B', status: 'pending' },
      { id: 't3', title: 'C', status: 'completed' },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B05 — câu trả lời cuối tự đứng
// ─────────────────────────────────────────────────────────────────────────────

describe('B05 — câu trả lời cuối phải tự đứng được', () => {
  const SIX_READS = () => toolTurn(['a', 'b', 'c', 'd', 'e', 'f'].map((n, i) => read(`${n}.txt`, `r${i}`)));
  const FILES = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((n) => [`${n}.txt`, n]));

  it('sau lượt dài, "Chi tiết ở trên." → nhắc MỘT lần viết lại đầy đủ; câu trả lời đủ thì dừng', async () => {
    const h = makeHarness([() => SIX_READS(), () => textTurn('Chi tiết ở trên.'), () => textTurn('Kết quả: 6 tệp đọc xong.\n- a: a\n- b: b\n- c: c\nKhông còn việc gì.')], { files: FILES });
    const r = await h.run('đọc hết');
    expect(r.stopReason).toBe('end_turn');
    expect(h.provider.requests).toHaveLength(3);
    const nudges = synthetic(h.session.messages);
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toMatch(/^\[nhắc lần 1\] .*tự đứng được/);
  });

  it('câu quá ngắn sau ≥ 6 lệnh công cụ cũng bị nhắc; câu ngắn sau lượt ngắn thì không', async () => {
    const h = makeHarness([() => SIX_READS(), () => textTurn('Xong.'), () => textTurn('Đã đọc 6 tệp: a, b, c, d, e, f — nội dung mỗi tệp là một chữ cái trùng tên.')], { files: FILES });
    await h.run('x');
    expect(synthetic(h.session.messages)).toHaveLength(1);

    const h2 = makeHarness([() => toolTurn([read('a.txt')]), () => textTurn('Xong.')], { files: FILES });
    await h2.run('x');
    expect(synthetic(h2.session.messages)).toHaveLength(0);
  });

  it('tính CHUNG ngân sách nhắc: việc dở + trỏ lên trên → tổng vẫn 2 nhắc + 1 chốt, không bao giờ quá 3 can thiệp', async () => {
    const h = makeHarness([
      () => SIX_READS(),
      () => todo([{ id: 't1', title: 'Tổng hợp kết quả', status: 'pending' }]),
      () => textTurn('Như đã nói ở trên.'), // 1: việc dở
      () => textTurn('Như đã nói ở trên.'), // 2: câu cuối không tự đứng
      () => textTurn('Như đã nói ở trên.'), // 3: chốt (không nhắc)
    ], { files: FILES });
    await h.run('x');
    expect(h.provider.requests).toHaveLength(5);
    const nudges = synthetic(h.session.messages);
    expect(nudges.map((s) => /^\[nhắc lần (\d)\]/.exec(s)?.[1])).toEqual(['1', '2']);
    expect(nudges[1]).toContain('tự đứng được');
    expect(eventsOf(h.events, 'notice').filter((n) => n.level === 'warn')).toHaveLength(1);
  });

  it('bộ phát hiện thuần: cụm trỏ vi/en, ngưỡng số lệnh, câu dài có bảng/danh sách thì không bắt', () => {
    expect(finalAnswerProblem('Chi tiết ở trên.', 2)).toBe('pointer');
    expect(finalAnswerProblem('Xem phần Worked for.', 2)).toBe('pointer');
    expect(finalAnswerProblem('See above for details.', 2)).toBe('pointer');
    expect(finalAnswerProblem('As mentioned earlier, done.', 3)).toBe('pointer');
    expect(finalAnswerProblem('Chi tiết ở trên.', 1)).toBeNull(); // chưa đủ lệnh công cụ để "ở trên" có nghĩa
    expect(finalAnswerProblem('Xong.', 6)).toBe('short');
    expect(finalAnswerProblem('Xong.', 5)).toBeNull();
    expect(finalAnswerProblem('- a\n- b', 6)).toBeNull(); // danh sách = có nội dung
    expect(finalAnswerProblem('Như đã nói ở trên, bảng:\n' + '| a | b |\n'.repeat(80), 6)).toBeNull();
    expect(finalAnswerProblem('', 10)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B06 — kiểm tra shell qua móc toolBefore (kho lệnh ở test/shellCheck.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

describe('B06 — run_command được kiểm tra theo shell thật của host', () => {
  const asPs51 = (h: ReturnType<typeof makeHarness>) => {
    (h.host as unknown as { platform: unknown }).platform = { os: 'windows', shell: 'powershell', shellLabel: 'Windows PowerShell 5.1' };
  };

  it('&& phức tạp (trộn ||) → bị CHẶN kèm hướng dẫn, không chạy', async () => {
    const h = makeHarness([() => toolTurn([{ id: 'c1', name: 'run_command', input: { command: 'npm test && echo ok || echo fail' } }]), () => textTurn('ok')]);
    asPs51(h);
    await h.run('x');
    const r = results(h, 1)[0];
    expect(r.isError).toBe(true);
    expect(r.content).toContain('[kiểm tra shell]');
    expect(r.content).toContain('CHƯA chạy');
    expect(h.permissionRequests).toHaveLength(0); // chặn TRƯỚC khi hỏi quyền
  });

  // Các ca dưới TỪ CHỐI quyền để không spawn shell thật (Windows PowerShell khởi động chậm làm test quá hạn dưới tải): điều cần chứng minh là
  // lệnh đã được viết lại TRƯỚC khi hỏi quyền — giao diện (tool_start) và thẻ xin quyền đều thấy lệnh mới.
  it('&& đơn giản → viết lại thành `; if ($?) { … }` TRƯỚC khi hỏi quyền; giao diện và thẻ quyền thấy lệnh đã viết lại', async () => {
    const h = makeHarness([() => toolTurn([{ id: 'c1', name: 'run_command', input: { command: 'echo a && echo b' } }]), () => textTurn('ok')], { decide: () => 'deny' });
    asPs51(h);
    await h.run('x');
    const starts = eventsOf(h.events, 'tool_start').filter((e) => e.callId === 'c1');
    expect(starts.at(-1)!.args.command).toBe('echo a; if ($?) { echo b }');
    expect(h.permissionRequests).toHaveLength(1);
    expect(h.permissionRequests[0].command).toBe('echo a; if ($?) { echo b }');
    expect(results(h, 1)[0].isError).toBe(true); // bị từ chối, không chạy
  });

  it('chế độ hint: lệnh gốc giữ nguyên tới thẻ quyền', async () => {
    const h = makeHarness([() => toolTurn([{ id: 'c1', name: 'run_command', input: { command: 'echo a && echo b' } }]), () => textTurn('ok')], { hostSettings: { 'agent.shellCheck': 'hint' }, decide: () => 'deny' });
    asPs51(h);
    await h.run('x');
    expect(eventsOf(h.events, 'tool_start').at(-1)!.args.command).toBe('echo a && echo b');
    expect(h.permissionRequests[0].command).toBe('echo a && echo b');
  });

  it('chế độ off: && phức tạp cũng không bị chặn (đi tới thẻ quyền như cũ)', async () => {
    const h = makeHarness([() => toolTurn([{ id: 'c1', name: 'run_command', input: { command: 'npm test && echo ok || echo fail' } }]), () => textTurn('ok')], { hostSettings: { 'agent.shellCheck': 'off' }, decide: () => 'deny' });
    asPs51(h);
    await h.run('x');
    expect(h.permissionRequests).toHaveLength(1);
    expect(results(h, 1)[0].content).not.toContain('[kiểm tra shell]');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B07 — phá vòng lặp theo kết quả
// ─────────────────────────────────────────────────────────────────────────────

describe('B07 — cùng công cụ, kết quả y hệt dù đối số hơi khác', () => {
  const glob = (p: string | undefined, id: string) => ({ id, name: 'glob', input: { pattern: '*.txt', ...(p !== undefined ? { path: p } : {}) } });

  it('lần 3 cùng kết quả → nối ghi chú [phá vòng lặp]; lần 4 gần y hệt → chặn; sau khi ghi tệp → chuỗi được xoá', async () => {
    const h = makeHarness(
      [
        () => toolTurn([glob('.', 'g1')]),
        () => toolTurn([glob('./', 'g2')]),
        () => toolTurn([glob(undefined, 'g3')]),
        () => toolTurn([glob('.', 'g4')]),
        () => toolTurn([write('new.txt', 'x', 'w1')]),
        () => toolTurn([glob('.', 'g5')]),
        () => textTurn('xong'),
      ],
      { files: { 'a.txt': '1', 'b.txt': '2' } },
    );
    await h.run('tìm');
    expect(results(h, 1)[0].content).not.toContain('[phá vòng lặp]');
    expect(results(h, 2)[0].content).not.toContain('[phá vòng lặp]');
    const third = results(h, 3)[0];
    expect(third.isError).toBeFalsy();
    expect(third.content).toContain('a.txt'); // vẫn chạy, chỉ thêm ghi chú
    expect(third.content).toContain('[phá vòng lặp] glob đã trả cùng một kết quả 3 lần');
    const fourth = results(h, 4)[0];
    expect(fourth.isError).toBe(true);
    expect(fourth.content).toContain('[phá vòng lặp] Không chạy');
    expect(fourth.content).not.toContain('a.txt');
    // ghi tệp → thế giới đổi → glob lại là chính đáng
    const fifth = results(h, 6)[0];
    expect(fifth.isError).toBeFalsy();
    expect(fifth.content).toContain('new.txt');
    expect(fifth.content).not.toContain('[phá vòng lặp]');
  });

  it('cài đặt agent.loopBreaker = false → không ghi chú, không chặn', async () => {
    const h = makeHarness([() => toolTurn([glob('.', 'g1')]), () => toolTurn([glob('./', 'g2')]), () => toolTurn([glob(undefined, 'g3')]), () => toolTurn([glob('.', 'g4')]), () => textTurn('xong')], {
      files: { 'a.txt': '1' },
      hostSettings: { 'agent.loopBreaker': false },
    });
    await h.run('x');
    expect(results(h, 4)[0].isError).toBeFalsy();
    expect(JSON.stringify(h.provider.requests)).not.toContain('[phá vòng lặp]');
  });

  it('todo_write lặp lại là bình thường: không bao giờ bị tính vòng lặp', async () => {
    const same = () => todo([{ id: 't1', title: 'A', status: 'in_progress' }]);
    const h = makeHarness([same, same, same, same, () => todo([{ id: 't1', title: 'A', status: 'completed' }]), () => textTurn('xong')]);
    await h.run('x');
    for (let i = 1; i <= 4; i++) expect(results(h, i)[0].isError).toBeFalsy();
  });

  it('LoopTracker: chuẩn hoá bỏ thời gian/dấu thời gian; đối số khác xa thì không chặn; kết quả khác thì chuỗi đứt', () => {
    expect(normalizeOutput('Done in 1.2s at 2026-11-07T10:00:00Z')).toBe(normalizeOutput('Done in 3.9s at 2026-11-07T10:05:12Z'));
    expect(similarity('pattern:*.txt,path:.', 'pattern:*.txt,path:./')).toBeGreaterThan(0.8);
    expect(similarity('path:src/a.ts', 'path:docs/readme-long-file-name.md')).toBeLessThan(0.6);
    const t = new LoopTracker();
    expect(t.record('x', { a: 1 }, 'same', false)).toBe(1);
    expect(t.record('x', { a: 2 }, 'same', false)).toBe(2);
    expect(t.record('x', { a: 3 }, 'same', false)).toBe(3);
    expect(t.shouldBlock('x', { a: 3 })).toBe(true); // y hệt
    expect(t.shouldBlock('x', { completely: 'different-and-much-longer-arguments-here' })).toBe(false);
    expect(t.shouldBlock('y', { a: 3 })).toBe(false);
    const t2 = new LoopTracker();
    for (const p of ['src/app.ts', 'src/app.ts ', './src/app.ts']) t2.record('read_file', { path: p }, 'same content', false);
    expect(t2.shouldBlock('read_file', { path: 'src/app.ts' })).toBe(true); // hơi khác
    expect(t2.shouldBlock('read_file', { path: 'docs/README-rat-dai.md' })).toBe(false); // khác hẳn
    expect(t.record('x', { a: 4 }, 'different', false)).toBe(1); // kết quả khác → chuỗi đứt
    expect(t.shouldBlock('x', { a: 4 })).toBe(false);
    t.record('x', {}, 'e', true);
    t.record('x', {}, 'e', true);
    t.record('x', {}, 'e', true);
    t.reset();
    expect(t.shouldBlock('x', {})).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B09 — JSON đối số
// ─────────────────────────────────────────────────────────────────────────────

describe('B09 — sửa nhẹ JSON đối số khi không mơ hồ', () => {
  it('hàm thuần: dấu phẩy thừa, xuống dòng thật trong chuỗi, thiếu ngoặc cuối (chỉ khi được phép)', () => {
    expect(stripTrailingCommas('{"a":1,}')).toBe('{"a":1}');
    expect(stripTrailingCommas('{"a":[1,2,],}')).toBe('{"a":[1,2]}');
    expect(stripTrailingCommas('{"a":"x,}"}')).toBe('{"a":"x,}"}'); // trong chuỗi: giữ nguyên
    expect(escapeRawControlChars('{"c":"l1\nl2\t"}')).toBe('{"c":"l1\\nl2\\t"}');
    expect(escapeRawControlChars('{"c":"ok"}\n')).toBe('{"c":"ok"}\n'); // ngoài chuỗi: giữ
    expect(closeOpenBrackets('{"a":{"b":[1,2')).toBe('{"a":{"b":[1,2]}}');
    expect(closeOpenBrackets('{"a":"cut')).toBeNull(); // đang ở giữa chuỗi → không đoán
    expect(closeOpenBrackets('{"a":')).toBeNull();
    expect(repairJsonArgs('{"path":"a.txt",}', { allowClose: false })).toEqual({ path: 'a.txt' });
    expect(repairJsonArgs('{"path":"a.txt","content":"x\ny"}', { allowClose: false })).toEqual({ path: 'a.txt', content: 'x\ny' });
    expect(repairJsonArgs('{"path":"a.txt"', { allowClose: true })).toEqual({ path: 'a.txt' });
    expect(repairJsonArgs('{"path":"a.txt"', { allowClose: false })).toBeNull();
    expect(repairJsonArgs('[1,2]', { allowClose: true })).toBeNull(); // không phải object
    expect(repairJsonArgs('not json', { allowClose: true })).toBeNull();
  });

  it('engine: dấu phẩy thừa → sửa và chạy; xuống dòng thật trong content → ghi đúng tệp', async () => {
    const h = makeHarness(
      [
        () => toolTurn([{ id: 'r1', name: 'read_file', input: {}, rawArgs: '{"path":"a.txt",}' }]),
        () => toolTurn([{ id: 'w1', name: 'write_file', input: {}, rawArgs: '{"path":"o.txt","content":"dòng 1\ndòng 2"}' }]),
        () => textTurn('xong'),
      ],
      { files: { 'a.txt': 'AAA' } },
    );
    await h.run('x');
    expect(results(h, 1)[0].isError).toBeFalsy();
    expect(results(h, 1)[0].content).toContain('AAA');
    expect(results(h, 2)[0].isError).toBeFalsy();
    expect(fs.readFileSync(path.join(h.dir, 'o.txt'), 'utf8')).toBe('dòng 1\ndòng 2');
  });

  it('engine: chạm trần đầu ra (max_tokens) → KHÔNG BAO GIỜ sửa nội dung cụt; lần hỏng thứ 2 liên tiếp có hướng dẫn mạnh hơn', async () => {
    const h = makeHarness(
      [
        () => toolTurn([{ id: 'w1', name: 'write_file', input: {}, rawArgs: '{"path":"o.txt","content":"abc' }], { stopReason: 'max_tokens' }),
        () => toolTurn([{ id: 'w2', name: 'write_file', input: {}, rawArgs: '{"path":"o.txt","content":"abc' }], { stopReason: 'max_tokens' }),
        () => textTurn('kẹt'),
      ],
      {},
    );
    await h.run('x');
    const first = results(h, 1)[0];
    expect(first.isError).toBe(true);
    expect(first.content).toContain('write_file');
    expect(first.content).toContain('nội dung thô');
    expect(first.content).not.toContain('lần thứ 2');
    expect(fs.existsSync(path.join(h.dir, 'o.txt'))).toBe(false);
    const second = results(h, 2)[0];
    expect(second.content).toContain('lần thứ 2 liên tiếp');
    expect(second.content).toContain('BẮT BUỘC');
  });

  it('repairToolArgs: bộ đếm về 0 khi một lượt không có lỗi JSON; lệnh không phải lệnh cuối vẫn được sửa khi max_tokens (trừ đóng ngoặc)', () => {
    const state = { streak: 2 };
    const calls = [
      { type: 'tool_use' as const, id: '1', name: 'read_file', input: {}, parseError: 'x', rawArgs: '{"path":"a",}' },
      { type: 'tool_use' as const, id: '2', name: 'read_file', input: {}, parseError: 'cụt', rawArgs: '{"path":"b' },
    ];
    repairToolArgs(calls, 'max_tokens', state, 'vi');
    expect(calls[0].parseError).toBeUndefined();
    expect(calls[0].input).toEqual({ path: 'a' });
    expect(calls[1].parseError).toContain('cụt');
    expect(state.streak).toBe(3);
    repairToolArgs([{ type: 'tool_use' as const, id: '3', name: 'read_file', input: { path: 'ok' } }], 'tool_use', state, 'vi');
    expect(state.streak).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Skill đóng gói + Remote
// ─────────────────────────────────────────────────────────────────────────────

describe('skill ky-luat-agent và Remote', () => {
  it('skill ky-luat-agent đóng gói sẵn, dùng được với mọi nhà cung cấp, KHÔNG tự nạp', async () => {
    const r = new SkillRegistry(builtinSkills());
    for (const p of ['locaith', 'anthropic', 'openai', 'deepseek']) expect(r.get('ky-luat-agent', p), p).toBeDefined();
    const def = r.get('ky-luat-agent', 'locaith')!;
    expect(def.description).toMatch(/vòng/);
    expect(def.tags).toContain('todo_write');
    expect(r.search('hết vòng chốt việc shell PowerShell', 5, 'locaith').map((s) => s.name)).toContain('ky-luat-agent');
    const h = makeHarness([() => textTurn('chào')]);
    await h.run('chào');
    expect(h.session.loadedSkills).toEqual([]);
    expect(h.provider.requests[0].system).not.toContain('Kỷ luật làm việc khi phiên đã dài');
  });

  it('skill nói đúng về trạng thái blocked và việc harness tự đóng ở lần 3', () => {
    const raw = fs.readFileSync(path.resolve(__dirname, '../skills/ky-luat-agent/SKILL.md'), 'utf8');
    expect(raw).toMatch(/^---\nname: ky-luat-agent\n/);
    expect(raw).toContain('status: "blocked"');
    expect(raw).toContain('[kiểm tra shell]');
  });

  it('Remote: trạng thái blocked hạ cấp về pending + lý do vào tiêu đề (reducer cũ không hỏng); note bị cắt', () => {
    const todos: TodoItem[] = [
      { id: 't1', title: 'A', status: 'blocked', note: 'x'.repeat(500) },
      { id: 't2', title: 'B', status: 'in_progress' },
    ];
    const out = sanitizeTodos(todos);
    expect(out[0].status).toBe('pending');
    expect(out[0].title.startsWith('A — xxx')).toBe(true);
    expect(out[0].title.length).toBeLessThan(260);
    expect((out[0] as { note?: string }).note).toBeUndefined();
    expect(out[1]).toEqual({ id: 't2', title: 'B', status: 'in_progress' });
    expect(JSON.stringify(sanitizeEvent({ t: 'tasks', id: 'a', todos, added: [] }))).not.toContain('blocked');
    expect(JSON.stringify(sanitizeEvent({ t: 'todos', todos }))).not.toContain('blocked');
    const view = { transcript: [], todos, running: false, provider: 'p', model: 'm', mode: 'default', thinkingLevel: 'medium', sessionId: 's', title: 't', queued: [], providers: [], sessions: [] } as unknown as ViewState;
    expect(JSON.stringify(toRemoteState(view, { name: 'PC', vscode: '1', ext: '1', platform: 'win32' }, { canBypass: false }).todos)).not.toContain('blocked');
  });
});
