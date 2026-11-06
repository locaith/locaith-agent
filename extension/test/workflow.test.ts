import { describe, expect, it } from 'vitest';
import { clampLimits, extractJson, runWorkflow, type WfAgentOpts, type WfAgentResult, type WorkflowLimits } from '../src/core/agents/workflow';

const LIMITS: WorkflowLimits = { maxAgents: 50, maxConcurrent: 8, maxTotalTokens: 1_000_000, timeoutMs: 20_000 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function run(script: string, o: { limits?: Partial<WorkflowLimits>; args?: unknown; agent?: (p: string, opts: WfAgentOpts) => Promise<WfAgentResult> | WfAgentResult; signal?: AbortSignal } = {}) {
  const lines: string[] = [];
  const artifacts: Record<string, string> = {};
  const promise = runWorkflow({
    script,
    args: o.args,
    limits: { ...LIMITS, ...o.limits },
    signal: o.signal ?? new AbortController().signal,
    hooks: {
      progress: (l) => lines.push(l),
      onArtifact: (k, v) => (artifacts[k] = v),
      runAgent: async (p, opts) => (o.agent ? o.agent(p, opts) : { ok: true, text: `trả lời: ${p}`, tokens: 100, model: 'm' }),
    },
  });
  return { promise, lines, artifacts };
}

describe('extractJson', () => {
  it('lấy JSON trần, trong khối ```json và trong văn bản lẫn tạp', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Kết quả:\n```json\n{"a":[1,2]}\n```\nxong')).toEqual({ a: [1, 2] });
    expect(extractJson('Đây là kết quả {"x":"}"} cảm ơn')).toEqual({ x: '}' });
    expect(extractJson('không có json')).toBeUndefined();
  });
});

describe('clampLimits', () => {
  it('kẹp theo trần cứng: ≤16 agent đồng thời, ≤1000 agent', () => {
    const l = clampLimits({ maxAgents: 99999, maxConcurrent: 500, maxTotalTokens: 1e12, timeoutMs: 1e12 }, LIMITS);
    expect(l.maxAgents).toBe(1000);
    expect(l.maxConcurrent).toBe(16);
    expect(l.maxTotalTokens).toBe(20_000_000);
    expect(l.timeoutMs).toBe(3_600_000);
    expect(clampLimits({}, LIMITS)).toEqual(LIMITS);
  });
});

describe('runWorkflow — worker + vm', () => {
  it('pipeline nhiều pha: kết quả trung gian ở trong script, chỉ giá trị return quay về', async () => {
    const script = `
      phase("Trace");
      const traces = await pipeline(args.items, (h) => agent("điều tra " + h, { json: true }));
      phase("Adjudicate");
      const v = await agent("phán quyết", { tier: "top" });
      return { n: traces.length, ok: traces.every((t) => t.ok), first: traces[0].data, verdict: v.text };`;
    const { promise } = run(script, {
      args: { items: ['a', 'b', 'c'] },
      agent: (p) => ({ ok: true, text: p.startsWith('điều tra') ? '```json\n{"finding":"' + p.slice(9, 10) + '"}\n```' : 'đúng', tokens: 1000, model: 'm1' }),
    });
    const r = await promise;
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ n: 3, ok: true, first: { finding: 'a' }, verdict: 'đúng' });
    expect(r.agents).toBe(4);
    expect(r.tokens).toBe(4000);
    expect(r.phases).toEqual(['Trace', 'Adjudicate']);
  });

  it('json:true thử lại một lần khi phản hồi không phải JSON', async () => {
    let n = 0;
    const { promise } = run('const r = await agent("x", { json: true }); return r.data;', {
      agent: () => ({ ok: true, text: ++n === 1 ? 'không phải json' : '{"ok":true}', tokens: 10, model: 'm' }),
    });
    const r = await promise;
    expect(r.value).toEqual({ ok: true });
    expect(n).toBe(2);
  });

  it('giới hạn đồng thời được tôn trọng', async () => {
    let cur = 0;
    let peak = 0;
    const { promise } = run('return (await pipeline(Array.from({length: 12}, (_, i) => i), (i) => agent("t" + i), { concurrency: 12 })).length;', {
      limits: { maxConcurrent: 3 },
      agent: async () => {
        cur++;
        peak = Math.max(peak, cur);
        await sleep(20);
        cur--;
        return { ok: true, text: 'x', tokens: 1, model: 'm' };
      },
    });
    const r = await promise;
    expect(r.value).toBe(12);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('vượt số agent tối đa: agent() từ chối, script bắt được lỗi', async () => {
    const { promise } = run('const out = []; for (let i = 0; i < 4; i++) { try { await agent("t" + i); out.push("ok"); } catch (e) { out.push(e.message); } } return out;', { limits: { maxAgents: 2 } });
    const r = await promise;
    expect(r.ok).toBe(true);
    const v = r.value as string[];
    expect(v.slice(0, 2)).toEqual(['ok', 'ok']);
    expect(v[2]).toContain('giới hạn 2 agent');
  });

  it('cache:true dùng lại kết quả; store.put/get/list hoạt động', async () => {
    let calls = 0;
    const { promise, artifacts } = run(
      'await agent("same", { cache: true }); await agent("same", { cache: true }); await store.put("k", { a: 1 }); return { got: await store.get("k"), keys: await store.list() };',
      {
        agent: () => {
          calls++;
          return { ok: true, text: 't', tokens: 1, model: 'm' };
        },
      },
    );
    const r = await promise;
    expect(calls).toBe(1);
    expect((r.value as { got: unknown }).got).toEqual({ a: 1 });
    expect(artifacts.k).toBe('{"a":1}');
  });

  it('hộp cát: không có process/require/fetch; eval và Function bị tắt; không lần ngược được tới Function của host', async () => {
    const script = `
      const out = { t: [typeof process, typeof require, typeof fetch, typeof module, typeof globalThis.process] };
      try { out.evalRes = eval("1+1"); } catch (e) { out.eval = e.name; }
      try { out.fnRes = agent.constructor("return process")(); } catch (e) { out.fn = e.name; }
      try { out.fn2 = (function(){}).constructor("return typeof process")(); } catch (e) { out.fn2e = e.name; }
      try { out.gen = Object.getPrototypeOf(async function(){}).constructor("return 1")(); } catch (e) { out.gen = e.name; }
      return out;`;
    const r = await run(script).promise;
    expect(r.ok).toBe(true);
    const v = r.value as Record<string, unknown>;
    expect(v.t).toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'undefined']);
    expect(v.evalRes).toBeUndefined();
    expect(v.eval).toBe('EvalError');
    expect(v.fnRes).toBeUndefined();
    expect(v.fn).toBe('EvalError');
    expect(v.fn2).toBeUndefined();
    expect(v.fn2e).toBe('EvalError');
  });

  it('lỗi cú pháp / lỗi chạy trả ok:false kèm thông điệp', async () => {
    const a = await run('const = ;').promise;
    expect(a.ok).toBe(false);
    expect(a.error).toMatch(/Unexpected|token/i);
    const b = await run('throw new Error("hỏng rồi");').promise;
    expect(b.ok).toBe(false);
    expect(b.error).toContain('hỏng rồi');
  });

  it('người dùng bấm Dừng → kết thúc ngay và giết worker', async () => {
    const ctl = new AbortController();
    const { promise } = run('await new Promise(() => {}); return 1;', { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 150);
    const t0 = Date.now();
    const r = await promise;
    expect(r.ok).toBe(false);
    expect(r.error).toBe('Đã dừng.');
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('vòng lặp vô hạn sau await bị chặn bởi hạn chót (worker bị giết, extension host không treo)', async () => {
    const { promise } = run('await agent("x"); while (true) {}', { limits: { timeoutMs: 1200 } });
    const t0 = Date.now();
    const r = await promise;
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Quá thời hạn');
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('script quá dài bị từ chối', async () => {
    const r = await run('/*' + 'x'.repeat(31_000) + '*/ return 1;').promise;
    expect(r.ok).toBe(false);
    expect(r.error).toContain('dài quá');
  });
});
