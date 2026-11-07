import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OPEN_ONCE_WINDOW_MS, createOpenOnce, openExternalOnce } from '../src/core/host/openOnce';

const posted: unknown[] = [];
vi.mock('../webview/src/vscode', () => ({ post: (m: unknown) => void posted.push(m) }));
vi.mock('../webview/src/ctx', () => ({ useApp: () => ({ platform: 'vscode', t: (k: string) => k }) }));

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

  it('liên kết http(s) KHÔNG có href thật (nếu có, bộ xử lý có sẵn của VS Code sẽ mở thêm một tab)', async () => {
    const { MdLink } = await import('../webview/src/markdown/Markdown');
    const el = MdLink({ href: 'https://example.com/a', title: null, children: 'a' }) as unknown as { type: string; props: Record<string, unknown> };
    expect(el.type).toBe('a');
    expect(el.props.href).toBeUndefined();
    expect(el.props['data-href']).toBe('https://example.com/a');
    expect(el.props.role).toBe('link');
    expect(el.props.tabIndex).toBe(0);
    // Mô phỏng VS Code: không có gì để nó mở.
    const builtin: string[] = [];
    vscodeBuiltinLinkHandler(el, builtin);
    expect(builtin).toEqual([]);
  });

  it('một cú bấm → đúng một open_external; handler dừng nổi bọt và chặn hành vi mặc định', async () => {
    const { MdLink } = await import('../webview/src/markdown/Markdown');
    const el = MdLink({ href: 'https://example.com/b', children: 'b' }) as unknown as { props: Record<string, (e: FakeEvent) => void> };
    const e = fakeEvent();
    el.props.onClick(e);
    expect(e.defaultPrevented).toBe(true);
    expect(e.propagationStopped).toBe(true);
    expect(posted).toEqual([{ type: 'open_external', url: 'https://example.com/b' }]);
  });

  it('sự kiện bắt hai lần (click + Enter + auxclick giữa) cho cùng một cú bấm vẫn chỉ gửi một lần', async () => {
    const { MdLink } = await import('../webview/src/markdown/Markdown');
    const el = MdLink({ href: 'https://example.com/c', children: 'c' }) as unknown as { props: Record<string, (e: FakeEvent) => void> };
    el.props.onClick(fakeEvent());
    el.props.onClick(fakeEvent()); // capture + bubble
    el.props.onKeyDown(fakeEvent({ key: 'Enter' }));
    el.props.onAuxClick(fakeEvent({ button: 1 }));
    expect(posted).toHaveLength(1);
  });

  it('phím khác Enter và nút phụ không phải giữa không mở gì', async () => {
    const { MdLink } = await import('../webview/src/markdown/Markdown');
    const el = MdLink({ href: 'https://example.com/d', children: 'd' }) as unknown as { props: Record<string, (e: FakeEvent) => void> };
    el.props.onKeyDown(fakeEvent({ key: 'a' }));
    el.props.onAuxClick(fakeEvent({ button: 2 }));
    expect(posted).toHaveLength(0);
  });

  it('javascript: / vscode: vẫn không thành liên kết bấm được', async () => {
    const { MdLink } = await import('../webview/src/markdown/Markdown');
    for (const href of ['javascript:alert(1)', 'vscode://x/y', 'data:text/html,hi']) {
      const el = MdLink({ href, children: 'x' }) as unknown as { type: string; props: Record<string, unknown> };
      expect(el.type).toBe('span');
      expect(el.props.onClick).toBeUndefined();
    }
  });
});
