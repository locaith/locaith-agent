import { describe, expect, it } from 'vitest';
import type { ToolResultBlock } from '../src/core/types';
import { completionGateExtension } from '../src/core/engine/extensions/gate';
import { coreRunExtensions } from '../src/core/engine/extensions';
import type { RunExtension, RunHooks, RunScope } from '../src/core/engine/seams';
import { eventsOf, makeHarness } from './helpers/harness';
import { textTurn, toolTurn } from './helpers/fakeProvider';

/** Extension thử: ghi lại mọi cuộc gọi móc để test kiểm tra thứ tự và nội dung. */
function probe(id: string, hooks: (scope: RunScope, log: string[]) => RunHooks, log: string[] = []): RunExtension & { log: string[] } {
  return { id, log, begin: (scope) => hooks(scope, log) };
}

const toolResults = (h: ReturnType<typeof makeHarness>, reqIndex: number): ToolResultBlock[] =>
  h.provider.requests[reqIndex].messages.flatMap((m) => m.content.filter((b): b is ToolResultBlock => b.type === 'tool_result'));

describe('seams — RunExtension', () => {
  it('beforeModel: chữ trả về được nối vào lịch sử và LƯU lại', async () => {
    const ext = probe('note', (_s, log) => ({
      beforeModel(turn) {
        log.push(`before:${turn.turn}`);
        return turn.turn === 2 ? ['[ghi chú từ extension]'] : undefined;
      },
    }));
    const h = makeHarness([() => toolTurn([{ name: 'read_file', input: { path: 'a.txt' } }]), () => textTurn('xong')], {
      files: { 'a.txt': 'x' },
      engineDeps: { extensions: [...coreRunExtensions(), ext] },
    });
    await h.run('đọc a.txt');
    expect(ext.log).toEqual(['before:1', 'before:2']);
    const second = JSON.stringify(h.provider.requests[1].messages);
    expect(second).toContain('[ghi chú từ extension]');
    // đi chung tin nhắn kết quả công cụ (giữ xen kẽ vai trò), không thành tin người dùng thứ hai liền kề
    const roles = h.provider.requests[1].messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'user']);
    expect(JSON.stringify(h.session.messages)).toContain('[ghi chú từ extension]');
  });

  it('toolBefore: chặn công cụ → tool_result lỗi, công cụ KHÔNG chạy', async () => {
    const ext = probe('deny', () => ({
      toolBefore(call) {
        if (call.name === 'write_file') return { block: 'Bị chặn bởi extension thử' };
      },
    }));
    const h = makeHarness([() => toolTurn([{ name: 'write_file', input: { path: 'out.txt', content: 'hi' } }]), () => textTurn('ok')], {
      engineDeps: { extensions: [...coreRunExtensions(), ext] },
    });
    await h.run('ghi');
    const r = toolResults(h, 1)[0];
    expect(r.isError).toBe(true);
    expect(r.content).toContain('Bị chặn bởi extension thử');
    const { existsSync } = await import('node:fs');
    expect(existsSync(h.dir + '/out.txt')).toBe(false);
    expect(eventsOf(h.events, 'tool_end')[0].state).toBe('error');
  });

  it('toolBefore: sửa đối số → công cụ chạy với đối số mới (được kiểm tra lại theo schema)', async () => {
    const ext = probe('rewrite', () => ({
      toolBefore(call) {
        if (call.name === 'read_file') return { input: { path: 'b.txt' }, note: '(đã chuyển sang b.txt)' };
      },
    }));
    const h = makeHarness([() => toolTurn([{ name: 'read_file', input: { path: 'a.txt' } }]), () => textTurn('ok')], {
      files: { 'a.txt': 'AAA', 'b.txt': 'BBB' },
      engineDeps: { extensions: [...coreRunExtensions(), ext] },
    });
    await h.run('đọc');
    const r = toolResults(h, 1)[0];
    expect(r.content).toContain('BBB');
    expect(r.content).not.toContain('AAA');
    expect(r.content).toContain('(đã chuyển sang b.txt)');
  });

  it('toolBefore: đối số sửa sai schema → lỗi rõ ràng, không chạy', async () => {
    const ext = probe('bad', () => ({
      toolBefore(call) {
        if (call.name === 'read_file') return { input: { path: 123 as unknown as string, offset: 'abc' } };
      },
    }));
    const h = makeHarness([() => toolTurn([{ name: 'read_file', input: { path: 'a.txt' } }]), () => textTurn('ok')], {
      files: { 'a.txt': 'AAA' },
      engineDeps: { extensions: [...coreRunExtensions(), ext] },
    });
    await h.run('đọc');
    expect(toolResults(h, 1)[0].isError).toBe(true);
  });

  it('toolAfter: sửa được kết quả mà model nhìn thấy', async () => {
    const ext = probe('after', () => ({
      toolAfter(_call, _def, _ctx, result) {
        return { ...result, content: result.content + '\n[PostTool: ghi chú thêm]' };
      },
    }));
    const h = makeHarness([() => toolTurn([{ name: 'read_file', input: { path: 'a.txt' } }]), () => textTurn('ok')], {
      files: { 'a.txt': 'AAA' },
      engineDeps: { extensions: [...coreRunExtensions(), ext] },
    });
    await h.run('đọc');
    expect(toolResults(h, 1)[0].content).toContain('[PostTool: ghi chú thêm]');
  });

  it('finalize: continue buộc model làm tiếp, rồi accept thì dừng', async () => {
    let asked = 0;
    const ext = probe('more', () => ({
      finalize(ctx) {
        asked++;
        return asked === 1 ? { action: 'continue', message: '[kiểm tra] còn thiếu mục 2', reason: 'test' } : { action: 'accept' };
      },
    }));
    const h = makeHarness([() => textTurn('xong rồi'), () => textTurn('đã bổ sung mục 2')], {
      engineDeps: { extensions: [...coreRunExtensions(), ext] },
    });
    const r = await h.run('làm việc');
    expect(r.turns).toBe(2);
    expect(JSON.stringify(h.provider.requests[1].messages)).toContain('[kiểm tra] còn thiếu mục 2');
    expect(h.session.messages.filter((m) => m.synthetic).length).toBe(1);
  });

  it('finalize: halt kết thúc ngay kèm thông báo', async () => {
    const ext = probe('halt', () => ({ finalize: () => ({ action: 'halt', notice: { level: 'warn', text: 'dừng bởi extension' } }) }));
    const h = makeHarness([() => textTurn('xong'), () => textTurn('KHÔNG ĐƯỢC TỚI ĐÂY')], {
      engineDeps: { extensions: [...coreRunExtensions(), ext] },
    });
    const r = await h.run('x');
    expect(r.turns).toBe(1);
    expect(eventsOf(h.events, 'notice').some((n) => n.text === 'dừng bởi extension')).toBe(true);
  });

  it('finalize: extension đầu tiên khác accept thắng; các extension sau không bị gọi', async () => {
    const calls: string[] = [];
    const a = probe('a', () => ({ finalize: () => (calls.push('a'), { action: 'accept' as const }) }));
    const b = probe('b', () => ({ finalize: () => (calls.push('b'), { action: 'halt' as const }) }));
    const c = probe('c', () => ({ finalize: () => (calls.push('c'), { action: 'accept' as const }) }));
    const h = makeHarness([() => textTurn('xong')], { engineDeps: { extensions: [a, b, c] } });
    await h.run('x');
    expect(calls).toEqual(['a', 'b']);
  });

  it('ngoại lệ trong một móc KHÔNG làm hỏng lần chạy', async () => {
    const boom = probe('boom', () => ({
      beforeModel() {
        throw new Error('nổ beforeModel');
      },
      toolBefore() {
        throw new Error('nổ toolBefore');
      },
      toolAfter() {
        throw new Error('nổ toolAfter');
      },
      finalize() {
        throw new Error('nổ finalize');
      },
      end() {
        throw new Error('nổ end');
      },
    }));
    const throwingBegin: RunExtension = {
      id: 'begin-boom',
      begin() {
        throw new Error('nổ begin');
      },
    };
    const h = makeHarness([() => toolTurn([{ name: 'read_file', input: { path: 'a.txt' } }]), () => textTurn('xong')], {
      files: { 'a.txt': 'AAA' },
      engineDeps: { extensions: [throwingBegin, boom] },
    });
    const r = await h.run('đọc');
    expect(r.stopReason).toBe('end_turn');
    expect(toolResults(h, 1)[0].content).toContain('AAA');
  });

  it('end: được gọi với lý do dừng khi kết thúc bình thường và khi bị Dừng', async () => {
    const seen: string[] = [];
    const ext = probe('end', () => ({ end: (info) => void seen.push(`${info.stopReason}/${info.turns}`) }));
    const h = makeHarness([() => textTurn('xong')], { engineDeps: { extensions: [ext] } });
    await h.run('x');
    expect(seen).toEqual(['end_turn/1']);

    const ac = new AbortController();
    const h2 = makeHarness([() => { ac.abort(); return textTurn('xong'); }], { engineDeps: { extensions: [ext] } });
    await h2.run('x', ac.signal);
    expect(seen.length).toBe(2);
    expect(seen[1].startsWith('aborted/')).toBe(true);
  });

  it('trace: ghi nhận lệnh gọi công cụ đã hoàn tất, đường dẫn đã ghi, wrote/execs', async () => {
    let snap: { wrote: boolean; execs: number; names: string[]; written: string[] } | null = null;
    const ext = probe('trace', (scope) => ({
      end() {
        snap = { wrote: scope.trace.wrote, execs: scope.trace.execs, names: scope.trace.calls.map((c) => c.name), written: scope.trace.writtenPaths() };
      },
    }));
    const h = makeHarness(
      [
        () => toolTurn([{ name: 'write_file', input: { path: 'out.txt', content: 'hi' } }]),
        () => toolTurn([{ name: 'read_file', input: { path: 'out.txt' } }]),
        () => textTurn('xong'),
      ],
      { engineDeps: { extensions: [ext] } },
    );
    await h.run('ghi rồi đọc');
    expect(snap).not.toBeNull();
    expect(snap!.wrote).toBe(true);
    expect(snap!.names).toEqual(['write_file', 'read_file']);
    expect(snap!.written).toEqual(['out.txt']);
  });

  it('queuedTurn: gọi khi tin xếp hàng được nhận làm lượt kế tiếp của cùng lần chạy', async () => {
    let queuedCalls = 0;
    const ext = probe('q', () => ({ queuedTurn: () => void queuedCalls++ }));
    let delivered = false;
    const h = makeHarness([() => textTurn('xong việc 1'), () => textTurn('xong việc 2')], {
      engineDeps: { extensions: [ext] },
      takeQueued: () => {
        if (delivered) return [];
        delivered = true;
        return [{ id: 'q1', text: 'việc 2', display: [], content: [{ type: 'text', text: 'việc 2' }], ts: Date.now() }];
      },
    });
    await h.run('việc 1');
    expect(queuedCalls).toBe(1);
  });

  it('mặc định (không truyền extensions): cổng hoàn thành vẫn hoạt động', async () => {
    const h = makeHarness([
      () => toolTurn([{ name: 'todo_write', input: { todos: [{ id: 't1', title: 'Việc dở', status: 'pending' }] } }]),
      () => textTurn('xong'),
      () => textTurn('xong thật'),
    ]);
    await h.run('x');
    // lượt thứ 2 kết thúc khi còn việc dở → cổng nhắc → lượt 3 mới được kết thúc
    expect(h.provider.requests.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(h.provider.requests[2].messages)).toContain('[nhắc lần 1]');
  });

  it('completionGateExtension: tới lần thứ max thì thôi nhắc và báo người dùng', async () => {
    const h = makeHarness(
      [
        () => toolTurn([{ name: 'todo_write', input: { todos: [{ id: 't1', title: 'Việc dở', status: 'pending' }] } }]),
        () => textTurn('xong 1'),
        () => textTurn('xong 2'),
        () => textTurn('xong 3'),
        () => textTurn('KHÔNG ĐƯỢC TỚI ĐÂY'),
      ],
      { engineDeps: { extensions: [completionGateExtension(3)] } },
    );
    await h.run('x');
    expect(h.provider.requests.length).toBe(4);
    expect(eventsOf(h.events, 'notice').some((n) => n.level === 'warn' && /Việc dở/.test(n.text))).toBe(true);
  });
});
