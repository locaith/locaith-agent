import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetParamMemory, withRetries } from '../../src/core/providers/http';
import { ProviderRegistry, type AccountProviderHooks, type ProviderRegistryOptions } from '../../src/core/providers/registry';
import { ProviderError, type ProviderEvent } from '../../src/core/types';
import { MockServer, type SseEvent } from '../helpers/mockServer';
import { kinds, req, run, textOfEvents } from './util';

let server: MockServer;
beforeAll(async () => {
  server = await MockServer.start();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => resetParamMemory());
afterEach(() => server.reset());

const TOKEN = `lat_${'Zz9Yy8Xx7W'.repeat(5).slice(0, 43)}`;
const BASE = () => `${server.url}/api/llm/v1`;

const hooks = (over: Partial<AccountProviderHooks> = {}): AccountProviderHooks => ({
  token: () => TOKEN,
  headers: ({ sessionKey, ticket }) => ({
    'x-locaith-client': 'vscode/test',
    'x-locaith-queue': 'ticket',
    ...(sessionKey ? { 'x-locaith-session': sessionKey } : {}),
    ...(ticket ? { 'x-locaith-ticket': ticket } : {}),
  }),
  ...over,
});

const reg = (over: Partial<ProviderRegistryOptions> = {}) =>
  new ProviderRegistry({
    resolveApiKey: async () => undefined,
    env: {},
    baseUrlOverrides: { locaith: BASE() },
    // maxRetries = 0: nếu hàng chờ bị tính như "thử lại" thì mọi test xếp hàng dưới đây sẽ ném lỗi.
    defaultOptions: { retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 5 } },
    account: hooks(),
    ...over,
  });

const chunk = (delta: Record<string, unknown>, finish: string | null = null): SseEvent => ({
  data: { id: 'c1', object: 'chat.completion.chunk', model: 'locaith-v5-flash', choices: [{ index: 0, delta, finish_reason: finish }] },
});
const textStream = (text: string): SseEvent[] => [
  chunk({ role: 'assistant', content: '' }),
  chunk({ content: text }),
  chunk({}, 'stop'),
  { data: { id: 'c1', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } } },
  { data: '[DONE]' },
];
const queueReply = (position: number, ticket = 'q_t1', sec = 1) => ({
  status: 429,
  headers: { 'retry-after': String(sec) },
  json: {
    error: { message: 'Đang có nhiều lượt sử dụng, vui lòng chờ xử lý.', type: 'queue', code: 'locaith_queue' },
    queue: { ticket, position, ahead: position - 1, retry_after_sec: sec, limit: 100, active: 100, waiting: 20 },
  },
});

const locaith = (r = reg()) => r.get('locaith');
/** Chờ một lời hứa phải thất bại; trả về ProviderError. */
const failure = async (p: Promise<unknown>): Promise<ProviderError> => {
  try {
    await p;
  } catch (e) {
    return e as ProviderError;
  }
  throw new Error('mong đợi lỗi nhưng đã thành công');
};
const sessionReq = (over = {}) => req({ model: 'locaith-v5-flash', sessionKey: 'sess-42', ...over });

describe('ProviderRegistry — nhà cung cấp tài khoản Locaith', () => {
  it('chỉ được đăng ký khi nơi chạy cấp `account` (bản trình duyệt không cấp) và đứng đầu danh sách', async () => {
    const without = await new ProviderRegistry({ resolveApiKey: async () => undefined, env: {} }).descriptors();
    expect(without.map((d) => d.id)).toEqual(['anthropic', 'openai', 'gemini', 'deepseek', 'xai']);

    const withAcc = await reg().descriptors();
    expect(withAcc.map((d) => d.id)).toEqual(['locaith', 'anthropic', 'openai', 'gemini', 'deepseek', 'xai']);
    const d = withAcc[0];
    expect(d).toMatchObject({ id: 'locaith', label: 'Locaith AI Local', kind: 'openai-chat', flavor: 'deepseek', builtin: true, account: true, keyFromEnv: false, defaultModel: 'locaith-v5-flash' });
    expect(withAcc.slice(1).every((x) => x.account === false)).toBe(true);
  });

  it('`hasKey` = đã đăng nhập (có token); không đọc kho khoá API và không đọc biến môi trường', async () => {
    const asked: string[] = [];
    const r = reg({ resolveApiKey: async (id) => (asked.push(id), 'sk-should-not-be-used'), env: { LOCAITH_API_KEY: 'sk-env-should-not-be-used' } });
    expect((await r.descriptors()).find((d) => d.id === 'locaith')!.hasKey).toBe(true);
    expect(asked).not.toContain('locaith');
    const signedOut = reg({ account: hooks({ token: () => undefined }) });
    expect((await signedOut.descriptors()).find((d) => d.id === 'locaith')!.hasKey).toBe(false);
  });

  it('danh sách model dự phòng 1M token; chọn model nhanh = Locaith-v5-flash', async () => {
    const r = reg();
    const d = (await r.descriptors()).find((x) => x.id === 'locaith')!;
    expect(d.fallbackModels.map((m) => m.id)).toEqual(['locaith-v5-flash', 'locaith-v5-si']);
    expect(await r.pickFastModel('locaith')).toBe('locaith-v5-flash');
  });

  it('danh sách model thật từ cổng: giữ cửa sổ 1M + trần đầu ra, bổ sung bậc/suy luận từ danh sách dự phòng, giữ cả model mang tên locaith-*', async () => {
    server.reply({
      json: {
        object: 'list',
        data: [
          { id: 'locaith-v5-flash', object: 'model', owned_by: 'locaith', name: 'Locaith-v5-flash', context_length: 1_000_000, max_output_tokens: 393_216, reasoning: false, tier: 'fast' },
          { id: 'locaith-v5-si', object: 'model', owned_by: 'locaith', name: 'Locaith-v5-SI', context_length: 1_000_000, max_output_tokens: 393_216, reasoning: true, tier: 'top' },
        ],
        capacity: { limit: 100, active: 3, waiting: 0 },
      },
    });
    const r = reg();
    const res = await r.catalog.list('locaith');
    expect(res.source).toBe('live');
    expect(res.models.map((m) => [m.id, m.label, m.contextWindow, m.maxOutputTokens, m.tier, m.reasoning])).toEqual([
      ['locaith-v5-flash', 'Locaith-v5-flash', 1_000_000, 393_216, 'fast', true],
      ['locaith-v5-si', 'Locaith-v5-SI', 1_000_000, 393_216, 'top', true],
    ]);
    const http = server.lastRequest;
    expect(http.method).toBe('GET');
    expect(http.path).toBe('/api/llm/v1/models');
    expect(http.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(http.headers['x-locaith-client']).toBe('vscode/test');
  });

  it('chưa đăng nhập: không gọi mạng lấy danh sách model, dùng danh sách dự phòng', async () => {
    const r = reg({ account: hooks({ token: () => undefined }) });
    const res = await r.catalog.list('locaith');
    expect(res.source).toBe('fallback');
    expect(server.requests).toHaveLength(0);
  });
});

describe('stream tới cổng Locaith', () => {
  it('khoá = token tài khoản; tiêu đề client/phiên/hàng chờ; thân yêu cầu theo kiểu DeepSeek (thinking + reasoning_effort)', async () => {
    server.reply({ sse: textStream('Xin chào') });
    const { events, done } = await run(locaith(), sessionReq());
    expect(textOfEvents(events)).toBe('Xin chào');
    expect(done.message.content).toEqual([{ type: 'text', text: 'Xin chào', provider: 'locaith' }]);
    const r = server.lastRequest;
    expect(r.path).toBe('/api/llm/v1/chat/completions');
    expect(r.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(r.headers['x-locaith-client']).toBe('vscode/test');
    expect(r.headers['x-locaith-queue']).toBe('ticket');
    expect(r.headers['x-locaith-session']).toBe('sess-42');
    expect(r.headers['x-locaith-ticket']).toBeUndefined();
    expect(r.json).toMatchObject({ model: 'locaith-v5-flash', stream: true, thinking: { type: 'enabled' }, reasoning_effort: 'high' });
    expect(r.json.stream_options).toEqual({ include_usage: true });
  });

  it('mức suy luận "off" → thinking disabled (cổng đặt mặc định theo model, máy khách luôn nói rõ ý mình)', async () => {
    server.reply({ sse: textStream('ok') });
    await run(locaith(), sessionReq({ thinking: { level: 'off', summaries: false } }));
    expect(server.lastRequest.json.thinking).toEqual({ type: 'disabled' });
    expect(server.lastRequest.json.reasoning_effort).toBeUndefined();
  });

  it('suy luận hiển thị (reasoning_content) đi qua như DeepSeek', async () => {
    server.reply({ sse: [chunk({ role: 'assistant', reasoning_content: 'Cân nhắc… ' }), chunk({ content: 'Kết quả' }), chunk({}, 'stop'), { data: '[DONE]' }] });
    const { done } = await run(locaith(), sessionReq());
    expect(done.message.content.map((b) => b.type)).toEqual(['thinking', 'text']);
  });

  it('HÀNG CHỜ: 429 locaith_queue → sự kiện queue (vị trí, mốc thử lại) → gửi lại CÙNG yêu cầu kèm vé → queue_end khi được nhận; không tính vào số lần thử lại', async () => {
    server.reply(queueReply(3, 'q_abc')).reply(queueReply(1, 'q_abc')).reply({ sse: textStream('Đã vào được') });
    const before = Date.now();
    const events: ProviderEvent[] = [];
    for await (const ev of locaith().stream(sessionReq())) events.push(ev);

    expect(kinds(events)).toEqual(['queue', 'queue', 'queue_end', 'text_delta', 'usage', 'done']);
    const [q1, q2] = events.filter((e): e is Extract<ProviderEvent, { type: 'queue' }> => e.type === 'queue');
    expect(q1).toMatchObject({ position: 3, ahead: 2, attempt: 1, waitMs: 1000, limit: 100, active: 100, waiting: 20 });
    expect(q2).toMatchObject({ position: 1, ahead: 0, attempt: 2, waitMs: 1000 });
    // Mốc `retryAt` tính từ lúc nhận được 429 (đồng hồ máy này) để giao diện đếm ngược từng giây.
    expect(q1.retryAt).toBeGreaterThanOrEqual(before + 1000);
    expect(q1.retryAt).toBeLessThan(before + 2500);
    expect(textOfEvents(events)).toBe('Đã vào được');

    // Ba lần gọi, CÙNG thân yêu cầu; vé chỉ từ lần hỏi lại; tiêu đề hàng chờ luôn có.
    expect(server.requests.map((r) => r.path)).toEqual(Array(3).fill('/api/llm/v1/chat/completions'));
    expect(server.requests.map((r) => r.headers['x-locaith-ticket'])).toEqual([undefined, 'q_abc', 'q_abc']);
    expect(new Set(server.requests.map((r) => JSON.stringify(r.json))).size).toBe(1);
    expect(server.requests.every((r) => r.headers['x-locaith-queue'] === 'ticket' && r.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
  }, 15_000);

  it('bấm Dừng khi đang xếp hàng → thoát ngay (aborted), không gửi lại, và báo cổng rời hàng: POST /queue/leave {ticket}', async () => {
    server.reply(queueReply(5, 'q_leave', 30)).reply({ json: { ok: true } });
    const ctl = new AbortController();
    const events: ProviderEvent[] = [];
    let error: unknown;
    try {
      for await (const ev of locaith().stream(sessionReq({ signal: ctl.signal }))) {
        events.push(ev);
        if (ev.type === 'queue') setTimeout(() => ctl.abort(), 20);
      }
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe('aborted');
    expect(kinds(events)).toEqual(['queue']);
    for (let i = 0; i < 40 && !server.requests.some((r) => r.path.endsWith('/queue/leave')); i++) await new Promise((r) => setTimeout(r, 25));
    const leave = server.requests.find((r) => r.path === '/api/llm/v1/queue/leave');
    expect(leave).toBeDefined();
    expect(leave!.method).toBe('POST');
    expect(leave!.json).toEqual({ ticket: 'q_leave' });
    expect(leave!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    // Không có lần gửi lại chat/completions sau khi dừng.
    expect(server.requests.filter((r) => r.path.endsWith('/chat/completions'))).toHaveLength(1);
  }, 10_000);

  it('403 locaith_consent_required → ProviderError "consent_required" (không thử lại, không phải lỗi chung)', async () => {
    server.reply({ status: 403, json: { error: { message: 'Hãy đồng ý thông báo dữ liệu trong ứng dụng.', type: 'consent', code: 'locaith_consent_required' } } });
    await expect(run(locaith(), sessionReq())).rejects.toMatchObject({ name: 'ProviderError', kind: 'consent_required', retryable: false, status: 403 });
    expect(server.requests).toHaveLength(1);
  });

  it('401 locaith_unauthorized → "auth" nhắc đăng nhập lại tài khoản (không bảo nhập khoá API)', async () => {
    server.reply({ status: 401, json: { error: { message: 'x', type: 'auth', code: 'locaith_unauthorized' } } });
    const err = await failure(run(locaith(), sessionReq()));
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe('auth');
    expect(err.message).toMatch(/đăng nhập lại tài khoản Locaith/);
    expect(err.message).not.toMatch(/khoá API|khóa API/i);
    expect(server.requests).toHaveLength(1);
  });

  it('CHỐT CHẶN: chưa đồng ý thông báo → lỗi consent_required và KHÔNG có byte nào rời máy', async () => {
    const guarded = reg({ account: hooks({ guard: () => new ProviderError('Cần đồng ý', { kind: 'consent_required', providerId: 'locaith', retryable: false }) }) });
    await expect(run(guarded.get('locaith'), sessionReq())).rejects.toMatchObject({ kind: 'consent_required' });
    expect(server.requests).toHaveLength(0);
    // Danh sách model KHÔNG bị chốt chặn (không mang nội dung người dùng).
    server.reply({ json: { data: [{ id: 'locaith-v5-flash' }] } });
    await expect(guarded.get('locaith').fetchModels()).resolves.toHaveLength(1);
  });

  it('chưa đăng nhập: báo cần đăng nhập tài khoản Locaith (không nói "đặt khoá API"), không gọi mạng', async () => {
    const out = reg({ account: hooks({ token: () => undefined }) });
    const err = await failure(run(out.get('locaith'), sessionReq()));
    expect(err.kind).toBe('auth');
    expect(err.message).toBe('Cần đăng nhập tài khoản Locaith để dùng mô hình này.');
    expect(server.requests).toHaveLength(0);
  });

  it('token không bao giờ lọt vào thông báo lỗi dù máy chủ phản chiếu nó trong thân', async () => {
    server.reply({ status: 500, json: { error: { message: `lỗi với ${TOKEN}` } } });
    const err = await failure(run(locaith(reg({ defaultOptions: { retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 2 } } })), sessionReq()));
    expect(err).toBeInstanceOf(ProviderError);
    expect(`${err.message} ${err.details ?? ''}`).not.toContain(TOKEN);
  });
});

describe('withRetries — hàng chờ so với thử lại thông thường', () => {
  const cfg = (signal = new AbortController().signal, extra: Record<string, unknown> = {}) => ({
    providerId: 'locaith',
    signal,
    policy: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 2 },
    ...extra,
  });
  const queued = (position: number, ms: number, ticket?: string) =>
    new ProviderError('đợi', { kind: 'queued', providerId: 'locaith', retryable: true, status: 429, retryAfterMs: ms, queue: { position, ahead: position - 1, retryAfterMs: ms, ...(ticket ? { ticket } : {}) } });

  it('nhiều lượt xếp hàng liên tiếp không làm cạn maxRetries; lỗi 5xx thường vẫn bị giới hạn như cũ', async () => {
    let n = 0;
    const seenTickets: (string | undefined)[] = [];
    const events: ProviderEvent[] = [];
    // Dùng thời gian chờ thật rất ngắn (kẹp 1 giây chỉ áp ở bước phân tích phản hồi; ở đây nhét thẳng lỗi nên 5 ms).
    for await (const ev of withRetries(cfg(), async function* (st) {
      seenTickets.push(st.ticket);
      if (++n <= 4) throw queued(5 - n, 5, `q${n}`);
      yield { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 }, message: { role: 'assistant', content: [] } };
    })) events.push(ev);
    expect(kinds(events)).toEqual(['queue', 'queue', 'queue', 'queue', 'done']);
    expect(seenTickets).toEqual([undefined, 'q1', 'q2', 'q3', 'q4']); // vé mới nhất luôn được trao cho lần gọi kế tiếp
    expect(events.filter((e) => e.type === 'queue').map((e) => (e as { attempt: number }).attempt)).toEqual([1, 2, 3, 4]);

    let m = 0;
    await expect(
      (async () => {
        for await (const _ of withRetries(cfg(), async function* () {
          m++;
          throw new ProviderError('boom', { kind: 'server', providerId: 'locaith', status: 500 });
        })) void _;
      })(),
    ).rejects.toMatchObject({ kind: 'server' });
    expect(m).toBe(2); // 1 lần đầu + đúng maxRetries = 1 lần thử lại
  });

  it('dừng giữa lúc chờ → ném aborted và gọi onQueueLeave(vé cuối); không xếp hàng thì KHÔNG gọi', async () => {
    const leaves: (string | undefined)[] = [];
    const ctl = new AbortController();
    const gen = withRetries(cfg(ctl.signal, { onQueueLeave: (t: string | undefined) => leaves.push(t) }), async function* () {
      throw queued(2, 60_000, 'q_x');
    });
    const first = await gen.next();
    expect(first.value).toMatchObject({ type: 'queue', position: 2 });
    setTimeout(() => ctl.abort(), 10);
    await expect(gen.next()).rejects.toMatchObject({ kind: 'aborted' });
    expect(leaves).toEqual(['q_x']);

    const none: (string | undefined)[] = [];
    const ctl2 = new AbortController();
    ctl2.abort();
    await expect(
      (async () => {
        for await (const _ of withRetries(cfg(ctl2.signal, { onQueueLeave: (t: string | undefined) => none.push(t) }), async function* () {
          throw new ProviderError('network', { kind: 'network', providerId: 'locaith' });
        })) void _;
      })(),
    ).rejects.toMatchObject({ kind: 'aborted' });
    expect(none).toEqual([]);
  });

  it('mốc retryAt = đồng hồ hiện tại + thời gian chờ (đồng hồ tiêm được)', async () => {
    const t = 1_000_000;
    const gen = withRetries(cfg(undefined, { now: () => t }), async function* () {
      throw queued(9, 40, 'q9');
    });
    const ev = (await gen.next()).value as Extract<ProviderEvent, { type: 'queue' }>;
    expect(ev).toMatchObject({ type: 'queue', position: 9, ahead: 8, attempt: 1, waitMs: 40, retryAt: 1_000_040 });
    await gen.return?.(undefined);
  });
});

// ── Lỗi của cổng, qua provider thật với fetch giả (không mạng, giờ giả) ──────────────────────────────────────────

interface Reply {
  status: number;
  headers?: Record<string, string>;
  json?: unknown;
  sse?: string;
}
function scripted(replies: Reply[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const r = replies.shift();
    if (!r) throw new Error('hết kịch bản fetch giả');
    calls.push({ url, headers: init.headers as Record<string, string> });
    const headers = new Headers(r.headers ?? {});
    if (r.sse !== undefined) {
      headers.set('content-type', 'text/event-stream');
      return new Response(r.sse, { status: r.status, headers });
    }
    headers.set('content-type', 'application/json');
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status, headers });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const err = (code: string, message: string, status: number, headers: Record<string, string> = {}): Reply => ({ status, headers, json: { error: { code, type: 'x', message } } });
const OK_SSE = ['data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Xin chào"},"finish_reason":null}]}', 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}', 'data: [DONE]'].join('\n\n') + '\n\n';
/** Chính sách thử lại MẶC ĐỊNH của sản phẩm (4 lần, backoff tới 60 giây): lỗi không được phép thử lại thì vẫn không thử lại dù chính sách cho phép. */
const productRetry = { retry: { maxRetries: 4, baseDelayMs: 1000, maxDelayMs: 60_000 } };
const stubbed = (replies: Reply[], retry = productRetry) => {
  const s = scripted(replies);
  return { ...s, provider: new ProviderRegistry({ resolveApiKey: async () => undefined, env: {}, account: hooks(), baseUrlOverrides: { locaith: 'http://gw.test/api/llm/v1' }, fetchImpl: s.f, defaultOptions: retry }).get('locaith') };
};

describe('lỗi của cổng Locaith qua provider thật (fetch giả)', () => {
  it('locaith_quota: một lần gọi duy nhất, KHÔNG thử lại dù Retry-After là nhiều giờ, lời cổng nguyên văn, không phải câu chung', async () => {
    const msg = 'Hôm nay bạn đã dùng hết hạn mức của mô hình Locaith. Hạn mức làm mới lúc 00:00.';
    const { provider, calls } = stubbed([err('locaith_quota', msg, 429, { 'retry-after': '10800' }), { status: 200, sse: OK_SSE }]);
    const e = await failure(run(provider, sessionReq()));
    expect(calls).toHaveLength(1);
    expect(e).toMatchObject({ kind: 'rate_limit', retryable: false, verbatim: true, message: msg, retryAfterMs: 10_800_000 });
    expect(e.message).not.toMatch(/giới hạn tốc độ|chờ khoảng/);
  });

  it('locaith_rate_limited Retry-After 120 giây: một lần gọi, hiện lời cổng (không tự chờ 2 phút)', async () => {
    const msg = 'Bạn đang gửi quá nhiều yêu cầu cùng lúc.';
    const { provider, calls } = stubbed([err('locaith_rate_limited', msg, 429, { 'retry-after': '120' }), { status: 200, sse: OK_SSE }]);
    const e = await failure(run(provider, sessionReq()));
    expect(calls).toHaveLength(1);
    expect(e).toMatchObject({ kind: 'rate_limit', retryable: false, verbatim: true, message: msg });
  });

  it('locaith_rate_limited Retry-After 5 giây: chờ đúng ~5 giây rồi thử lại và thành công (có sự kiện retry)', async () => {
    vi.useFakeTimers();
    try {
      const { provider, calls } = stubbed([err('locaith_rate_limited', 'chậm lại', 429, { 'retry-after': '5' }), { status: 200, sse: OK_SSE }]);
      const events: ProviderEvent[] = [];
      const done = (async () => {
        for await (const ev of provider.stream(sessionReq())) events.push(ev);
      })();
      await vi.advanceTimersByTimeAsync(4_000);
      expect(calls).toHaveLength(1); // chưa tới giờ
      await vi.advanceTimersByTimeAsync(2_500);
      await done;
      expect(calls).toHaveLength(2);
      expect(kinds(events)).toContain('retry');
      expect(textOfEvents(events)).toBe('Xin chào');
    } finally {
      vi.useRealTimers();
    }
  });

  it('locaith_unavailable (503): thử lại ĐÚNG MỘT lần sau ~3 giây; vẫn 503 thì hiện lời cổng (không thử lần ba)', async () => {
    vi.useFakeTimers();
    try {
      const msg = 'Dịch vụ mô hình Locaith đang bảo trì. Hãy thử lại sau ít phút.';
      const { provider, calls } = stubbed([err('locaith_unavailable', msg, 503), err('locaith_unavailable', msg, 503), { status: 200, sse: OK_SSE }]);
      const outcome = failure(run(provider, sessionReq()));
      await vi.advanceTimersByTimeAsync(2_500);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_500); // ~3 giây (+ nhiễu tối đa 10%)
      await vi.advanceTimersByTimeAsync(60_000); // dù chờ lâu cũng không có lần thứ ba
      const e = await outcome;
      expect(calls).toHaveLength(2);
      expect(e).toMatchObject({ kind: 'overloaded', verbatim: true, message: msg });
    } finally {
      vi.useRealTimers();
    }
  });

  it('locaith_unavailable rồi hồi phục ở lần thử lại → thành công', async () => {
    vi.useFakeTimers();
    try {
      const { provider, calls } = stubbed([err('locaith_unavailable', 'bảo trì', 503), { status: 200, sse: OK_SSE }]);
      const events: ProviderEvent[] = [];
      const done = (async () => {
        for await (const ev of provider.stream(sessionReq())) events.push(ev);
      })();
      await vi.advanceTimersByTimeAsync(4_000);
      await done;
      expect(calls).toHaveLength(2);
      expect(textOfEvents(events)).toBe('Xin chào');
    } finally {
      vi.useRealTimers();
    }
  });

  it('locaith_unauthorized (401): accountAuth, một lần gọi, không thử lại', async () => {
    const { provider, calls } = stubbed([err('locaith_unauthorized', 'token không hợp lệ', 401)]);
    const e = await failure(run(provider, sessionReq()));
    expect(calls).toHaveLength(1);
    expect(e).toMatchObject({ kind: 'auth', retryable: false, accountAuth: true });
    expect(e.message).toMatch(/đăng nhập lại tài khoản Locaith/);
  });

  it('locaith_model_not_found (404): một lần gọi, lời cổng nguyên văn', async () => {
    const msg = 'Không có mô hình "locaith-v9".';
    const { provider, calls } = stubbed([err('locaith_model_not_found', msg, 404)]);
    const e = await failure(run(provider, sessionReq({ model: 'locaith-v9' })));
    expect(calls).toHaveLength(1);
    expect(e).toMatchObject({ kind: 'not_found', retryable: false, verbatim: true, message: msg });
  });

  it('lỗi 429 THƯỜNG (không mang mã locaith_) vẫn đi đường cũ: rate_limit có thử lại', async () => {
    vi.useFakeTimers();
    try {
      const { provider, calls } = stubbed([{ status: 429, headers: { 'retry-after': '1' }, json: { error: { message: 'slow down' } } }, { status: 200, sse: OK_SSE }]);
      const events: ProviderEvent[] = [];
      const done = (async () => {
        for await (const ev of provider.stream(sessionReq())) events.push(ev);
      })();
      await vi.advanceTimersByTimeAsync(2_000);
      await done;
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
