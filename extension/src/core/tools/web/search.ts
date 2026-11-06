/**
 * Các backend tìm kiếm cho web_search. Công cụ tìm kiếm chạy phía client (không dùng web search riêng của từng hãng)
 * để mọi model — Claude, GPT, Gemini, DeepSeek, Grok — dùng chung một cách và có thể gọi song song.
 */

import { parse } from 'node-html-parser';
import type { ToolHost } from '../../engine/types';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type Recency = 'day' | 'week' | 'month' | 'year';

export interface SearchRequest {
  query: string;
  max: number;
  recency?: Recency;
  host: ToolHost;
  signal: AbortSignal;
}

export type SearchBackendId = 'duckduckgo' | 'brave' | 'tavily' | 'serper' | 'searxng';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function withTimeout(signal: AbortSignal, ms: number): { signal: AbortSignal; done(): void } {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('timeout')), ms);
  const onAbort = () => ctl.abort(signal.reason);
  if (signal.aborted) ctl.abort(signal.reason);
  else signal.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ctl.signal,
    done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    },
  };
}

async function getJson(req: SearchRequest, url: string, init: RequestInit): Promise<any> {
  const t = withTimeout(req.signal, 15_000);
  try {
    const res = await req.host.fetch(url, { ...init, signal: t.signal });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`HTTP ${res.status}${res.status === 401 || res.status === 403 ? ' — khóa API không hợp lệ hoặc hết hạn' : res.status === 429 ? ' — vượt giới hạn truy vấn' : ''}${body ? `: ${body}` : ''}`);
    }
    return await res.json();
  } finally {
    t.done();
  }
}

async function needKey(host: ToolHost, name: string, label: string): Promise<string> {
  const key = await host.secret(name);
  if (!key) throw new Error(`Chưa có API key cho ${label}. Dùng lệnh "Locaith AI: Đặt API key…" hoặc đổi locaithAgent.search.backend.`);
  return key;
}

// ── DuckDuckGo (không cần khoá) ───────────────────────────────────────────────

function ddgUnwrap(href: string): string {
  try {
    const u = new URL(href.startsWith('//') ? `https:${href}` : href, 'https://duckduckgo.com');
    const target = u.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : u.toString();
  } catch {
    return href;
  }
}

export function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const root = parse(html);
  const out: SearchResult[] = [];
  for (const r of root.querySelectorAll('.result')) {
    if (r.classNames.includes('result--ad')) continue;
    const a = r.querySelector('a.result__a');
    if (!a) continue;
    const href = a.getAttribute('href');
    if (!href) continue;
    const url = ddgUnwrap(href);
    if (!/^https?:/i.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
    out.push({
      title: a.text.replace(/\s+/g, ' ').trim(),
      url,
      snippet: (r.querySelector('.result__snippet')?.text ?? '').replace(/\s+/g, ' ').trim(),
    });
  }
  return out;
}

/**
 * Gọi DuckDuckGo HTML bằng một phương thức; trả null nếu bị chặn (HTTP 202 / trang "anomaly").
 * Thực tế: DuckDuckGo thường chặn POST tự động nhưng vẫn phục vụ GET — nên thử GET trước.
 */
async function ddgFetch(req: SearchRequest, method: 'GET' | 'POST'): Promise<string | null> {
  const df = { day: 'd', week: 'w', month: 'm', year: 'y' }[req.recency ?? 'year'];
  const params = new URLSearchParams({ q: req.query, kl: 'vn-vi', ...(req.recency ? { df } : {}) });
  const t = withTimeout(req.signal, 15_000);
  try {
    const headers = { 'User-Agent': UA, 'Accept-Language': 'vi,en;q=0.8', Accept: 'text/html' };
    const res =
      method === 'GET'
        ? await req.host.fetch(`https://html.duckduckgo.com/html/?${params}`, { headers, signal: t.signal })
        : await req.host.fetch('https://html.duckduckgo.com/html/', {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params,
            signal: t.signal,
          });
    const html = await res.text();
    if (res.status === 202 || /anomaly-modal|Unfortunately, bots use DuckDuckGo too|challenge-form/i.test(html)) return null;
    if (!res.ok) return null;
    return html;
  } finally {
    t.done();
  }
}

/** Liên kết kết quả của Bing thường bọc qua /ck/a?...&u=a1<base64url của URL thật>. */
export function unwrapBingUrl(href: string): string {
  try {
    const u = new URL(href, 'https://www.bing.com');
    if (u.hostname.endsWith('bing.com') && u.pathname.startsWith('/ck/')) {
      const enc = u.searchParams.get('u');
      if (enc?.startsWith('a1')) {
        const decoded = Buffer.from(enc.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        if (/^https?:\/\//i.test(decoded)) return decoded;
      }
    }
    return u.toString();
  } catch {
    return href;
  }
}

export function parseBingHtml(html: string): SearchResult[] {
  const root = parse(html);
  const out: SearchResult[] = [];
  for (const li of root.querySelectorAll('li.b_algo')) {
    const a = li.querySelector('h2 a');
    const href = a?.getAttribute('href');
    if (!a || !href) continue;
    const url = unwrapBingUrl(href);
    if (!/^https?:/i.test(url) || /bing\.com\/(search|aclick)/.test(url)) continue;
    const snippet = (li.querySelector('.b_caption p') ?? li.querySelector('.b_lineclamp2') ?? li.querySelector('p'))?.text ?? '';
    out.push({ title: a.text.replace(/\s+/g, ' ').trim(), url, snippet: snippet.replace(/\s+/g, ' ').trim() });
  }
  return out;
}

async function bing(req: SearchRequest): Promise<SearchResult[]> {
  const t = withTimeout(req.signal, 15_000);
  try {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(req.query)}&setlang=vi&cc=VN&count=${Math.min(20, Math.max(10, req.max))}`;
    const res = await req.host.fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'vi,en;q=0.8', Accept: 'text/html' }, signal: t.signal });
    if (!res.ok) return [];
    return parseBingHtml(await res.text());
  } finally {
    t.done();
  }
}

/** Backend không cần khoá: DuckDuckGo (GET → POST) rồi tới Bing khi bị chặn hoặc không có kết quả. */
async function duckduckgo(req: SearchRequest): Promise<SearchResult[]> {
  for (const method of ['GET', 'POST'] as const) {
    try {
      const html = await ddgFetch(req, method);
      if (html) {
        const results = parseDuckDuckGoHtml(html);
        if (results.length > 0) return results;
      }
    } catch (err) {
      if (req.signal.aborted) throw err;
    }
  }
  const fallback = await bing(req).catch(() => []);
  if (fallback.length > 0) return fallback;
  throw new Error(
    'Các công cụ tìm kiếm không cần khoá (DuckDuckGo, Bing) đang chặn truy vấn tự động. Hãy đặt API key cho Brave/Tavily/Serper và chọn locaithAgent.search.backend để ổn định hơn.',
  );
}

// ── Brave ─────────────────────────────────────────────────────────────────────

async function brave(req: SearchRequest): Promise<SearchResult[]> {
  const key = await needKey(req.host, 'search.brave', 'Brave Search');
  const fresh = req.recency ? { day: 'pd', week: 'pw', month: 'pm', year: 'py' }[req.recency] : undefined;
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(req.query)}&count=${Math.min(20, req.max)}&country=VN&search_lang=vi${fresh ? `&freshness=${fresh}` : ''}`;
  const data = await getJson(req, url, { headers: { 'X-Subscription-Token': key, Accept: 'application/json' } });
  return (data.web?.results ?? []).map((r: any) => ({ title: String(r.title ?? ''), url: String(r.url ?? ''), snippet: String(r.description ?? '').replace(/<[^>]+>/g, '') }));
}

// ── Tavily ────────────────────────────────────────────────────────────────────

async function tavily(req: SearchRequest): Promise<SearchResult[]> {
  const key = await needKey(req.host, 'search.tavily', 'Tavily');
  const data = await getJson(req, 'https://api.tavily.com/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: req.query, max_results: Math.min(20, req.max), search_depth: 'basic', include_answer: false, ...(req.recency ? { time_range: req.recency } : {}) }),
  });
  return (data.results ?? []).map((r: any) => ({ title: String(r.title ?? ''), url: String(r.url ?? ''), snippet: String(r.content ?? '') }));
}

// ── Serper (Google) ───────────────────────────────────────────────────────────

async function serper(req: SearchRequest): Promise<SearchResult[]> {
  const key = await needKey(req.host, 'search.serper', 'Serper');
  const tbs = req.recency ? { day: 'qdr:d', week: 'qdr:w', month: 'qdr:m', year: 'qdr:y' }[req.recency] : undefined;
  const data = await getJson(req, 'https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: req.query, num: Math.min(20, req.max), gl: 'vn', hl: 'vi', ...(tbs ? { tbs } : {}) }),
  });
  return (data.organic ?? []).map((r: any) => ({ title: String(r.title ?? ''), url: String(r.link ?? ''), snippet: String(r.snippet ?? '') }));
}

// ── SearXNG ───────────────────────────────────────────────────────────────────

async function searxng(req: SearchRequest): Promise<SearchResult[]> {
  const base = req.host.setting<string>('search.searxngUrl', '').replace(/\/+$/, '');
  if (!base) throw new Error('Chưa đặt locaithAgent.search.searxngUrl.');
  const range = req.recency ? `&time_range=${req.recency}` : '';
  const data = await getJson(req, `${base}/search?q=${encodeURIComponent(req.query)}&format=json&language=vi${range}`, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  return (data.results ?? []).map((r: any) => ({ title: String(r.title ?? ''), url: String(r.url ?? ''), snippet: String(r.content ?? '') }));
}

const BACKENDS: Record<SearchBackendId, (req: SearchRequest) => Promise<SearchResult[]>> = { duckduckgo, brave, tavily, serper, searxng };

export async function runSearch(backend: SearchBackendId, req: SearchRequest): Promise<SearchResult[]> {
  const fn = BACKENDS[backend] ?? duckduckgo;
  const results = await fn(req);
  const seen = new Set<string>();
  return results
    .filter((r) => r.url && r.title && !seen.has(r.url) && (seen.add(r.url), true))
    .slice(0, req.max);
}
