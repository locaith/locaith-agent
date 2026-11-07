// (lane:ide-context) Chẩn đoán IDE: định dạng, lọc, trần, nguồn VS Code giả, công cụ get_diagnostics, phản hồi sau khi sửa.
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ToolResultBlock } from '../src/core/types';
import { coreRunExtensions } from '../src/core/engine/extensions';
import { filterDiagnostics, formatDiagnostic, newDiagnostics, parseSeverity, type DiagnosticItem, type DiagnosticsQuery, type DiagnosticsResult } from '../src/core/ide/diagnostics';
import { editDiagnosticsExtension, editDiagnosticsMode } from '../src/core/ide/editDiagnostics';
import { createToolRegistry } from '../src/core/tools';
import { NodeToolHost } from '../src/core/host/nodeHost';
import { SkillRegistry } from '../src/core/skills/registry';
import { toDiagnosticItems, waitForDiagnostics, type VsDiagnosticLike, type VsUriLike } from '../src/host/diagnosticsSource';
import { makeHarness } from './helpers/harness';
import { textTurn, toolTurn } from './helpers/fakeProvider';

const d = (over: Partial<DiagnosticItem> & { rel: string }): DiagnosticItem => ({
  abs: '/ws/' + over.rel,
  line: 1,
  column: 1,
  severity: 'error',
  message: 'boom',
  ...over,
});

describe('diagnostics — định dạng, lọc, trần', () => {
  it('định dạng "tệp:dòng:cột mức [nguồn mã] thông điệp" trên một dòng', () => {
    expect(formatDiagnostic(d({ rel: 'src/a.ts', line: 12, column: 5, source: 'ts', code: '2304', message: "Cannot find name 'x'.\n  more" }))).toBe(
      "src/a.ts:12:5 error [ts 2304] Cannot find name 'x'. more",
    );
    expect(formatDiagnostic(d({ rel: 'b.py', severity: 'warning', message: 'unused' }))).toBe('b.py:1:1 warning unused');
  });

  it('sắp lỗi trước, lọc theo mức/nguồn/đường dẫn (thư mục chứa), cắt theo limit nhưng giữ total', () => {
    const all = [
      d({ rel: 'src/z.ts', severity: 'warning', source: 'eslint' }),
      d({ rel: 'src/a.ts', severity: 'error', line: 9, source: 'ts' }),
      d({ rel: 'src/a.ts', severity: 'error', line: 2, source: 'ts' }),
      d({ rel: 'lib/c.ts', severity: 'hint' }),
      d({ rel: 'src/sub/b.ts', severity: 'info' }),
    ];
    const r = filterDiagnostics(all);
    expect(r.items.map((x) => `${x.rel}:${x.line}`)).toEqual(['src/a.ts:2', 'src/a.ts:9', 'src/z.ts:1']);
    expect(filterDiagnostics(all, { minSeverity: 'error' }).total).toBe(2);
    expect(filterDiagnostics(all, { minSeverity: 'hint', paths: ['/ws/src'] }).items.map((x) => x.rel)).toEqual(['src/a.ts', 'src/a.ts', 'src/z.ts', 'src/sub/b.ts']);
    // "/ws/sr" KHÔNG khớp "/ws/src/…" (so theo đoạn đường dẫn, không theo tiền tố chữ)
    expect(filterDiagnostics(all, { paths: ['/ws/sr'] }).total).toBe(0);
    expect(filterDiagnostics(all, { source: 'ESLint' }).items.map((x) => x.rel)).toEqual(['src/z.ts']);
    const capped = filterDiagnostics(all, { minSeverity: 'hint', limit: 2 });
    expect(capped.items).toHaveLength(2);
    expect(capped.total).toBe(5);
  });

  it('newDiagnostics: bỏ lỗi đã có trước (kể cả khi dòng dịch chuyển), giữ lỗi mới theo đa tập', () => {
    const before = [d({ rel: 'a.ts', line: 3, message: 'old' }), d({ rel: 'a.ts', line: 4, message: 'dup' })];
    const after = [d({ rel: 'a.ts', line: 10, message: 'old' }), d({ rel: 'a.ts', line: 11, message: 'dup' }), d({ rel: 'a.ts', line: 12, message: 'dup' }), d({ rel: 'a.ts', message: 'fresh' })];
    expect(newDiagnostics(before, after).map((x) => `${x.message}@${x.line}`)).toEqual(['dup@12', 'fresh@1']);
  });

  it('parseSeverity và chế độ cài đặt', () => {
    expect(parseSeverity('errors')).toBe('error');
    expect(parseSeverity('all')).toBe('hint');
    expect(parseSeverity('???')).toBe('warning');
    expect(editDiagnosticsMode(undefined)).toBe('errors');
    expect(editDiagnosticsMode('all')).toBe('all');
    expect(editDiagnosticsMode('off')).toBe('off');
    expect(editDiagnosticsMode(false)).toBe('off');
  });
});

describe('diagnosticsSource — vscode.languages giả', () => {
  const root = path.resolve('/ws');
  const uri = (p: string, scheme = 'file'): VsUriLike => ({ scheme, fsPath: path.resolve(p) });
  const vd = (severity: number, message: string, extra: Partial<VsDiagnosticLike> = {}): VsDiagnosticLike => ({
    severity,
    message,
    range: { start: { line: 4, character: 2 } },
    ...extra,
  });

  it('đổi mức 0..3, số 1-based, mã dạng object, bỏ tệp ngoài workspace và scheme lạ', () => {
    const items = toDiagnosticItems(
      [
        [uri('/ws/src/a.ts'), [vd(0, 'E', { source: 'ts', code: { value: 2304 } }), vd(1, 'W', { code: 'no-unused' })]],
        [uri('/elsewhere/lib.d.ts'), [vd(0, 'outside')]],
        [uri('/ws/x.ts', 'git'), [vd(0, 'git scheme')]],
        [uri('/ws/b.ts'), [vd(3, 'H')]],
      ],
      [root],
    );
    expect(items.map((i) => [i.rel, i.line, i.column, i.severity, i.code])).toEqual([
      ['src/a.ts', 5, 3, 'error', '2304'],
      ['src/a.ts', 5, 3, 'warning', 'no-unused'],
      ['b.ts', 5, 3, 'hint', undefined],
    ]);
  });

  it('waitForDiagnostics: chờ ≥ minMs, xong sớm khi có thay đổi + quãng lặng, không quá maxMs, Dừng → trả ngay', async () => {
    vi.useFakeTimers();
    try {
      let listener: ((e: { uris: readonly VsUriLike[] }) => void) | undefined;
      const disposed = vi.fn();
      const langs = { onDidChangeDiagnostics: (l: typeof listener) => ((listener = l), { dispose: disposed }) };
      const ac = new AbortController();
      let done = false;
      void waitForDiagnostics(langs, path.resolve('/ws/a.ts'), { minMs: 500, maxMs: 2000, quietMs: 200, signal: ac.signal }).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(300);
      listener!({ uris: [uri('/ws/a.ts')] });
      await vi.advanceTimersByTimeAsync(150);
      expect(done).toBe(false); // chưa đủ minMs
      await vi.advanceTimersByTimeAsync(100);
      expect(done).toBe(true);
      expect(disposed).toHaveBeenCalledTimes(1);

      // Không có sự kiện → hết maxMs? Không: hết minMs là trả (chẩn đoán có thể không đổi).
      let done2 = false;
      void waitForDiagnostics(langs, path.resolve('/ws/a.ts'), { minMs: 500, maxMs: 2000, signal: ac.signal }).then(() => (done2 = true));
      await vi.advanceTimersByTimeAsync(499);
      expect(done2).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(done2).toBe(true);

      // Sự kiện liên tục → bị chặn ở maxMs.
      let done3 = false;
      void waitForDiagnostics(langs, path.resolve('/ws/a.ts'), { minMs: 100, maxMs: 1000, quietMs: 300, signal: ac.signal }).then(() => (done3 = true));
      await vi.advanceTimersByTimeAsync(50);
      listener!({ uris: [uri('/ws/a.ts')] });
      for (let i = 0; i < 8; i++) {
        await vi.advanceTimersByTimeAsync(110);
        listener!({ uris: [uri('/ws/other.ts')] }); // tệp khác: không kéo dài
        listener!({ uris: [uri('/ws/a.ts')] });
      }
      expect(done3).toBe(false); // 930 ms, vẫn đang đổi
      await vi.advanceTimersByTimeAsync(80);
      expect(done3).toBe(true);

      // Dừng.
      let done4 = false;
      void waitForDiagnostics(langs, path.resolve('/ws/a.ts'), { minMs: 900, maxMs: 2000, signal: ac.signal }).then(() => (done4 = true));
      ac.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(done4).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Host giả có chẩn đoán đổi được theo thời gian (giả language server). */
function attachFakeDiagnostics(host: NodeToolHost, dir: string, state: { items: DiagnosticItem[] }) {
  const calls: DiagnosticsQuery[] = [];
  const fn = vi.fn(async (q: DiagnosticsQuery): Promise<DiagnosticsResult> => {
    calls.push(q);
    return filterDiagnostics(state.items, q);
  });
  Object.assign(host, { diagnostics: fn, waitForDiagnostics: vi.fn(async () => undefined) });
  const mk = (rel: string, message: string, severity: DiagnosticItem['severity'] = 'error', line = 1): DiagnosticItem => ({
    abs: path.join(dir, rel),
    rel,
    line,
    column: 1,
    severity,
    source: 'ts',
    message,
  });
  return { fn, calls, mk };
}

const toolResults = (h: ReturnType<typeof makeHarness>, reqIndex: number): ToolResultBlock[] =>
  h.provider.requests[reqIndex].messages.flatMap((m) => m.content.filter((b): b is ToolResultBlock => b.type === 'tool_result'));

describe('get_diagnostics — công cụ', () => {
  it('không đăng ký khi host không có IDE (CLI/Chrome); có khi host có diagnostics', () => {
    const skills = new SkillRegistry([]);
    const plain = new NodeToolHost({ roots: [process.cwd()] });
    expect(createToolRegistry({ skills, host: plain }).get('get_diagnostics')).toBeUndefined();
    const ide = new NodeToolHost({ roots: [process.cwd()] });
    Object.assign(ide, { diagnostics: async () => ({ items: [], total: 0 }) });
    expect(createToolRegistry({ skills, host: ide }).get('get_diagnostics')?.risk).toBe('read');
  });

  it('trả danh sách đã lọc, chặn đường dẫn ngoài workspace, báo "không khả dụng" khi host mất IDE', async () => {
    const h = makeHarness(
      [
        () => toolTurn([{ name: 'get_diagnostics', input: { paths: ['src'], severity: 'error' } }]),
        () => toolTurn([{ name: 'get_diagnostics', input: { paths: ['../../etc'] } }]),
        () => textTurn('xong'),
      ],
      { files: { 'src/a.ts': 'x' } },
    );
    const state = { items: [] as DiagnosticItem[] };
    const fake = attachFakeDiagnostics(h.host, h.dir, state);
    state.items = [fake.mk('src/a.ts', 'Cannot find name x', 'error', 3), fake.mk('src/a.ts', 'unused', 'warning'), fake.mk('other.ts', 'not in scope')];
    // Công cụ chỉ có trong registry khi host có diagnostics → dựng lại registry sau khi gắn.
    const { getDiagnosticsTool } = await import('../src/core/tools/diagnostics');
    (h.engine as unknown as { d: { registry: { register(t: unknown): unknown } } }).d.registry.register(getDiagnosticsTool);
    await h.run('xem lỗi');
    const first = toolResults(h, 1)[0];
    expect(first.isError).toBeFalsy();
    expect(first.content).toContain('src/a.ts:3:1 error [ts] Cannot find name x');
    expect(first.content).not.toContain('unused');
    expect(first.content).not.toContain('not in scope');
    expect(fake.calls[0].paths).toEqual([path.join(h.dir, 'src')]);
    const second = toolResults(h, 2).at(-1)!;
    expect(second.isError).toBe(true);
    expect(second.content).toMatch(/workspace/);
    expect(fake.calls).toHaveLength(1); // đường dẫn bị chặn thì không hỏi IDE

    // Host mất IDE (công cụ vẫn bị gọi từ lịch sử cũ) → "không khả dụng", không ném.
    const bare = new NodeToolHost({ roots: [h.dir] });
    const r = await getDiagnosticsTool.execute({}, { host: bare } as never);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Không khả dụng/);
  });
});

describe('phản hồi chẩn đoán sau khi sửa (toolAfter)', () => {
  const ext = (mode: 'errors' | 'all' | 'off' = 'errors') => editDiagnosticsExtension({ mode: () => mode, minWaitMs: 0, maxWaitMs: 0 });

  it('gắn lỗi MỚI của tệp vừa sửa vào kết quả edit_file; không báo lại lỗi có từ trước; summary có số lỗi', async () => {
    const h = makeHarness(
      [
        () => toolTurn([{ name: 'read_file', input: { path: 'a.ts' } }]),
        () => toolTurn([{ name: 'edit_file', input: { path: 'a.ts', old_string: 'const a = 1;', new_string: 'const a = b;' } }]),
        () => textTurn('xong'),
      ],
      { files: { 'a.ts': 'const a = 1;\n' }, engineDeps: { extensions: [...coreRunExtensions(), ext()] } },
    );
    const state = { items: [] as DiagnosticItem[] };
    const fake = attachFakeDiagnostics(h.host, h.dir, state);
    state.items = [fake.mk('a.ts', 'old problem', 'error', 5), fake.mk('other.ts', 'other file error')];
    // Language server "phân tích lại" ngay sau khi ghi.
    const realWrite = h.host.writeText.bind(h.host);
    h.host.writeText = async (abs, content) => {
      await realWrite(abs, content);
      state.items = [fake.mk('a.ts', 'old problem', 'error', 6), fake.mk('a.ts', "Cannot find name 'b'.", 'error', 1), fake.mk('a.ts', 'just a warning', 'warning'), fake.mk('other.ts', 'other file error')];
    };
    await h.run('sửa a.ts');
    const r = toolResults(h, 2).at(-1)!;
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('Sau khi sửa, VS Code báo 1 lỗi mới ở a.ts');
    expect(r.content).toContain("a.ts:1:1 error [ts] Cannot find name 'b'.");
    expect(r.content).not.toContain('old problem');
    expect(r.content).not.toContain('just a warning'); // chế độ 'errors'
    expect(r.content).not.toContain('other file error'); // chỉ tệp vừa sửa
    // chụp trước + sau, đều chỉ cho tệp a.ts, chỉ mức lỗi
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls.every((q) => q.paths?.length === 1 && q.paths[0] === path.join(h.dir, 'a.ts') && q.minSeverity === 'error')).toBe(true);
    const toolEnd = h.events.filter((e) => e.t === 'tool_end').at(-1) as { summary?: string } | undefined;
    expect(toolEnd?.summary).toMatch(/1 lỗi mới/);
  });

  it("chế độ 'all' báo cả cảnh báo; sửa không sinh lỗi mới → kết quả giữ nguyên", async () => {
    const h = makeHarness(
      [
        () => toolTurn([{ name: 'write_file', input: { path: 'n.ts', content: 'let x' } }]),
        () => toolTurn([{ name: 'write_file', input: { path: 'm.ts', content: 'ok' } }]),
        () => textTurn('xong'),
      ],
      { engineDeps: { extensions: [...coreRunExtensions(), ext('all')] } },
    );
    const state = { items: [] as DiagnosticItem[] };
    const fake = attachFakeDiagnostics(h.host, h.dir, state);
    const realWrite = h.host.writeText.bind(h.host);
    h.host.writeText = async (abs, content) => {
      await realWrite(abs, content);
      if (abs.endsWith('n.ts')) state.items = [fake.mk('n.ts', 'implicit any', 'warning')];
    };
    await h.run('tạo tệp');
    expect(toolResults(h, 1)[0].content).toContain('1 cảnh báo mới');
    expect(toolResults(h, 2).at(-1)!.content).not.toContain('VS Code');
  });

  it("tắt cài đặt ('off') → KHÔNG gọi diagnostics", async () => {
    const h = makeHarness([() => toolTurn([{ name: 'write_file', input: { path: 'n.ts', content: 'x' } }]), () => textTurn('xong')], {
      engineDeps: { extensions: [...coreRunExtensions(), ext('off')] },
    });
    const fake = attachFakeDiagnostics(h.host, h.dir, { items: [] });
    await h.run('tạo tệp');
    expect(fake.fn).not.toHaveBeenCalled();
  });

  it('đọc cài đặt agent.editDiagnostics từ host khi không truyền mode', async () => {
    const h = makeHarness([() => toolTurn([{ name: 'write_file', input: { path: 'n.ts', content: 'x' } }]), () => textTurn('xong')], {
      hostSettings: { 'agent.editDiagnostics': 'off' },
      engineDeps: { extensions: [...coreRunExtensions(), editDiagnosticsExtension({ minWaitMs: 0 })] },
    });
    const fake = attachFakeDiagnostics(h.host, h.dir, { items: [] });
    await h.run('tạo tệp');
    expect(fake.fn).not.toHaveBeenCalled();
  });

  it('công cụ sửa thất bại → không chờ, không gắn gì; tệp ngoài workspace → không chụp', async () => {
    const h = makeHarness(
      [
        () => toolTurn([{ name: 'edit_file', input: { path: 'missing.ts', old_string: 'a', new_string: 'b' } }]),
        () => textTurn('xong'),
      ],
      { engineDeps: { extensions: [...coreRunExtensions(), ext()] } },
    );
    const fake = attachFakeDiagnostics(h.host, h.dir, { items: [] });
    await h.run('sửa');
    const r = toolResults(h, 1)[0];
    expect(r.isError).toBe(true);
    expect((h.host as unknown as { waitForDiagnostics: ReturnType<typeof vi.fn> }).waitForDiagnostics).not.toHaveBeenCalled();
    expect(fake.calls.length).toBeLessThanOrEqual(1);
  });
});
