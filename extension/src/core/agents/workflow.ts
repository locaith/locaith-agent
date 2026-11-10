/**
 * Workflow runtime (kiểu "Dynamic Workflows" của Claude Code): mô hình viết MỘT chương trình JavaScript ngắn điều phối hàng chục/hàng trăm
 * agent con. Kết quả trung gian nằm trong biến của script và kho artifact — KHÔNG đi vào ngữ cảnh của mô hình chính;
 * mô hình chỉ nhận giá trị mà script `return`.
 *
 * Cách ly: script chạy trong một worker_thread riêng (treo/hết bộ nhớ chỉ giết worker; bị dừng khi quá hạn hoặc người dùng bấm Dừng),
 * bên trong `vm` với ngữ cảnh trống: không có `process`/`require`/`fetch`, `eval` và `new Function` bị tắt, môi trường worker rỗng
 * (không thừa hưởng khoá API). Cầu nối ra ngoài chỉ truyền CHUỖI JSON qua một hàm không có prototype nên không lần ngược được tới
 * `Function` của host. Đây là lớp phòng thủ nhiều tầng chứ không phải hộp cát tuyệt đối — vì vậy `workflow_run` luôn xin phép người dùng
 * (xem tools.ts) và agent con mặc định chỉ đọc.
 */

import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { Semaphore } from './semaphore';

export interface WfAgentOpts {
  agent?: string;
  tier?: 'top' | 'balanced' | 'fast' | 'inherit';
  label?: string;
  /** Yêu cầu agent trả JSON hợp lệ; kết quả có thêm `data`. */
  json?: boolean;
  retries?: number;
  maxTurns?: number;
  /** Dùng lại kết quả nếu cùng (prompt, agent, tier) đã chạy trong lần này. */
  cache?: boolean;
}

export interface WfAgentResult {
  ok: boolean;
  text: string;
  tokens: number;
  model: string;
  error?: string;
}

export interface WorkflowLimits {
  maxAgents: number;
  maxConcurrent: number;
  /**
   * Ngân sách token cho CẢ workflow. `null` = KHÔNG có ngân sách (mặc định — như Claude Code, nơi ngân sách chỉ có khi người dùng đặt «+500k»): trước đây mặc định 2M/5M token
   * (đếm cả token ngữ cảnh đọc lại mỗi vòng: ~1M mỗi agent) nên Swarm chết sau ~5 agent với «Đã hết ngân sách token của workflow».
   */
  maxTotalTokens: number | null;
  timeoutMs: number;
}

/** Vòng đời của MỘT agent trong workflow, để giao diện hiện bảng từng agent (xem WfProgress). */
export interface WfAgentEvent {
  /** Số thứ tự agent (1…), ổn định qua các lần thử lại. */
  n: number;
  label: string;
  type?: string;
  phase?: string;
  state: 'queued' | 'running' | 'done' | 'error';
  /** Chỉ khi done/error. */
  tokens?: number;
  model?: string;
  error?: string;
  preview?: string;
}

export interface WorkflowHooks {
  /** `meta.n` = số thứ tự của agent (cùng `n` ở onAgent); thử lại thì gọi lại với cùng n. */
  runAgent(prompt: string, opts: WfAgentOpts, signal: AbortSignal, meta: { n: number }): Promise<WfAgentResult>;
  progress(line: string): void;
  onArtifact?(key: string, value: string): void;
  /** Agent xếp hàng / bắt đầu chạy / xong. */
  onAgent?(e: WfAgentEvent): void;
  /** Script gọi phase(name). */
  onPhase?(name: string): void;
  /** Chạm giới hạn do người dùng/lệnh đặt: `skipped` = số lời gọi agent() đã bị bỏ qua tới giờ. */
  onLimit?(h: { kind: 'agents' | 'tokens'; limit: number; skipped: number }): void;
}

export interface WorkflowResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  agents: number;
  tokens: number;
  phases: string[];
  artifacts: string[];
  durationMs: number;
  /** Số lời gọi `agent()` bị BỎ QUA vì chạm giới hạn (số agent hoặc ngân sách token do người dùng/lệnh đặt). Script vẫn chạy tiếp (kết quả cục bộ không mất). */
  skipped?: number;
  /** Giới hạn đã chạm đầu tiên (nếu có). */
  hit?: { kind: 'agents' | 'tokens'; limit: number };
}

/** Lưới an toàn: 1.000 agent mỗi lần chạy (như Claude Code), 16 cùng lúc, tối đa 8 giờ. KHÔNG có trần token (xem WorkflowLimits.maxTotalTokens). */
export const HARD_LIMITS = { maxAgents: 1000, maxConcurrent: 16, timeoutMs: 8 * 60 * 60_000 } as const;
/** Ngân sách token tối thiểu khi người dùng/lệnh tự đặt. */
export const MIN_TOKEN_BUDGET = 10_000;
export const MAX_SCRIPT_CHARS = 30_000;
const MAX_ARTIFACT_CHARS = 400_000;
/** Kho artifact: 1.000 báo cáo agent × tới 50k ký tự không còn làm đầy kho giữa chừng (trước đây 4M ký tự → ném lỗi sau khi agent đã chạy xong). Đầy thì CẮT giá trị mới, không ném. */
const MAX_STORE_CHARS = 32_000_000;
/** Quá ngần này lời gọi agent() liên tiếp bị bỏ qua (script lặp vô hạn dù đã báo chạm giới hạn) → dừng script thay vì quay CPU tới hết hạn giờ. */
const MAX_SKIPPED_CALLS = 200;

/** Chạy BÊN TRONG ngữ cảnh vm (không có `require`); `b` là cầu nối do worker cấp, bị xoá khỏi global ngay sau khi dựng API. */
const PRELUDE = String.raw`(function (b, argsJson) {
  'use strict';
  const call = (op, p) => new Promise((res, rej) => {
    b(op, JSON.stringify(p === undefined ? null : p),
      (s) => res(s === undefined || s === null ? undefined : JSON.parse(s)),
      (e) => rej(new Error(String(e))));
  });
  const mapLimit = async (items, limit, fn) => {
    const arr = Array.from(items);
    const out = new Array(arr.length);
    let next = 0;
    const lim = Math.max(1, Math.min(Number(limit) || 8, 64));
    const run = async () => { for (;;) { const i = next++; if (i >= arr.length) return; out[i] = await fn(arr[i], i); } };
    await Promise.all(Array.from({ length: Math.min(lim, arr.length) }, run));
    return out;
  };
  const agent = (prompt, opts) => call('agent', { prompt: String(prompt), opts: opts || {} });
  const parallel = (tasks, opts) => mapLimit(tasks, (opts && opts.concurrency) || 16, (t) => (typeof t === 'function' ? t() : t));
  const pipeline = (items, fn, opts) => mapLimit(items, (opts && opts.concurrency) || 8, fn);
  const store = Object.freeze({
    put: (k, v) => call('put', { k: String(k), v }),
    get: (k) => call('get', { k: String(k) }),
    list: () => call('list', {}),
  });
  const fmt = (x) => (typeof x === 'string' ? x : JSON.stringify(x));
  const log = (...a) => { call('log', { text: a.map(fmt).join(' ') }).catch(() => {}); };
  const phase = (name) => { call('phase', { name: String(name) }).catch(() => {}); };
  const g = globalThis;
  const def = (k, v) => Object.defineProperty(g, k, { value: v, enumerable: true });
  def('agent', agent); def('parallel', parallel); def('pipeline', pipeline); def('store', store);
  def('log', log); def('phase', phase);
  def('console', Object.freeze({ log, info: log, warn: log, error: log }));
  def('args', JSON.parse(argsJson));
  delete g.__b; delete g.__args;
})(__b, __args)`;

const WORKER_SRC = String.raw`'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
let seq = 0;
const pending = new Map();
parentPort.on('message', (m) => {
  if (!m || m.t !== 'reply') return;
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.ok) p.resolve(m.value); else p.reject(m.error);
});
function bridge(op, payload, resolve, reject) {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  parentPort.postMessage({ t: 'call', id, op, payload });
}
Object.setPrototypeOf(bridge, null);
const sandbox = Object.create(null);
sandbox.__b = bridge;
sandbox.__args = workerData.args;
const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
function fail(e) {
  parentPort.postMessage({ t: 'error', message: String((e && e.message) || e), stack: String((e && e.stack) || '') });
}
try {
  new vm.Script(workerData.prelude, { filename: 'prelude.js' }).runInContext(ctx, { timeout: 2000 });
  const code = '(async () => {\n"use strict";\n' + workerData.script + '\n})()';
  const p = new vm.Script(code, { filename: 'workflow.js' }).runInContext(ctx, { timeout: 2000 });
  Promise.resolve(p).then(
    (v) => {
      try { parentPort.postMessage({ t: 'done', value: JSON.stringify(v === undefined ? null : v) }); }
      catch (e) { fail(new Error('Giá trị return của script không chuyển được sang JSON: ' + ((e && e.message) || e))); }
    },
    fail,
  );
} catch (e) { fail(e); }
`;

/** Lấy JSON đầu tiên trong văn bản (có thể nằm trong khối ```json). */
export function extractJson(text: string): unknown | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fenced?.[1], text].filter((s): s is string => !!s);
  for (const c of candidates) {
    try {
      return JSON.parse(c.trim());
    } catch {
      /* thử cách khác */
    }
    for (let i = 0; i < c.length; i++) {
      const open = c[i];
      if (open !== '{' && open !== '[') continue;
      const close = open === '{' ? '}' : ']';
      let depth = 0;
      let inStr = false;
      for (let j = i; j < c.length; j++) {
        const ch = c[j];
        if (inStr) {
          if (ch === '\\') j++;
          else if (ch === '"') inStr = false;
        } else if (ch === '"') inStr = true;
        else if (ch === open) depth++;
        else if (ch === close && --depth === 0) {
          try {
            return JSON.parse(c.slice(i, j + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return undefined;
}

export function clampLimits(want: Partial<WorkflowLimits>, defaults: WorkflowLimits): WorkflowLimits {
  const c = (v: number | undefined, d: number, hi: number) => Math.max(1, Math.min(hi, Math.floor(Number.isFinite(v as number) ? (v as number) : d)));
  // Ngân sách token: chỉ có khi người dùng/lệnh ĐẶT (không có trần trên); không đặt thì theo mặc định (null = không ngân sách).
  const wantTokens = want.maxTotalTokens;
  const tokens = typeof wantTokens === 'number' && Number.isFinite(wantTokens) ? Math.max(MIN_TOKEN_BUDGET, Math.floor(wantTokens)) : defaults.maxTotalTokens;
  return {
    maxAgents: c(want.maxAgents, defaults.maxAgents, HARD_LIMITS.maxAgents),
    maxConcurrent: c(want.maxConcurrent, defaults.maxConcurrent, HARD_LIMITS.maxConcurrent),
    maxTotalTokens: tokens,
    timeoutMs: c(want.timeoutMs, defaults.timeoutMs, HARD_LIMITS.timeoutMs),
  };
}

export async function runWorkflow(input: {
  script: string;
  args?: unknown;
  limits: WorkflowLimits;
  hooks: WorkflowHooks;
  signal: AbortSignal;
  runId?: string;
}): Promise<WorkflowResult> {
  const started = Date.now();
  const { hooks, limits } = input;
  const runId = input.runId ?? `wf${started.toString(36)}`;
  const stats = { started: 0, done: 0, tokens: 0, skipped: 0 };
  let hit: WorkflowResult['hit'];
  const phases: string[] = [];
  const store = new Map<string, string>();
  let storeChars = 0;
  const cache = new Map<string, WfAgentResult & { data?: unknown }>();
  const sem = new Semaphore(limits.maxConcurrent);
  let lastProgress = 0;

  const progress = (force = false): void => {
    const now = Date.now();
    if (!force && now - lastProgress < 1000) return;
    lastProgress = now;
    const k = stats.tokens >= 1000 ? `${(stats.tokens / 1000).toFixed(1).replace('.', ',')}k` : String(stats.tokens);
    hooks.progress(`Workflow ${runId}${phases.length ? ` · pha «${phases[phases.length - 1]}»` : ''} · ${stats.done}/${stats.started} agent xong · ${k} token\n`);
  };

  const result = (r: Partial<WorkflowResult> & { ok: boolean }): WorkflowResult => ({
    agents: stats.started, tokens: stats.tokens, phases, artifacts: [...store.keys()], durationMs: Date.now() - started,
    ...(stats.skipped > 0 ? { skipped: stats.skipped, ...(hit ? { hit } : {}) } : {}),
    ...r,
  });

  if (input.script.length > MAX_SCRIPT_CHARS) return result({ ok: false, error: `Script dài quá ${MAX_SCRIPT_CHARS} ký tự.` });

  let worker: Worker;
  try {
    worker = new Worker(WORKER_SRC, {
      eval: true,
      env: {},
      workerData: { script: input.script, prelude: PRELUDE, args: JSON.stringify(input.args ?? null) },
      resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      stdout: true,
      stderr: true,
    });
  } catch (err) {
    return result({ ok: false, error: `Không khởi động được worker: ${err instanceof Error ? err.message : String(err)}` });
  }

  const putArtifact = (key: string, text: string): string => {
    const k = key.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'artifact';
    let v = text.length > MAX_ARTIFACT_CHARS ? text.slice(0, MAX_ARTIFACT_CHARS) : text;
    const before = store.get(k)?.length ?? 0;
    if (storeChars + v.length - before > MAX_STORE_CHARS) {
      // Kho đầy: KHÔNG ném (trước đây một workflow đã chạy hàng trăm agent chết ở đúng lúc ghi báo cáo cuối) — giữ phần đầu của giá trị mới.
      v = `${v.slice(0, 2000)}\n… [kho artifact của workflow đã đầy — phần còn lại của giá trị này đã bỏ]`;
    }
    storeChars += v.length - before;
    store.set(k, v);
    hooks.onArtifact?.(k, v);
    return `artifact://${runId}/${k}`;
  };

  const agentCall = async (p: { prompt: string; opts: WfAgentOpts }): Promise<unknown> => {
    const opts = p.opts ?? {};
    const prompt = String(p.prompt ?? '');
    if (!prompt.trim()) throw new Error('agent(): prompt rỗng.');
    const key = opts.cache ? createHash('sha1').update(`${opts.agent ?? ''}|${opts.tier ?? ''}|${prompt}`).digest('hex') : '';
    if (key && cache.has(key)) return cache.get(key);
    // Chạm giới hạn do người dùng/lệnh đặt: agent này KHÔNG chạy nhưng script KHÔNG chết — trả `{ok:false, skipped}` để script gom kết quả đã có
    // (trước đây `throw` làm mất cả báo cáo của các agent đã xong: «Workflow thất bại … Đã hết ngân sách token» sau 263 giây và 6 báo cáo).
    const skip = (kind: 'agents' | 'tokens', limit: number, why: string): unknown => {
      stats.skipped++;
      hit ??= { kind, limit };
      if (stats.skipped > MAX_SKIPPED_CALLS) throw new Error(`${why} Script vẫn gọi agent() sau khi đã chạm giới hạn (${stats.skipped} lời gọi bị bỏ qua) — dừng script.`);
      hooks.onLimit?.({ kind, limit, skipped: stats.skipped });
      progress(true);
      return { ok: false, text: '', tokens: 0, model: '', ref: '', skipped: kind, error: why };
    };
    if (stats.started >= limits.maxAgents) return skip('agents', limits.maxAgents, `Đã đạt giới hạn ${limits.maxAgents} agent cho lần chạy này; agent này KHÔNG chạy.`);
    if (limits.maxTotalTokens !== null && stats.tokens >= limits.maxTotalTokens) return skip('tokens', limits.maxTotalTokens, `Đã hết ngân sách ${limits.maxTotalTokens.toLocaleString('en-US')} token mà bạn đặt cho workflow; agent này KHÔNG chạy.`);
    stats.started++;
    const n = stats.started;
    const label = String(opts.label ?? '').slice(0, 120);
    const phase = phases[phases.length - 1];
    hooks.onAgent?.({ n, label, ...(opts.agent ? { type: opts.agent } : {}), ...(phase ? { phase } : {}), state: 'queued' });
    let release: () => void;
    try {
      release = await sem.acquire(input.signal);
    } catch (err) {
      // Bị dừng khi còn xếp hàng: không còn «chờ» nữa (giao diện không để dòng treo ở trạng thái xếp hàng).
      hooks.onAgent?.({ n, label, state: 'error', error: 'Đã dừng.' });
      throw err;
    }
    let finalEvent: WfAgentEvent | undefined;
    try {
      hooks.onAgent?.({ n, label, state: 'running' });
      progress();
      const wantJson = opts.json === true;
      const retries = Math.max(0, Math.min(2, Number(opts.retries ?? (wantJson ? 1 : 0))));
      let r: WfAgentResult = { ok: false, text: '', tokens: 0, model: '' };
      let data: unknown;
      let ask = wantJson ? `${prompt}\n\nTrả về DUY NHẤT một JSON hợp lệ (không giải thích ngoài JSON).` : prompt;
      let spent = 0; // token của MỌI lần thử (kể cả thử lại) cho dòng của agent này
      for (let attempt = 0; attempt <= retries; attempt++) {
        r = await hooks.runAgent(ask, opts, input.signal, { n });
        stats.tokens += r.tokens;
        spent += r.tokens;
        if (!r.ok) continue;
        if (!wantJson) break;
        data = extractJson(r.text);
        if (data !== undefined) break;
        ask = `${prompt}\n\nPhản hồi trước KHÔNG phải JSON hợp lệ. Trả về DUY NHẤT một JSON hợp lệ.`;
      }
      const ref = putArtifact(`agent-${n}`, r.text);
      const ok = r.ok && (!wantJson || data !== undefined);
      const error = r.ok ? (wantJson && data === undefined ? 'Phản hồi không phải JSON hợp lệ.' : undefined) : r.error;
      const out = { ok, text: r.text, data, tokens: r.tokens, model: r.model, ref, error };
      finalEvent = { n, label, state: ok ? 'done' : 'error', tokens: spent, model: r.model, ...(error ? { error: error.slice(0, 200) } : {}), ...(ok && r.text ? { preview: r.text.replace(/\s+/g, ' ').trim().slice(0, 160) } : {}) };
      if (key) cache.set(key, out);
      return out;
    } finally {
      stats.done++;
      release();
      hooks.onAgent?.(finalEvent ?? { n, label, state: 'error', error: 'Đã dừng.' });
      progress();
    }
  };

  const handle = async (op: string, payload: unknown): Promise<unknown> => {
    switch (op) {
      case 'agent':
        return agentCall(payload as { prompt: string; opts: WfAgentOpts });
      case 'put': {
        const { k, v } = payload as { k: string; v: unknown };
        return putArtifact(String(k), typeof v === 'string' ? v : JSON.stringify(v));
      }
      case 'get': {
        const { k } = payload as { k: string };
        const raw = store.get(String(k).replace(/[^\w.-]+/g, '_').slice(0, 80));
        if (raw === undefined) return null;
        try {
          return JSON.parse(raw);
        } catch {
          return raw;
        }
      }
      case 'list':
        return [...store.keys()];
      case 'log':
        hooks.progress(`${String((payload as { text: string }).text).slice(0, 500)}\n`);
        return null;
      case 'phase': {
        const name = String((payload as { name: string }).name).slice(0, 80);
        phases.push(name);
        hooks.onPhase?.(name);
        progress(true);
        return null;
      }
      default:
        throw new Error(`Thao tác không hợp lệ: ${op}`);
    }
  };

  return new Promise<WorkflowResult>((resolve) => {
    let settled = false;
    const finish = (r: WorkflowResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener('abort', onAbort);
      progress(true);
      void worker.terminate();
      resolve(r);
    };
    const human = limits.timeoutMs >= 60_000 ? `${Math.round(limits.timeoutMs / 60_000)} phút` : `${Math.max(1, Math.round(limits.timeoutMs / 1000))} giây`;
    const timer = setTimeout(() => finish(result({ ok: false, error: `Quá thời hạn ${human} nên đã dừng workflow.` })), limits.timeoutMs);
    const onAbort = () => finish(result({ ok: false, error: 'Đã dừng.' }));
    if (input.signal.aborted) return onAbort();
    input.signal.addEventListener('abort', onAbort, { once: true });

    worker.on('message', (m: { t: string; id?: number; op?: string; payload?: string; value?: string; message?: string; stack?: string }) => {
      if (m.t === 'call' && typeof m.id === 'number') {
        let payload: unknown;
        try {
          payload = JSON.parse(m.payload ?? 'null');
        } catch {
          payload = null;
        }
        handle(String(m.op), payload).then(
          (v) => worker.postMessage({ t: 'reply', id: m.id, ok: true, value: JSON.stringify(v === undefined ? null : v) }),
          (e) => worker.postMessage({ t: 'reply', id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) }),
        );
      } else if (m.t === 'done') {
        let value: unknown;
        try {
          value = JSON.parse(m.value ?? 'null');
        } catch {
          value = null;
        }
        finish(result({ ok: true, value }));
      } else if (m.t === 'error') {
        finish(result({ ok: false, error: m.message || 'Script lỗi.' }));
      }
    });
    worker.on('error', (e) => finish(result({ ok: false, error: `Worker lỗi: ${e instanceof Error ? e.message : String(e)}` })));
    worker.on('exit', (code) => {
      if (!settled) finish(result({ ok: false, error: code === 0 ? 'Script kết thúc mà không trả kết quả.' : `Worker dừng bất thường (mã ${code}); có thể hết bộ nhớ.` }));
    });
  });
}
