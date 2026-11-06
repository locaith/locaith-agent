/**
 * Địa chỉ API nhận khoá của người dùng: bắt buộc https. http chỉ chấp nhận cho máy cục bộ/mạng nội bộ (Ollama, LM Studio,
 * proxy công ty) vì khoá và nội dung hội thoại sẽ đi qua đó dạng không mã hoá. Dùng chung cho VS Code và trình duyệt.
 */
export function isAllowedBaseUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;
  if (h === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return !h.includes('.'); // tên máy trong mạng nội bộ (không có dấu chấm)
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
