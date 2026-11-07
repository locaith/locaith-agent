import { describe, expect, it } from 'vitest';
import type { CompactInfo, TItem, UiEvent } from '../src/shared/protocol';
import { applyEvent } from '../src/shared/transcript';
import { sanitizeCompact, sanitizeEvent, sanitizeEvents, sanitizeItem, sanitizeTranscript } from '../src/core/remote/sanitize';

const COMPACT: CompactInfo = { mode: 'auto', tokensFreed: 968_000, summarizedMessages: 41, clearedResults: 12, summary: 'Đã đọc: a.ts, b.ts' };

describe('notice + compact (số liệu nén ngữ cảnh) — trường tuỳ chọn của loại đã có', () => {
  it('reducer: notice độc lập mang compact', () => {
    const ev: UiEvent = { t: 'notice', level: 'info', text: 'Đã nén cuộc trò chuyện · tự động · giải phóng 968k token', compact: COMPACT };
    const items = applyEvent([], ev);
    expect(items).toHaveLength(1);
    const it = items[0] as Extract<TItem, { kind: 'notice' }>;
    expect(it.kind).toBe('notice');
    expect(it.compact).toEqual(COMPACT);
  });

  it('reducer: notice trong lượt trả lời (có id) mang compact vào khối notice', () => {
    let items: TItem[] = [];
    items = applyEvent(items, { t: 'assistant_start', id: 'a1', provider: 'p', model: 'm', ts: 1 });
    items = applyEvent(items, { t: 'notice', id: 'a1', level: 'info', text: 'đã nén', compact: COMPACT });
    const a = items[0] as Extract<TItem, { kind: 'assistant' }>;
    const block = a.blocks[0] as Extract<(typeof a.blocks)[number], { type: 'notice' }>;
    expect(block.type).toBe('notice');
    expect(block.compact).toEqual(COMPACT);
  });

  it('reducer: notice thường KHÔNG có trường compact (không thêm khoá rỗng)', () => {
    const items = applyEvent([], { t: 'notice', level: 'warn', text: 'x' });
    expect('compact' in (items[0] as object)).toBe(false);
  });

  it('sanitizeCompact: chế độ lạ → auto, số âm/NaN/không phải số bị bỏ, tóm tắt bị cắt', () => {
    const out = sanitizeCompact({ mode: 'weird' as never, tokensFreed: -5, summarizedMessages: Number.NaN, clearedResults: 7.9, summary: 'x'.repeat(5000) });
    expect(out.mode).toBe('auto');
    expect(out.tokensFreed).toBe(0);
    expect('summarizedMessages' in out).toBe(false);
    expect(out.clearedResults).toBe(7);
    expect(out.summary!.length).toBeLessThan(1600);
  });

  it('sanitizeCompact: không để lọt trường lạ', () => {
    const dirty = { ...COMPACT, secret: 'khoá-bí-mật', extra: { a: 1 } } as unknown as CompactInfo;
    const out = sanitizeCompact(dirty);
    expect(Object.keys(out).sort()).toEqual(['clearedResults', 'mode', 'summarizedMessages', 'summary', 'tokensFreed']);
  });

  it('relay: sự kiện, mục và khối đều giữ compact đã được làm sạch', () => {
    const big: CompactInfo = { ...COMPACT, summary: 'y'.repeat(9000) };
    const ev = sanitizeEvent({ t: 'notice', level: 'info', text: 't', compact: big });
    expect((ev as Extract<UiEvent, { t: 'notice' }>).compact!.summary!.length).toBeLessThan(1600);
    const evs = sanitizeEvents([{ t: 'notice', level: 'info', text: 't', compact: big }]);
    expect(evs).toHaveLength(1);

    const item = sanitizeItem({ kind: 'notice', id: 'n', level: 'info', text: 't', ts: 1, compact: big });
    expect((item as Extract<TItem, { kind: 'notice' }>).compact!.summary!.length).toBeLessThan(1600);

    const { transcript } = sanitizeTranscript([
      { kind: 'assistant', id: 'a', provider: 'p', model: 'm', ts: 1, done: true, blocks: [{ type: 'notice', id: 'b', level: 'info', text: 't', compact: big }] },
    ]);
    const blk = (transcript[0] as Extract<TItem, { kind: 'assistant' }>).blocks[0] as { compact?: CompactInfo };
    expect(blk.compact!.summary!.length).toBeLessThan(1600);
  });

  it('tương thích ngược: bản cũ chỉ thấy chữ — notice có compact vẫn mang đủ level/text', () => {
    const ev = sanitizeEvent({ t: 'notice', level: 'info', text: 'Đã nén', compact: COMPACT }) as Extract<UiEvent, { t: 'notice' }>;
    expect(ev.t).toBe('notice');
    expect(ev.level).toBe('info');
    expect(ev.text).toBe('Đã nén');
  });
});
