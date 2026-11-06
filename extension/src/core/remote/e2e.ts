/**
 * Mã hoá đầu-cuối cho kênh Remote qua relay (Supabase Realtime): relay chỉ thấy bản mã, không đọc/sửa/chèn được tin.
 *
 * ⚠️ TỆP NÀY LÀ NGUỒN DUY NHẤT CHO CẢ HAI PHÍA — bản sao nguyên văn nằm ở locaith-ai-v2/src/screens/remote/relay/e2e.ts.
 * Sửa ở đây thì chép sang đó (test/relayCrypto.test.ts có vector kiểm thử cố định; cả hai phía chạy cùng vector).
 * Chỉ dùng WebCrypto (`globalThis.crypto.subtle`) nên chạy y hệt trong Node ≥ 20 và trình duyệt. Không import gì.
 *
 * Giao thức (v1, mọi chuỗi nhị phân là base64url không đệm):
 *
 *  GHÉP ĐÔI (một lần cho mỗi trình duyệt; người ngồi ở máy phải bấm «Cho phép»):
 *    host sinh `psk` (128 bit) đưa cho trình duyệt QUA KÊNH NGOÀI relay (liên kết/QR hiện trên màn hình VS Code).
 *    trình duyệt  → pair_req   { A, nC, label, mac = HMAC(psk, "pair_req"|A|nC|label) }          A = khoá ECDH P-256 tạm của trình duyệt
 *    host         → pair_hello { r=nC, B, nH, mac = HMAC(psk, "pair_hello"|A|B|nC|nH) }           B = khoá ECDH tạm của host
 *        hai bên tính  z = ECDH(a,B) = ECDH(b,A);  K_dev = HKDF(z, salt=psk, "device"|A|B|nC|nH);  SAS = 6 chữ số từ HKDF(z, salt=psk, "sas"|…)
 *        trình duyệt hiện SAS «123 456»; host hiện hộp thoại «Cho phép thiết bị X? Mã xác nhận 123 456» — người dùng so hai mã.
 *    host (sau khi cho phép) → pair_ok { r=nC, dev, mac = HMAC(K_dev, "pair_ok"|dev|A|B|nC|nH) }   hoặc  pair_no { r, reason, mac = HMAC(psk, …) }
 *
 *  PHIÊN (mỗi lần kết nối; khoá phiên có bí mật chuyển tiếp nhờ ECDH tạm mới):
 *    trình duyệt → hello    { dev, A2, n1, mac = HMAC(K_dev, "hello"|dev|A2|n1) }
 *    host        → hello_ok { r=n1, dev, sid, B2, n2, e, mac = HMAC(K_dev, "hello_ok"|dev|sid|A2|B2|n1|n2|e) }
 *        okm = HKDF(ECDH(a2,B2), salt=K_dev, "session"|dev|sid|A2|B2|n1|n2, 64);  c2h = okm[0..32), h2c = okm[32..64)
 *    sau đó mọi tin là khung `d` = AES-256-GCM (IV = 0⁴ ‖ u64be(q), AAD = "d"|hướng|sid|q), `q` tăng dần ở bên gửi. Bên nhận chống phát lại bằng
 *    CỬA SỔ TRƯỢT (REPLAY_WINDOW khung): mỗi `q` chỉ nhận một lần, `q` cũ hơn cửa sổ bị bỏ; khung đến lộn thứ tự trong cửa sổ vẫn nhận (đo trên Realtime thật:
 *    gửi dồn 12 khung thì có khi tới lộn thứ tự — kiểm `q` tăng ngặt sẽ làm rơi mảnh và tin lớn không bao giờ ghép được).
 *
 *  Tin lớn được cắt mảnh TRƯỚC khi mã hoá (xem encodeMessage/Reassembler) vì Supabase Realtime giới hạn ~250 KB/tin.
 */

// ── kiểu tối thiểu để cùng biên dịch được với tsconfig không có thư viện DOM ──────────
interface SubtleLike {
  generateKey(alg: unknown, extractable: boolean, usages: string[]): Promise<{ privateKey: unknown; publicKey: unknown }>;
  exportKey(format: string, key: unknown): Promise<ArrayBuffer>;
  importKey(format: string, data: unknown, alg: unknown, extractable: boolean, usages: string[]): Promise<unknown>;
  deriveBits(alg: unknown, key: unknown, length: number): Promise<ArrayBuffer>;
  sign(alg: unknown, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
  verify(alg: unknown, key: unknown, sig: Uint8Array, data: Uint8Array): Promise<boolean>;
  encrypt(alg: unknown, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
  decrypt(alg: unknown, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
}
interface CryptoLike {
  subtle: SubtleLike;
  getRandomValues<T extends Uint8Array>(a: T): T;
}
const cr = (): CryptoLike => (globalThis as unknown as { crypto: CryptoLike }).crypto;
const subtle = (): SubtleLike => cr().subtle;

export type EcdhPrivate = unknown;
export type AesKey = unknown;

export const PROTOCOL_V = 1;
export const TOPIC_PREFIX = 'lcr1:';
export const topicOf = (hostId: string): string => TOPIC_PREFIX + hostId;

// ── byte & base64url ─────────────────────────────────────────────────────────
const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: true });
export const utf8 = (s: string): Uint8Array => te.encode(s);
export const fromUtf8 = (b: Uint8Array): string => td.decode(b);

export function b64u(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x2000) s += String.fromCharCode(...b.subarray(i, i + 0x2000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(s: string): Uint8Array {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new Error('b64u');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export const u16be = (n: number): Uint8Array => new Uint8Array([(n >>> 8) & 255, n & 255]);
export const u32be = (n: number): Uint8Array => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
export function u64be(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('u64');
  const hi = Math.floor(n / 0x1_0000_0000);
  return concat(u32be(hi), u32be(n >>> 0));
}

/** Ghép có tiền tố độ dài: không có hai bộ tham số khác nhau nào cho cùng một chuỗi byte (chống nhập nhằng khi băm/ký). */
export function lp(label: string, ...parts: (Uint8Array | string)[]): Uint8Array {
  const items = [utf8(`lcr${PROTOCOL_V}/${label}`), ...parts.map((p) => (typeof p === 'string' ? utf8(p) : p))];
  const out: Uint8Array[] = [];
  for (const it of items) {
    if (it.length > 0xffff) throw new Error('lp: phần tử quá dài');
    out.push(u16be(it.length), it);
  }
  return concat(...out);
}

export function randomBytes(n: number): Uint8Array {
  return cr().getRandomValues(new Uint8Array(n));
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

// ── nguyên thuỷ ──────────────────────────────────────────────────────────────
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;

export async function genEcdh(): Promise<{ priv: EcdhPrivate; pub: Uint8Array }> {
  const kp = await subtle().generateKey(ECDH, false, ['deriveBits']);
  return { priv: kp.privateKey, pub: new Uint8Array(await subtle().exportKey('raw', kp.publicKey)) };
}

/** Khoá công khai thô 65 byte (0x04‖X‖Y). WebCrypto từ chối điểm không nằm trên đường cong (chặn tấn công đường cong không hợp lệ). */
export async function ecdh(priv: EcdhPrivate, peerPub: Uint8Array): Promise<Uint8Array> {
  if (peerPub.length !== 65 || peerPub[0] !== 4) throw new Error('khoá công khai không hợp lệ');
  const pub = await subtle().importKey('raw', peerPub, ECDH, false, []);
  return new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: pub }, priv, 256));
}

export async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}

const HMAC = { name: 'HMAC', hash: 'SHA-256' } as const;

export async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', key, HMAC, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', k, data));
}

/** So MAC bằng `verify` của WebCrypto (thời gian không đổi). */
export async function hmacVerify(key: Uint8Array, data: Uint8Array, mac: Uint8Array): Promise<boolean> {
  if (mac.length !== 32) return false;
  const k = await subtle().importKey('raw', key, HMAC, false, ['verify']);
  return subtle().verify('HMAC', k, mac, data);
}

const aesKey = (raw: Uint8Array): Promise<AesKey> => subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

// ── ghép đôi ─────────────────────────────────────────────────────────────────
export interface PairParams {
  A: Uint8Array;
  B: Uint8Array;
  nC: Uint8Array;
  nH: Uint8Array;
}

/** K_dev (256 bit, dùng lâu dài cho thiết bị này) và mã so sánh SAS 6 chữ số. */
export async function derivePairing(z: Uint8Array, psk: Uint8Array, p: PairParams): Promise<{ kDev: Uint8Array; sas: string }> {
  const kDev = await hkdf(z, psk, lp('device', p.A, p.B, p.nC, p.nH), 32);
  const sasBytes = await hkdf(z, psk, lp('sas', p.A, p.B, p.nC, p.nH), 4);
  const n = ((sasBytes[0]! << 24) | (sasBytes[1]! << 16) | (sasBytes[2]! << 8) | sasBytes[3]!) >>> 0;
  const six = String(n % 1_000_000).padStart(6, '0');
  return { kDev, sas: `${six.slice(0, 3)} ${six.slice(3)}` };
}

export const macPairReq = (psk: Uint8Array, A: Uint8Array, nC: Uint8Array, label: string) => hmac(psk, lp('pair_req', A, nC, label));
export const macPairHello = (psk: Uint8Array, p: PairParams) => hmac(psk, lp('pair_hello', p.A, p.B, p.nC, p.nH));
export const macPairOk = (kDev: Uint8Array, dev: string, p: PairParams) => hmac(kDev, lp('pair_ok', dev, p.A, p.B, p.nC, p.nH));
export const macPairNo = (psk: Uint8Array, nC: Uint8Array, reason: string) => hmac(psk, lp('pair_no', nC, reason));

// ── phiên ────────────────────────────────────────────────────────────────────
export interface HelloParams {
  dev: string;
  A: Uint8Array;
  n1: Uint8Array;
}
export interface HelloOkParams extends HelloParams {
  sid: Uint8Array;
  B: Uint8Array;
  n2: Uint8Array;
  epoch: string;
}

export const macHello = (kDev: Uint8Array, h: HelloParams) => hmac(kDev, lp('hello', h.dev, h.A, h.n1));
export const macHelloOk = (kDev: Uint8Array, h: HelloOkParams) => hmac(kDev, lp('hello_ok', h.dev, h.sid, h.A, h.B, h.n1, h.n2, h.epoch));

/** Khoá phiên hai chiều: c2h = trình duyệt→host, h2c = host→trình duyệt. */
export async function deriveSession(z: Uint8Array, kDev: Uint8Array, h: HelloOkParams): Promise<{ c2h: Uint8Array; h2c: Uint8Array }> {
  const okm = await hkdf(z, kDev, lp('session', h.dev, h.sid, h.A, h.B, h.n1, h.n2), 64);
  return { c2h: okm.slice(0, 32), h2c: okm.slice(32, 64) };
}

// ── kênh mã hoá ──────────────────────────────────────────────────────────────
export const DIR_C2H = 1;
export const DIR_H2C = 2;

/** Số khung gần nhất (tính từ `q` lớn nhất đã nhận) mà bên nhận còn chấp nhận đến lộn thứ tự. Đủ rộng cho một tin lớn cắt mảnh (≤ 160) cộng các tin theo sau. */
export const REPLAY_WINDOW = 1024;

export class SecureChannel {
  private sendQ = 0;
  private maxQ = 0;
  /** `q` đã nhận trong cửa sổ trượt (để từ chối trùng lặp). */
  private readonly seen = new Set<number>();
  /** `q` đang giải mã dở (chống hai khung giống hệt giải mã song song rồi cùng lọt qua). */
  private readonly inflight = new Set<number>();
  private constructor(
    readonly sid: Uint8Array,
    private readonly sendKey: AesKey,
    private readonly recvKey: AesKey,
    private readonly sendDir: number,
    private readonly recvDir: number,
  ) {}

  /** `role` = bên nào đang giữ đối tượng này. */
  static async create(role: 'client' | 'host', sid: Uint8Array, keys: { c2h: Uint8Array; h2c: Uint8Array }): Promise<SecureChannel> {
    const [c2h, h2c] = await Promise.all([aesKey(keys.c2h), aesKey(keys.h2c)]);
    return role === 'client' ? new SecureChannel(sid, c2h, h2c, DIR_C2H, DIR_H2C) : new SecureChannel(sid, h2c, c2h, DIR_H2C, DIR_C2H);
  }

  private static iv(q: number): Uint8Array {
    return concat(new Uint8Array(4), u64be(q));
  }
  private static aad(dir: number, sid: Uint8Array, q: number): Uint8Array {
    return lp('d', new Uint8Array([dir]), sid, u64be(q));
  }

  async seal(plain: Uint8Array): Promise<{ q: number; c: Uint8Array }> {
    const q = ++this.sendQ;
    if (!Number.isSafeInteger(q)) throw new Error('hết bộ đếm');
    const c = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: SecureChannel.iv(q), additionalData: SecureChannel.aad(this.sendDir, this.sid, q), tagLength: 128 }, this.sendKey, plain));
    return { q, c };
  }

  /**
   * null = bản mã sai/bị sửa, `q` đã nhận rồi (phát lại), hoặc `q` cũ hơn cửa sổ. Khung đến lộn thứ tự trong cửa sổ vẫn được nhận.
   * Chỉ ghi nhận `q` SAU khi giải mã thành công (khung giả không làm hỏng trạng thái).
   */
  async open(q: number, c: Uint8Array): Promise<Uint8Array | null> {
    if (!Number.isSafeInteger(q) || q < 1 || c.length < 16) return null;
    if (q <= this.maxQ - REPLAY_WINDOW || this.seen.has(q) || this.inflight.has(q)) return null;
    this.inflight.add(q);
    try {
      const p = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: SecureChannel.iv(q), additionalData: SecureChannel.aad(this.recvDir, this.sid, q), tagLength: 128 }, this.recvKey, c));
      this.seen.add(q);
      if (q > this.maxQ) {
        this.maxQ = q;
        for (const x of this.seen) if (x <= this.maxQ - REPLAY_WINDOW) this.seen.delete(x);
      }
      return p;
    } catch {
      return null;
    } finally {
      this.inflight.delete(q);
    }
  }
}

// ── khung & cắt mảnh ─────────────────────────────────────────────────────────
/** Phần tải tối đa mỗi mảnh (byte thô, trước mã hoá). Sau base64url + JSON vẫn < ~56 KB, xa giới hạn 250 KB của Realtime. */
export const CHUNK_BYTES = 36_000;
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_PARTS = 160;
const MAX_ASSEMBLIES = 4;
const ASSEMBLY_TTL_MS = 30_000;

/** Object → các khung thô (xem encodeJson). */
export function encodeMessage(obj: unknown, mid: number, chunkBytes = CHUNK_BYTES): Uint8Array[] {
  return encodeJson(JSON.stringify(obj), mid, chunkBytes);
}

/** Chuỗi JSON → các khung thô (0x00‖json nếu vừa một mảnh; ngược lại 0x01‖mid‖idx‖total‖bytes). */
export function encodeJson(json: string, mid: number, chunkBytes = CHUNK_BYTES): Uint8Array[] {
  const body = utf8(json);
  if (body.length > MAX_MESSAGE_BYTES) throw new Error('tin quá lớn');
  if (body.length < chunkBytes) return [concat(new Uint8Array([0]), body)];
  const total = Math.ceil(body.length / chunkBytes);
  if (total > MAX_PARTS) throw new Error('tin quá lớn');
  const out: Uint8Array[] = [];
  for (let i = 0; i < total; i++) out.push(concat(new Uint8Array([1]), u32be(mid >>> 0), u16be(i), u16be(total), body.subarray(i * chunkBytes, (i + 1) * chunkBytes)));
  return out;
}

export class Reassembler {
  private readonly asm = new Map<number, { total: number; parts: (Uint8Array | undefined)[]; got: number; bytes: number; at: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  /** Nhận một khung đã giải mã; trả object khi đủ mảnh, null nếu chưa đủ hoặc khung không hợp lệ. */
  push(frame: Uint8Array): unknown | null {
    const t = this.now();
    for (const [k, a] of this.asm) if (t - a.at > ASSEMBLY_TTL_MS) this.asm.delete(k);
    if (frame.length < 1) return null;
    if (frame[0] === 0) return parseJson(frame.subarray(1));
    if (frame[0] !== 1 || frame.length < 9) return null;
    const mid = ((frame[1]! << 24) | (frame[2]! << 16) | (frame[3]! << 8) | frame[4]!) >>> 0;
    const idx = (frame[5]! << 8) | frame[6]!;
    const total = (frame[7]! << 8) | frame[8]!;
    if (total < 2 || total > MAX_PARTS || idx >= total) return null;
    let a = this.asm.get(mid);
    if (!a) {
      if (this.asm.size >= MAX_ASSEMBLIES) return null;
      a = { total, parts: new Array(total), got: 0, bytes: 0, at: t };
      this.asm.set(mid, a);
    }
    if (a.total !== total || a.parts[idx]) return null;
    const part = frame.slice(9);
    a.bytes += part.length;
    if (a.bytes > MAX_MESSAGE_BYTES) {
      this.asm.delete(mid);
      return null;
    }
    a.parts[idx] = part;
    a.got++;
    if (a.got < a.total) return null;
    this.asm.delete(mid);
    return parseJson(concat(...(a.parts as Uint8Array[])));
  }
}

function parseJson(b: Uint8Array): unknown | null {
  try {
    return JSON.parse(fromUtf8(b));
  } catch {
    return null;
  }
}

// ── tin trên dây (kiểm nghiêm ngặt: kênh là quảng bá, ai biết tên kênh đều gửi được) ─────────
const B64 = /^[A-Za-z0-9_-]+$/;
const lenB64 = (bytes: number): number => Math.ceil((bytes * 4) / 3);
const isB64 = (v: unknown, bytes: number): v is string => typeof v === 'string' && v.length === lenB64(bytes) && B64.test(v);

export type Wire =
  | { t: 'pair_req'; v: 1; A: string; nC: string; label: string; mac: string }
  | { t: 'pair_hello'; r: string; B: string; nH: string; mac: string }
  | { t: 'pair_ok'; r: string; dev: string; mac: string }
  | { t: 'pair_no'; r: string; reason: string; mac: string }
  | { t: 'hello'; v: 1; dev: string; A: string; n: string; mac: string }
  | { t: 'hello_ok'; r: string; dev: string; sid: string; B: string; n: string; e: string; mac: string }
  | { t: 'hello_no'; r: string; dev: string; reason: string }
  | { t: 'reset'; s: string }
  | { t: 'd'; s: string; q: number; c: string };

export const SID_BYTES = 8;
export const DEV_BYTES = 12;
export const PSK_BYTES = 16;
export const HOST_ID_BYTES = 16;

/**
 * Thiết bị «tài khoản» (0.6.5): trình duyệt đã đăng nhập ĐÚNG tài khoản Locaith của chủ máy vào được ngay, không ghép đôi từng trình duyệt.
 * Máy báo danh với tài khoản một «khoá tài khoản» ngẫu nhiên 128 bit (chỉ chủ tài khoản đọc lại được, xem migration 20261105); khoá thiết bị của nhóm
 * này SUY RA từ nó nên không có bản ghi thiết bị nào để lưu hay dọn. Đổi khoá tài khoản = mọi bên đang giữ khoá cũ mất quyền ngay.
 * `ACCOUNT_DEV` là mã thiết bị cố định (12 byte 0; mã ghép đôi ngẫu nhiên 96 bit không trùng được), `deriveAccountKey` là K_dev của nó.
 * Phiên vẫn bắt tay như thiết bị thường (`hello`/`hello_ok`, ECDH tạm mỗi phiên → bí mật chuyển tiếp); chỉ khác nguồn gốc K_dev.
 */
export const ACCOUNT_DEV = b64u(new Uint8Array(DEV_BYTES));
export async function deriveAccountKey(accountKey: Uint8Array, hostId: string): Promise<Uint8Array> {
  return hkdf(accountKey, new Uint8Array(0), lp('account_dev', hostId), 32);
}

export function parseWire(raw: unknown): Wire | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  switch (o.t) {
    case 'pair_req':
      return o.v === 1 && isB64(o.A, 65) && isB64(o.nC, 16) && typeof o.label === 'string' && o.label.length <= 64 && isB64(o.mac, 32) ? { t: 'pair_req', v: 1, A: o.A, nC: o.nC, label: o.label, mac: o.mac } : null;
    case 'pair_hello':
      return isB64(o.r, 16) && isB64(o.B, 65) && isB64(o.nH, 16) && isB64(o.mac, 32) ? { t: 'pair_hello', r: o.r, B: o.B, nH: o.nH, mac: o.mac } : null;
    case 'pair_ok':
      return isB64(o.r, 16) && isB64(o.dev, DEV_BYTES) && isB64(o.mac, 32) ? { t: 'pair_ok', r: o.r, dev: o.dev, mac: o.mac } : null;
    case 'pair_no':
      return isB64(o.r, 16) && typeof o.reason === 'string' && /^[a-z_]{1,24}$/.test(o.reason) && isB64(o.mac, 32) ? { t: 'pair_no', r: o.r, reason: o.reason, mac: o.mac } : null;
    case 'hello':
      return o.v === 1 && isB64(o.dev, DEV_BYTES) && isB64(o.A, 65) && isB64(o.n, 16) && isB64(o.mac, 32) ? { t: 'hello', v: 1, dev: o.dev, A: o.A, n: o.n, mac: o.mac } : null;
    case 'hello_ok':
      return isB64(o.r, 16) && isB64(o.dev, DEV_BYTES) && isB64(o.sid, SID_BYTES) && isB64(o.B, 65) && isB64(o.n, 16) && typeof o.e === 'string' && /^[0-9a-f]{1,32}$/.test(o.e) && isB64(o.mac, 32)
        ? { t: 'hello_ok', r: o.r, dev: o.dev, sid: o.sid, B: o.B, n: o.n, e: o.e, mac: o.mac }
        : null;
    case 'hello_no':
      return isB64(o.r, 16) && isB64(o.dev, DEV_BYTES) && typeof o.reason === 'string' && /^[a-z_]{1,24}$/.test(o.reason) ? { t: 'hello_no', r: o.r, dev: o.dev, reason: o.reason } : null;
    case 'reset':
      return isB64(o.s, SID_BYTES) ? { t: 'reset', s: o.s } : null;
    case 'd':
      return isB64(o.s, SID_BYTES) && typeof o.q === 'number' && Number.isSafeInteger(o.q) && o.q >= 1 && typeof o.c === 'string' && o.c.length >= 22 && o.c.length <= 100_000 && B64.test(o.c)
        ? { t: 'd', s: o.s, q: o.q, c: o.c }
        : null;
    default:
      return null;
  }
}

// ── liên kết ghép đôi ────────────────────────────────────────────────────────
export interface PairingLink {
  hostId: string;
  psk: string;
  /** Tên máy để hiển thị (không bí mật). */
  name?: string;
}

/** `#remote?r=<hostId>&k=<psk>[&n=<tên máy>]` — nằm sau dấu # nên không bao giờ gửi tới máy chủ web. */
export function pairingLink(web: string, l: PairingLink): string {
  const q = new URLSearchParams({ r: l.hostId, k: l.psk, ...(l.name ? { n: l.name.slice(0, 48) } : {}) });
  return `${web.replace(/\/+$/, '')}/#remote?${q.toString()}`;
}

/** Nhận cả liên kết đầy đủ lẫn đoạn `remote?r=…&k=…`; trả null nếu không hợp lệ. */
export function parsePairingLink(input: string): PairingLink | null {
  const m = /[?&#]r=([A-Za-z0-9_-]+)/.exec(input);
  const k = /[?&#]k=([A-Za-z0-9_-]+)/.exec(input);
  if (!m || !k || !isB64(m[1], HOST_ID_BYTES) || !isB64(k[1], PSK_BYTES)) return null;
  const n = /[?&#]n=([^&#]*)/.exec(input);
  let name: string | undefined;
  try {
    name = n ? decodeURIComponent(n[1]!.replace(/\+/g, ' ')).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 48) || undefined : undefined;
  } catch {
    name = undefined;
  }
  return { hostId: m[1]!, psk: k[1]!, ...(name ? { name } : {}) };
}
