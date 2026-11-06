/**
 * Chặn SSRF cho fetch_url: nội dung trang web có thể chứa lời dụ model đọc địa chỉ nội bộ
 * (metadata đám mây 169.254.169.254, router 192.168.x.x, dịch vụ localhost…). Mặc định chỉ cho mạng công cộng.
 *
 * Cách làm ĐÚNG là phân tích địa chỉ thành số rồi so với các dải đặc biệt — không so chuỗi: WHATWG URL đổi
 * `[::ffff:127.0.0.1]` thành `[::ffff:7f00:1]`, nên mọi phép khớp theo dạng dấu chấm đều bị vượt qua.
 */

import { lookup } from 'node:dns/promises';
import * as net from 'node:net';
import { isPrivateIPv4, isPrivateIPv6, parseIPv6 } from './ipcheck';

export type Resolver = (hostname: string) => Promise<{ address: string; family: 4 | 6 }[]>;

export const defaultResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true })).map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));

// Phần thuần (phân tích IP, dải riêng) nằm ở ipcheck.ts để bản trình duyệt dùng chung; ở đây giữ nguyên API cũ.
export { isPrivateIPv4, isPrivateIPv6, parseIPv6 } from './ipcheck';

export function isPrivateIp(ip: string): boolean {
  const clean = ip.replace(/^\[|\]$/g, '');
  if (net.isIPv4(clean)) {
    const [a, b, c, d] = clean.split('.').map(Number);
    return isPrivateIPv4(a, b, c, d);
  }
  if (net.isIPv6(clean) || clean.includes(':')) {
    const g = parseIPv6(clean);
    return g === null ? true : isPrivateIPv6(g); // không phân tích được → coi là không an toàn
  }
  return false;
}

const MAX_URL_LENGTH = 2048;

export async function assertPublicUrl(raw: string, allowPrivate: boolean, resolver: Resolver = defaultResolver): Promise<URL> {
  if (raw.length > MAX_URL_LENGTH) throw new Error(`URL quá dài (${raw.length} ký tự, tối đa ${MAX_URL_LENGTH}).`);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`URL không hợp lệ: ${raw.slice(0, 200)}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`Chỉ hỗ trợ http/https (nhận được ${u.protocol}).`);
  if (u.username || u.password) throw new Error('URL chứa thông tin đăng nhập — không cho phép.');
  if (allowPrivate) return u;
  await resolvePublicAddress(u.hostname, resolver);
  return u;
}

/**
 * Phân giải tên miền MỘT lần và kiểm tra MỌI địa chỉ trả về; trả địa chỉ đầu tiên để kết nối ghim vào đúng IP đó
 * (chống DNS rebinding: nếu để fetch phân giải lần hai, kẻ tấn công có thể trả IP công cộng lúc kiểm tra rồi IP nội bộ lúc kết nối).
 */
export async function resolvePublicAddress(hostname: string, resolver: Resolver = defaultResolver): Promise<{ address: string; family: 4 | 6 }> {
  // Dấu chấm cuối (`localhost.`, `x.internal.`) là tên miền đầy đủ hợp lệ nhưng làm hỏng phép so khớp hậu tố.
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.home.arpa')) {
    throw new Error(`Địa chỉ nội bộ bị chặn: ${host}. Bật locaithAgent.fetch.allowPrivateNetwork nếu thật sự cần.`);
  }
  let addrs: { address: string; family: 4 | 6 }[];
  if (net.isIP(host)) addrs = [{ address: host, family: net.isIPv6(host) ? 6 : 4 }];
  else {
    try {
      addrs = await resolver(host);
    } catch {
      throw new Error(`Không phân giải được tên miền: ${host}`);
    }
  }
  if (addrs.length === 0) throw new Error(`Không phân giải được tên miền: ${host}`);
  if (addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error(`Địa chỉ nội bộ bị chặn: ${host} → ${addrs.map((a) => a.address).join(', ')}. Bật locaithAgent.fetch.allowPrivateNetwork nếu thật sự cần.`);
  }
  return addrs[0];
}
