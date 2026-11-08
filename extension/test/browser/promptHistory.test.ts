/**
 * (0.7.4) Lịch sử các tin đã gõ (↑/↓ ở ô nhập) — lớp Chrome/Edge: BrowserConfig lưu qua kho khoá–giá trị.
 * (Logic thuần và lớp VS Code: test/promptHistory.test.ts.)
 */
import { describe, expect, it } from 'vitest';
import { BrowserConfig } from '../../src/browser/config';
import { MemoryKv } from '../../src/browser/kv';

describe('promptHistory · Chrome/Edge (BrowserConfig)', () => {
  it('ghi tuần tự, không lặp, bền qua lần mở lại; ghi dồn dập không mất tin', async () => {
    const kv = new MemoryKv();
    const c = new BrowserConfig(kv);
    await c.load();
    expect(await c.promptHistory()).toEqual([]);
    await Promise.all(['a', 'b', 'c', 'a', '  ', 'd'].map((t) => c.addPromptHistory(t)));
    expect(await c.promptHistory()).toEqual(['b', 'c', 'a', 'd']);
    const again = new BrowserConfig(kv);
    await again.load();
    expect(await again.promptHistory()).toEqual(['b', 'c', 'a', 'd']);
    await c.addPromptHistory(7 as never);
    expect(await c.promptHistory()).toEqual(['b', 'c', 'a', 'd']);
  });

  it('khoá riêng: đổi cấu hình không làm mất lịch sử, và dữ liệu hỏng được làm sạch', async () => {
    const kv = new MemoryKv();
    await kv.set('nd.promptHistory', ['x', 9, 'y', 'x']);
    const c = new BrowserConfig(kv);
    await c.load();
    await c.setUi('language', 'en');
    expect(await c.promptHistory()).toEqual(['y', 'x']);
  });
});

