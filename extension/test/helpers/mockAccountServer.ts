/**
 * Máy chủ tài khoản giả cho kiểm thử: cùng ngữ nghĩa với các hàm SQL ext_auth_* / ext_host_* (đã kiểm bằng Postgres thật trong
 * locaith-ai-v2/supabase/migrations/20261104_extension_account_and_remote_registry.sql). Nói chuyện qua HTTP đúng đường dẫn PostgREST
 * (`POST /rest/v1/rpc/<hàm>`), nên `AccountClient` chạy nguyên văn.
 */

import { createHash, randomBytes } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const b64u = (b: Buffer): string => b.toString('base64url');

interface Code {
  userId: string;
  challenge: string;
  redirect: string;
  label: string;
  used: boolean;
  expiresAt: number;
}
interface Device {
  id: string;
  userId: string;
  label: string;
  revoked: boolean;
  expiresAt: number;
  lastSeen: number;
}
export interface MockUser {
  id: string;
  email: string;
  name: string;
}

export class MockAccountServer {
  private server?: http.Server;
  url = '';
  anonKey = 'test-anon-key';
  users = new Map<string, MockUser>();
  private codes = new Map<string, Code>();
  devices = new Map<string, Device>(); // theo băm token
  hosts = new Map<string, { hostId: string; userId: string; deviceId: string; label: string; workspace?: string; lastSeen: number; accountKey?: string }>();
  /** true = giả lập máy chủ CHƯA nâng cấp migration 20261105: hàm ext_host_upsert không có tham số p_account_psk (PostgREST trả 404 PGRST202). */
  legacyHostUpsert = false;
  calls: { fn: string; args: Record<string, unknown> }[] = [];
  /** 'down' = đóng kết nối ngay (mất mạng); 'error' = 500; undefined = bình thường. */
  mode: 'down' | 'error' | undefined;
  now = () => Date.now();

  addUser(u: MockUser): MockUser {
    this.users.set(u.id, u);
    return u;
  }

  /** Giống ext_auth_approve: người dùng (đã đăng nhập trên web) bấm «Cho phép». */
  approve(userId: string, challenge: string, redirect: string, label = 'Máy thử'): string {
    if (!this.users.has(userId)) throw new Error('not_authenticated');
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new Error('bad_challenge');
    const okRedirect =
      /^(vscode|vscode-insiders|vscodium|code-oss|cursor|windsurf|positron|kiro|trae|void|antigravity):\/\/locaithai\.locaith-agent(\/[A-Za-z0-9._~%/-]{0,100})?$/i.test(redirect) ||
      /^http:\/\/(127\.0\.0\.1|localhost)(:[0-9]{2,5})?\/[A-Za-z0-9._~/-]{0,100}$/i.test(redirect);
    if (!okRedirect) throw new Error('bad_redirect');
    const code = b64u(randomBytes(20));
    this.codes.set(sha(code), { userId, challenge, redirect, label, used: false, expiresAt: this.now() + 5 * 60_000 });
    return code;
  }

  expireCodes(): void {
    for (const c of this.codes.values()) c.expiresAt = this.now() - 1;
  }

  revokeAll(): void {
    for (const d of this.devices.values()) d.revoked = true;
  }

  /** Id tài khoản của một token thiết bị còn hiệu lực (cổng mô hình giả dùng để biết ai gọi). */
  userIdForToken(token: string): string | undefined {
    return this.deviceOf(token)?.userId;
  }

  private deviceOf(token: unknown): Device | undefined {
    if (typeof token !== 'string' || !/^lat_[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const d = this.devices.get(sha(token));
    return d && !d.revoked && d.expiresAt > this.now() ? d : undefined;
  }

  private card(id: string) {
    const u = this.users.get(id)!;
    return { id: u.id, email: u.email, name: u.name, avatar: null };
  }

  private call(fn: string, a: Record<string, unknown>): unknown {
    switch (fn) {
      case 'ext_auth_exchange': {
        const code = this.codes.get(sha(String(a.p_code)));
        if (!code || code.used || code.expiresAt < this.now() || typeof a.p_verifier !== 'string' || !/^[A-Za-z0-9_.~-]{43,128}$/.test(a.p_verifier)) return { ok: false, error: 'invalid_grant' };
        code.used = true; // đốt mã trước khi kiểm verifier
        if (b64u(createHash('sha256').update(a.p_verifier, 'utf8').digest()) !== code.challenge) return { ok: false, error: 'invalid_grant' };
        const token = `lat_${b64u(randomBytes(32))}`;
        const dev: Device = { id: `d-${this.devices.size + 1}`, userId: code.userId, label: code.label, revoked: false, expiresAt: this.now() + 90 * 86_400_000, lastSeen: this.now() };
        this.devices.set(sha(token), dev);
        return { ok: true, token, device: { id: dev.id, label: dev.label, expires_at: new Date(dev.expiresAt).toISOString() }, user: this.card(code.userId) };
      }
      case 'ext_auth_whoami': {
        const d = this.deviceOf(a.p_token);
        if (!d) return { ok: false, error: 'invalid_token' };
        d.lastSeen = this.now();
        return { ok: true, user: this.card(d.userId), device: { id: d.id, label: d.label, expires_at: new Date(d.expiresAt).toISOString() } };
      }
      case 'ext_auth_logout': {
        const d = this.deviceOf(a.p_token);
        if (d) {
          d.revoked = true;
          for (const [k, h] of this.hosts) if (h.deviceId === d.id) this.hosts.delete(k);
        }
        return { ok: true };
      }
      case 'ext_host_upsert': {
        const d = this.deviceOf(a.p_token);
        if (!d) return { ok: false, error: 'invalid_token' };
        const id = String(a.p_host_id);
        if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return { ok: false, error: 'bad_host' };
        const hasKeyParam = 'p_account_psk' in a;
        if (hasKeyParam && this.legacyHostUpsert) return { code: 'PGRST202', message: 'Could not find the function public.ext_host_upsert(...) in the schema cache' };
        // p_account_psk: null/vắng = giữ nguyên · '' = xoá · 22 ký tự base64url = đặt (cùng ngữ nghĩa với 20261105_remote_account_trust.sql)
        const k = a.p_account_psk;
        if (typeof k === 'string' && k !== '' && !/^[A-Za-z0-9_-]{22}$/.test(k)) return { ok: false, error: 'bad_key' };
        const cur = this.hosts.get(id);
        if (cur && cur.userId !== d.userId) return { ok: false, error: 'conflict' };
        const accountKey = k === undefined || k === null ? cur?.accountKey : k === '' ? undefined : (k as string);
        this.hosts.set(id, { hostId: id, userId: d.userId, deviceId: d.id, label: String(a.p_label ?? ''), workspace: typeof a.p_workspace === 'string' ? a.p_workspace : undefined, lastSeen: this.now(), ...(accountKey ? { accountKey } : {}) });
        return { ok: true };
      }
      case 'ext_host_remove': {
        const d = this.deviceOf(a.p_token);
        if (d) this.hosts.delete(String(a.p_host_id));
        return { ok: true };
      }
      default:
        return { code: 'PGRST202', message: 'function not found' };
    }
  }

  /** Xử lý một yêu cầu PostgREST (dùng cả khi chia chung cổng với máy chủ khác — xem TestBackend). */
  handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    {
      if (this.mode === 'down') return void req.socket.destroy();
      const m = /^\/rest\/v1\/rpc\/(\w+)$/.exec(req.url ?? '');
      if (req.method !== 'POST' || !m) {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        if (this.mode === 'error') {
          res.writeHead(500, { 'content-type': 'application/json' }).end('{"message":"boom"}');
          return;
        }
        if (req.headers.apikey !== this.anonKey) {
          res.writeHead(401, { 'content-type': 'application/json' }).end('{"message":"Invalid API key"}');
          return;
        }
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          /* để trống */
        }
        this.calls.push({ fn: m[1]!, args });
        const out = this.call(m[1]!, args);
        res.writeHead(typeof out === 'object' && out && 'code' in out ? 404 : 200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
      });
    }
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = undefined;
    if (!s) return;
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
}
