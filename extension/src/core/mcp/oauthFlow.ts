/** Luồng đăng nhập OAuth hoàn chỉnh (`authorize`) và phiên đã đăng nhập tự làm mới token (`OAuthSession`). Xem oauth.ts. */

import type { McpAuth } from './client';
import { OAuthError, buildAuthUrl, discover, newPkce, newState, registerClient, tokenRequest, type AuthServerMeta, type FetchLike, type OAuthClientInfo, type OAuthTokens } from './oauth';

/** Mọi thứ cần nhớ để dùng lại phiên đăng nhập (lưu trong SecretStorage — chứa token, không bao giờ ghi vào cài đặt). */
export interface OAuthState {
  serverUrl: string;
  resource: string;
  redirectUri: string;
  meta: AuthServerMeta;
  client: OAuthClientInfo;
  tokens: OAuthTokens;
  scope?: string;
}

export interface AuthorizeOptions {
  serverUrl: string;
  redirectUri: string;
  /** Mở trình duyệt tới `authUrl`, chờ chuyển hướng về `redirectUri` rồi trả các tham số nhận được. */
  waitForCode(authUrl: string): Promise<{ code?: string; state?: string; error?: string; errorDescription?: string }>;
  f?: FetchLike;
  /** Dùng lại ứng dụng đã đăng ký ở lần trước (tránh đăng ký mới mỗi lần đăng nhập). */
  client?: OAuthClientInfo;
}

export async function authorize(o: AuthorizeOptions): Promise<OAuthState> {
  const f = o.f ?? fetch;
  const d = await discover(o.serverUrl, f);
  const client = o.client ?? (await registerClient(d.meta, o.redirectUri, f));
  const pkce = newPkce();
  const state = newState();
  const url = buildAuthUrl({ meta: d.meta, clientId: client.clientId, redirectUri: o.redirectUri, state, challenge: pkce.challenge, scope: d.scope, resource: d.resource });
  const got = await o.waitForCode(url);
  if (got.error) throw new OAuthError('denied', `Bạn đã từ chối, hoặc máy chủ báo lỗi: ${got.error}${got.errorDescription ? ` — ${got.errorDescription}` : ''}`);
  if (got.state !== state) throw new OAuthError('state', 'Phản hồi đăng nhập không khớp phiên (state) — đã huỷ để an toàn.');
  if (!got.code) throw new OAuthError('denied', 'Không nhận được mã xác thực từ máy chủ.');
  const tokens = await tokenRequest(d.meta, client, { grant_type: 'authorization_code', code: got.code, redirect_uri: o.redirectUri, code_verifier: pkce.verifier, resource: d.resource }, f);
  return { serverUrl: o.serverUrl, resource: d.resource, redirectUri: o.redirectUri, meta: d.meta, client, tokens, scope: d.scope };
}

export class OAuthSession implements McpAuth {
  private inflight: Promise<boolean> | null = null;

  constructor(
    public state: OAuthState,
    private readonly persist: (s: OAuthState) => Promise<void> | void,
    private readonly f: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** Token sắp hết hạn (còn < 60 giây) thì làm mới trước khi dùng. */
  async headers(): Promise<Record<string, string>> {
    const t = this.state.tokens;
    if (t.expiresAt && t.refreshToken && this.now() > t.expiresAt - 60_000) await this.refresh();
    return { authorization: `Bearer ${this.state.tokens.accessToken}` };
  }

  /** Nhiều yêu cầu cùng gặp 401 chỉ làm mới MỘT lần. */
  refresh(): Promise<boolean> {
    if (!this.inflight) {
      this.inflight = this.doRefresh().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async doRefresh(): Promise<boolean> {
    const rt = this.state.tokens.refreshToken;
    if (!rt) return false;
    try {
      const tokens = await tokenRequest(this.state.meta, this.state.client, { grant_type: 'refresh_token', refresh_token: rt, resource: this.state.resource }, this.f);
      this.state = { ...this.state, tokens: { ...tokens, refreshToken: tokens.refreshToken ?? rt } };
      await this.persist(this.state);
      return true;
    } catch {
      return false; // refresh token hết hạn/bị thu hồi → người dùng phải kết nối lại
    }
  }
}
