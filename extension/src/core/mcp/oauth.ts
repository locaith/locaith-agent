/**
 * OAuth cho server MCP từ xa theo đặc tả MCP Authorization (2025-06-18) — cùng cách Claude Code / ChatGPT kết nối dịch vụ:
 *   401 + `WWW-Authenticate: …resource_metadata=…` (RFC 9728) → metadata tài nguyên → máy chủ cấp quyền (RFC 8414 / OpenID)
 *   → đăng ký ứng dụng tự động (RFC 7591, DCR) → mở trình duyệt, PKCE S256 + tham số `resource` (RFC 8707) → đổi mã lấy token → làm mới token.
 * Thuần logic, `fetch` được tiêm vào nên kiểm thử được bằng một máy chủ giả.
 */

import { createHash, randomBytes } from 'node:crypto';

export class OAuthError extends Error {
  constructor(
    readonly code: 'discovery' | 'no_dcr' | 'denied' | 'token' | 'state' | 'timeout',
    message: string,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

export type FetchLike = typeof fetch;

export interface AuthServerMeta {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  scopes_supported?: string[];
}
export interface OAuthClientInfo {
  clientId: string;
  clientSecret?: string;
  authMethod: 'none' | 'client_secret_post' | 'client_secret_basic';
}
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}
export interface Discovery {
  /** URI tài nguyên (tham số `resource`). */
  resource: string;
  meta: AuthServerMeta;
  scope?: string;
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'locaith-agent', version: '0' } } };

export function parseChallenge(h: string | null): { resourceMetadata?: string; scope?: string } {
  if (!h) return {};
  const pick = (k: string): string | undefined => {
    const m = new RegExp(`${k}="([^"]*)"|${k}=([^\\s,]+)`, 'i').exec(h);
    return m ? (m[1] ?? m[2]) : undefined;
  };
  return { resourceMetadata: pick('resource_metadata'), scope: pick('scope') };
}

async function getJson(url: string, f: FetchLike): Promise<any | null> {
  try {
    const r = await f(url, { headers: { accept: 'application/json' } });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

export async function discover(serverUrl: string, f: FetchLike = fetch): Promise<Discovery> {
  const u = new URL(serverUrl);
  let challenge: { resourceMetadata?: string; scope?: string } = {};
  try {
    const r = await f(serverUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(INIT) });
    if (r.status === 401) challenge = parseChallenge(r.headers.get('www-authenticate'));
    await r.body?.cancel().catch(() => undefined);
  } catch (e) {
    throw new OAuthError('discovery', `Không kết nối được tới ${u.host}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const path = u.pathname.replace(/\/$/, '');
  let pr: any = null;
  for (const url of [challenge.resourceMetadata, `${u.origin}/.well-known/oauth-protected-resource${path}`, `${u.origin}/.well-known/oauth-protected-resource`]) {
    if (!url) continue;
    const j = await getJson(url, f);
    if (j?.authorization_servers?.length) {
      pr = j;
      break;
    }
  }
  const as: string = pr?.authorization_servers?.[0] ?? u.origin;
  const a = new URL(as);
  const ap = a.pathname.replace(/\/$/, '');
  let meta: AuthServerMeta | null = null;
  for (const url of [`${a.origin}/.well-known/oauth-authorization-server${ap}`, `${a.origin}/.well-known/oauth-authorization-server`, `${a.origin}/.well-known/openid-configuration${ap}`, `${as.replace(/\/$/, '')}/.well-known/openid-configuration`]) {
    const m = await getJson(url, f);
    if (m?.authorization_endpoint && m?.token_endpoint) {
      meta = m;
      break;
    }
  }
  if (!meta) throw new OAuthError('discovery', `Không đọc được thông tin đăng nhập của ${a.host} (máy chủ có thể không hỗ trợ OAuth theo chuẩn MCP).`);
  const scopes: string[] | undefined = pr?.scopes_supported;
  return { resource: typeof pr?.resource === 'string' ? pr.resource : serverUrl, meta, scope: challenge.scope ?? (scopes?.length ? scopes.join(' ') : undefined) };
}

export async function registerClient(meta: AuthServerMeta, redirectUri: string, f: FetchLike = fetch, name = 'Locaith AI'): Promise<OAuthClientInfo> {
  if (!meta.registration_endpoint) throw new OAuthError('no_dcr', 'Máy chủ này không cho đăng ký ứng dụng tự động — cần một ứng dụng OAuth riêng (chưa hỗ trợ).');
  const methods = meta.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
  const authMethod = methods.includes('none') ? 'none' : methods.includes('client_secret_post') ? 'client_secret_post' : 'client_secret_basic';
  const r = await f(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_name: name, redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: authMethod, application_type: 'native' }),
  });
  const j: any = await r.json().catch(() => null);
  if (!r.ok || typeof j?.client_id !== 'string') throw new OAuthError('no_dcr', `Đăng ký ứng dụng thất bại (HTTP ${r.status}${j?.error ? `: ${j.error}` : ''}).`);
  return { clientId: j.client_id, clientSecret: j.client_secret, authMethod: j.token_endpoint_auth_method ?? authMethod };
}

export const newState = (): string => randomBytes(16).toString('base64url');
export function newPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function buildAuthUrl(o: { meta: AuthServerMeta; clientId: string; redirectUri: string; state: string; challenge: string; scope?: string; resource?: string }): string {
  const u = new URL(o.meta.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', o.clientId);
  u.searchParams.set('redirect_uri', o.redirectUri);
  u.searchParams.set('state', o.state);
  u.searchParams.set('code_challenge', o.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (o.scope) u.searchParams.set('scope', o.scope);
  if (o.resource) u.searchParams.set('resource', o.resource);
  return u.toString();
}

export async function tokenRequest(meta: AuthServerMeta, client: OAuthClientInfo, params: Record<string, string>, f: FetchLike = fetch): Promise<OAuthTokens> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  body.set('client_id', client.clientId);
  if (client.authMethod === 'client_secret_post' && client.clientSecret) body.set('client_secret', client.clientSecret);
  if (client.authMethod === 'client_secret_basic' && client.clientSecret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString('base64')}`;
  const r = await f(meta.token_endpoint, { method: 'POST', headers, body });
  const j: any = await r.json().catch(() => null);
  if (!r.ok || typeof j?.access_token !== 'string') throw new OAuthError('token', `Máy chủ từ chối cấp token (${j?.error ?? `HTTP ${r.status}`}${j?.error_description ? `: ${j.error_description}` : ''}).`);
  return { accessToken: j.access_token, refreshToken: j.refresh_token, scope: j.scope, expiresAt: typeof j.expires_in === 'number' ? Date.now() + j.expires_in * 1000 : undefined };
}
