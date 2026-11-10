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
  it('kẹp theo trần cứng: ≤16 agent đồng thời, ≤1000 agent, ≤8 giờ; ngân sách token KHÔNG có trần trên (chỉ có khi người dùng đặt)', () => {
    const l = clampLimits({ maxAgents: 99999, maxConcurrent: 500, maxTotalTokens: 1e12, timeoutMs: 1e12 }, LIMITS);
    expect(l.maxAgents).toBe(1000);
    expect(l.maxConcurrent).toBe(16);
    expect(l.maxTotalTokens).toBe(1e12); // người dùng/lệnh tự đặt → tôn trọng (trước đây bị kẹp 20M)
    expect(l.timeoutMs).toBe(8 * 3_600_000);
    expect(clampLimits({}, LIMITS)).toEqual(LIMITS);
  });

  it('mặc định null = KHÔNG ngân sách token; không đặt thì giữ null; đặt thấp hơn tối thiểu thì nâng lên 10.000', () => {
    const none: WorkflowLimits = { ...LIMITS, maxTotalTokens: null };
    expect(clampLimits({}, none).maxTotalTokens).toBeNull();
    expect(clampLimits({ maxTotalTokens: undefined }, none).maxTotalTokens).toBeNull();
    expect(clampLimits({ maxTotalTokens: Number.NaN }, none).maxTotalTokens).toBeNull();
    expect(clampLimits({ maxTotalTokens: 50 }, none).maxTotalTokens).toBe(10_000);
    expect(clampLimits({ maxTotalTokens: 2_500_000 }, none).maxTotalTokens).toBe(2_500_000);
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

  it('vượt số agent tối đa: agent() KHÔNG ném — trả {ok:false, skipped:"agents"} và script chạy tiếp; kết quả báo `skipped`/`hit`', async () => {
    const { promise } = run('const out = []; for (let i = 0; i < 4; i++) { const r = await agent("t" + i); out.push(r.ok ? "ok" : r.skipped + ":" + r.error); } return out;', { limits: { maxAgents: 2 } });
    const r = await promise;
    expect(r.ok).toBe(true);
    const v = r.value as string[];
    expect(v.slice(0, 2)).toEqual(['ok', 'ok']);
    expect(v[2]).toContain('agents:');
    expect(v[2]).toContain('giới hạn 2 agent');
    expect(r.agents).toBe(2); // agent bị bỏ qua không được tính là đã chạy
    expect(r.skipped).toBe(2);
    expect(r.hit).toEqual({ kind: 'agents', limit: 2 });
  });

  it('hết ngân sách token do người dùng đặt: các agent đã xong GIỮ NGUYÊN, agent kế tiếp bị bỏ qua (không còn «Workflow thất bại … hết ngân sách» mất cả báo cáo)', async () => {
    const { promise } = run(
      'const res = []; for (let i = 0; i < 5; i++) { const r = await agent("t" + i); res.push(r.ok ? r.text : "BỎ:" + r.skipped); } return { res };',
      { limits: { maxTotalTokens: 250 }, agent: () => ({ ok: true, text: 'xong', tokens: 100, model: 'm' }) },
    );
    const r = await promise;
    expect(r.ok).toBe(true);
    expect((r.value as { res: string[] }).res).toEqual(['xong', 'xong', 'xong', 'BỎ:tokens', 'BỎ:tokens']); // 100+100+100 ≥ 250 sau agent thứ 3
    expect(r.hit).toEqual({ kind: 'tokens', limit: 250 });
    expect(r.skipped).toBe(2);
  });

  it('KHÔNG đặt ngân sách (null): chạy 40 agent × 5M token mỗi agent vẫn không bị chặn', async () => {
    const { promise } = run('const rs = await pipeline(Array.from({ length: 40 }, (_, i) => i), (i) => agent("x" + i)); return rs.filter((r) => r.ok).length;', {
      limits: { maxAgents: 1000, maxTotalTokens: null },
      agent: () => ({ ok: true, text: 't', tokens: 5_000_000, model: 'm' }),
    });
    const r = await promise;
    expect(r.ok).toBe(true);
    expect(r.value).toBe(40);
    expect(r.tokens).toBe(200_000_000);
    expect(r.skipped).toBeUndefined();
  });

  it('script cứ gọi agent() mãi sau khi chạm giới hạn → dừng script (không quay CPU tới hết hạn giờ)', async () => {
    const { promise } = run('for (;;) { await agent("x"); }', { limits: { maxAgents: 1 } });
    const r = await promise;
    expect(r.ok).toBe(false);
    expect(r.error).toContain('dừng script');
  });

  it('kho artifact đầy: KHÔNG ném (trước đây chết sau khi agent đã chạy), cắt giá trị mới', async () => {
    const big = 'x'.repeat(400_000);
    const { promise, artifacts } = run('for (let i = 0; i < 90; i++) { await store.put("k" + i, "y".repeat(400000)); } return { n: (await store.list()).length };', { agent: () => ({ ok: true, text: big, tokens: 1, model: 'm' }) });
    const r = await promise;
    expect(r.ok).toBe(true);
    expect((r.value as { n: number }).n).toBe(90);
    // 90 × 400k = 36M > 32M: các giá trị sau cùng bị cắt còn ~2k thay vì ném
    const lens = Object.values(artifacts).map((v) => v.length);
    expect(lens.some((n) => n < 5000)).toBe(true);
  }, 60_000);

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

describe('runWorkflow — sự kiện vòng đời từng agent cho bảng agent (0.7.7)', () => {
  type Ev = import('../src/core/agents/workflow').WfAgentEvent;
  const trace = (script: string, o: { limits?: Partial<WorkflowLimits>; agent?: (p: string, opts: WfAgentOpts, n: number) => Promise<WfAgentResult> | WfAgentResult } = {}) => {
    const events: Ev[] = [];
    const phases: string[] = [];
    const limits: Array<{ kind: string; limit: number; skipped: number }> = [];
    const promise = runWorkflow({
      script,
      limits: { ...LIMITS, ...o.limits },
      signal: new AbortController().signal,
      hooks: {
        progress: () => undefined,
        onAgent: (e) => void events.push(e),
        onPhase: (n) => void phases.push(n),
        onLimit: (h) => void limits.push(h),
        runAgent: async (p, opts, _s, meta) => (o.agent ? o.agent(p, opts, meta.n) : { ok: true, text: `trả lời: ${p}`, tokens: 100, model: 'm' }),
      },
    });
    return { promise, events, phases, limits };
  };

  it('mỗi agent đi qua queued → running → done, mang nhãn/loại/pha; kết quả có trích báo cáo gọn một dòng', async () => {
    const t = trace('phase("Trace"); await agent("điều tra A", { label: "Nguyên nhân A", agent: "researcher" }); return 1;', { agent: () => ({ ok: true, text: 'Kết luận:' + String.fromCharCode(10) + '  lỗi ở  hàm x', tokens: 321, model: 'deepseek-v4-pro' }) });
    const r = await t.promise;
    expect(r.ok).toBe(true);
    expect(t.phases).toEqual(['Trace']);
    expect(t.events.map((e) => e.state)).toEqual(['queued', 'running', 'done']);
    expect(t.events[0]).toMatchObject({ n: 1, label: 'Nguyên nhân A', type: 'researcher', phase: 'Trace' });
    expect(t.events[2]).toMatchObject({ n: 1, state: 'done', tokens: 321, model: 'deepseek-v4-pro', preview: 'Kết luận: lỗi ở hàm x' });
  });

  it('hết chỗ cùng lúc: agent thứ hai ĐỨNG HÀNG (queued) trong khi agent đầu đang chạy, rồi mới chạy', async () => {
    const order: string[] = [];
    const t = trace('await Promise.all([agent("a", { label: "A" }), agent("b", { label: "B" })]); return 1;', {
      limits: { maxConcurrent: 1 },
      agent: async (p) => {
        order.push(`start:${p}`);
        await sleep(60);
        order.push(`end:${p}`);
        return { ok: true, text: 't', tokens: 1, model: 'm' };
      },
    });
    await t.promise;
    const states = t.events.map((e) => `${e.n}:${e.state}`);
    // cả hai vào hàng đợi trước; agent 2 chỉ chạy sau khi agent 1 xong
    expect(states.indexOf('1:queued')).toBeLessThan(states.indexOf('1:running'));
    expect(states.indexOf('2:queued')).toBeLessThan(states.indexOf('1:done'));
    expect(states.indexOf('1:done')).toBeLessThan(states.indexOf('2:running'));
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  it('agent lỗi → state error kèm lý do; thử lại cộng dồn token; agent bị bỏ qua vì chạm giới hạn KHÔNG sinh dòng và báo onLimit', async () => {
    let calls = 0;
    const t = trace('const a = await agent("x", { retries: 0 }); const b = await agent("y"); return [a.ok, b.skipped];', {
      limits: { maxAgents: 1 },
      agent: () => (calls++, { ok: false, text: '', tokens: 40, model: 'm', error: 'Hết thời gian chờ' }),
    });
    const r = await t.promise;
    expect(r.value).toEqual([false, 'agents']);
    expect(t.events.map((e) => e.state)).toEqual(['queued', 'running', 'error']);
    expect(t.events[2]).toMatchObject({ state: 'error', error: 'Hết thời gian chờ', tokens: 40 });
    expect(t.limits).toEqual([{ kind: 'agents', limit: 1, skipped: 1 }]);
    expect(calls).toBe(1);
  });

  it('bị Dừng khi còn xếp hàng: dòng chuyển sang error («Đã dừng.»), không treo ở queued', async () => {
    const ctl = new AbortController();
    const events: Ev[] = [];
    const p = runWorkflow({
      script: 'await Promise.all([agent("a"), agent("b")]); return 1;',
      limits: { ...LIMITS, maxConcurrent: 1 },
      signal: ctl.signal,
      hooks: {
        progress: () => undefined,
        onAgent: (e) => void events.push(e),
        runAgent: async () => {
          await sleep(300);
          return { ok: true, text: 't', tokens: 1, model: 'm' };
        },
      },
    });
    setTimeout(() => ctl.abort(), 80);
    const r = await p;
    expect(r.ok).toBe(false);
    await sleep(50);
    const last = (n: number) => [...events].reverse().find((e) => e.n === n)!;
    expect(last(2).state).toBe('error'); // đang xếp hàng lúc bị dừng
    expect(last(2).state).not.toBe('queued');
  });
});
