import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Màn đăng nhập có hiệu ứng "cao cấp" (vệt shimmer, quầng sáng, viền gradient). Những hiệu ứng đó chỉ được phép tồn tại nếu luôn có đường lui:
 * giảm chuyển động, theme tương phản cao, chế độ màu hệ thống — và không phá quy tắc chữ tiếng Việt của dự án (xem đầu base.css).
 * Test đọc thẳng CSS nguồn để ai sửa giao diện sau này không vô tình bỏ mất các đường lui.
 */
const STYLES = path.resolve(__dirname, '../../webview/src/styles');
const account = fs.readFileSync(path.join(STYLES, 'account.css'), 'utf8');
const brand = fs.readFileSync(path.join(STYLES, 'brand.css'), 'utf8');

/** Lấy nội dung (kể cả lồng nhau) của khối at-rule bắt đầu bằng `head`, ví dụ `@media (prefers-reduced-motion: reduce)`. */
function atBlocks(css: string, head: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const i = css.indexOf(head, from);
    if (i < 0) return out;
    const open = css.indexOf('{', i);
    let depth = 0;
    let j = open;
    for (; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}' && --depth === 0) break;
    }
    out.push(css.slice(open + 1, j));
    from = j + 1;
  }
}

describe('màn đăng nhập: hiệu ứng luôn có đường lui', () => {
  it('giảm chuyển động tắt vệt shimmer, quầng sáng và vệt sáng trên logo', () => {
    const reduced = atBlocks(account, '@media (prefers-reduced-motion: reduce)').join('\n');
    expect(reduced).toMatch(/\.acct-signin::after\s*\{[^}]*animation:\s*none/);
    expect(reduced).toMatch(/\.acct-logo-aura\s*\{[^}]*animation:\s*none/);
    expect(atBlocks(brand, '@media (prefers-reduced-motion: reduce)').join('\n')).toMatch(/\.lo-shine \.lo-shine-band\s*\{[^}]*animation:\s*none/);
  });

  it('theme tương phản cao và chế độ màu hệ thống bỏ hiệu ứng, dùng màu của theme', () => {
    expect(account).toMatch(/body\.vscode-high-contrast \.acct-signin,\s*body\.vscode-high-contrast-light \.acct-signin\s*\{[^}]*--vscode-button-background/);
    expect(account).toMatch(/body\.vscode-high-contrast \.acct-signin::before[\s\S]*?\{\s*display:\s*none/);
    const forced = atBlocks(account, '@media (forced-colors: active)').join('\n');
    expect(forced).toMatch(/ButtonFace/);
    expect(forced).toMatch(/\.acct-signin::after\s*\{\s*display:\s*none/);
  });

  it('mọi hoạt họa vô hạn chỉ đổi transform/opacity (nhẹ, chạy trên compositor)', () => {
    for (const name of ['acct-shimmer', 'acct-aura']) {
      const m = account.match(new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?)\\n\\}\\n`));
      expect(m, `thiếu @keyframes ${name}`).toBeTruthy();
      const props = [...m![1]!.matchAll(/([a-z-]+)\s*:/g)].map((x) => x[1]);
      expect(props.length).toBeGreaterThan(0);
      for (const p of props) expect(['transform', 'opacity']).toContain(p);
    }
  });

  it('nút đăng nhập hiện vòng focus khi dùng bàn phím và là <button> thật có tên đọc được', () => {
    expect(account).toMatch(/\.acct-signin:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus\)/);
    const tsx = fs.readFileSync(path.resolve(__dirname, '../../webview/src/components/AccountGate.tsx'), 'utf8');
    expect(tsx).toMatch(/<button type="button" class="acct-signin"/);
    expect(tsx).toMatch(/class="acct-signin-label">\{t\('acct\.signIn'\)\}/); // chữ nằm trong DOM thật, không phải ảnh/CSS content
    expect(tsx).toMatch(/class="acct-signin-mark" aria-hidden="true"/); // logo trang trí: ẩn khỏi trình đọc màn hình
  });
});

describe('màn đăng nhập: quy tắc chữ tiếng Việt của dự án', () => {
  it('không IN HOA, không letter-spacing âm, không chữ nhỏ hơn 12px, line-height >= 1.5 ở nút', () => {
    expect(account).not.toMatch(/text-transform:\s*uppercase/);
    for (const m of account.matchAll(/letter-spacing:\s*(-[^;]+);/g)) throw new Error(`letter-spacing âm: ${m[1]}`);
    for (const m of account.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(12);
    const signin = account.match(/\.acct-signin\s*\{([^}]*)\}/)![1]!;
    expect(Number(signin.match(/line-height:\s*([\d.]+)/)![1])).toBeGreaterThanOrEqual(1.5);
  });
});
