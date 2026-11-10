/**
 * Kết nối dịch vụ (connector) cho trợ lý — cùng ý tưởng "Connectors" của Claude/ChatGPT: chọn một dịch vụ trong kho, đăng nhập một lần,
 * trợ lý dùng được công cụ của dịch vụ đó. Ba kiểu đăng nhập:
 *   • oauth  — OAuth 2.1 theo chuẩn MCP (đăng ký ứng dụng tự động + PKCE) qua một cổng loopback tạm trên máy bạn;
 *   • github — phiên đăng nhập GitHub CÓ SẴN của VS Code (không cho đăng ký ứng dụng tự động), hoặc token cá nhân (PAT) bạn dán vào;
 *   • none   — dịch vụ mở, không cần đăng nhập.
 * (0.7.7) Thêm «key» và các mục chạy trên máy có `inputs`: người dùng nhập khoá API / ID khách hàng / địa chỉ máy chủ riêng; giá trị nằm trong SecretStorage và chỉ được ghép vào cấu hình lúc KHỞI ĐỘNG server.
 * Token OAuth/PAT chỉ nằm trong SecretStorage của VS Code (mã hoá bằng kho khoá của hệ điều hành), không bao giờ ghi vào cài đặt hay gửi sang giao diện.
 * Tệp này KHÔNG import `vscode`: mọi thứ phụ thuộc môi trường được tiêm vào (xem ConnectorDeps) nên kiểm thử được bằng máy chủ giả.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BIO_SERVER_NAME, CATALOG, catalogEntry, localConfig, type CatalogEntry, type CatalogInput } from '../core/mcp/catalog';
import type { McpAuth, McpServerConfig } from '../core/mcp/client';
import type { McpServerEntry } from '../core/mcp/manager';
import { OAuthError } from '../core/mcp/oauth';
import { OAuthSession, authorize, type OAuthState } from '../core/mcp/oauthFlow';

/** Mô tả (KHÔNG chứa giá trị) một thứ người dùng đã nhập khi kết nối: giá trị nằm ở SecretStorage `mcp.input.<id>.<idx>`. */
export interface InputMeta {
  idx: number;
  key: string;
  kind: CatalogInput['kind'];
  secret: boolean;
  prefix?: string;
}

export interface ConnectorRecord {
  id: string;
  name: string;
  auth: 'none' | 'oauth' | 'github' | 'token' | 'local' | 'key';
  url?: string;
  cfg?: McpServerConfig;
  /** (0.7.7) Khoá/ID/địa chỉ người dùng đã nhập khi kết nối (chỉ mô tả; giá trị ở SecretStorage). */
  inputs?: InputMeta[];
  custom?: boolean;
  /** Đổi mỗi lần kết nối lại → server được khởi động lại với phiên đăng nhập mới. */
  rev?: string;
}

export interface ConnectorDeps {
  memento: { get<T>(k: string, d: T): T; update(k: string, v: unknown): PromiseLike<void> | void };
  secrets: { get(n: string): Promise<string | undefined>; set(n: string, v: string): Promise<void>; delete(n: string): Promise<void> };
  /** Mở trình duyệt tới một địa chỉ (kiểm thử thay bằng hàm tự đi theo chuyển hướng). */
  openExternal(url: string): Promise<void>;
  /** Phiên GitHub của VS Code: `create` = hiện hộp đăng nhập nếu chưa có. Trả undefined nếu chưa đăng nhập. */
  githubToken(create: boolean): Promise<string | undefined>;
  /** Hỏi người dùng một dòng chữ (token…); undefined = huỷ. */
  prompt(o: { title: string; prompt: string; password?: boolean; value?: string; placeholder?: string }): Promise<string | undefined>;
  /** (0.7.7) Đăng ký một giá trị bí mật để nhật ký che đi (khoá API vừa nhập / vừa đọc từ SecretStorage). */
  registerSecret?(value: string): void;
  workspaceFolder(): string | undefined;
  homedir: string;
  log(level: 'debug' | 'info' | 'warn' | 'error', msg: string): void;
  fetchImpl?: typeof fetch;
}

export interface ConnectResult {
  ok: boolean;
  message: string;
}

const KEY = 'locaithAgent.connectors';
const CALLBACK_TIMEOUT_MS = 5 * 60_000;
const safeId = (s: string): string => s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'server';

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const PAGE = (ok: boolean, text: string): string =>
  `<!doctype html><meta charset="utf-8"><title>Locaith AI</title><body style="font:16px system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222"><h2>${ok ? '✓ Đã kết nối' : '✗ Chưa kết nối được'}</h2><p>${esc(text)}</p><p style="color:#666">Bạn có thể đóng tab này và quay lại VS Code.</p></body>`;

/** Cổng loopback tạm nhận chuyển hướng OAuth. Chỉ chấp nhận GET /callback; tự đóng khi xong hoặc quá hạn. */
export async function loopback(): Promise<{
  redirectUri: string;
  wait(): Promise<{ code?: string; state?: string; error?: string; errorDescription?: string }>;
  close(): void;
}> {
  let settle!: (v: { code?: string; state?: string; error?: string; errorDescription?: string }) => void;
  const result = new Promise<{ code?: string; state?: string; error?: string; errorDescription?: string }>((r) => (settle = r));
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'GET' || u.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const p = u.searchParams;
    const err = p.get('error');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(PAGE(!err && !!p.get('code'), err ? `${err}${p.get('error_description') ? ` — ${p.get('error_description')}` : ''}` : 'Locaith AI đã nhận được xác thực.'));
    settle({ code: p.get('code') ?? undefined, state: p.get('state') ?? undefined, error: err ?? undefined, errorDescription: p.get('error_description') ?? undefined });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    redirectUri: `http://localhost:${port}/callback`,
    wait: () => {
      timer = setTimeout(() => settle({ error: 'timeout', errorDescription: 'Hết thời gian chờ đăng nhập (5 phút).' }), CALLBACK_TIMEOUT_MS);
      return result;
    },
    close: () => {
      if (timer) clearTimeout(timer);
      server.closeAllConnections?.();
      server.close();
    },
  };
}

class GithubAuth implements McpAuth {
  constructor(private readonly get: () => Promise<string | undefined>) {}
  async headers(): Promise<Record<string, string>> {
    const t = await this.get();
    if (!t) throw new Error('Chưa đăng nhập GitHub — mở Chợ → MCP và bấm "Kết nối" ở mục GitHub.');
    return { authorization: `Bearer ${t}` };
  }
}

/** Tên khoá trong SecretStorage của một thứ người dùng nhập. */
export const inputSecretName = (id: string, idx: number): string => `mcp.input.${id}.${idx}`;

/** (0.7.7) Header xác thực do người dùng nhập (mục «key»): đọc lại từ SecretStorage ở MỖI yêu cầu nên đổi khoá không cần khởi động lại. */
class HeadersAuth implements McpAuth {
  constructor(
    private readonly metas: InputMeta[],
    private readonly get: (idx: number) => Promise<string | undefined>,
    private readonly name: string,
  ) {}
  async headers(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const m of this.metas) {
      const v = await this.get(m.idx);
      if (!v) throw new Error(`Chưa có khoá cho ${this.name} — ngắt kết nối rồi kết nối lại và nhập khoá.`);
      out[m.key] = `${m.prefix ?? ''}${v}`;
    }
    return out;
  }
}

class TokenAuth implements McpAuth {
  constructor(private readonly get: () => Promise<string | undefined>) {}
  async headers(): Promise<Record<string, string>> {
    const t = await this.get();
    if (!t) throw new Error('Chưa có token cho kết nối này — kết nối lại và dán token.');
    return { authorization: `Bearer ${t}` };
  }
}

export class ConnectorService {
  private readonly changeListeners = new Set<() => void>();

  constructor(private readonly d: ConnectorDeps) {}

  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  private changed(): void {
    for (const l of [...this.changeListeners]) l();
  }

  list(): ConnectorRecord[] {
    const raw = this.d.memento.get<unknown>(KEY, []);
    return Array.isArray(raw) ? (raw as ConnectorRecord[]).filter((r) => r && typeof r.id === 'string' && typeof r.name === 'string') : [];
  }

  has(id: string): boolean {
    return this.list().some((r) => r.id === id);
  }

  private async save(list: ConnectorRecord[]): Promise<void> {
    await this.d.memento.update(KEY, list);
    this.changed();
  }

  /** Danh sách để nạp vào McpManager (server HTTP có cấp tiêu đề xác thực). */
  async entries(): Promise<McpServerEntry[]> {
    const out: McpServerEntry[] = [];
    for (const r of this.list()) {
      if (r.id === BIO_SERVER_NAME) continue; // Bio-Memory do BioMemoryService quản lý
      const base: McpServerConfig | null = r.cfg ?? (r.url ? { url: r.url } : null);
      if (!base) continue;
      const withIn = await this.withInputs(r, base);
      out.push({ name: r.id, cfg: withIn.cfg, scope: 'connector', origin: r.name, label: r.name, rev: r.rev, ...(withIn.maskEnv ? { maskEnv: withIn.maskEnv } : {}), ...(withIn.auth ? { auth: withIn.auth } : await this.authFor(r)) });
    }
    return out;
  }

  /**
   * Ghép những thứ người dùng đã nhập vào cấu hình lúc KHỞI ĐỘNG: biến môi trường (`env`), đối số (`arg`) — còn header (`header`) đi qua `HeadersAuth`, không nằm trong cấu hình.
   * `maskEnv` = tên biến môi trường bí mật để giao diện hiện «•••» (tên biến không nhất thiết có chữ KEY/TOKEN, ví dụ MDB_MCP_CONNECTION_STRING).
   */
  private async withInputs(r: ConnectorRecord, cfg: McpServerConfig): Promise<{ cfg: McpServerConfig; auth?: McpAuth; maskEnv?: string[] }> {
    if (!r.inputs?.length) return { cfg };
    const next: McpServerConfig = { ...cfg, ...(cfg.args ? { args: [...cfg.args] } : {}), ...(cfg.env ? { env: { ...cfg.env } } : {}) };
    const maskEnv: string[] = [];
    const headers: InputMeta[] = [];
    for (const m of r.inputs) {
      if (m.kind === 'header') {
        headers.push(m);
        continue;
      }
      const v = await this.d.secrets.get(inputSecretName(r.id, m.idx));
      if (v === undefined || v === '') continue;
      if (m.secret) this.d.registerSecret?.(v);
      if (m.kind === 'env') {
        next.env = { ...next.env, [m.key]: v };
        if (m.secret) maskEnv.push(m.key);
      } else next.args = [...(next.args ?? []), ...(m.key ? [m.key, v] : [v])];
    }
    const auth = headers.length
      ? new HeadersAuth(
          headers,
          async (idx) => {
            const v = await this.d.secrets.get(inputSecretName(r.id, idx));
            if (v) this.d.registerSecret?.(v);
            return v;
          },
          r.name,
        )
      : undefined;
    return { cfg: next, ...(auth ? { auth } : {}), ...(maskEnv.length ? { maskEnv } : {}) };
  }

  /**
   * Hỏi lần lượt các thứ cần nhập (hộp nhập VS Code; ô bí mật dạng mật khẩu) và kiểm tra nhẹ. Esc ở bất kỳ ô nào = huỷ cả việc kết nối (chưa lưu gì).
   * Ô tuỳ chọn để trống = bỏ qua. Giá trị không được chứa xuống dòng / ký tự NUL (tránh chèn header hay biến môi trường lạ).
   */
  private async askInputs(e: CatalogEntry): Promise<{ ok: true; metas: InputMeta[]; values: Map<number, string> } | { ok: false; message: string }> {
    const list = e.inputs ?? [];
    const metas: InputMeta[] = [];
    const values = new Map<number, string>();
    for (let i = 0; i < list.length; i++) {
      const spec = list[i];
      const v = await this.d.prompt({
        title: `${e.name} — ${spec.label}${list.length > 1 ? ` (${i + 1}/${list.length})` : ''}`,
        prompt: `${spec.help ?? spec.label}${spec.optional ? ' (có thể để trống)' : ''}${spec.secret ? ' Giá trị được lưu mã hoá trong SecretStorage của VS Code.' : ''}`,
        password: !!spec.secret,
        ...(spec.placeholder ? { placeholder: spec.placeholder } : {}),
      });
      if (v === undefined) return { ok: false, message: 'Đã huỷ.' };
      const val = v.trim();
      if (!val) {
        if (spec.optional) continue;
        return { ok: false, message: `Thiếu «${spec.label}» — chưa kết nối ${e.name}.` };
      }
      // eslint-disable-next-line no-control-regex
      if (/[\u0000\r\n]/.test(val)) return { ok: false, message: `«${spec.label}» không được chứa xuống dòng.` };
      metas.push({ idx: i, key: spec.key, kind: spec.kind, secret: !!spec.secret, ...(spec.prefix ? { prefix: spec.prefix } : {}) });
      values.set(i, val);
    }
    return { ok: true, metas, values };
  }

  private async storeInputs(id: string, values: Map<number, string>, secretIdx: Set<number>): Promise<void> {
    // Kết nối lại: xoá giá trị cũ của lần trước (một ô tuỳ chọn lần này bỏ trống không được để sót giá trị cũ trong kho bí mật).
    for (const m of this.list().find((r) => r.id === id)?.inputs ?? []) await this.d.secrets.delete(inputSecretName(id, m.idx));
    for (const [idx, v] of values) {
      await this.d.secrets.set(inputSecretName(id, idx), v);
      if (secretIdx.has(idx)) this.d.registerSecret?.(v);
    }
  }

  private async authFor(r: ConnectorRecord): Promise<{ auth?: McpAuth }> {
    if (r.auth === 'github') return { auth: new GithubAuth(() => this.d.githubToken(false)) };
    if (r.auth === 'token') return { auth: new TokenAuth(() => this.d.secrets.get(`mcp.token.${r.id}`)) };
    if (r.auth === 'oauth') {
      const raw = await this.d.secrets.get(`mcp.oauth.${r.id}`);
      if (!raw) return {};
      try {
        const state = JSON.parse(raw) as OAuthState;
        return { auth: new OAuthSession(state, (s) => this.d.secrets.set(`mcp.oauth.${r.id}`, JSON.stringify(s)), this.d.fetchImpl) };
      } catch {
        return {};
      }
    }
    return {};
  }

  /** Kết nối một mục của kho (hoặc `custom:<url>` do `addUrl` tạo). */
  async connect(id: string): Promise<ConnectResult> {
    const e = catalogEntry(id);
    if (!e) return { ok: false, message: 'Không có mục này trong kho kết nối.' };
    if (e.unsupported) return { ok: false, message: e.unsupported };
    if (e.id === BIO_SERVER_NAME) return { ok: false, message: 'Bio-Memory-Locaith được cài ở mục riêng phía trên.' };
    try {
      // Mục cần người dùng nhập khoá/ID/địa chỉ (0.7.7): hỏi TRƯỚC; huỷ giữa chừng thì không lưu gì.
      let given: { metas: InputMeta[]; values: Map<number, string> } | undefined;
      if (e.inputs?.length) {
        const got = await this.askInputs(e);
        if (!got.ok) return { ok: false, message: got.message };
        given = got;
      }
      if (e.transport === 'stdio') return await this.connectLocal(e, given);
      if (e.auth === 'key') return await this.connectKey(e, given);
      if (e.auth === 'none') return await this.add({ id: e.id, name: e.name, auth: 'none', url: e.url });
      if (e.auth === 'github') return await this.connectGithub(e);
      return await this.connectOauth({ id: e.id, name: e.name, url: e.url! });
    } catch (err) {
      return { ok: false, message: err instanceof OAuthError || err instanceof Error ? err.message : String(err) };
    }
  }

  private async add(r: ConnectorRecord): Promise<ConnectResult> {
    await this.save([...this.list().filter((x) => x.id !== r.id), { ...r, rev: String(Date.now()) }]);
    return { ok: true, message: `Đã kết nối ${r.name}.` };
  }

  private async connectLocal(e: CatalogEntry, given?: { metas: InputMeta[]; values: Map<number, string> }): Promise<ConnectResult> {
    const cfg = localConfig(e, this.d.workspaceFolder(), this.d.homedir);
    if (!cfg) return { ok: false, message: 'Mục này cần một thư mục workspace đang mở.' };
    if (given) await this.storeInputs(e.id, given.values, new Set(given.metas.filter((m) => m.secret).map((m) => m.idx)));
    const r = await this.add({ id: e.id, name: e.name, auth: 'local', cfg, ...(given?.metas.length ? { inputs: given.metas } : {}) });
    const need = e.needs === 'node' ? ' (cần Node.js)' : e.needs === 'python' ? ' (cần cài uv: docs.astral.sh/uv)' : '';
    return { ok: true, message: `${r.message} Lần đầu chạy, ${e.command ?? 'trình chạy'} có thể mất vài chục giây để tải gói${need}.` };
  }

  /** Máy chủ HTTP xác thực bằng khoá API người dùng nhập (header). */
  private async connectKey(e: CatalogEntry, given?: { metas: InputMeta[]; values: Map<number, string> }): Promise<ConnectResult> {
    if (!given?.metas.some((m) => m.kind === 'header')) return { ok: false, message: 'Mục này cần khoá API — chưa có gì để lưu.' };
    await this.storeInputs(e.id, given.values, new Set(given.metas.filter((m) => m.secret).map((m) => m.idx)));
    return this.add({ id: e.id, name: e.name, auth: 'key', url: e.url, inputs: given.metas });
  }

  private async connectGithub(e: CatalogEntry): Promise<ConnectResult> {
    const token = await this.d.githubToken(true);
    if (!token) return { ok: false, message: 'Chưa đăng nhập GitHub. Có thể dùng token cá nhân: bấm "Dùng token" ở mục GitHub.' };
    await this.d.secrets.delete(`mcp.token.${e.id}`);
    return this.add({ id: e.id, name: e.name, auth: 'github', url: e.url });
  }

  /** GitHub (hoặc dịch vụ bất kỳ) bằng token cá nhân bạn dán vào. */
  async connectToken(id: string): Promise<ConnectResult> {
    const rec = this.list().find((r) => r.id === id);
    const e = catalogEntry(id);
    const url = e?.url ?? rec?.url;
    const name = e?.name ?? rec?.name ?? id;
    if (!url) return { ok: false, message: 'Không rõ địa chỉ máy chủ.' };
    const token = await this.d.prompt({ title: `Token cho ${name}`, prompt: `Dán token truy cập cá nhân (PAT) của ${name}. Token được lưu trong SecretStorage của VS Code.`, password: true });
    if (!token?.trim()) return { ok: false, message: 'Đã huỷ.' };
    await this.d.secrets.set(`mcp.token.${id}`, token.trim());
    return this.add({ id, name, auth: 'token', url });
  }

  private async connectOauth(t: { id: string; name: string; url: string; custom?: boolean }): Promise<ConnectResult> {
    const lb = await loopback();
    try {
      const state = await authorize({
        serverUrl: t.url,
        redirectUri: lb.redirectUri,
        f: this.d.fetchImpl,
        waitForCode: async (authUrl) => {
          this.d.log('info', `Mở trình duyệt để đăng nhập ${t.name}…`);
          await this.d.openExternal(authUrl);
          return lb.wait();
        },
      });
      await this.d.secrets.set(`mcp.oauth.${t.id}`, JSON.stringify(state));
      return await this.add({ id: t.id, name: t.name, auth: 'oauth', url: t.url, ...(t.custom ? { custom: true } : {}) });
    } finally {
      lb.close();
    }
  }

  /** Thêm một server MCP từ xa theo địa chỉ (như `claude mcp add --transport http`): tự dò xem có cần đăng nhập OAuth không. */
  async addUrl(rawUrl: string, rawName?: string): Promise<ConnectResult> {
    let u: URL;
    try {
      u = new URL(rawUrl.trim());
    } catch {
      return { ok: false, message: 'Địa chỉ không hợp lệ.' };
    }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) return { ok: false, message: 'Chỉ nhận địa chỉ https:// (hoặc http://localhost).' };
    const id = `custom-${safeId(rawName || u.hostname)}`;
    const name = (rawName || u.hostname).trim();
    const f = this.d.fetchImpl ?? fetch;
    let status = 0;
    try {
      const r = await f(u.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'locaith-agent', version: '0' } } }),
      });
      status = r.status;
      await r.body?.cancel().catch(() => undefined);
    } catch (err) {
      return { ok: false, message: `Không kết nối được tới ${u.host}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (status === 401 || status === 403) {
      try {
        return await this.connectOauth({ id, name, url: u.toString(), custom: true });
      } catch (err) {
        return { ok: false, message: `${err instanceof Error ? err.message : String(err)} Nếu dịch vụ dùng token cá nhân, hãy khai báo trong cài đặt "mcp.servers" với "headers".` };
      }
    }
    if (status >= 200 && status < 300) return this.add({ id, name, auth: 'none', url: u.toString(), custom: true });
    return { ok: false, message: `Máy chủ trả về HTTP ${status} — có thể địa chỉ không phải một server MCP.` };
  }

  async disconnect(id: string): Promise<ConnectResult> {
    const rec = this.list().find((r) => r.id === id);
    if (!rec) return { ok: false, message: 'Kết nối này không còn.' };
    await this.d.secrets.delete(`mcp.oauth.${id}`);
    await this.d.secrets.delete(`mcp.token.${id}`);
    for (const m of rec.inputs ?? []) await this.d.secrets.delete(inputSecretName(id, m.idx));
    await this.save(this.list().filter((r) => r.id !== id));
    return { ok: true, message: `Đã ngắt kết nối ${rec.name} và xoá thông tin đăng nhập.` };
  }

  /** Mục trong kho đã được kết nối chưa. */
  connectedIds(): Set<string> {
    return new Set(this.list().map((r) => r.id));
  }

  catalog(): CatalogEntry[] {
    return CATALOG;
  }
}
