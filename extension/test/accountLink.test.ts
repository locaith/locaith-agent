import { describe, expect, it } from 'vitest';
import { accountLink } from '../src/core/remote/accountLink';
import { b64u, pairingLink, parsePairingLink, randomBytes } from '../src/core/remote/e2e';

const HOST = b64u(randomBytes(16));

describe('liên kết mở máy bằng tài khoản (#remote?h=)', () => {
  it('dạng đúng, nằm sau dấu # (không bao giờ tới máy chủ web) và không mang bí mật nào', () => {
    const l = accountLink('https://locaith.ai', HOST);
    expect(l).toBe(`https://locaith.ai/#remote?h=${HOST}`);
    expect(new URL(l).search).toBe(''); // không có query gửi lên máy chủ
    expect(new URL(l).hash).toBe(`#remote?h=${HOST}`);
    expect(accountLink('http://localhost:3000///', HOST)).toBe(`http://localhost:3000/#remote?h=${HOST}`);
  });

  it('KHÔNG bị nhầm với liên kết ghép đôi (r=…&k=…): parsePairingLink bỏ qua, và ngược lại liên kết ghép đôi không có h=', () => {
    expect(parsePairingLink(accountLink('https://locaith.ai', HOST))).toBeNull();
    const pair = pairingLink('https://locaith.ai', { hostId: HOST, psk: b64u(randomBytes(16)), name: 'PC' });
    expect(/[?&#]h=/.test(pair)).toBe(false);
    expect(parsePairingLink(pair)).not.toBeNull();
  });

  it('phía web đọc được mã máy bằng đúng biểu thức của relay/accountLink.ts', () => {
    const m = /[?&#]h=([A-Za-z0-9_-]{22})/.exec(accountLink('https://locaith.ai', HOST));
    expect(m?.[1]).toBe(HOST);
  });

  it('từ chối mã máy sai định dạng (không chèn được ký tự lạ vào liên kết)', () => {
    for (const bad of ['', 'abc', `${HOST}x`, `${HOST.slice(1)}!`, `${HOST.slice(0, 21)}&`, `${HOST.slice(0, 21)}#`, ' '.repeat(22)]) expect(() => accountLink('https://locaith.ai', bad)).toThrow();
  });
});
