import { describe, expect, it } from 'vitest';
import '../../src/cli/strings';
import { parseArgs } from '../../src/cli/args';
import { buildPrompt, runPrint, type PrintDeps } from '../../src/cli/print';
import type { CliRuntime, RuntimeEvent, RuntimeOptions, RuntimeStatus } from '../../src/cli/runtime/contract';
import type { UiEvent } from '../../src/shared/protocol';

function status(over: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    version: 't',
    cwd: '/w',
    provider: 'locaith',
    model: 'locaith-v5-flash',
    mode: 'default',
    thinking: 'medium',
    context: { tokens: 0, window: 1_000_000, percent: 0 },
    usage: { input: 1200, output: 340 },
    running: false,
    queued: [],
    sessionId: 'sess-1',
    title: '',
    todos: [],
    bgTasks: { running: 0, total: 0 },
    notices: [],
    ...over,
  } as RuntimeStatus;
}

/** Runtime giả: submit() phát chuỗi UiEvent do kịch bản cho trước. */
function fakeRuntime(script: UiEvent[], st: Partial<RuntimeStatus> = {}): { rt: CliRuntime; opts: RuntimeOptions[]; submitted: string[]; disposed: () => boolean } {
  const listeners = new Set<(e: RuntimeEvent) => void>();
  const submitted: string[] = [];
  let disposed = false;
  const rt = {
    on: (l: (e: RuntimeEvent) => void) => (listeners.add(l), () => listeners.delete(l)),
    status: () => status(st),
    submit: async (text: string) => {
      submitted.push(text);
      for (const ev of script) for (const l of listeners) l({ t: 'ui', ev });
    },
    idle: async () => undefined,
    interrupt: () => undefined,
    dispose: async () => {
      disposed = true;
    },
  } as unknown as CliRuntime;
  return { rt, opts: [], submitted, disposed: () => disposed };
}

function deps(rt: CliRuntime, over: Partial<PrintDeps> = {}): { d: PrintDeps; out: string[]; err: string[]; created: RuntimeOptions[] } {
  const out: string[] = [];
  const err: string[] = [];
  const created: RuntimeOptions[] = [];
  const d: PrintDeps = {
    createRuntime: async (o) => (created.push(o), rt),
    readStdin: async () => '',
    stdinPiped: false,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    version: '0.4.0',
    isTrusted: () => true,
    lang: 'vi',
    ...over,
  };
  return { d, out, err, created };
}

const happy: UiEvent[] = [
  { t: 'assistant_start', id: 'a1', provider: 'locaith', model: 'm', ts: 1 },
  { t: 'text', id: 'a1', delta: 'Xin ' },
  { t: 'tool_start', id: 'a1', callId: 'c1', name: 'read_file', args: { path: 'a.ts' } },
  { t: 'tool_end', id: 'a1', callId: 'c1', state: 'done', summary: 'Đọc 3 dòng', output: 'x', durationMs: 5 },
  { t: 'assistant_start', id: 'a2', provider: 'locaith', model: 'm', ts: 2 },
  { t: 'text', id: 'a2', delta: 'chào ' },
  { t: 'text', id: 'a2', delta: 'bạn' },
  { t: 'assistant_end', id: 'a2', stopReason: 'end_turn' },
];

describe('buildPrompt', () => {
  it('ghép đối số và stdin', () => {
    expect(buildPrompt('tóm tắt', 'log dài\n')).toBe('tóm tắt\n\n---\nlog dài');
    expect(buildPrompt(undefined, 'chỉ stdin\n')).toBe('chỉ stdin');
    expect(buildPrompt('chỉ đối số', '')).toBe('chỉ đối số');
    expect(buildPrompt(' ', '')).toBeUndefined();
  });
});

describe('runPrint', () => {
  it('text: chỉ câu trả lời cuối ra stdout, thống kê ra stderr, mã 0', async () => {
    const f = fakeRuntime(happy);
    const { d, out, err, created } = deps(f.rt);
    const code = await runPrint(parseArgs(['-p', 'chào']), d);
    expect(code).toBe(0);
    expect(out).toEqual(['chào bạn']);
    expect(err.join('\n')).toMatch(/2 vòng · 1540 token/);
    expect(f.submitted).toEqual(['chào']);
    expect(created[0]).toMatchObject({ interactive: false, version: '0.4.0', trusted: true, timeoutSec: 900 });
    expect(f.disposed()).toBe(true);
  });

  it('json: có cả khoá mới (result, usage…) và khoá cũ 0.3.x (ok, text, turns…)', async () => {
    const f = fakeRuntime(happy);
    const { d, out } = deps(f.rt);
    const code = await runPrint(parseArgs(['-p', '--output-format', 'json', 'chào']), d);
    expect(code).toBe(0);
    const j = JSON.parse(out.join('\n'));
    expect(j).toMatchObject({ type: 'result', subtype: 'success', is_error: false, result: 'chào bạn', num_turns: 2, session_id: 'sess-1', usage: { input_tokens: 1200, output_tokens: 340 } });
    expect(j).toMatchObject({ ok: true, stopReason: 'end_turn', turns: 2, text: 'chào bạn', model: 'locaith-v5-flash' });
  });

  it('stream-json: init → assistant/tool_use → user/tool_result → assistant → result (mỗi dòng một JSON)', async () => {
    const f = fakeRuntime(happy);
    const { d, out } = deps(f.rt);
    await runPrint(parseArgs(['-p', '--output-format', 'stream-json', 'x']), d);
    const evs = out.map((l) => JSON.parse(l));
    expect(evs[0]).toMatchObject({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    const types = evs.map((e) => `${e.type}${e.message ? ':' + e.message.content[0].type : ''}`);
    expect(types).toEqual(['system', 'assistant:text', 'assistant:tool_use', 'user:tool_result', 'assistant:text', 'result']);
    expect(evs[2].message.content[0]).toMatchObject({ name: 'read_file', input: { path: 'a.ts' } });
    expect(evs[3].message.content[0]).toMatchObject({ tool_use_id: 'c1', is_error: false });
    expect(evs[5]).toMatchObject({ type: 'result', is_error: false, result: 'chào bạn' });
  });

  it('lỗi giữa chừng → mã 1 và is_error', async () => {
    const f = fakeRuntime([
      { t: 'assistant_start', id: 'a1', provider: 'p', model: 'm', ts: 1 },
      { t: 'notice', level: 'error', text: 'Cổng trả 500' },
      { t: 'assistant_end', id: 'a1', stopReason: 'error' },
    ]);
    const { d, out } = deps(f.rt);
    const code = await runPrint(parseArgs(['-p', '--output-format', 'json', 'x']), d);
    expect(code).toBe(1);
    const j = JSON.parse(out.join('\n'));
    expect(j).toMatchObject({ is_error: true, ok: false, error: 'Cổng trả 500', subtype: 'error' });
  });

  it('thao tác bị từ chối → nhắc cách cấp quyền', async () => {
    const f = fakeRuntime([
      { t: 'assistant_start', id: 'a1', provider: 'p', model: 'm', ts: 1 },
      { t: 'tool_start', id: 'a1', callId: 'c', name: 'run_command', args: {} },
      { t: 'tool_end', id: 'a1', callId: 'c', state: 'denied', durationMs: 1 },
      { t: 'text', id: 'a1', delta: 'Không làm được' },
      { t: 'assistant_end', id: 'a1', stopReason: 'end_turn' },
    ]);
    const { d, err } = deps(f.rt);
    await runPrint(parseArgs(['-p', 'x']), d);
    expect(err.join('\n')).toMatch(/1 thao tác bị từ chối/);
  });

  it('thiếu nội dung → mã 2; stdin làm dữ liệu', async () => {
    const f = fakeRuntime(happy);
    const a = deps(f.rt);
    expect(await runPrint(parseArgs(['-p']), a.d)).toBe(2);
    expect(a.err.join('\n')).toMatch(/Thiếu nội dung/);

    const b = fakeRuntime(happy);
    const piped = deps(b.rt, { stdinPiped: true, readStdin: async () => 'nội dung từ ống\n' });
    expect(await runPrint(parseArgs(['-p', 'giải thích']), piped.d)).toBe(0);
    expect(b.submitted[0]).toBe('giải thích\n\n---\nnội dung từ ống');
  });

  it('chuyển cờ dòng lệnh sang RuntimeOptions', async () => {
    const f = fakeRuntime(happy);
    const { d, created } = deps(f.rt, { isTrusted: () => false });
    await runPrint(parseArgs(['-p', 'x', '--model', 'locaith-v5-si', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read', '--max-turns', '5', '-c', '--no-session-persistence']), d);
    expect(created[0]).toMatchObject({ model: 'locaith-v5-si', permissionMode: 'acceptEdits', allowedTools: ['Read'], maxTurns: 5, resume: true, noPersist: true, trusted: false });
  });
});
