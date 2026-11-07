import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { externalLinkProps } from '../webview/src/externalLink';
import { OPEN_ONCE_WINDOW_MS, createOpenOnce, openExternalOnce } from '../src/core/host/openOnce';

const posted: unknown[] = [];
vi.mock('../webview/src/vscode', () => ({ post: (m: unknown) => void posted.push(m) }));

/** Mô phỏng bộ xử lý click có sẵn của webview VS Code: mọi thẻ <a> có `href` đều bị mở thêm một lần ở lớp window (kể cả khi đã preventDefault). */
function vscodeBuiltinLinkHandler(el: { props: Record<string, unknown> }, opened: string[]): void {
  const href = el.props.href;
  if (typeof href === 'string' && href) opened.push(href);
}

interface FakeEvent {
  defaultPrevented: boolean;
  propagationStopped: boolean;
  key?: string;
  button?: number;
  preventDefault(): void;
  stopPropagation(): void;
}
const fakeEvent = (extra: Partial<FakeEvent> = {}): FakeEvent => {
  const e: FakeEvent = {
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      e.defaultPrevented = true;
    },
    stopPropagation() {
      e.propagationStopped = true;
    },
    ...extra,
  };
  return e;
};

describe('createOpenOnce / openExternalOnce (chống nảy đúp openExternal)', () => {
  it('cùng URL trong cửa sổ chỉ mở một lần; URL khác vẫn mở; hết cửa sổ mở lại được', async () => {
    let t = 1000;
    const g = createOpenOnce({ now: () => t });
    const opened: string[] = [];
    const open = (u: string) => void opened.push(u);
    expect(await g('https://a.test/x', open)).toBe(true);
    expect(await g('https://a.test/x', open)).toBe(false);
    expect(await g(' https://a.test/x ', open)).toBe(false); // khoảng trắng thừa không lách được
    expect(await g('https://b.test/', open)).toBe(true);
    t += OPEN_ONCE_WINDOW_MS - 1;
    expect(await g('https://a.test/x', open)).toBe(false);
    t += 2;
    expect(await g('https://a.test/x', open)).toBe(true);
    expect(opened).toEqual(['https://a.test/x', 'https://b.test/', 'https://a.test/x']);
  });

  it('hai lệnh mở đồng thời (cùng một tick) chỉ gọi open một lần', async () => {
    const g = createOpenOnce();
    const open = vi.fn(async () => undefined);
    const r = await Promise.all([g('https://c.test/', open), g('https://c.test/', open)]);
    expect(r).toEqual([true, false]);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('URL rỗng không bao giờ được mở; bộ nhớ bị chặn trần', async () => {
    let t = 0;
    const g = createOpenOnce({ now: () => t });
    expect(g.allow('   ')).toBe(false);
    for (let i = 0; i < 500; i++) g.allow(`https://x.test/${i}`);
    expect(g.allow('https://x.test/499')).toBe(false); // vẫn nhớ cái gần nhất
    t += OPEN_ONCE_WINDOW_MS + 1;
    expect(g.allow('https://x.test/499')).toBe(true);
  });

  it('bộ dùng chung của tiến trình hoạt động như bộ riêng', async () => {
    openExternalOnce.reset();
    const open = vi.fn();
    await openExternalOnce('https://shared.test/', open);
    await openExternalOnce('https://shared.test/', open);
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('liên kết Markdown trong webview — không mở hai lần', () => {
  beforeEach(() => {
    posted.length = 0;
    openExternalOnce.reset();
  });

  it('thuộc tính liên kết KHÔNG có href thật (nếu có, bộ xử lý có sẵn của VS Code sẽ mở thêm một tab)', () => {
    const props = externalLinkProps('https://example.com/a') as unknown as Record<string, unknown>;
    expect(props.href).toBeUndefined();
    expect(props['data-href']).toBe('https://example.com/a');
    expect(props.role).toBe('link');
    expect(props.tabIndex).toBe(0);
    const builtin: string[] = [];
    vscodeBuiltinLinkHandler({ props }, builtin);
    expect(builtin).toEqual([]); // không có gì để VS Code mở
  });

  it('Markdown.tsx dùng đúng externalLinkProps cho liên kết http(s), không gắn href={href} lên thẻ <a>', () => {
    const src = readFileSync(fileURLToPath(new URL('../webview/src/markdown/Markdown.tsx', import.meta.url)), 'utf8');
    const fn = src.slice(src.indexOf('function MdLink'), src.indexOf('function BlockedImage'));
    expect(fn).toContain('{...externalLinkProps(href)}');
    expect(fn).not.toMatch(/<a[^>]*href=/);
  });

  it('một cú bấm → đúng một open_external; handler dừng nổi bọt và chặn hành vi mặc định', () => {
    const p = externalLinkProps('https://example.com/b');
    const e = fakeEvent();
    p.onClick(e);
    expect(e.defaultPrevented).toBe(true);
    expect(e.propagationStopped).toBe(true);
    expect(posted).toEqual([{ type: 'open_external', url: 'https://example.com/b' }]);
  });

  it('sự kiện bắt hai lần (click + Enter + auxclick giữa) cho cùng một cú bấm vẫn chỉ gửi một lần', () => {
    const p = externalLinkProps('https://example.com/c');
    p.onClick(fakeEvent());
    p.onClick(fakeEvent()); // capture + bubble
    p.onKeyDown(fakeEvent({ key: 'Enter' }));
    p.onAuxClick(fakeEvent({ button: 1 }));
    expect(posted).toHaveLength(1);
  });

  it('phím khác Enter và nút phụ không phải giữa không mở gì', () => {
    const p = externalLinkProps('https://example.com/d');
    p.onKeyDown(fakeEvent({ key: 'a' }));
    p.onAuxClick(fakeEvent({ button: 2 }));
    expect(posted).toHaveLength(0);
  });
});
