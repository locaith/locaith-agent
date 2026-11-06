/**
 * Cổng mô hình Locaith GIẢ (`/api/llm/v1/*`) cho kiểm thử: cùng hợp đồng với cổng thật (docs/LOCAITH-MODELS.md ở locaith-ai-v2) — danh sách model, bản ghi đồng ý theo TÀI KHOẢN
 * (GET/POST /consent), /chat/completions kiểu OpenAI có SSE, hàng chờ 429 `locaith_queue` kèm vé, /queue/leave và các mã lỗi `locaith_*` — để kiểm thử extension chạy THẬT trong VS Code
 * mà không chạm máy chủ production. Ghi lại mọi yêu cầu (tiêu đề + thân) để bài kiểm thử xác minh đúng những gì extension gửi đi.
 */

import type * as http from 'node:http';

export interface GatewayRecord {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: any;
  user?: string;
}

/** Kịch bản hành vi của /chat/completions (đặt qua /__admin/locaith/mode; `{}` = bình thường). */
export interface GatewayMode {
  /** Trả 429 hàng chờ theo từng vị trí (mỗi yêu cầu lấy một phần tử); hết danh sách thì nhận. 'forever' = luôn xếp hàng (vé q_forever). */
  queue?: number[] | 'forever';
  /** Hết hạn mức ngày: 429 locaith_quota với Retry-After nhiều giờ. */
  quota?: string;
  rateLimited?: { message: string; retryAfterSec: number };
  unavailable?: string;
  unauthorized?: boolean;
  /** Luôn trả 403 locaith_consent_required (như khi bản ghi bị xoá / đổi phiên bản). */
  consentRequired?: boolean;
  /** POST /consent trả 500 (để thử «thẻ giữ nguyên kèm lỗi»). */
  consentFail?: boolean;
  modelNotFound?: boolean;
  /** Dòng chữ cổng trả lời (mặc định «Xin chào từ Locaith»). */
  reply?: string;
}

export const GATEWAY_MODELS = [
  { id: 'locaith-v5-flash', name: 'Locaith-v5-flash', tier: 'fast', reasoning: false },
  { id: 'locaith-v5-si', name: 'Locaith-v5-SI', tier: 'top', reasoning: true },
] as const;

const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => void res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
const errBody = (code: string, message: string, type = 'error') => ({ error: { message, type, code } });

export class MockGateway {
  mode: GatewayMode = {};
  readonly chat: GatewayRecord[] = [];
  readonly others: GatewayRecord[] = [];
  readonly consents: { userId: string; version: number; client: string }[] = [];
  readonly leaves: { ticket: string; userId?: string }[] = [];
  noticeVersion = 1;

  /** `verify`: token Bearer → id tài khoản (undefined = không hợp lệ). */
  constructor(private readonly verify: (token: string) => string | undefined) {}

  reset(): void {
    this.mode = {};
    this.chat.length = 0;
    this.others.length = 0;
    this.consents.length = 0;
    this.leaves.length = 0;
  }

  state() {
    return { mode: this.mode, chat: this.chat, others: this.others, consents: this.consents, leaves: this.leaves, noticeVersion: this.noticeVersion };
  }

  private recorded(userId: string, version: number | undefined): number | undefined {
    for (let i = this.consents.length - 1; i >= 0; i--) if (this.consents[i]!.userId === userId) return this.consents[i]!.version;
    return version;
  }

  /** true = đã xử lý (đường dẫn thuộc cổng). */
  handle(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const url = (req.url ?? '').replace(/\?.*$/, '');
    const m = /^\/api\/llm\/v1(\/.*)?$/.exec(url);
    if (!m) return false;
    const path = m[1] ?? '/';
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      let body: any;
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      } catch {
        body = undefined;
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k.toLowerCase()] = v;
      const token = /^Bearer\s+(\S+)$/i.exec(headers.authorization ?? '')?.[1];
      const user = token ? this.verify(token) : undefined;
      const rec: GatewayRecord = { method: req.method ?? 'GET', path, headers, body, ...(user ? { user } : {}) };
      (path === '/chat/completions' ? this.chat : this.others).push(rec);
      if (!user || this.mode.unauthorized) return json(res, 401, errBody('locaith_unauthorized', 'Phiên đăng nhập Locaith không còn hiệu lực.', 'auth'));
      this.route(path, rec, user, res);
    });
    return true;
  }

  private route(path: string, rec: GatewayRecord, user: string, res: http.ServerResponse): void {
    if (path === '/models' && rec.method === 'GET') {
      return json(res, 200, {
        object: 'list',
        data: GATEWAY_MODELS.map((x) => ({ ...x, object: 'model', owned_by: 'locaith', context_length: 1_000_000, max_output_tokens: 393_216 })),
        capacity: { limit: 100, active: 3, waiting: 0 },
      });
    }
    if (path === '/consent') {
      if (rec.method === 'GET') {
        const v = this.recorded(user, 0) ?? 0;
        return json(res, 200, { accepted: v >= this.noticeVersion, version: v, current: this.noticeVersion });
      }
      if (this.mode.consentFail) return json(res, 500, errBody('locaith_unavailable', 'Máy chủ tạm lỗi khi ghi nhận đồng ý.'));
      const version = Number(rec.body?.version);
      if (!Number.isFinite(version) || version < 1) return json(res, 400, errBody('locaith_bad_request', 'version không hợp lệ'));
      this.consents.push({ userId: user, version, client: String(rec.body?.client ?? '') });
      return json(res, 200, { ok: true });
    }
    if (path === '/queue/leave' && rec.method === 'POST') {
      this.leaves.push({ ticket: String(rec.body?.ticket ?? ''), userId: user });
      return json(res, 200, { ok: true });
    }
    if (path === '/chat/completions' && rec.method === 'POST') return this.complete(rec, user, res);
    return json(res, 404, errBody('locaith_not_found', 'Không có đường dẫn này.'));
  }

  private complete(rec: GatewayRecord, user: string, res: http.ServerResponse): void {
    const mode = this.mode;
    const model = String(rec.body?.model ?? '');
    if (mode.modelNotFound || !GATEWAY_MODELS.some((x) => x.id === model)) {
      return json(res, 404, errBody('locaith_model_not_found', `Không có mô hình "${model}". Hãy chọn Locaith-v5-flash hoặc Locaith-v5-SI.`));
    }
    const recordedVersion = this.recorded(user, 0) ?? 0;
    if (mode.consentRequired || recordedVersion < this.noticeVersion) {
      return json(res, 403, errBody('locaith_consent_required', 'Hãy đồng ý thông báo dữ liệu của Locaith trong ứng dụng rồi thử lại.', 'consent'));
    }
    if (mode.queue) {
      let position: number | undefined;
      if (mode.queue === 'forever') position = 5;
      else if (mode.queue.length > 0) position = mode.queue.shift();
      if (position !== undefined) {
        const ticket = mode.queue === 'forever' ? 'q_forever' : 'q_test1';
        return json(
          res,
          429,
          { ...errBody('locaith_queue', 'Đang có nhiều lượt sử dụng, vui lòng chờ xử lý.', 'queue'), queue: { ticket, position, ahead: position - 1, retry_after_sec: 1, limit: 100, active: 100, waiting: 20 } },
          { 'retry-after': '1' },
        );
      }
    }
    if (mode.quota) return json(res, 429, errBody('locaith_quota', mode.quota, 'quota'), { 'retry-after': '10800' });
    if (mode.rateLimited) return json(res, 429, errBody('locaith_rate_limited', mode.rateLimited.message, 'rate_limit'), { 'retry-after': String(mode.rateLimited.retryAfterSec) });
    if (mode.unavailable) return json(res, 503, errBody('locaith_unavailable', mode.unavailable, 'unavailable'));

    const text = mode.reply ?? 'Xin chào từ Locaith';
    const id = `chatcmpl-test-${this.chat.length}`;
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform' });
    res.write(chunk({ role: 'assistant', content: '' }));
    res.write(chunk({ content: text }));
    res.write(chunk({}, 'stop'));
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [], usage: { prompt_tokens: 12, completion_tokens: 6, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 12 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  }
}
