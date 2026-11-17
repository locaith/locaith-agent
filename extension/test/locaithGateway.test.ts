import { describe, expect, it } from 'vitest';
import {
  AUTH_MESSAGE,
  CONSENT_MESSAGE,
  LOCAITH_CONTEXT_WINDOW,
  LOCAITH_GATEWAY_URL,
  LOCAITH_MAX_OUTPUT_TOKENS,
  LOCAITH_NOTICE_VERSION,
  LOCAITH_UPGRADE_URL,
  LocaithGatewayClient,
  PLAN_REQUIRED_DEFAULT_MESSAGE,
  QUEUE_DEFAULT_WAIT_MS,
  QUEUE_MAX_WAIT_MS,
  QUEUE_MIN_WAIT_MS,
  classifyGatewayError,
  queueWaitMs,
  safeUpgradeUrl,
} from '../src/core/providers/locaithGateway';
import { classifyHttpError, redactSecrets } from '../src/core/providers/http';
import { knownContextWindow, presetById, ACCOUNT_PRESETS, BUILTIN_PRESETS } from '../src/core/providers/presets';
import { ProviderError } from '../src/core/types';

const TOKEN = `lat_${'A1b2C3d4E5'.repeat(4).slice(0, 43)}`;

const queueBody = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    error: { message: 'Đang có nhiều lượt sử dụng, vui lòng chờ xử lý.', type: 'queue', code: 'locaith_queue' },
    queue: { ticket: 'q_9f3c1a', position: 7, ahead: 6, retry_after_sec: 8, limit: 100, active: 100, waiting: 23, ...over },
  });

describe('classifyGatewayError — phản hồi đặc biệt của cổng Locaith', () => {
  it('429 locaith_queue → ProviderError "queued" mang vị trí, vé, thời gian chờ và số liệu hàng', () => {
    const e = classifyGatewayError('locaith', 429, queueBody(), undefined)!;
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.kind).toBe('queued');
    expect(e.status).toBe(429);
    expect(e.retryable).toBe(true);
    expect(e.message).toBe('Đang có nhiều lượt sử dụng, vui lòng chờ xử lý.');
    expect(e.queue).toEqual({ ticket: 'q_9f3c1a', position: 7, ahead: 6, retryAfterMs: 8000, limit: 100, active: 100, waiting: 23 });
  });

  it('thiếu thân `queue` vẫn là hàng chờ hợp lệ (vị trí 1, chờ mặc định) — không bao giờ rơi thành lỗi chung', () => {
    const e = classifyGatewayError('locaith', 429, JSON.stringify({ error: { code: 'locaith_queue', message: '' } }), undefined)!;
    expect(e.kind).toBe('queued');
    expect(e.queue).toMatchObject({ position: 1, ahead: 0, retryAfterMs: QUEUE_DEFAULT_WAIT_MS });
    expect(e.message).toMatch(/nhiều lượt sử dụng/);
  });

  it('thời gian chờ: thân `retry_after_sec` thắng tiêu đề Retry-After, và bị kẹp trong [1 giây, 60 giây]', () => {
    expect(queueWaitMs(8, 3000)).toBe(8000);
    expect(queueWaitMs(undefined, 3000)).toBe(3000);
    expect(queueWaitMs(undefined, undefined)).toBe(QUEUE_DEFAULT_WAIT_MS);
    expect(queueWaitMs(0, undefined)).toBe(QUEUE_MIN_WAIT_MS);
    expect(queueWaitMs(100000, undefined)).toBe(QUEUE_MAX_WAIT_MS);
    expect(classifyGatewayError('locaith', 429, queueBody({ retry_after_sec: undefined }), 4000)!.queue?.retryAfterMs).toBe(4000);
  });

  it('số liệu vô lý từ máy chủ bị chặn (vị trí âm / quá lớn, vé quá dài)', () => {
    const e = classifyGatewayError('locaith', 429, queueBody({ position: -5, ahead: 'x', ticket: 'q_'.padEnd(500, 'a') }), undefined)!;
    expect(e.queue?.position).toBe(1);
    expect(e.queue?.ticket).toBeUndefined();
  });

  it('403 locaith_consent_required → "consent_required", không thử lại', () => {
    const e = classifyGatewayError('locaith', 403, JSON.stringify({ error: { code: 'locaith_consent_required', message: 'Hãy đồng ý thông báo trong ứng dụng.' } }), undefined)!;
    expect(e.kind).toBe('consent_required');
    expect(e.retryable).toBe(false);
    expect(e.message).toBe('Hãy đồng ý thông báo trong ứng dụng.');
    expect(classifyGatewayError('locaith', 403, JSON.stringify({ error: { code: 'locaith_consent_required' } }), undefined)!.message).toBe(CONSENT_MESSAGE);
  });

  it('401 locaith_unauthorized → "auth" với lời nhắc đăng nhập lại tài khoản Locaith (không nói chuyện "khoá API")', () => {
    const e = classifyGatewayError('locaith', 401, JSON.stringify({ error: { code: 'locaith_unauthorized', message: 'x' } }), undefined)!;
    expect(e.kind).toBe('auth');
    expect(e.message).toBe(AUTH_MESSAGE);
    expect(e.message).not.toMatch(/khoá API|khóa API/i);
  });

  it('không phải mã của cổng → undefined (để phân loại HTTP chung xử lý)', () => {
    expect(classifyGatewayError('x', 429, JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'slow down' } }), undefined)).toBeUndefined();
    expect(classifyGatewayError('x', 429, 'Too Many Requests', undefined)).toBeUndefined();
    // Phân loại theo MÃ lỗi chứ không theo mã HTTP (503 bảo trì, 404 sai model cũng là mã của cổng); thân không phải JSON thì để đường chung.
    expect(classifyGatewayError('x', 500, '<html>Bad gateway</html>', undefined)).toBeUndefined();
    expect(classifyGatewayError('x', 429, '[1,2]', undefined)).toBeUndefined();
    // Mã locaith_ không có xử lý riêng (bad_request, upstream_error…) → đường chung, nhờ vậy lời lẽ tràn ngữ cảnh vẫn được nhận ra.
    expect(classifyGatewayError('x', 429, JSON.stringify({ error: { code: 'locaith_bad_request' } }), undefined)).toBeUndefined();
  });

  it('classifyHttpError dùng nó trước phân loại chung: 429 hàng chờ KHÔNG thành "rate_limit"; 429 thường vẫn là rate_limit', () => {
    const headers = new Headers({ 'retry-after': '8' });
    expect(classifyHttpError('locaith', 429, queueBody(), headers).kind).toBe('queued');
    expect(classifyHttpError('locaith', 429, JSON.stringify({ error: { code: 'locaith_rate_limited', message: 'quá nhanh' } }), headers).kind).toBe('rate_limit');
    expect(classifyHttpError('openai', 429, JSON.stringify({ error: { message: 'slow down' } }), headers).kind).toBe('rate_limit');
  });
});

describe('classifyGatewayError — các mã lỗi khác của cổng (lời của cổng hiện NGUYÊN VĂN)', () => {
  const body = (code: string, message?: string) => JSON.stringify({ error: { code, type: 'x', ...(message !== undefined ? { message } : {}) } });
  const HOURS = 3 * 3600 * 1000;

  it('locaith_quota (hết hạn mức chi tiêu trong NGÀY): kind rate_limit nhưng KHÔNG BAO GIỜ thử lại dù Retry-After là nhiều giờ; lời cổng giữ nguyên', () => {
    const msg = 'Hôm nay bạn đã dùng hết hạn mức của mô hình Locaith (làm mới lúc 00:00). Hãy quay lại vào ngày mai hoặc dùng API key riêng.';
    const e = classifyGatewayError('locaith', 429, body('locaith_quota', msg), HOURS)!;
    expect(e).toBeInstanceOf(ProviderError);
    expect(e).toMatchObject({ kind: 'rate_limit', retryable: false, verbatim: true, status: 429, retryAfterMs: HOURS, message: msg });
    expect(e.accountAuth).toBeUndefined();
    // Qua classifyHttpError (đường thật): cùng kết quả, KHÔNG phải câu chung "Đã chạm giới hạn tốc độ… chờ N phút".
    const viaHttp = classifyHttpError('locaith', 429, body('locaith_quota', msg), new Headers({ 'retry-after': String(3 * 3600) }));
    expect(viaHttp.message).toBe(msg);
    expect(viaHttp.message).not.toMatch(/giới hạn tốc độ|chờ khoảng|phút/);
    // Không có lời kèm theo: dùng câu tiếng Việt mặc định (vẫn không phải câu chung).
    expect(classifyGatewayError('locaith', 429, body('locaith_quota'), undefined)!.message).toMatch(/hạn mức/);
  });

  it('locaith_rate_limited: chỉ tự thử lại khi Retry-After ≤ 60 giây (hoặc không có); lâu hơn thì không thử lại và hiện lời cổng', () => {
    const msg = 'Bạn đang gửi quá nhiều yêu cầu cùng lúc. Hãy chờ một lát.';
    const quick = classifyGatewayError('locaith', 429, body('locaith_rate_limited', msg), 5_000)!;
    expect(quick).toMatchObject({ kind: 'rate_limit', retryable: true, verbatim: true, retryAfterMs: 5_000, message: msg });
    expect(classifyGatewayError('locaith', 429, body('locaith_rate_limited', msg), 60_000)!.retryable).toBe(true);
    expect(classifyGatewayError('locaith', 429, body('locaith_rate_limited', msg), undefined)!.retryable).toBe(true);
    const slow = classifyGatewayError('locaith', 429, body('locaith_rate_limited', msg), 60_001)!;
    expect(slow).toMatchObject({ kind: 'rate_limit', retryable: false, verbatim: true, message: msg });
    expect(classifyGatewayError('locaith', 429, body('locaith_rate_limited', msg), HOURS)!.retryable).toBe(false);
  });

  it('locaith_unavailable (503 bảo trì): thử lại ĐÚNG MỘT lần sau vài giây (≤ 10 giây), lời cổng giữ nguyên', () => {
    const msg = 'Dịch vụ mô hình Locaith đang bảo trì. Hãy thử lại sau ít phút.';
    const e = classifyGatewayError('locaith', 503, body('locaith_unavailable', msg), undefined)!;
    expect(e).toMatchObject({ kind: 'overloaded', retryable: true, retryLimit: 1, verbatim: true, status: 503, retryAfterMs: 3_000, message: msg });
    expect(classifyGatewayError('locaith', 503, body('locaith_unavailable', msg), 5_000)!.retryAfterMs).toBe(5_000);
    expect(classifyGatewayError('locaith', 503, body('locaith_unavailable', msg), HOURS)!.retryAfterMs).toBe(10_000);
    expect(classifyGatewayError('locaith', 503, body('locaith_unavailable', msg), 10)!.retryAfterMs).toBe(1_000);
  });

  it('locaith_unauthorized (401): lỗi xác thực của TÀI KHOẢN (accountAuth), không thử lại, không nói chuyện khoá API', () => {
    const e = classifyGatewayError('locaith', 401, body('locaith_unauthorized', 'x'), undefined)!;
    expect(e).toMatchObject({ kind: 'auth', retryable: false, accountAuth: true, status: 401, message: AUTH_MESSAGE });
    expect(e.verbatim).toBeUndefined();
  });

  it('locaith_model_not_found (404): không thử lại, hiện lời cổng', () => {
    const msg = 'Không có mô hình "locaith-v9". Hãy chọn Locaith-v5-flash hoặc Locaith-v5-SI.';
    const e = classifyGatewayError('locaith', 404, body('locaith_model_not_found', msg), undefined)!;
    expect(e).toMatchObject({ kind: 'not_found', retryable: false, verbatim: true, status: 404, message: msg });
  });

  it('lời của cổng được làm sạch: bỏ ký tự điều khiển, cắt ở 600 ký tự; mã locaith_ lạ → undefined (đường chung xử lý)', () => {
    const e = classifyGatewayError('locaith', 429, body('locaith_quota', '\u0007Hết \u0000hạn mức\u001b.' + 'x'.repeat(900)), undefined)!;
    expect(e.message.startsWith('Hết hạn mức.')).toBe(true);
    expect(e.message.length).toBe(600);
    expect(classifyGatewayError('locaith', 500, body('locaith_bad_request', 'sai'), undefined)).toBeUndefined();
    expect(classifyGatewayError('locaith', 502, body('locaith_upstream_error', 'lỗi'), undefined)).toBeUndefined();
    expect(classifyGatewayError('locaith', 429, body('khong_phai_locaith', 'x'), undefined)).toBeUndefined();
  });

  it('thân 400 "locaith_bad_request" và lời lẽ ngữ cảnh-quá-dài KHÔNG bị chặn: vẫn đi đường chung để phát hiện tràn ngữ cảnh', () => {
    const ctx = JSON.stringify({ error: { code: 'locaith_bad_request', message: "This model's maximum context length is 1000000 tokens. However, you requested 1200000 tokens." } });
    expect(classifyHttpError('locaith', 400, ctx, undefined).kind).toBe('context_length');
  });
});

describe('402 locaith_quota — hết dùng thử miễn phí 1 ngày, cần mua gói (từ 17/11/2026)', () => {
  const MSG = 'Bạn đã dùng hết 1 ngày dùng thử miễn phí Locaith-v5 của tài khoản này. Hãy mua gói tại https://locaith.ai/#upgrade để dùng tiếp — hoặc chọn mô hình khác bằng API riêng của bạn.';
  const body = (ent: unknown, message: string | null = MSG) =>
    JSON.stringify({ error: { code: 'locaith_quota', type: 'insufficient_quota', ...(message !== null ? { message } : {}) }, ...(ent !== undefined ? { entitlement: ent } : {}) });
  const ENT = { state: 'trial_ended', trial_hours: 24, upgrade_url: 'https://locaith.ai/#upgrade' };

  it('mang khối entitlement: không bao giờ thử lại, lời cổng nguyên văn, có địa chỉ mua gói', () => {
    const e = classifyGatewayError('locaith', 402, body(ENT), undefined)!;
    expect(e).toMatchObject({ kind: 'rate_limit', retryable: false, verbatim: true, status: 402, gatewayCode: 'locaith_quota', message: MSG });
    expect(e.entitlement).toEqual({ state: 'trial_ended', trialHours: 24, upgradeUrl: 'https://locaith.ai/#upgrade' });
    // Qua classifyHttpError (đường thật của mọi lần gọi): cùng kết quả, KHÔNG phải câu chung «đã hết hạn mức hoặc chưa kích hoạt thanh toán».
    const viaHttp = classifyHttpError('locaith', 402, body(ENT), new Headers());
    expect(viaHttp.entitlement?.upgradeUrl).toBe('https://locaith.ai/#upgrade');
    expect(viaHttp.message).toBe(MSG);
    expect(viaHttp.message).not.toMatch(/chưa kích hoạt thanh toán/);
  });

  it('cổng đã bỏ khối entitlement nhưng vẫn HTTP 402 → vẫn là «cần gói» với địa chỉ chuẩn; 429 không có khối → hạn mức NGÀY như cũ', () => {
    const e402 = classifyGatewayError('locaith', 402, body(undefined), undefined)!;
    expect(e402.entitlement).toEqual({ state: 'trial_ended', upgradeUrl: LOCAITH_UPGRADE_URL });
    expect(classifyGatewayError('locaith', 402, body(undefined, null), undefined)!.message).toBe(PLAN_REQUIRED_DEFAULT_MESSAGE);
    const e429 = classifyGatewayError('locaith', 429, body(undefined, 'Hết hạn mức hôm nay.'), 3_600_000)!;
    expect(e429.entitlement).toBeUndefined();
    expect(e429).toMatchObject({ status: 429, retryable: false, verbatim: true });
    // trạng thái lạ trong khối ở một 429: không phải «cần gói»
    expect(classifyGatewayError('locaith', 429, body({ state: 'paid' }, 'x'), undefined)!.entitlement).toBeUndefined();
  });

  it('địa chỉ mua gói: chỉ https + tên miền Locaith; mọi thứ khác (máy chủ lạ nói giọng cổng) → địa chỉ chuẩn', () => {
    const url = (u: unknown) => classifyGatewayError('locaith', 402, body({ ...ENT, upgrade_url: u }), undefined)!.entitlement!.upgradeUrl;
    expect(url('https://locaith.ai/#upgrade')).toBe('https://locaith.ai/#upgrade');
    expect(url('https://www.locaith.ai/goi?from=cli')).toBe('https://www.locaith.ai/goi?from=cli');
    expect(url('https://pay.locaith.com/plans')).toBe('https://pay.locaith.com/plans');
    for (const bad of ['http://locaith.ai/#upgrade', 'https://evil.example/#upgrade', 'https://locaith.ai.evil.example/', 'https://evil.example/locaith.ai', 'https://user:pw@locaith.ai/', 'javascript:alert(1)', 'https://notlocaith.ai/', 'ftp://locaith.ai/', '', 5, null, 'x'.repeat(400)]) {
      expect(url(bad)).toBe(LOCAITH_UPGRADE_URL);
    }
    expect(safeUpgradeUrl(undefined)).toBe(LOCAITH_UPGRADE_URL);
  });

  it('trial_hours bất thường bị bỏ (không tin số vô lý), còn lại vẫn là «cần gói»', () => {
    for (const h of [-1, 1e9, 'x', null]) {
      const e = classifyGatewayError('locaith', 402, body({ ...ENT, trial_hours: h }), undefined)!;
      expect(e.entitlement).toEqual({ state: 'trial_ended', upgradeUrl: LOCAITH_UPGRADE_URL });
    }
    expect(classifyGatewayError('locaith', 402, body({ ...ENT, trial_hours: 0 }), undefined)!.entitlement?.trialHours).toBe(0);
  });
});

describe('token tài khoản không lọt vào log / thông báo lỗi', () => {
  it('redactSecrets che token lat_… (đứng một mình, trong Bearer, trong thân JSON)', () => {
    expect(redactSecrets(`token ${TOKEN} hết hạn`)).not.toContain(TOKEN);
    expect(redactSecrets(`Authorization: Bearer ${TOKEN}`)).not.toContain(TOKEN);
    expect(redactSecrets(JSON.stringify({ message: `bad ${TOKEN}` }))).not.toContain(TOKEN);
  });

  it('thông báo lỗi và chi tiết của ProviderError không chứa token dù máy chủ phản chiếu nó', () => {
    const body = JSON.stringify({ error: { message: `Invalid for ${TOKEN}`, code: 'x' } });
    const e = classifyHttpError('locaith', 500, body, undefined, [TOKEN]);
    expect(e.message).not.toContain(TOKEN);
    expect(e.details ?? '').not.toContain(TOKEN);
  });
});

describe('preset Locaith và cửa sổ ngữ cảnh', () => {
  it('preset tài khoản: id locaith, openai-chat/deepseek, cổng đúng, khoá = token tài khoản, hai model 1M token', () => {
    const p = presetById('locaith')!;
    expect(ACCOUNT_PRESETS.map((x) => x.id)).toEqual(['locaith']);
    expect(p).toMatchObject({ label: 'Locaith AI Local', kind: 'openai-chat', flavor: 'deepseek', baseUrl: LOCAITH_GATEWAY_URL, credential: 'account', defaultModel: 'locaith-v5-flash' });
    expect(LOCAITH_GATEWAY_URL).toBe('https://studio-api.locaith.com/api/llm/v1');
    expect(p.fallbackModels.map((m) => [m.id, m.label, m.tier, m.reasoning])).toEqual([
      ['locaith-v5-flash', 'Locaith-v5-flash', 'fast', true],
      ['locaith-v5-si', 'Locaith-v5-SI', 'top', true],
    ]);
    for (const m of p.fallbackModels) {
      expect(m.contextWindow).toBe(1_000_000);
      expect(m.maxOutputTokens).toBe(393_216);
    }
    expect(LOCAITH_CONTEXT_WINDOW).toBe(1_000_000);
    expect(LOCAITH_MAX_OUTPUT_TOKENS).toBe(393_216);
    // Nhà cung cấp tài khoản KHÔNG nằm trong danh sách dựng sẵn dùng khoá API (bản trình duyệt dùng chung danh sách này).
    expect(BUILTIN_PRESETS.map((x) => x.id)).not.toContain('locaith');
  });

  it('DeepSeek: cả hai model đều 1M token (trước đây rơi về 128K mặc định)', () => {
    const ds = BUILTIN_PRESETS.find((p) => p.id === 'deepseek')!;
    expect(ds.fallbackModels.map((m) => [m.id, m.contextWindow])).toEqual([
      ['deepseek-v4-pro', 1_000_000],
      ['deepseek-flash', 1_000_000],
    ]);
  });

  it('knownContextWindow: tên model đã biết → 1M; tên lạ → undefined (nơi gọi dùng 128K mặc định)', () => {
    for (const id of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4.1-flash', 'locaith-v5-flash', 'locaith-v5-si', 'Locaith-V5-SI']) {
      expect(knownContextWindow(id), id).toBe(1_000_000);
    }
    for (const id of ['deepseek-chat', 'deepseek-reasoner', 'gpt-4o', 'llama-3', '']) expect(knownContextWindow(id), id).toBeUndefined();
  });
});

describe('LocaithGatewayClient — bản ghi đồng ý theo tài khoản', () => {
  function client(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return handler(url, init);
    }) as unknown as typeof fetch;
    return { calls, c: new LocaithGatewayClient({ baseUrl: () => 'http://gw.test/api/llm/v1/', fetch: f }) };
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('GET /consent gửi token qua Bearer, đọc {accepted, version, current}', async () => {
    const { c, calls } = client(() => json(200, { accepted: true, version: 1, current: 1 }));
    const r = await c.getConsent(TOKEN);
    expect(r).toEqual({ ok: true, state: { accepted: true, version: 1, current: 1 } });
    expect(calls[0]).toMatchObject({ url: 'http://gw.test/api/llm/v1/consent', method: 'GET' });
    expect(calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('POST /consent gửi {version, client}; ok:true → ok', async () => {
    const { c, calls } = client(() => json(200, { ok: true }));
    expect(await c.postConsent(TOKEN, LOCAITH_NOTICE_VERSION, 'vscode/0.6.0')).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({ url: 'http://gw.test/api/llm/v1/consent', method: 'POST', body: { version: LOCAITH_NOTICE_VERSION, client: 'vscode/0.6.0' } });
    expect(calls[0].headers['content-type']).toBe('application/json');
  });

  it('phân loại lỗi: 401 → unauthorized · mất mạng → network · 5xx → server · 4xx khác → rejected (kèm lời máy chủ)', async () => {
    expect(await client(() => json(401, {})).c.getConsent(TOKEN)).toEqual({ ok: false, error: 'unauthorized' });
    expect(await client(() => json(401, {})).c.postConsent(TOKEN, 1, 'x')).toEqual({ ok: false, error: 'unauthorized' });
    expect(await client(() => { throw new TypeError('fetch failed'); }).c.getConsent(TOKEN)).toEqual({ ok: false, error: 'network' });
    expect(await client(() => json(500, {})).c.getConsent(TOKEN)).toEqual({ ok: false, error: 'server' });
    expect(await client(() => json(200, { nope: 1 })).c.getConsent(TOKEN)).toEqual({ ok: false, error: 'server' });
    const rej = await client(() => json(422, { error: { message: 'bad version' } })).c.postConsent(TOKEN, 9, 'x');
    expect(rej).toEqual({ ok: false, error: 'rejected', message: 'bad version' });
    expect(await client(() => json(503, { error: { message: 'bảo trì' } })).c.postConsent(TOKEN, 1, 'x')).toMatchObject({ ok: false, error: 'server' });
  });

  it('hết giờ chờ → network (không treo)', async () => {
    const f = ((_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))))) as unknown as typeof fetch;
    const c = new LocaithGatewayClient({ baseUrl: () => 'http://x', fetch: f, timeoutMs: 30 });
    expect(await c.getConsent(TOKEN)).toEqual({ ok: false, error: 'network' });
  });
});
