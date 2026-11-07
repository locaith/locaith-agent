/**
 * Nhãn chẩn đoán gắn vào MỌI yêu cầu tới cổng Locaith (lane:gateway-client, H02).
 *
 * Log của cổng từng có 83/83 bản ghi lỗi thiếu client/tài khoản/thiết bị nên không điều tra được. Ba tiêu đề dưới đây cho phép cổng nối một dòng log với
 * một họ máy khách, một thiết bị và một phiên trò chuyện MÀ KHÔNG biết người dùng là ai:
 *
 *   X-Locaith-Client:  vscode/0.6.32            họ máy khách + phiên bản (vscode | browser | cli)
 *   X-Locaith-Device:  <16 hex>                 băm một chiều của mã thiết bị (id thiết bị cấp lúc đăng nhập) — KHÔNG phải mã thô, KHÔNG phải email
 *   X-Locaith-Session: <16 hex>                 băm một chiều của id phiên chat — KHÔNG gửi id thô, không có đường dẫn / tên dự án
 *
 * Băm = SHA-256 của `locaith-<loại>:<giá trị>`, lấy 16 ký tự hex đầu (64 bit: đủ để nối bản ghi, không đủ để suy ngược). Cổng muốn đối chiếu thì tự băm cùng công thức
 * (xem docs/GATEWAY-LOGGING.md). Tệp này thuần (không import `vscode` hay `node:*`) nên dùng chung cho bản VS Code, trình duyệt và CLI.
 */

export type GatewayClientFamily = 'vscode' | 'browser' | 'cli';

// ── SHA-256 thuần JS (đồng bộ; tiêu đề phải tính ngay, mà WebCrypto chỉ có bản bất đồng bộ) ────────────────────────────
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** SHA-256 của chuỗi UTF-8, trả về 64 ký tự hex. */
export function sha256Hex(text: string): string {
  const msg = new TextEncoder().encode(text);
  const bitLen = msg.length * 8;
  const padded = new Uint8Array(((msg.length + 9 + 63) >> 6) << 6);
  padded.set(msg);
  padded[msg.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(padded.length - 4, bitLen >>> 0);

  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25);
      const ch = (e! & f!) ^ (~e! & g!);
      const t1 = (hh! + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22);
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d! + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a!) >>> 0;
    h[1] = (h[1]! + b!) >>> 0;
    h[2] = (h[2]! + c!) >>> 0;
    h[3] = (h[3]! + d!) >>> 0;
    h[4] = (h[4]! + e!) >>> 0;
    h[5] = (h[5]! + f!) >>> 0;
    h[6] = (h[6]! + g!) >>> 0;
    h[7] = (h[7]! + hh!) >>> 0;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('');
}

/** Băm một chiều có tên miền (device | session), 16 ký tự hex. */
export function diagHash(domain: 'device' | 'session', value: string): string {
  return sha256Hex(`locaith-${domain}:${value}`).slice(0, 16);
}

/** Phiên bản chỉ giữ ký tự an toàn cho tiêu đề (semver); rỗng → "0". */
function safeVersion(v: string): string {
  return v.replace(/[^A-Za-z0-9.+-]/g, '').slice(0, 24) || '0';
}

export interface GatewayDiagnosticsInput {
  family: GatewayClientFamily;
  /** Phiên bản extension / bản trình duyệt / CLI. */
  version: string;
  /** Mã thiết bị đã cấp lúc đăng nhập (chưa băm). Không có = không gửi tiêu đề thiết bị. */
  deviceId?: string;
  /** Id phiên chat (chưa băm). */
  sessionKey?: string;
}

/** Ba tiêu đề chẩn đoán; chỉ chứa họ+phiên bản và hai mã băm. */
export function gatewayDiagnosticHeaders(i: GatewayDiagnosticsInput): Record<string, string> {
  return {
    'x-locaith-client': `${i.family}/${safeVersion(i.version)}`,
    ...(i.deviceId ? { 'x-locaith-device': diagHash('device', i.deviceId) } : {}),
    ...(i.sessionKey ? { 'x-locaith-session': diagHash('session', i.sessionKey) } : {}),
  };
}
