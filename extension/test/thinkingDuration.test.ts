import { describe, expect, it } from 'vitest';
import type { AssistantItem, TItem, UiEvent } from '../src/shared/protocol';
import { applyEvent } from '../src/shared/transcript';
import { sanitizeEvent, sanitizeItem } from '../src/core/remote/sanitize';

/**
 * (lane:cc-timeline-ui) «Đã suy nghĩ 14 giây»: sự kiện `thinking` mang `ts` tuỳ chọn → reducer tính `startedAt`/`durationMs` trên khối;
 * thiếu ts (phiên cũ, nhà cung cấp không đóng dấu) → không có trường nào; Remote giữ số hợp lệ, bỏ số lạ.
 */
const start = (): TItem[] => applyEvent([], { t: 'assistant_start', id: 'a1', provider: 'p', model: 'm', ts: 1 });
const think = (delta: string, ts?: number): UiEvent => ({ t: 'thinking', id: 'a1', delta, ...(ts !== undefined ? { ts } : {}) });
const blocksOf = (items: TItem[]) => (items[0] as AssistantItem).blocks;

describe('reducer: thời lượng suy nghĩ từ ts của delta', () => {
  it('delta đầu đặt startedAt; các delta sau cập nhật durationMs = ts − startedAt', () => {
    let items = start();
    items = applyEvent(items, think('a', 10_000));
    expect(blocksOf(items)[0]).toMatchObject({ type: 'thinking', text: 'a', startedAt: 10_000 });
    expect('durationMs' in blocksOf(items)[0]).toBe(false);
    items = applyEvent(items, think('b', 15_500));
    items = applyEvent(items, think('c', 24_000));
    expect(blocksOf(items)[0]).toMatchObject({ text: 'abc', startedAt: 10_000, durationMs: 14_000 });
  });

  it('không có ts → khối suy nghĩ không mang startedAt/durationMs (tương thích phiên cũ)', () => {
    let items = start();
    items = applyEvent(items, think('a'));
    items = applyEvent(items, think('b'));
    const b = blocksOf(items)[0] as Record<string, unknown>;
    expect(b.text).toBe('ab');
    expect('startedAt' in b).toBe(false);
    expect('durationMs' in b).toBe(false);
  });

  it('ts lạ (âm, NaN) bị bỏ qua; đồng hồ lùi → durationMs không âm', () => {
    let items = start();
    items = applyEvent(items, think('a', Number.NaN));
    expect('startedAt' in (blocksOf(items)[0] as object)).toBe(false);
    items = applyEvent(items, think('b', 5000));
    items = applyEvent(items, think('c', 4000));
    expect(blocksOf(items)[0]).toMatchObject({ startedAt: 5000, durationMs: 0 });
  });

  it('khối suy nghĩ thứ hai (sau một đoạn chữ) có mốc riêng', () => {
    let items = start();
    items = applyEvent(items, think('a', 1000));
    items = applyEvent(items, { t: 'text', id: 'a1', delta: 'x' });
    items = applyEvent(items, think('b', 9000));
    items = applyEvent(items, think('c', 12_000));
    const blocks = blocksOf(items);
    expect(blocks.map((b) => b.type)).toEqual(['thinking', 'text', 'thinking']);
    expect(blocks[2]).toMatchObject({ startedAt: 9000, durationMs: 3000 });
  });

  it('khối chữ không bao giờ mang trường thời gian', () => {
    let items = start();
    items = applyEvent(items, { t: 'text', id: 'a1', delta: 'x' });
    expect('startedAt' in (blocksOf(items)[0] as object)).toBe(false);
  });
});

describe('Remote: sanitize giữ số hợp lệ, bỏ số lạ', () => {
  it('sự kiện thinking: ts hợp lệ giữ nguyên (cùng tham chiếu), ts lạ bị bỏ, không ts thì nguyên vẹn', () => {
    const ok = think('a', 12_345);
    expect(sanitizeEvent(ok)).toBe(ok);
    const bad = sanitizeEvent(think('a', -1)) as Record<string, unknown>;
    expect('ts' in bad).toBe(false);
    expect(bad.delta).toBe('a');
    const frac = sanitizeEvent(think('a', 12.9)) as { ts?: number };
    expect(frac.ts).toBe(12);
    const none = think('a');
    expect(sanitizeEvent(none)).toBe(none);
  });

  it('khối thinking trong transcript: startedAt/durationMs nguyên không âm, giá trị lạ bị bỏ, chữ dài vẫn bị cắt', () => {
    const item: AssistantItem = {
      kind: 'assistant', id: 'a', provider: 'p', model: 'm', ts: 1, done: true,
      blocks: [
        { type: 'thinking', id: 'k1', text: 'x'.repeat(9000), startedAt: 1000, durationMs: 14_000 },
        { type: 'thinking', id: 'k2', text: 'y', startedAt: Number.NaN, durationMs: -5 },
        { type: 'thinking', id: 'k3', text: 'z' },
      ],
    };
    const out = sanitizeItem(item) as AssistantItem;
    const [k1, k2, k3] = out.blocks as Array<Record<string, unknown>>;
    expect(k1).toMatchObject({ startedAt: 1000, durationMs: 14_000 });
    expect((k1.text as string).length).toBeLessThanOrEqual(4000);
    expect('startedAt' in k2).toBe(false);
    expect('durationMs' in k2).toBe(false);
    expect(k3).toEqual({ type: 'thinking', id: 'k3', text: 'z' });
  });
});
