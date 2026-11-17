import { describe, expect, it } from 'vitest';
import type { NoticeLink, TItem, UiEvent } from '../src/shared/protocol';
import { applyEvent } from '../src/shared/transcript';
import { sanitizeEvent, sanitizeItem, sanitizeNoticeLink, sanitizeTranscript } from '../src/core/remote/sanitize';

// (0.7.8) Thông báo «hết dùng thử miễn phí» mang nút «Mua gói»: trường `link` đi từ engine → transcript → Remote, và bị lọc ở biên.
const LINK: NoticeLink = { url: 'https://locaith.ai/#upgrade', label: 'Mua gói' };

describe('notice + link («Mua gói») — trường tuỳ chọn của loại đã có', () => {
  it('reducer: thông báo độc lập và thông báo trong lượt trả lời đều mang link', () => {
    const solo = applyEvent([], { t: 'notice', level: 'error', text: 'Hết dùng thử.', link: LINK });
    expect((solo[0] as Extract<TItem, { kind: 'notice' }>).link).toEqual(LINK);
    let items: TItem[] = [];
    items = applyEvent(items, { t: 'assistant_start', id: 'a1', provider: 'p', model: 'm', ts: 1 });
    items = applyEvent(items, { t: 'notice', id: 'a1', level: 'error', text: 'Hết dùng thử.', link: LINK });
    const a = items[0] as Extract<TItem, { kind: 'assistant' }>;
    const block = a.blocks[0] as Extract<(typeof a.blocks)[number], { type: 'notice' }>;
    expect(block.link).toEqual(LINK);
  });

  it('reducer: thông báo thường KHÔNG có khoá link (không thêm khoá rỗng)', () => {
    const solo = applyEvent([], { t: 'notice', level: 'warn', text: 'x' });
    expect('link' in (solo[0] as object)).toBe(false);
    let items: TItem[] = [];
    items = applyEvent(items, { t: 'assistant_start', id: 'a1', provider: 'p', model: 'm', ts: 1 });
    items = applyEvent(items, { t: 'notice', id: 'a1', level: 'warn', text: 'x' });
    const a = items[0] as Extract<TItem, { kind: 'assistant' }>;
    expect('link' in (a.blocks[0] as object)).toBe(false);
  });

  it('sanitizeNoticeLink: chỉ https ngắn + nhãn 1–40 ký tự; mọi thứ khác bị bỏ', () => {
    expect(sanitizeNoticeLink(LINK)).toEqual(LINK);
    expect(sanitizeNoticeLink(undefined)).toBeUndefined();
    for (const bad of [
      { url: 'http://locaith.ai/', label: 'x' },
      { url: 'javascript:alert(1)', label: 'x' },
      { url: 'https://locaith.ai/' + 'a'.repeat(400), label: 'x' },
      { url: 'https://locaith.ai/', label: '' },
      { url: 'https://locaith.ai/', label: 'x'.repeat(41) },
      { url: 5, label: 'x' },
      { url: 'https://locaith.ai/', label: null },
    ]) {
      expect(sanitizeNoticeLink(bad as never)).toBeUndefined();
    }
  });

  it('Remote: sự kiện, mục transcript và khối trong lượt trả lời đều giữ link hợp lệ và bỏ link xấu (dòng chữ vẫn nguyên)', () => {
    const good = sanitizeEvent({ t: 'notice', level: 'error', text: 'Hết dùng thử.', link: LINK }) as Extract<UiEvent, { t: 'notice' }>;
    expect(good.link).toEqual(LINK);
    expect(good.text).toBe('Hết dùng thử.');
    const evil = sanitizeEvent({ t: 'notice', level: 'error', text: 'Hết dùng thử.', link: { url: 'http://evil.example/', label: 'Mua gói' } }) as Extract<UiEvent, { t: 'notice' }>;
    expect('link' in evil).toBe(false);
    expect(evil.text).toBe('Hết dùng thử.');

    const item: TItem = { kind: 'notice', id: 'n1', level: 'error', text: 'Hết dùng thử.', ts: 1, link: LINK };
    expect((sanitizeItem(item) as Extract<TItem, { kind: 'notice' }>).link).toEqual(LINK);
    const bad = sanitizeItem({ ...item, link: { url: 'ftp://x', label: 'Mua gói' } }) as Extract<TItem, { kind: 'notice' }>;
    expect('link' in bad).toBe(false);

    const asst: TItem = { kind: 'assistant', id: 'a1', provider: 'p', model: 'm', ts: 1, done: true, blocks: [{ type: 'notice', id: 'n', level: 'error', text: 'Hết dùng thử.', link: LINK }] } as TItem;
    const t = sanitizeTranscript([asst]).transcript[0] as Extract<TItem, { kind: 'assistant' }>;
    expect((t.blocks[0] as { link?: NoticeLink }).link).toEqual(LINK);
    const asstBad = { ...asst, blocks: [{ type: 'notice', id: 'n', level: 'error', text: 'x', link: { url: 'http://x', label: 'y' } }] } as TItem;
    const tb = sanitizeTranscript([asstBad]).transcript[0] as Extract<TItem, { kind: 'assistant' }>;
    expect('link' in (tb.blocks[0] as object)).toBe(false);
  });
});
