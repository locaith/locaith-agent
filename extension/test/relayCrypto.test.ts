import { describe, expect, it } from 'vitest';
import {
  CHUNK_BYTES,
  DEV_BYTES,
  PSK_BYTES,
  REPLAY_WINDOW,
  Reassembler,
  SecureChannel,
  b64u,
  concat,
  derivePairing,
  deriveSession,
  ecdh,
  encodeMessage,
  genEcdh,
  hmac,
  hmacVerify,
  lp,
  macHello,
  macHelloOk,
  macPairHello,
  macPairNo,
  macPairOk,
  macPairReq,
  pairingLink,
  parsePairingLink,
  parseWire,
  randomBytes,
  u64be,
  unb64u,
  utf8,
  type EcdhPrivate,
  ACCOUNT_DEV,
  deriveAccountKey,
} from '../src/core/remote/e2e';
import VECTORS from './fixtures/relay-vectors.json';

const subtle = (globalThis as unknown as { crypto: { subtle: { importKey(...a: unknown[]): Promise<unknown> } } }).crypto.subtle;
const importPriv = (jwk: object): Promise<EcdhPrivate> => subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (s: string): Uint8Array => new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16)));
const seq = (start: number, n: number): Uint8Array => new Uint8Array(Array.from({ length: n }, (_, i) => start + i));

describe('tiện ích byte', () => {
  it('base64url: khứ hồi mọi độ dài 0..70, không đệm, và từ chối ký tự lạ/độ dài vô lý', () => {
    for (let n = 0; n <= 70; n++) {
      const b = randomBytes(n);
      const s = b64u(b);
      expect(s).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(Array.from(unb64u(s))).toEqual(Array.from(b));
    }
    expect(() => unb64u('ab+/')).toThrow();
    expect(() => unb64u('a')).toThrow(); // độ dài ≡ 1 (mod 4)
    expect(() => unb64u('ab=c')).toThrow();
  });
  it('lp: tiền tố độ dài khiến các bộ tham số khác nhau không bao giờ trùng chuỗi byte', () => {
    expect(hex(lp('x', 'ab', 'c'))).not.toBe(hex(lp('x', 'a', 'bc')));
    expect(hex(lp('x', 'a'))).not.toBe(hex(lp('y', 'a')));
  });
  it('u64be big-endian đúng với số > 2^32', () => {
    expect(hex(u64be(1))).toBe('0000000000000001');
    expect(hex(u64be(0x1_0000_0002))).toBe('0000000100000002');
    expect(() => u64be(-1)).toThrow();
  });
});

describe('ghép đôi (ECDH P-256 + psk) — hai phía tính ra cùng K_dev và cùng mã SAS', () => {
  async function run(pskHost: Uint8Array, pskWeb: Uint8Array) {
    const web = await genEcdh();
    const host = await genEcdh();
    const nC = randomBytes(16);
    const nH = randomBytes(16);
    const p = { A: web.pub, B: host.pub, nC, nH };
    const zW = await ecdh(web.priv, host.pub);
    const zH = await ecdh(host.priv, web.pub);
    return { p, web: await derivePairing(zW, pskWeb, p), host: await derivePairing(zH, pskHost, p), zW, zH };
  }

  it('cùng psk → cùng K_dev (32 byte) và cùng SAS 6 chữ số dạng "123 456"', async () => {
    const psk = randomBytes(PSK_BYTES);
    const r = await run(psk, psk);
    expect(hex(r.zW)).toBe(hex(r.zH));
    expect(hex(r.web.kDev)).toBe(hex(r.host.kDev));
    expect(r.web.kDev.length).toBe(32);
    expect(r.web.sas).toMatch(/^\d{3} \d{3}$/);
    expect(r.web.sas).toBe(r.host.sas);
  });

  it('khác psk → K_dev khác hẳn (kẻ giữa đường không có psk không dựng được khoá)', async () => {
    const r = await run(randomBytes(16), randomBytes(16));
    expect(hex(r.web.kDev)).not.toBe(hex(r.host.kDev));
  });

  it('MAC ghép đôi: đúng psk thì xác minh được; sai psk / sửa một bit / sai nhãn thì không', async () => {
    const psk = randomBytes(16);
    const r = await run(psk, psk);
    const label = 'Chrome · Windows';
    const mac = await macPairReq(psk, r.p.A, r.p.nC, label);
    const data = lp('pair_req', r.p.A, r.p.nC, label);
    expect(await hmacVerify(psk, data, mac)).toBe(true);
    expect(await hmacVerify(randomBytes(16), data, mac)).toBe(false);
    expect(await hmacVerify(psk, lp('pair_req', r.p.A, r.p.nC, 'Chrome · Linux'), mac)).toBe(false);
    const flipped = mac.slice();
    flipped[0]! ^= 1;
    expect(await hmacVerify(psk, data, flipped)).toBe(false);
    expect(await hmacVerify(psk, data, mac.slice(0, 31))).toBe(false);
    expect(hex(await macPairHello(psk, r.p))).not.toBe(hex(await macPairReq(psk, r.p.A, r.p.nC, label)));
    expect(hex(await macPairNo(psk, r.p.nC, 'denied'))).not.toBe(hex(await macPairNo(psk, r.p.nC, 'expired')));
    expect((await macPairOk(r.web.kDev, b64u(randomBytes(DEV_BYTES)), r.p)).length).toBe(32);
  });

  it('khoá công khai sai (không phải điểm trên đường cong / sai độ dài) bị từ chối', async () => {
    const a = await genEcdh();
    await expect(ecdh(a.priv, new Uint8Array(65))).rejects.toThrow();
    const bad = a.pub.slice();
    bad[40]! ^= 0xff;
    await expect(ecdh(a.priv, bad)).rejects.toBeTruthy(); // điểm không nằm trên P-256
    await expect(ecdh(a.priv, a.pub.slice(0, 64))).rejects.toThrow();
  });
});

describe('phiên: khoá hai chiều, bí mật chuyển tiếp, chống phát lại', () => {
  async function session() {
    const kDev = randomBytes(32);
    const web = await genEcdh();
    const host = await genEcdh();
    const h = { dev: b64u(randomBytes(DEV_BYTES)), A: web.pub, B: host.pub, n1: randomBytes(16), n2: randomBytes(16), sid: randomBytes(8), epoch: 'abcdef012345' };
    const zW = await ecdh(web.priv, host.pub);
    const zH = await ecdh(host.priv, web.pub);
    const kw = await deriveSession(zW, kDev, h);
    const kh = await deriveSession(zH, kDev, h);
    return { kDev, h, kw, kh, client: await SecureChannel.create('client', h.sid, kw), host: await SecureChannel.create('host', h.sid, kh) };
  }

  it('hai chiều dùng hai khoá khác nhau, hai bên suy ra giống nhau', async () => {
    const s = await session();
    expect(hex(s.kw.c2h)).toBe(hex(s.kh.c2h));
    expect(hex(s.kw.h2c)).toBe(hex(s.kh.h2c));
    expect(hex(s.kw.c2h)).not.toBe(hex(s.kw.h2c));
  });

  it('mã hoá/giải mã khứ hồi cả hai chiều', async () => {
    const s = await session();
    const a = await s.client.seal(utf8('lệnh từ trình duyệt'));
    expect(new TextDecoder().decode((await s.host.open(a.q, a.c))!)).toBe('lệnh từ trình duyệt');
    const b = await s.host.seal(utf8('sự kiện từ host'));
    expect(new TextDecoder().decode((await s.client.open(b.q, b.c))!)).toBe('sự kiện từ host');
  });

  it('bản mã không lộ nội dung và dài hơn bản rõ đúng 16 byte (thẻ GCM)', async () => {
    const s = await session();
    const plain = utf8('{"k":"cmd","cmd":{"type":"send","text":"đọc ~/.ssh/id_rsa"}}');
    const a = await s.client.seal(plain);
    expect(a.c.length).toBe(plain.length + 16);
    expect(hex(a.c)).not.toContain(hex(plain.slice(0, 8)));
  });

  it('phát lại cùng khung bị từ chối (kể cả khung tới lộn thứ tự); khung hợp lệ kế tiếp vẫn nhận', async () => {
    const s = await session();
    const f1 = await s.client.seal(utf8('1'));
    const f2 = await s.client.seal(utf8('2'));
    expect(await s.host.open(f2.q, f2.c)).not.toBeNull();
    expect(await s.host.open(f2.q, f2.c)).toBeNull(); // phát lại
    expect(new TextDecoder().decode((await s.host.open(f1.q, f1.c))!)).toBe('1'); // đến lộn thứ tự trong cửa sổ: nhận
    expect(await s.host.open(f1.q, f1.c)).toBeNull(); // nhưng chỉ một lần
    const f3 = await s.client.seal(utf8('3'));
    expect(await s.host.open(f3.q, f3.c)).not.toBeNull();
  });

  it('đảo thứ tự ngẫu nhiên cả trăm khung: mỗi khung được nhận đúng một lần, không khung nào bị rơi', async () => {
    const s = await session();
    const frames = [];
    for (let i = 0; i < 100; i++) frames.push({ i, ...(await s.client.seal(utf8(String(i)))) });
    const shuffled = frames.sort(() => Math.random() - 0.5);
    const got: number[] = [];
    for (const f of shuffled) {
      const p = await s.host.open(f.q, f.c);
      expect(p).not.toBeNull();
      got.push(Number(new TextDecoder().decode(p!)));
      expect(await s.host.open(f.q, f.c)).toBeNull(); // phát lại ngay sau đó bị từ chối
    }
    expect(got.sort((a, b) => a - b)).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  it('khung cũ hơn cửa sổ chống phát lại bị từ chối', async () => {
    const s = await session();
    const first = await s.client.seal(utf8('đầu'));
    let last = first;
    for (let i = 0; i < REPLAY_WINDOW + 5; i++) last = await s.client.seal(utf8('x'));
    expect(await s.host.open(last.q, last.c)).not.toBeNull(); // đẩy maxQ lên
    expect(await s.host.open(first.q, first.c)).toBeNull(); // q = 1 đã quá cũ so với cửa sổ
  });

  it('hai khung giống hệt giải mã song song: chỉ một khung lọt qua', async () => {
    const s = await session();
    const f = await s.client.seal(utf8('một'));
    const [a, b] = await Promise.all([s.host.open(f.q, f.c), s.host.open(f.q, f.c)]);
    expect([a, b].filter((x) => x !== null)).toHaveLength(1);
  });

  it('sửa một bit bản mã / đổi q / đổi hướng / sai phiên đều bị từ chối, và không làm hỏng bộ đếm', async () => {
    const s = await session();
    const f = await s.client.seal(utf8('tin thật'));
    const bad = f.c.slice();
    bad[3]! ^= 1;
    expect(await s.host.open(f.q, bad)).toBeNull();
    expect(await s.host.open(f.q + 1, f.c)).toBeNull(); // q bị đổi (IV + AAD khác)
    expect(await s.host.open(f.q + 1, f.c)).toBeNull(); // và thử hỏng không "đốt" số thứ tự q+1 của một khung thật sau này
    expect(await s.client.open(f.q, f.c)).toBeNull(); // phản chiếu về chính bên gửi: sai hướng
    const other = await session();
    expect(await other.host.open(f.q, f.c)).toBeNull(); // phiên khác
    expect(await s.host.open(f.q, f.c)).not.toBeNull(); // khung thật vẫn nhận được sau các lần thử hỏng
  });

  it('khung quá ngắn / q không hợp lệ bị từ chối', async () => {
    const s = await session();
    expect(await s.host.open(1, new Uint8Array(10))).toBeNull();
    expect(await s.host.open(0, new Uint8Array(40))).toBeNull();
    expect(await s.host.open(1.5, new Uint8Array(40))).toBeNull();
  });

  it('MAC hello/hello_ok gắn với K_dev: không có K_dev thì không giả được', async () => {
    const s = await session();
    const h = { dev: s.h.dev, A: s.h.A, n1: s.h.n1 };
    const mac = await macHello(s.kDev, h);
    expect(await hmacVerify(s.kDev, lp('hello', h.dev, h.A, h.n1), mac)).toBe(true);
    expect(await hmacVerify(randomBytes(32), lp('hello', h.dev, h.A, h.n1), mac)).toBe(false);
    const ok = await macHelloOk(s.kDev, s.h);
    expect(await hmacVerify(s.kDev, lp('hello_ok', s.h.dev, s.h.sid, s.h.A, s.h.B, s.h.n1, s.h.n2, s.h.epoch), ok)).toBe(true);
    expect(await hmacVerify(s.kDev, lp('hello_ok', s.h.dev, s.h.sid, s.h.A, s.h.B, s.h.n1, s.h.n2, 'khac'), ok)).toBe(false);
  });

  it('bí mật chuyển tiếp: phiên mới (ECDH tạm mới) cho khoá hoàn toàn khác dù cùng K_dev', async () => {
    const a = await session();
    const kDev = a.kDev;
    const web = await genEcdh();
    const host = await genEcdh();
    const h2 = { ...a.h, A: web.pub, B: host.pub };
    const k2 = await deriveSession(await ecdh(web.priv, host.pub), kDev, h2);
    expect(hex(k2.c2h)).not.toBe(hex(a.kw.c2h));
  });
});

describe('cắt mảnh & ghép lại', () => {
  const big = (n: number) => ({ type: 'snapshot', seq: 1, blob: 'x'.repeat(n) });

  it('tin nhỏ đi một khung 0x00; tin lớn được cắt thành các mảnh ≤ CHUNK_BYTES và ghép lại nguyên vẹn (kể cả khi đảo thứ tự)', () => {
    expect(encodeMessage({ a: 1 }, 1).length).toBe(1);
    const obj = big(200_000);
    const frames = encodeMessage(obj, 7);
    expect(frames.length).toBeGreaterThan(5);
    for (const f of frames) expect(f.length).toBeLessThanOrEqual(CHUNK_BYTES + 9);
    const r = new Reassembler();
    const order = [...frames.keys()].sort(() => Math.random() - 0.5);
    let out: unknown = null;
    for (const i of order) out = r.push(frames[i]!) ?? out;
    expect(out).toEqual(obj);
  });

  it('tiếng Việt có dấu / emoji khứ hồi đúng khi mảnh cắt giữa ký tự nhiều byte', () => {
    const text = 'Trợ lý đang chạy 🚀 ổn định '.repeat(2000);
    const frames = encodeMessage({ text }, 9, 1000);
    const r = new Reassembler();
    let out: { text: string } | null = null;
    for (const f of frames) out = (r.push(f) as { text: string } | null) ?? out;
    expect(out?.text).toBe(text);
  });

  it('mảnh trùng bị bỏ qua; thiếu mảnh thì không bao giờ trả kết quả; quá 4 tin dở dang cùng lúc bị từ chối', () => {
    const frames = encodeMessage(big(100_000), 1);
    const r = new Reassembler();
    expect(r.push(frames[0]!)).toBeNull();
    expect(r.push(frames[0]!)).toBeNull();
    for (let i = 1; i < frames.length - 1; i++) expect(r.push(frames[i]!)).toBeNull();
    const many = new Reassembler();
    for (let m = 1; m <= 6; m++) many.push(encodeMessage(big(100_000), m)[0]!);
    expect(many.push(encodeMessage(big(100_000), 99)[1]!)).toBeNull();
  });

  it('mảnh dở dang hết hạn sau 30 giây', () => {
    let t = 1000;
    const r = new Reassembler(() => t);
    const frames = encodeMessage(big(100_000), 5);
    r.push(frames[0]!);
    t += 31_000;
    for (let i = 1; i < frames.length; i++) expect(r.push(frames[i]!)).toBeNull(); // mảnh 0 đã bị xoá nên không bao giờ đủ
  });

  it('khung rác không làm hỏng bộ ghép', () => {
    const r = new Reassembler();
    expect(r.push(new Uint8Array(0))).toBeNull();
    expect(r.push(new Uint8Array([9, 1, 2, 3]))).toBeNull();
    expect(r.push(concat(new Uint8Array([0]), utf8('không phải json')))).toBeNull();
    expect(r.push(new Uint8Array([1, 0, 0, 0, 1, 0, 5, 0, 2, 65]))).toBeNull(); // idx ≥ total
    expect(r.push(concat(new Uint8Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), utf8('x')))).toBeNull(); // total < 2
  });

  it('từ chối tin lớn hơn 4 MB', () => {
    expect(() => encodeMessage(big(5 * 1024 * 1024), 1)).toThrow();
  });
});

describe('parseWire — tin trên dây kiểm nghiêm', () => {
  const A = b64u(randomBytes(65));
  const n = b64u(randomBytes(16));
  const mac = b64u(randomBytes(32));
  const dev = b64u(randomBytes(DEV_BYTES));
  const ok = [
    { t: 'pair_req', v: 1, A, nC: n, label: 'Chrome', mac },
    { t: 'pair_hello', r: n, B: A, nH: n, mac },
    { t: 'pair_ok', r: n, dev, mac },
    { t: 'pair_no', r: n, reason: 'denied', mac },
    { t: 'hello', v: 1, dev, A, n, mac },
    { t: 'hello_ok', r: n, dev, sid: b64u(randomBytes(8)), B: A, n, e: 'abcdef012345', mac },
    { t: 'hello_no', r: n, dev, reason: 'unknown_device' },
    { t: 'd', s: b64u(randomBytes(8)), q: 5, c: b64u(randomBytes(40)) },
  ];
  it.each(ok.map((m) => [m.t, m] as const))('chấp nhận %s hợp lệ', (_t, m) => {
    expect(parseWire(m)).toEqual(m);
  });
  it('từ chối: không phải object, thiếu trường, sai độ dài, ký tự lạ, kiểu lạ, q không nguyên', () => {
    for (const bad of [null, 1, 'x', [], {}, { t: 'zzz' }, { t: 'd' }, { t: 'd', s: 'x', q: 1, c: 'y' }, { ...ok[7], q: 0 }, { ...ok[7], q: 1.5 }, { ...ok[7], q: '1' }, { ...ok[7], c: 'a b c d e f g h i j k l m n o p q r s t u v w x y z' }, { ...ok[0], A: 'AAAA' }, { ...ok[0], label: 'x'.repeat(65) }, { ...ok[0], v: 2 }, { ...ok[4], dev: 'có dấu' }, { ...ok[3], reason: 'BAD REASON' }, { ...ok[5], e: 'XYZ' }]) {
      expect(parseWire(bad)).toBeNull();
    }
  });
  it('bỏ trường thừa: kết quả chỉ chứa trường hợp lệ (không mang theo __proto__/rác)', () => {
    const w = parseWire({ ...ok[6], extra: 'x', __proto__: { evil: 1 } }) as unknown as Record<string, unknown>;
    expect(Object.keys(w).sort()).toEqual(['dev', 'r', 'reason', 't']);
  });
});

describe('liên kết ghép đôi', () => {
  const hostId = b64u(randomBytes(16));
  const psk = b64u(randomBytes(16));
  it('tạo rồi phân tích lại đúng, kể cả tên máy có dấu cách/ký tự đặc biệt', () => {
    const link = pairingLink('https://locaith.ai/', { hostId, psk, name: 'PC_WORK · Máy chính & phụ' });
    expect(link.startsWith('https://locaith.ai/#remote?')).toBe(true);
    expect(parsePairingLink(link)).toEqual({ hostId, psk, name: 'PC_WORK · Máy chính & phụ' });
    expect(parsePairingLink(`remote?r=${hostId}&k=${psk}`)).toEqual({ hostId, psk });
  });
  it('từ chối thiếu/sai độ dài/ký tự lạ', () => {
    expect(parsePairingLink('')).toBeNull();
    expect(parsePairingLink(`#remote?r=${hostId}`)).toBeNull();
    expect(parsePairingLink(`#remote?r=abc&k=${psk}`)).toBeNull();
    expect(parsePairingLink(`#remote?r=${hostId}&k=${psk}x`)).toBeNull();
  });
  it('tên máy chứa ký tự điều khiển bị lọc', () => {
    expect(parsePairingLink(`#remote?r=${hostId}&k=${psk}&n=a%00b%07c`)?.name).toBe('abc');
  });
});

// ── VECTOR CỐ ĐỊNH: cả extension lẫn trang web phải ra đúng các giá trị này ─────────────────
describe('vector kiểm thử cố định (known-answer)', () => {
  it('ghép đôi + phiên + mã hoá cho đúng giá trị đã đóng băng', async () => {
    const v = VECTORS;
    const psk = seq(0x01, 16);
    const privA = await importPriv(v.keys.A.jwk);
    const privB = await importPriv(v.keys.B.jwk);
    const pubA = unb64u(v.keys.A.pub);
    const pubB = unb64u(v.keys.B.pub);
    const p = { A: pubA, B: pubB, nC: seq(0x20, 16), nH: seq(0x30, 16) };
    const zA = await ecdh(privA, pubB);
    const zB = await ecdh(privB, pubA);
    expect(hex(zA)).toBe(hex(zB));
    expect(hex(zA)).toBe(v.pairing.z);
    const d = await derivePairing(zA, psk, p);
    expect(hex(d.kDev)).toBe(v.pairing.kDev);
    expect(d.sas).toBe(v.pairing.sas);
    expect(hex(await macPairReq(psk, pubA, p.nC, 'Chrome · Windows'))).toBe(v.pairing.macPairReq);
    expect(hex(await macPairHello(psk, p))).toBe(v.pairing.macPairHello);
    const dev = b64u(seq(0x40, 12));
    expect(hex(await macPairOk(d.kDev, dev, p))).toBe(v.pairing.macPairOk);

    const priv2A = await importPriv(v.keys.A2.jwk);
    const priv2B = await importPriv(v.keys.B2.jwk);
    const h = { dev, A: unb64u(v.keys.A2.pub), B: unb64u(v.keys.B2.pub), n1: seq(0x60, 16), n2: seq(0x70, 16), sid: seq(0x50, 8), epoch: 'abcdef012345' };
    const z2 = await ecdh(priv2A, h.B);
    expect(hex(z2)).toBe(hex(await ecdh(priv2B, h.A)));
    expect(hex(await macHello(d.kDev, h))).toBe(v.session.macHello);
    expect(hex(await macHelloOk(d.kDev, h))).toBe(v.session.macHelloOk);
    const keys = await deriveSession(z2, d.kDev, h);
    expect(hex(keys.c2h)).toBe(v.session.c2h);
    expect(hex(keys.h2c)).toBe(v.session.h2c);
    const client = await SecureChannel.create('client', h.sid, keys);
    const host = await SecureChannel.create('host', h.sid, keys);
    const f = await client.seal(utf8(v.session.plain));
    expect(f.q).toBe(1);
    expect(hex(f.c)).toBe(v.session.cipherC2h);
    const g = await host.seal(utf8(v.session.plain));
    expect(hex(g.c)).toBe(v.session.cipherH2c);
    expect(new TextDecoder().decode((await host.open(1, fromHex(v.session.cipherC2h)))!)).toBe(v.session.plain);
    expect(new TextDecoder().decode((await client.open(1, fromHex(v.session.cipherH2c)))!)).toBe(v.session.plain);
  });
  it('HMAC cơ bản khớp RFC 4231 test case 1', async () => {
    const key = new Uint8Array(20).fill(0x0b);
    expect(hex(await hmac(key, utf8('Hi There')))).toBe('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
  });
});

describe('thiết bị «tài khoản» (0.6.5) — khoá suy ra từ khoá tài khoản của máy', () => {
  const v = (VECTORS as unknown as { account: { accountKey: string; hostId: string; dev: string; kDev: string } }).account;

  it('mã thiết bị cố định là 12 byte 0 và là mã hợp lệ trong tin hello (không lệch định dạng dây)', () => {
    expect(ACCOUNT_DEV).toBe(v.dev);
    expect([...unb64u(ACCOUNT_DEV)]).toEqual(new Array(12).fill(0));
    const hello = parseWire({ t: 'hello', v: 1, dev: ACCOUNT_DEV, A: b64u(new Uint8Array(65)), n: b64u(new Uint8Array(16)), mac: b64u(new Uint8Array(32)) });
    expect(hello).toMatchObject({ t: 'hello', dev: ACCOUNT_DEV });
  });

  it('K_dev khớp vector tính độc lập bằng node:crypto (cả trang web cũng phải ra đúng giá trị này)', async () => {
    const k = await deriveAccountKey(unb64u(v.accountKey), v.hostId);
    expect(k.length).toBe(32);
    expect(b64u(k)).toBe(v.kDev);
  });

  it('khác khoá tài khoản hoặc khác mã máy → K_dev khác hẳn (xoay khoá = thu hồi; khoá của máy này vô dụng với máy khác)', async () => {
    const base = b64u(await deriveAccountKey(unb64u(v.accountKey), v.hostId));
    const other = new Uint8Array(unb64u(v.accountKey));
    other[0] ^= 1;
    expect(b64u(await deriveAccountKey(other, v.hostId))).not.toBe(base);
    expect(b64u(await deriveAccountKey(unb64u(v.accountKey), b64u(randomBytes(16))))).not.toBe(base);
  });
});
