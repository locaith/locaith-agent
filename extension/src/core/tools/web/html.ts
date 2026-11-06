/**
 * HTML → Markdown gọn cho model đọc (không cần trình duyệt không đầu).
 * Bỏ script/style/điều hướng, giữ tiêu đề, đoạn, danh sách, liên kết, bảng, mã.
 */

import { parse, HTMLElement, NodeType, type Node as HNode } from 'node-html-parser';

const DROP_TAGS = ['script', 'style', 'noscript', 'svg', 'canvas', 'iframe', 'template', 'head', 'object', 'embed', 'link', 'meta'];
const NOISE_TAGS = ['nav', 'footer', 'aside', 'form'];
const MAIN_SELECTORS = ['main', 'article', '[role="main"]', '#main-content', '#content', '.post-content', '.entry-content', '.article-body', '.markdown-body'];

function collapse(s: string): string {
  return s.replace(/[ \t ]+/g, ' ');
}

function resolveUrl(href: string, base?: string): string | null {
  const h = href.trim();
  if (!h || h.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(h)) return null;
  try {
    return base ? new URL(h, base).toString() : new URL(h).toString();
  } catch {
    return null;
  }
}

class Converter {
  constructor(private readonly base?: string) {}

  block(node: HNode, listDepth = 0): string {
    if (node.nodeType === NodeType.TEXT_NODE) return collapse(node.text);
    if (node.nodeType !== NodeType.ELEMENT_NODE) return '';
    const el = node as HTMLElement;
    const tag = el.tagName?.toLowerCase() ?? '';
    const kids = () => el.childNodes.map((c) => this.block(c, listDepth)).join('');

    switch (tag) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        const text = this.inline(el).trim();
        return text ? `\n\n${'#'.repeat(Number(tag[1]))} ${text}\n\n` : '';
      }
      case 'p':
      case 'figcaption':
      case 'summary':
        return `\n\n${this.inline(el).trim()}\n\n`;
      case 'br':
        return '\n';
      case 'hr':
        return '\n\n---\n\n';
      case 'pre': {
        const code = el.text.replace(/\n+$/, '');
        const lang = /language-([\w+-]+)/.exec(el.querySelector('code')?.getAttribute('class') ?? '')?.[1] ?? '';
        return `\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
      }
      case 'blockquote':
        return `\n\n${kids().trim().split('\n').map((l) => `> ${l}`).join('\n')}\n\n`;
      case 'ul':
      case 'ol': {
        let i = 0;
        const items = el.childNodes
          .filter((c) => c.nodeType === NodeType.ELEMENT_NODE && (c as HTMLElement).tagName?.toLowerCase() === 'li')
          .map((li) => {
            i++;
            const marker = tag === 'ol' ? `${i}.` : '-';
            const inner = (li as HTMLElement).childNodes.map((c) => this.block(c, listDepth + 1)).join('').trim().replace(/\n{2,}/g, '\n');
            return `${'  '.repeat(listDepth)}${marker} ${inner.replace(/\n/g, `\n${'  '.repeat(listDepth + 1)}`)}`;
          });
        return `\n${items.join('\n')}\n`;
      }
      case 'table':
        return this.table(el);
      case 'img': {
        const alt = el.getAttribute('alt')?.trim();
        return alt ? `[ảnh: ${alt}]` : '';
      }
      case 'li':
        return `\n- ${this.inline(el).trim()}\n`;
      case 'div':
      case 'section':
      case 'article':
      case 'main':
      case 'header':
      case 'body':
      case 'figure':
      case 'details':
        return `\n${kids()}\n`;
      default:
        return this.inlineEl(el);
    }
  }

  inline(el: HTMLElement): string {
    return collapse(el.childNodes.map((c) => this.inlineNode(c)).join('')).replace(/\s*\n\s*/g, ' ');
  }

  private inlineNode(node: HNode): string {
    if (node.nodeType === NodeType.TEXT_NODE) return collapse(node.text);
    if (node.nodeType !== NodeType.ELEMENT_NODE) return '';
    return this.inlineEl(node as HTMLElement);
  }

  private inlineEl(el: HTMLElement): string {
    const tag = el.tagName?.toLowerCase() ?? '';
    const inner = () => el.childNodes.map((c) => this.inlineNode(c)).join('');
    switch (tag) {
      case 'a': {
        const text = inner().trim();
        const href = resolveUrl(el.getAttribute('href') ?? '', this.base);
        if (!text) return '';
        return href && href !== text ? `[${text}](${href})` : text;
      }
      case 'strong':
      case 'b': {
        const t = inner().trim();
        return t ? `**${t}**` : '';
      }
      case 'em':
      case 'i': {
        const t = inner().trim();
        return t ? `*${t}*` : '';
      }
      case 'code':
      case 'kbd':
      case 'samp': {
        const t = el.text.trim();
        return t ? `\`${t}\`` : '';
      }
      case 'br':
        return '\n';
      case 'img': {
        const alt = el.getAttribute('alt')?.trim();
        return alt ? `[ảnh: ${alt}]` : '';
      }
      case 'ul':
      case 'ol':
      case 'table':
      case 'pre':
      case 'p':
      case 'div':
      case 'blockquote':
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return this.block(el);
      default:
        return inner();
    }
  }

  private table(el: HTMLElement): string {
    const rows = el.querySelectorAll('tr').slice(0, 60);
    const grid = rows.map((tr) =>
      tr
        .querySelectorAll('th,td')
        .slice(0, 12)
        .map((c) => this.inline(c).replace(/\|/g, '\\|').trim()),
    );
    const width = Math.max(0, ...grid.map((r) => r.length));
    if (width === 0) return '';
    const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')];
    const lines = grid.map((r) => `| ${pad(r).join(' | ')} |`);
    lines.splice(1, 0, `| ${Array(width).fill('---').join(' | ')} |`);
    return `\n\n${lines.join('\n')}\n\n`;
  }
}

export interface HtmlResult {
  title: string;
  text: string;
}

/** Thành phần điều hướng/rác thường gặp bên TRONG vùng nội dung chính (Wikipedia, blog, báo): mục lục, danh sách ngôn ngữ, banner cookie… */
const NOISE_SELECTORS = [
  'nav',
  'aside',
  '[role="navigation"]',
  '[aria-hidden="true"]',
  '.toc',
  '#toc',
  '.vector-toc',
  '.mw-editsection',
  '.mw-interlanguage-selector',
  '#p-lang-btn',
  '.navbox',
  '.noprint',
  '.cookie',
  '[class*="cookie-"]',
  '[id*="cookie"]',
];

/** Kiểu inline làm phần tử không hiện ra: chữ nằm trong đó không phải thứ người đọc thấy (và có thể là lời dụ giấu). */
const HIDDEN_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px|pt|em|rem|%)?\s*(?:;|$)|opacity\s*:\s*0(?:\.0+)?\s*(?:;|$)|color\s*:\s*transparent/i;

/**
 * `fullDocument`: dùng cho TỆP HTML người dùng tải lên — giữ cả tài liệu (không thu hẹp vào <main>, không bỏ nav/footer/form vì với một báo cáo/biểu mẫu
 * đó có thể là nội dung), chỉ gỡ phần ẩn (thuộc tính hidden, aria-hidden, kiểu inline display:none…).
 */
export function htmlToMarkdown(html: string, baseUrl?: string, opts: { fullDocument?: boolean } = {}): HtmlResult {
  // `pre` KHÔNG nằm trong blockTextElements để thẻ <code class="language-…"> bên trong vẫn được phân tích.
  const root = parse(html.replace(/^\s*<!doctype[^>]*>/i, ''), { comment: false, blockTextElements: { script: false, style: false, noscript: false } });
  const title = root.querySelector('title')?.text.replace(/\s+/g, ' ').trim() ?? '';
  for (const t of DROP_TAGS) root.querySelectorAll(t).forEach((n) => n.remove());

  let scope: HTMLElement = root;
  if (opts.fullDocument) {
    for (const n of root.querySelectorAll('[hidden], [aria-hidden="true"], input[type="hidden"]')) n.remove();
    for (const n of root.querySelectorAll('[style]')) if (HIDDEN_STYLE.test(n.getAttribute('style') ?? '')) n.remove();
  } else {
    for (const sel of MAIN_SELECTORS) {
      const found = root.querySelector(sel);
      if (found && found.text.trim().length > 400) {
        scope = found;
        break;
      }
    }
    if (scope === root) for (const t of NOISE_TAGS) root.querySelectorAll(t).forEach((n) => n.remove());
    // Dù đã chọn đúng vùng nội dung chính, vẫn gỡ điều hướng/rác nằm bên trong nó.
    for (const sel of NOISE_SELECTORS) {
      try {
        scope.querySelectorAll(sel).forEach((n) => n.remove());
      } catch {
        /* bộ chọn không được hỗ trợ → bỏ qua */
      }
    }
  }

  const conv = new Converter(baseUrl);
  let text = conv.block(scope);
  text = text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}

/** Giải mã nội dung theo charset khai báo (header hoặc <meta>), mặc định UTF-8; hỗ trợ windows-1258 của web Việt cũ. */
export function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  let charset = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType ?? '')?.[1];
  if (!charset) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
    charset = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}
