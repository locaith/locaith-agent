/**
 * Hiển thị Markdown của model — AN TOÀN THEO CẤU TRÚC: token của marked được dựng thẳng thành vnode
 * của Preact (chữ luôn là text node), không bao giờ chèn HTML thô. Hình ảnh từ ngoài bị chặn,
 * liên kết đi qua host (open_external / open_file). Mỗi khối cấp cao được memo theo `raw`
 * nên khi đang stream chỉ khối cuối cùng phải dựng lại.
 */
import { Fragment, type ComponentChildren, type VNode } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { marked, type Token, type Tokens } from 'marked';
import { useApp } from '../ctx';
import { Icon } from '../components/Icons';
import { parseFileRef } from '../text';
import { cx, copyText, memo, useDismiss } from '../util';
import { post } from '../vscode';
import { externalLinkProps, openExternalLink } from '../externalLink'; // (lane:customer-bugs)
import { decodeEntities } from './entities';
import { prepareStreamingMarkdown } from './fence';
import { highlight, isApplicable, langLabel } from './highlight';
import { looksLikeMediaPath, mediaRefsByBlock, type MediaRef } from './mediaRefs';
import { MediaPreviews } from '../components/timeline/MediaPreviews';

// ── Inline ──────────────────────────────────────────────────────────────────

/** Thẻ HTML định dạng đơn giản mà model hay chèn; bỏ thẻ, giữ chữ bên trong. */
const STRIP_TAG = /^<\/?(b|i|u|s|em|strong|sub|sup|kbd|mark|small|span|p|center|details|summary|div|font|section|article)(\s[^>]*)?>$/i;
const BR_TAG = /^<br\s*\/?>$/i;

function InlineCode({ text }: { text: string }) {
  const { platform } = useApp();
  const ref = platform === 'vscode' ? parseFileRef(text) : null;
  if (ref) {
    return (
      <button
        type="button"
        class="md-code md-code-file"
        title={ref.path}
        onClick={() => post({ type: 'open_file', path: ref.path, line: ref.line })}
      >
        {text}
      </button>
    );
  }
  return <code class="md-code">{text}</code>;
}

function MdLink({ href, title, children }: { href: string; title?: string | null; children: ComponentChildren }) {
  const { platform } = useApp();
  if (/^(https?:|mailto:)/i.test(href)) {
    // (lane:customer-bugs) không đặt `href` thật: bộ xử lý liên kết có sẵn của webview VS Code sẽ mở thêm một tab nữa — xem externalLink.ts.
    return (
      <a class="md-link" title={title || href} {...externalLinkProps(href)}>
        {children}
      </a>
    );
  }
  const file = platform === 'vscode' ? parseFileRef(href) : null;
  if (file) {
    return (
      <button
        type="button"
        class="md-link md-link-file"
        title={href}
        onClick={() => post({ type: 'open_file', path: file.path, line: file.line })}
      >
        {children}
      </button>
    );
  }
  // javascript:, data:, vscode:, neo (#)… không tạo liên kết bấm được.
  return (
    <span class="md-link-dead" title={href}>
      {children}
    </span>
  );
}

function BlockedImage({ href, alt }: { href: string; alt: string }) {
  const { t, platform } = useApp();
  const external = /^https?:/i.test(href);
  // Ảnh trên máy (bản VS Code): chính ảnh hiện ngay dưới khối này (MediaPreviews) — chip chỉ còn là chỗ đánh dấu, không phải "bị chặn".
  const local = !external && platform === 'vscode' && looksLikeMediaPath(href.trim(), true);
  return (
    <span class={cx('md-image', local && 'is-local')} title={local ? t('md.imageLocal') : t('md.imageBlocked')}>
      <Icon name="image" size={14} />
      <span class="md-image-alt">{alt || t('md.image')}</span>
      {external && (
        <button
          type="button"
          class="md-image-open"
          aria-label={t('md.image')}
          onClick={(e) => openExternalLink(href, e)}
        >
          <Icon name="external" size={12} />
        </button>
      )}
    </span>
  );
}

function renderInline(tokens: Token[] | undefined, base: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  (tokens ?? []).forEach((tk, i) => {
    const key = `${base}.${i}`;
    switch (tk.type) {
      case 'text': {
        const t = tk as Tokens.Text;
        if (t.tokens && t.tokens.length) out.push(<Fragment key={key}>{renderInline(t.tokens, key)}</Fragment>);
        else out.push(decodeEntities(t.text));
        break;
      }
      case 'escape':
        out.push((tk as Tokens.Escape).text);
        break;
      case 'strong':
        out.push(<strong key={key}>{renderInline((tk as Tokens.Strong).tokens, key)}</strong>);
        break;
      case 'em':
        out.push(<em key={key}>{renderInline((tk as Tokens.Em).tokens, key)}</em>);
        break;
      case 'del':
        out.push(<del key={key}>{renderInline((tk as Tokens.Del).tokens, key)}</del>);
        break;
      case 'codespan':
        out.push(<InlineCode key={key} text={(tk as Tokens.Codespan).text} />);
        break;
      case 'br':
        out.push(<br key={key} />);
        break;
      case 'checkbox':
        out.push(<Checkbox key={key} checked={(tk as Tokens.Checkbox).checked} />);
        break;
      case 'link': {
        const l = tk as Tokens.Link;
        out.push(
          <MdLink key={key} href={l.href} title={l.title}>
            {renderInline(l.tokens, key)}
          </MdLink>,
        );
        break;
      }
      case 'image': {
        const im = tk as Tokens.Image;
        out.push(<BlockedImage key={key} href={im.href} alt={decodeEntities(im.text)} />);
        break;
      }
      case 'html': {
        const raw = (tk as Tokens.HTML).raw.trim();
        if (BR_TAG.test(raw)) out.push(<br key={key} />);
        else if (!STRIP_TAG.test(raw)) out.push((tk as Tokens.HTML).raw);
        break;
      }
      default: {
        const g = tk as Tokens.Generic;
        if (g.tokens && g.tokens.length) out.push(<Fragment key={key}>{renderInline(g.tokens, key)}</Fragment>);
        else if (g.raw) out.push(g.raw);
      }
    }
  });
  return out;
}

function Checkbox({ checked }: { checked: boolean }) {
  return (
    <span class={cx('md-check', checked && 'is-checked')} role="checkbox" aria-checked={checked} aria-disabled="true">
      {checked && <Icon name="check" size={11} />}
    </span>
  );
}

// ── Khối mã ─────────────────────────────────────────────────────────────────

const STREAM_HIGHLIGHT_LIMIT = 1800;

function CodeBlock({ code, lang, streaming }: { code: string; lang?: string; streaming: boolean }) {
  const { t, hasSelection, platform } = useApp();
  const [copied, setCopied] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);

  // Khối quá dài đang stream thì chưa tô màu (tốn CPU mỗi mảnh); tô một lần khi xong.
  const skip = streaming && code.length > STREAM_HIGHLIGHT_LIMIT;
  const html = useMemo(() => (skip ? null : highlight(code, lang)), [code, lang, skip]);
  // "Chèn vào editor / thay vùng chọn / tạo tệp" chỉ có nghĩa trong VS Code.
  const applicable = platform === 'vscode' && isApplicable(lang) && !streaming;

  useDismiss(menuRef, menu, () => setMenu(false));
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const doCopy = async () => {
    if (await copyText(code)) {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    }
  };
  const apply = (mode: 'insert' | 'replace' | 'new_file') => {
    setMenu(false);
    post({ type: 'apply_code', code, lang: lang?.trim() || undefined, mode });
  };

  return (
    <div class="md-codeblock">
      <div class="md-code-head">
        <span class="md-code-lang">{langLabel(lang, t('md.plain'))}</span>
        <div class="md-code-actions">
          <button type="button" class="md-code-btn" onClick={doCopy} aria-label={t('md.copy')}>
            <Icon name={copied ? 'check' : 'copy'} size={13} />
            <span>{copied ? t('md.copied') : t('md.copy')}</span>
          </button>
          {applicable && (
            <div class="md-apply" ref={menuRef}>
              <button
                type="button"
                class="md-code-btn"
                aria-haspopup="menu"
                aria-expanded={menu}
                onClick={() => setMenu((v) => !v)}
              >
                <Icon name="download" size={13} />
                <span>{t('md.apply')}</span>
                <Icon name="chevron-down" size={12} />
              </button>
              {menu && (
                <div class="md-apply-menu" role="menu">
                  <button type="button" role="menuitem" onClick={() => apply('insert')}>
                    {t('md.insert')}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!hasSelection}
                    title={hasSelection ? undefined : t('md.noSelection')}
                    onClick={() => apply('replace')}
                  >
                    {t('md.replace')}
                  </button>
                  <button type="button" role="menuitem" onClick={() => apply('new_file')}>
                    {t('md.newFile')}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <pre class="md-pre" tabIndex={0}>
        {html !== null ? <code class="hljs" dangerouslySetInnerHTML={{ __html: html }} /> : <code class="hljs">{code}</code>}
      </pre>
    </div>
  );
}

// ── Khối cấp cao ────────────────────────────────────────────────────────────

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<\/?[a-z][^>]*>/gi, '').replace(/\n{3,}/g, '\n\n')).trim();
}

function renderBlocks(tokens: Token[], base: string, streaming = false): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  tokens.forEach((tk, i) => {
    const node = renderBlock(tk, `${base}.${i}`, streaming);
    if (node !== null) out.push(node);
  });
  return out;
}

function renderBlock(tk: Token, key: string, streaming: boolean): VNode | string | null {
  switch (tk.type) {
    case 'space':
    case 'def':
      return null;
    case 'heading': {
      const hd = tk as Tokens.Heading;
      const Tag = `h${Math.min(6, Math.max(1, hd.depth))}` as 'h1';
      return (
        <Tag key={key} class="md-h">
          {renderInline(hd.tokens, key)}
        </Tag>
      );
    }
    case 'paragraph':
      return (
        <p key={key} class="md-p">
          {renderInline((tk as Tokens.Paragraph).tokens, key)}
        </p>
      );
    case 'text': {
      const t = tk as Tokens.Text;
      return <Fragment key={key}>{t.tokens ? renderInline(t.tokens, key) : decodeEntities(t.text)}</Fragment>;
    }
    case 'checkbox':
      return <Checkbox key={key} checked={(tk as Tokens.Checkbox).checked} />;
    case 'code': {
      const c = tk as Tokens.Code;
      return <CodeBlock key={key} code={c.text} lang={c.lang} streaming={streaming} />;
    }
    case 'blockquote':
      return (
        <blockquote key={key} class="md-quote">
          {renderBlocks((tk as Tokens.Blockquote).tokens, key)}
        </blockquote>
      );
    case 'hr':
      return <hr key={key} class="md-hr" />;
    case 'list': {
      const l = tk as Tokens.List;
      const Tag = l.ordered ? 'ol' : 'ul';
      const start = l.ordered && typeof l.start === 'number' && l.start !== 1 ? l.start : undefined;
      return (
        <Tag key={key} class="md-list" start={start}>
          {l.items.map((it, j) => (
            <li key={j} class={it.task ? 'md-task-item' : undefined}>
              {renderBlocks(it.tokens, `${key}.${j}`)}
            </li>
          ))}
        </Tag>
      );
    }
    case 'table': {
      const tb = tk as Tokens.Table;
      return (
        <div key={key} class="md-table-wrap" tabIndex={0}>
          <table class="md-table">
            <thead>
              <tr>
                {tb.header.map((c, j) => (
                  <th key={j} style={c.align ? { textAlign: c.align } : undefined}>
                    {renderInline(c.tokens, `${key}.h${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tb.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((c, j) => (
                    <td key={j} style={c.align ? { textAlign: c.align } : undefined}>
                      {renderInline(c.tokens, `${key}.${r}.${j}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'html': {
      const text = stripTags((tk as Tokens.HTML).raw);
      return text ? (
        <p key={key} class="md-p">
          {text}
        </p>
      ) : null;
    }
    default: {
      const g = tk as Tokens.Generic;
      return g.raw?.trim() ? (
        <p key={key} class="md-p">
          {g.raw}
        </p>
      ) : null;
    }
  }
}

const sameRefs = (a: readonly MediaRef[] | null, b: readonly MediaRef[] | null): boolean =>
  a === b || (!!a && !!b && a.length === b.length && a.every((r, i) => r.path === b[i].path));

const MdBlock = memo(
  function MdBlock({ token, active, media }: { token: Token; active: boolean; media: readonly MediaRef[] | null }) {
    return (
      <Fragment>
        {renderBlock(token, 'b', active)}
        {media && <MediaPreviews refs={media} />}
      </Fragment>
    );
  },
  (a, b) => a.token.raw === b.token.raw && a.active === b.active && sameRefs(a.media, b.media),
);

function lex(text: string): Token[] {
  try {
    return marked.lexer(text, { gfm: true, breaks: false });
  } catch {
    return [{ type: 'paragraph', raw: text, text, tokens: [{ type: 'text', raw: text, text }] } as Tokens.Paragraph];
  }
}

/**
 * `media` (0.6.3, chỉ bản VS Code, chỉ khi đoạn đã viết xong): ảnh / GIF / video / âm thanh / tài liệu mà khối nhắc tới được xem trước
 * ngay dưới khối đó (xem markdown/mediaRefs.ts và MediaPreviews).
 */
export function Markdown({ text, streaming = false, media = false }: { text: string; streaming?: boolean; media?: boolean }) {
  const blocks = useMemo(() => {
    const src = streaming ? prepareStreamingMarkdown(text) : text;
    return lex(src).filter((tk) => tk.type !== 'space' && tk.type !== 'def');
  }, [text, streaming]);
  const refs = useMemo(() => (media && !streaming ? mediaRefsByBlock(blocks) : null), [blocks, media, streaming]);

  return (
    <div class={cx('md', streaming && 'is-streaming')}>
      {blocks.map((tk, i) => (
        <MdBlock key={i} token={tk} active={streaming && i === blocks.length - 1} media={refs?.[i] ?? null} />
      ))}
    </div>
  );
}
