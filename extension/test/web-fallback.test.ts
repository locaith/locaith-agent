import { describe, expect, it } from 'vitest';
import { newSession } from '../src/core/engine/types';
import type { ToolContext } from '../src/core/engine/types';
import { NodeToolHost } from '../src/core/host/nodeHost';
import { htmlToMarkdown } from '../src/core/tools/web/html';
import { parseBingHtml, unwrapBingUrl } from '../src/core/tools/web/search';
import { webSearchTool } from '../src/core/tools/web/web';

const ddgOk = (n: number) =>
  `<div class="result"><h2><a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://example.com/' + n)}&rut=x">Kết quả DDG ${n}</a></h2><a class="result__snippet">Đoạn ${n}</a></div>`;

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const bingPage = `<ol id="b_results">
  <li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&&p=abc&u=a1${b64url('https://thoitiet.vn/ha-noi')}&ntb=1">Thời tiết Hà Nội</a></h2><div class="b_caption"><p>Dự báo hôm nay 28°C, có mưa rào.</p></div></li>
  <li class="b_algo"><h2><a href="https://vnexpress.net/thoi-tiet">VnExpress</a></h2><div class="b_caption"><p>Tin thời tiết</p></div></li>
  <li class="b_ad"><h2><a href="https://ads.example">Quảng cáo</a></h2></li>
</ol>`;

function ctx(fetchImpl: typeof fetch): ToolContext {
  const host = new NodeToolHost({ roots: [], fetchImpl, settings: { 'search.backend': 'duckduckgo' } });
  return {
    signal: new AbortController().signal,
    session: newSession({ id: 's', provider: 'p', model: 'm' }),
    host,
    callId: 'c',
    assistantId: 'a',
    emit: () => undefined,
    progress: () => undefined,
    log: () => undefined,
  };
}

describe('web_search không cần khoá: DuckDuckGo GET → POST → Bing', () => {
  it('dùng GET trước (DuckDuckGo thường chặn POST nhưng vẫn phục vụ GET)', async () => {
    const calls: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url.split('?')[0]}`);
      return new Response(ddgOk(1), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await webSearchTool.execute({ query: 'x' }, ctx(f));
    expect(r.content).toContain('https://example.com/1');
    expect(calls).toEqual(['GET https://html.duckduckgo.com/html/']);
  });

  it('GET bị chặn → thử POST; cả hai bị chặn → chuyển sang Bing và giải mã liên kết chuyển hướng', async () => {
    const calls: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(url).hostname}`);
      if (url.includes('duckduckgo')) return new Response('<div class="anomaly-modal">bots</div>', { status: 202 });
      return new Response(bingPage, { status: 200 });
    }) as unknown as typeof fetch;
    const r = await webSearchTool.execute({ query: 'thời tiết' }, ctx(f));
    expect(calls).toEqual(['GET html.duckduckgo.com', 'POST html.duckduckgo.com', 'GET www.bing.com']);
    expect(r.content).toContain('https://thoitiet.vn/ha-noi');
    expect(r.content).toContain('https://vnexpress.net/thoi-tiet');
    expect(r.content).not.toContain('bing.com/ck');
    expect(r.content).not.toContain('ads.example');
    expect(r.content).toContain('28°C');
  });

  it('mọi nguồn đều bị chặn → thông báo hành động rõ ràng (đặt khoá Brave/Tavily/Serper)', async () => {
    const f = (async () => new Response('blocked', { status: 202 })) as unknown as typeof fetch;
    await expect(webSearchTool.execute({ query: 'x' }, ctx(f))).rejects.toThrow(/Brave\/Tavily\/Serper/);
  });

  it('parseBingHtml / unwrapBingUrl', () => {
    expect(unwrapBingUrl(`https://www.bing.com/ck/a?u=a1${b64url('https://a.vn/đường-dẫn?x=1')}`)).toBe('https://a.vn/đường-dẫn?x=1');
    expect(unwrapBingUrl('https://example.org/direct')).toBe('https://example.org/direct');
    expect(parseBingHtml(bingPage)).toHaveLength(2);
  });
});

describe('htmlToMarkdown: gỡ rác bên trong vùng nội dung chính', () => {
  it('bỏ doctype, mục lục, danh sách ngôn ngữ, banner cookie nhưng giữ nội dung', () => {
    const long = '<p>' + 'Phở là món ăn truyền thống của Việt Nam. '.repeat(20) + '</p>';
    const html = `<!DOCTYPE html><html><head><title>Phở</title></head><body>
      <main id="content">
        <header><div id="p-lang-btn"><ul><li><a href="/x">Afrikaans</a></li><li><a href="/y">العربية</a></li></ul></div></header>
        <div class="vector-toc"><ul><li>Mục lục: Lịch sử</li></ul></div>
        <div class="cookie-banner">Chúng tôi dùng cookie</div>
        <nav>Điều hướng trang</nav>
        <h1>Phở</h1>${long}
        <span class="mw-editsection">[sửa]</span>
      </main></body></html>`;
    const { text, title } = htmlToMarkdown(html, 'https://vi.wikipedia.org/wiki/Pho');
    expect(title).toBe('Phở');
    expect(text.startsWith('# Phở')).toBe(true);
    expect(text).not.toMatch(/doctype/i);
    expect(text).not.toContain('Afrikaans');
    expect(text).not.toContain('Mục lục');
    expect(text).not.toContain('cookie');
    expect(text).not.toContain('Điều hướng');
    expect(text).not.toContain('[sửa]');
    expect(text).toContain('Phở là món ăn truyền thống của Việt Nam.');
  });
});
