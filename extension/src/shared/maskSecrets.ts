const KEY_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /xai-[A-Za-z0-9]{16,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  /(x-api-key["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]{12,}/gi,
];

/** Che mọi thứ trông như khoá API trước khi ghi nhật ký. Dùng chung cho VS Code và trình duyệt. */
export function maskSecrets(text: string, extra: Iterable<string> = []): string {
  let out = text;
  for (const s of extra) if (s && s.length >= 8) out = out.split(s).join('***');
  for (const re of KEY_PATTERNS) out = out.replace(re, (_m, p1) => (typeof p1 === 'string' ? p1 + '***' : '***'));
  return out;
}
