/**
 * Phân tích địa chỉ IP thành số rồi so với các dải đặc biệt — phần THUẦN của bộ chặn SSRF (không dns/net của Node) để cả bản
 * trình duyệt dùng chung. Không so chuỗi: WHATWG URL đổi `[::ffff:127.0.0.1]` thành `[::ffff:7f00:1]`, nên mọi phép khớp
 * theo dạng dấu chấm đều bị vượt qua.
 */

/** Dải IPv4 không phải địa chỉ công cộng dùng được. */
export function isPrivateIPv4(a: number, b: number, c: number, _d: number): boolean {
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) || // link-local + metadata đám mây
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // 192.0.0.0/24, 192.0.2.0/24
    (a === 192 && b === 88 && c === 99) || // 6to4 relay
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmark 198.18/15
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast + dành riêng + broadcast
  );
}

/** Phân tích IPv6 thành 8 nhóm 16-bit; null nếu không hợp lệ. Hỗ trợ `::`, đuôi IPv4 dạng chấm và vùng `%zone`. */
export function parseIPv6(input: string): number[] | null {
  let s = input.replace(/^\[|\]$/g, '').toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);

  let v4: number[] | null = null;
  const m4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (m4) {
    const p = [m4[1], m4[2], m4[3], m4[4]].map(Number);
    if (p.some((n) => n > 255)) return null;
    v4 = [(p[0] << 8) | p[1], (p[2] << 8) | p[3]];
    s = s.slice(0, s.length - m4[0].length) + '0:0';
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const split = (x: string) => (x === '' ? [] : x.split(':'));
  const head = split(halves[0]);
  const rest = halves.length === 2 ? split(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;

  const raw = halves.length === 2 ? [...head, ...Array<string>(missing).fill('0'), ...rest] : head;
  const groups: number[] = [];
  for (const g of raw) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    groups.push(parseInt(g, 16));
  }
  if (groups.length !== 8) return null;
  if (v4) {
    groups[6] = v4[0];
    groups[7] = v4[1];
  }
  return groups;
}

const embeddedV4 = (hi: number, lo: number) => isPrivateIPv4(hi >> 8, hi & 255, lo >> 8, lo & 255);

export function isPrivateIPv6(g: number[]): boolean {
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  // :: và ::1
  if (zero(0, 7) && (g[7] === 0 || g[7] === 1)) return true;
  // ::/96 (IPv4-compatible, lỗi thời) — coi như không công cộng
  if (zero(0, 6)) return true;
  // ::ffff:0:0/96 — IPv4 bọc trong IPv6
  if (zero(0, 5) && g[5] === 0xffff) return embeddedV4(g[6], g[7]);
  // 64:ff9b::/96 — NAT64; 64:ff9b:1::/48 — dùng nội bộ
  if (g[0] === 0x64 && g[1] === 0xff9b) return g[2] === 0 && zero(2, 6) ? embeddedV4(g[6], g[7]) : true;
  // 2002::/16 — 6to4, chứa IPv4 ở nhóm 1–2
  if (g[0] === 0x2002) return embeddedV4(g[1], g[2]);
  // 2001::/23 (Teredo + dải IETF) và 2001:db8::/32 (tài liệu)
  if (g[0] === 0x2001 && (g[1] <= 0x01ff || g[1] === 0x0db8)) return true;
  // 100::/64 (discard)
  if (g[0] === 0x0100 && zero(1, 4)) return true;
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

export function isIPv4(s: string): boolean {
  return IPV4_RE.test(s);
}

export function isIPv6(s: string): boolean {
  return s.includes(':') && parseIPv6(s) !== null;
}

/** true nếu `ip` là địa chỉ không công cộng (hoặc không phân tích được → coi là không an toàn). */
export function isPrivateIp(ip: string): boolean {
  const clean = ip.replace(/^\[|\]$/g, '');
  if (isIPv4(clean)) {
    const [a, b, c, d] = clean.split('.').map(Number);
    return isPrivateIPv4(a, b, c, d);
  }
  if (clean.includes(':')) {
    const g = parseIPv6(clean);
    return g === null ? true : isPrivateIPv6(g);
  }
  return false;
}

/** Tên máy nội bộ / hậu tố tên miền chỉ có ý nghĩa trong mạng riêng. */
export function isInternalHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.home.arpa');
}

/**
 * Kiểm tra KHÔNG cần DNS: tên nội bộ, IP thuần ở dạng bất kỳ mà WHATWG URL đã chuẩn hoá (thập phân/hex/bát phân đã đổi thành a.b.c.d).
 * Bản trình duyệt không ghim được IP theo kết nối nên chỉ chặn được những gì nhìn thấy trên URL.
 */
export function isPrivateHostLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
  if (isInternalHostname(host)) return true;
  if (isIPv4(host) || host.includes(':')) return isPrivateIp(host);
  return false;
}
