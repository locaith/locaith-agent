/**
 * Máy khách MCP (Model Context Protocol) tối giản nhưng đủ dùng: JSON-RPC 2.0 qua stdio (một tiến trình con, mỗi dòng một thông điệp)
 * hoặc HTTP "streamable" (POST, phản hồi JSON hoặc SSE). Hỗ trợ `tools/list` (có phân trang) và `tools/call`.
 *
 * An toàn: tiến trình con KHÔNG thừa hưởng biến môi trường trông giống bí mật (KEY/TOKEN/SECRET/PASSWORD…) — chỉ nhận những gì
 * cấu hình của server khai báo rõ; không dùng shell trừ khi bắt buộc trên Windows (npx/.cmd).
 */

import { spawn, type ChildProcess } from 'node:child_process';

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpCallResult {
  text: string;
  isError: boolean;
  images: { mediaType: string; data: string }[];
}

export type McpStatus = 'stopped' | 'starting' | 'running' | 'error';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
const SECRET_ENV = /(key|token|secret|passw|credential|auth)/i;

/** Môi trường an toàn cho tiến trình con: bỏ biến giống bí mật, giữ phần còn lại, cộng biến khai báo rõ. */
export function safeEnv(extra: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || SECRET_ENV.test(k)) continue;
    out[k] = v;
  }
  return { ...out, ...extra };
}

/** Chỉ nhận cấu hình có `command` (chuỗi) hoặc `url` http(s); lọc kiểu từng trường. */
export function sanitizeServerConfig(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const strMap = (v: unknown): Record<string, string> | undefined => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const o: Record<string, string> = {};
    for (const [k, x] of Object.entries(v)) if (typeof x === 'string') o[k] = x;
    return o;
  };
  if (typeof r.url === 'string' && /^https?:\/\//i.test(r.url.trim())) return { url: r.url.trim(), headers: strMap(r.headers) };
  if (typeof r.command === 'string' && r.command.trim()) {
    return {
      command: r.command.trim(),
      args: Array.isArray(r.args) ? r.args.filter((a): a is string => typeof a === 'string').slice(0, 64) : [],
      env: strMap(r.env),
      cwd: typeof r.cwd === 'string' ? r.cwd : undefined,
    };
  }
  return null;
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Cấp tiêu đề xác thực cho server HTTP (OAuth hoặc token). */
export interface McpAuth {
  headers(): Promise<Record<string, string>>;
  /** Gọi khi server trả 401: làm mới token; true = nên thử lại một lần. */
  refresh?(): Promise<boolean>;
}

export interface McpClientHooks {
  auth?: McpAuth;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  version?: string;
  onToolsChanged?(): void;
  /** Cho kiểm thử thay `spawn` thật. */
  spawnImpl?: typeof spawn;
  fetchImpl?: typeof fetch;
}

const quoteCmd = (s: string): string => (/[\s"&|<>^()%!]/.test(s) || s === '' ? `"${s.replace(/"/g, '\\"')}"` : s);

export class McpClient {
  status: McpStatus = 'stopped';
  error?: string;
  tools: McpToolInfo[] = [];
  serverInfo?: { name?: string; version?: string };
  /** Chỉ dẫn dùng công cụ do chính server gửi trong `initialize` (cắt 4.000 ký tự). */
  instructions?: string;
  private proc?: ChildProcess;
  private buf = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private sessionId?: string;
  private stderrTail = '';
  private stopping = false;

  constructor(
    readonly name: string,
    readonly cfg: McpServerConfig,
    private readonly hooks: McpClientHooks,
  ) {}

  get transport(): 'stdio' | 'http' {
    return this.cfg.url ? 'http' : 'stdio';
  }

  async start(timeoutMs = 60_000): Promise<void> {
    if (this.status === 'running' || this.status === 'starting') return;
    this.status = 'starting';
    this.error = undefined;
    this.stopping = false;
    try {
      if (this.cfg.url) {
        // HTTP: không có tiến trình, chỉ có phiên.
      } else {
        this.spawnProcess();
      }
      const init = (await this.request(
        'initialize',
        { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'locaith-agent', version: this.hooks.version ?? '0' } },
        { timeoutMs },
      )) as { serverInfo?: { name?: string; version?: string }; instructions?: string } | undefined;
      this.serverInfo = init?.serverInfo;
      this.instructions = typeof init?.instructions === 'string' && init.instructions.trim() ? init.instructions.slice(0, 4000) : undefined;
      await this.notify('notifications/initialized');
      this.tools = await this.listTools();
      this.status = 'running';
    } catch (err) {
      this.status = 'error';
      this.error = this.explain(err);
      await this.close(false);
      this.status = 'error';
      throw new Error(this.error);
    }
  }

  private explain(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    const tail = this.stderrTail.trim().split('\n').slice(-4).join(' | ').slice(0, 400);
    return tail && !msg.includes(tail) ? `${msg}${tail ? ` — ${tail}` : ''}` : msg;
  }

  private spawnProcess(): void {
    const cfg = this.cfg;
    if (!cfg.command) throw new Error('Thiếu "command" hoặc "url" trong cấu hình MCP.');
    const isWin = process.platform === 'win32';
    let file = cfg.command;
    let args = cfg.args ?? [];
    let verbatim = false;
    if (isWin && !/\.exe$/i.test(file)) {
      // npx, npm, uvx, *.cmd, *.bat chỉ chạy được qua cmd.exe trên Windows.
      file = process.env.ComSpec || 'cmd.exe';
      args = ['/d', '/s', '/c', `"${[cfg.command, ...(cfg.args ?? [])].map(quoteCmd).join(' ')}"`];
      verbatim = true;
    }
    const sp = (this.hooks.spawnImpl ?? spawn)(file, args, {
      cwd: cfg.cwd || undefined,
      env: safeEnv(cfg.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
    });
    this.proc = sp;
    sp.stdout?.setEncoding('utf8');
    sp.stdout?.on('data', (d: string) => this.onData(d));
    sp.stderr?.setEncoding('utf8');
    sp.stderr?.on('data', (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-4000);
      this.hooks.log('debug', `[mcp:${this.name}] ${d.trimEnd().slice(0, 300)}`);
    });
    sp.on('error', (e) => this.onExit(`Không chạy được "${cfg.command}": ${e.message}`));
    sp.on('exit', (code, sig) => this.onExit(`Server MCP dừng (mã ${code ?? sig ?? '?'})`));
  }

  private onExit(reason: string): void {
    const wasStopping = this.stopping;
    this.proc = undefined;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
    if (!wasStopping && this.status !== 'stopped') {
      this.status = 'error';
      this.error = this.explain(new Error(reason));
    }
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      try {
        this.onMessage(JSON.parse(line));
      } catch {
        this.hooks.log('debug', `[mcp:${this.name}] dòng không phải JSON: ${line.slice(0, 120)}`);
      }
    }
  }

  private onMessage(m: any): void {
    if (!m || typeof m !== 'object') return;
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined) && this.pending.has(m.id)) {
      const p = this.pending.get(m.id)!;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(`${m.error.message ?? 'Lỗi MCP'}${m.error.code !== undefined ? ` (${m.error.code})` : ''}`));
      else p.resolve(m.result);
      return;
    }
    if (typeof m.method === 'string') {
      if (m.method === 'notifications/tools/list_changed') this.hooks.onToolsChanged?.();
      if (m.id !== undefined) {
        // Yêu cầu từ server: chỉ trả lời ping; mọi thứ khác (sampling, roots…) chưa hỗ trợ.
        const reply = m.method === 'ping' ? { jsonrpc: '2.0', id: m.id, result: {} } : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not supported' } };
        this.write(reply);
      }
    }
  }

  private write(msg: unknown): void {
    this.proc?.stdin?.write(`${JSON.stringify(msg)}\n`);
  }

  async request(method: string, params?: unknown, o: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    const id = this.nextId++;
    const timeoutMs = o.timeoutMs ?? 120_000;
    if (this.cfg.url) return this.httpRequest(id, method, params, timeoutMs, o.signal);
    return new Promise<unknown>((resolve, reject) => {
      if (!this.proc) return reject(new Error('Server MCP chưa chạy.'));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP "${method}" quá ${Math.round(timeoutMs / 1000)} giây không phản hồi.`));
      }, timeoutMs);
      const onAbort = () => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        this.write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'aborted' } });
        reject(new Error('Đã dừng.'));
      };
      if (o.signal?.aborted) {
        clearTimeout(timer);
        return reject(new Error('Đã dừng.'));
      }
      o.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        timer,
        resolve: (v) => {
          o.signal?.removeEventListener('abort', onAbort);
          resolve(v);
        },
        reject: (e) => {
          o.signal?.removeEventListener('abort', onAbort);
          reject(e);
        },
      });
      this.write({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.cfg.url) {
      await this.httpPost({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }, 15_000).catch(() => undefined);
      return;
    }
    this.write({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
  }

  // ── HTTP ───────────────────────────────────────────────────────────────────

  private async httpPost(body: unknown, timeoutMs: number, signal?: AbortSignal, authRetried = false): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await (this.hooks.fetchImpl ?? fetch)(this.cfg.url!, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(this.sessionId ? { 'mcp-session-id': this.sessionId, 'mcp-protocol-version': MCP_PROTOCOL_VERSION } : {}),
          ...(this.cfg.headers ?? {}),
          ...(this.hooks.auth ? await this.hooks.auth.headers() : {}),
        },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      const sid = res.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;
      // 401 với xác thực OAuth: làm mới token MỘT lần rồi gửi lại.
      if (res.status === 401 && this.hooks.auth?.refresh && !authRetried) {
        await res.body?.cancel().catch(() => undefined);
        if (await this.hooks.auth.refresh()) return await this.httpPost(body, timeoutMs, signal, true);
      }
      return res;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private async httpRequest(id: number, method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const res = await this.httpPost({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }, timeoutMs, signal);
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    const text = await res.text();
    const pick = (m: any): unknown | undefined => {
      if (m && m.id === id) {
        if (m.error) throw new Error(`${m.error.message ?? 'Lỗi MCP'}${m.error.code !== undefined ? ` (${m.error.code})` : ''}`);
        return m.result ?? null;
      }
      return undefined;
    };
    if (type.includes('text/event-stream')) {
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        try {
          const r = pick(JSON.parse(data));
          if (r !== undefined) return r;
        } catch (e) {
          if (e instanceof Error && !/JSON/.test(e.message)) throw e;
        }
      }
      throw new Error('MCP: phản hồi SSE không chứa kết quả.');
    }
    const json = JSON.parse(text);
    for (const m of Array.isArray(json) ? json : [json]) {
      const r = pick(m);
      if (r !== undefined) return r;
    }
    throw new Error('MCP: phản hồi không chứa kết quả.');
  }

  // ── API cấp cao ────────────────────────────────────────────────────────────

  async listTools(): Promise<McpToolInfo[]> {
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = (await this.request('tools/list', cursor ? { cursor } : {}, { timeoutMs: 30_000 })) as { tools?: McpToolInfo[]; nextCursor?: string } | undefined;
      for (const t of r?.tools ?? []) if (t && typeof t.name === 'string') out.push(t);
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  async callTool(name: string, args: Record<string, unknown>, o: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<McpCallResult> {
    const r = (await this.request('tools/call', { name, arguments: args }, { signal: o.signal, timeoutMs: o.timeoutMs ?? 120_000 })) as
      | { content?: any[]; isError?: boolean; structuredContent?: unknown }
      | undefined;
    const parts: string[] = [];
    const images: McpCallResult['images'] = [];
    for (const c of r?.content ?? []) {
      if (!c || typeof c !== 'object') continue;
      if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
      else if (c.type === 'image' && typeof c.data === 'string') {
        images.push({ mediaType: String(c.mimeType || 'image/png'), data: c.data });
        parts.push('[ảnh]');
      } else if (c.type === 'resource' && c.resource) {
        parts.push(typeof c.resource.text === 'string' ? c.resource.text : `[tài nguyên ${c.resource.uri ?? ''}]`);
      } else if (c.type === 'resource_link') parts.push(`[liên kết ${c.uri ?? ''}]`);
      else if (c.type === 'audio') parts.push('[âm thanh]');
    }
    if (parts.length === 0 && r?.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent, null, 2));
    return { text: parts.join('\n'), isError: r?.isError === true, images };
  }

  async close(setStopped = true): Promise<void> {
    this.stopping = true;
    if (setStopped) this.status = 'stopped';
    const p = this.proc;
    this.proc = undefined;
    for (const [, x] of this.pending) {
      clearTimeout(x.timer);
      x.reject(new Error('Đã đóng.'));
    }
    this.pending.clear();
    if (this.cfg.url && this.sessionId) {
      void this.httpDelete();
    }
    if (p) {
      try {
        p.stdin?.end();
      } catch {
        /* đã đóng */
      }
      const killer = setTimeout(() => {
        try {
          p.kill();
        } catch {
          /* đã thoát */
        }
      }, 1500);
      p.once('exit', () => clearTimeout(killer));
    }
  }

  private async httpDelete(): Promise<void> {
    try {
      await (this.hooks.fetchImpl ?? fetch)(this.cfg.url!, { method: 'DELETE', headers: { 'mcp-session-id': this.sessionId!, ...(this.cfg.headers ?? {}) } });
    } catch {
      /* không quan trọng */
    }
    this.sessionId = undefined;
  }
}
