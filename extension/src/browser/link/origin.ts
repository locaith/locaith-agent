/** Hàm thuần dùng ở cả dịch vụ nền (linkSw.ts) và khung chat (host.ts) — tách riêng để khung chat không phải nạp cả engine cầu nối. */

export function originOf(u: string): string {
  const x = new URL(u);
  if (!/^https?:$/.test(x.protocol)) throw new Error('Chỉ điều khiển được trang http/https.');
  return x.origin;
}

/** Mẫu quyền của Chrome KHÔNG có cổng: "http://localhost/*" khớp mọi cổng. Việc duyệt của ta vẫn theo origin ĐẦY ĐỦ (kể cả cổng). */
export function permPattern(origin: string): string {
  const u = new URL(origin);
  return `${u.protocol}//${u.hostname}/*`;
}
