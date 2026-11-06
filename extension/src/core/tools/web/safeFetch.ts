/**
 * Tải URL do model chỉ định với địa chỉ IP ĐÃ KIỂM TRA được ghim vào kết nối.
 *
 * `fetch` thường phân giải DNS một lần nữa sau khi ta đã kiểm tra → kẻ tấn công điều khiển DNS có thể trả IP công cộng
 * lúc kiểm tra rồi IP nội bộ lúc kết nối (DNS rebinding). Ở đây ta phân giải MỘT lần, kiểm tra, rồi ép `lookup` của socket
 * trả đúng địa chỉ đó; tên miền gốc vẫn dùng cho Host header và SNI/chứng chỉ TLS nên HTTPS hoạt động bình thường.
 * Không tự theo chuyển hướng: trả nguyên phản hồi 3xx để công cụ kiểm tra lại từng bước.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import { Readable } from 'node:stream';
import * as zlib from 'node:zlib';
import { defaultResolver, resolvePublicAddress, type Resolver } from './ssrf';

export interface SafeFetchOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  allowPrivate: boolean;
  timeoutMs?: number;
  resolver?: Resolver;
}

const NO_BODY = new Set([101, 204, 205, 304]);

type LookupCallback = (...args: unknown[]) => void;

/** `lookup` của socket luôn trả đúng địa chỉ đã kiểm tra, bất kể tên miền hay DNS lúc kết nối. */
export function pinnedLookup(target: { address: string; family: 4 | 6 }) {
  return (_host: string, o: { all?: boolean } | undefined, cb: LookupCallback): void => {
    if (o && o.all) cb(null, [{ address: target.address, family: target.family }]);
    else cb(null, target.address, target.family);
  };
}

export async function safeFetch(url: URL, opts: SafeFetchOptions): Promise<Response> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let pinned: { address: string; family: 4 | 6 } | null = null;
  if (!opts.allowPrivate) pinned = await resolvePublicAddress(hostname, opts.resolver ?? defaultResolver);

  const isHttps = url.protocol === 'https:';
  const request = (isHttps ? https.request : http.request) as typeof http.request;

  const target = pinned;
  const options: http.RequestOptions = {
    protocol: url.protocol,
    hostname,
    port: url.port ? Number(url.port) : isHttps ? 443 : 80,
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    headers: { 'Accept-Encoding': 'gzip, deflate, br', ...(opts.headers ?? {}) },
    signal: opts.signal,
  };
  // Ép kết nối tới đúng địa chỉ đã kiểm tra, bất kể DNS lúc này trả gì.
  if (target) options.lookup = pinnedLookup(target) as unknown as http.RequestOptions['lookup'];

  return new Promise<Response>((resolve, reject) => {
    const req = request(
      options,
      (res) => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
          else if (v !== undefined) headers.set(k, v);
        }
        const status = res.statusCode ?? 0;
        if (NO_BODY.has(status) || (status >= 300 && status < 400)) {
          res.resume();
          resolve(new Response(null, { status, statusText: res.statusMessage, headers }));
          return;
        }
        let stream: Readable = res;
        const enc = (res.headers['content-encoding'] ?? '').toString().toLowerCase();
        if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        if (enc) {
          headers.delete('content-encoding');
          headers.delete('content-length');
        }
        resolve(new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status, statusText: res.statusMessage, headers }));
      },
    );
    req.setTimeout(opts.timeoutMs ?? 20_000, () => req.destroy(new Error('Hết thời gian chờ kết nối')));
    req.on('error', reject);
    req.end();
  });
}
