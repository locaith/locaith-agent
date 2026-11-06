import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Presence } from '../../src/browser/presence';
import { FakeBrowserApi } from './helpers/fakeApi';

const flush = () => vi.advanceTimersByTimeAsync(1);

function make(over: { enabled?: () => boolean; lang?: 'vi' | 'en' } = {}) {
  const api = new FakeBrowserApi();
  const tab = api.addTab({ url: 'https://shop.vn/' });
  const p = new Presence({ api, enabled: over.enabled ?? (() => true), lang: () => over.lang ?? 'vi', intervalMs: 4_000, ttlMs: 15_000 });
  return { api, tab, p };
}

describe('Presence — viền sáng + nút Dừng', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('chưa bắt đầu lượt chạy thì chạm vào tab không hiện gì', async () => {
    const { api, tab, p } = make();
    p.touch(tab.id, 'read');
    await flush();
    expect(api.presenceLog).toHaveLength(0);
    expect(p.has(tab.id)).toBe(false);
  });

  it('chạm vào tab: hiện viền sáng với chữ "đang đọc"; thao tác thì đổi sang "đang điều khiển" và giữ như vậy cả lượt', async () => {
    const { api, tab, p } = make();
    p.begin();
    p.touch(tab.id, 'read');
    await flush();
    expect(api.presenceOn.has(tab.id)).toBe(true);
    expect(api.presenceLog.at(-1)?.state).toMatchObject({ on: true, label: 'Locaith AI đang đọc trang này', stopLabel: 'Dừng', ttlMs: 15_000 });
    p.touch(tab.id, 'act');
    await flush();
    expect(api.presenceLog.at(-1)?.state).toMatchObject({ on: true, label: 'Locaith AI đang điều khiển trang này' });
    p.touch(tab.id, 'read'); // đọc thêm sau khi đã thao tác: nhãn không tụt về "đọc"
    await flush();
    expect(api.presenceLog.at(-1)?.state).toMatchObject({ label: 'Locaith AI đang điều khiển trang này' });
    expect(p.has(tab.id)).toBe(true);
  });

  it('nhãn theo ngôn ngữ giao diện', async () => {
    const { api, tab, p } = make({ lang: 'en' });
    p.begin();
    p.touch(tab.id, 'act');
    await flush();
    expect(api.presenceLog.at(-1)?.state).toMatchObject({ on: true, label: 'Locaith AI is controlling this page', stopLabel: 'Stop' });
  });

  it('gia hạn theo nhịp trong lúc lượt còn chạy (để trang không tự gỡ lớp phủ), và dừng nhịp khi kết thúc', async () => {
    const { api, tab, p } = make();
    p.begin();
    p.touch(tab.id, 'act');
    await flush();
    const before = api.presenceLog.length;
    await vi.advanceTimersByTimeAsync(4_000 * 3 + 10);
    expect(api.presenceLog.length).toBe(before + 3);
    expect(api.presenceLog.slice(before).every((l) => l.state.on)).toBe(true);
    p.end();
    await flush();
    const after = api.presenceLog.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.presenceLog.length).toBe(after); // hết nhịp
  });

  it('kết thúc lượt: gỡ viền sáng khỏi MỌI tab đã chạm; chạm sau đó không hiện lại', async () => {
    const { api, tab, p } = make();
    const second = api.addTab({ url: 'https://khac.example.org/' });
    p.begin();
    p.touch(tab.id, 'read');
    p.touch(second.id, 'act');
    await flush();
    expect([...api.presenceOn].sort()).toEqual([tab.id, second.id].sort());
    p.end();
    await flush();
    expect(api.presenceOn.size).toBe(0);
    expect(p.has(tab.id)).toBe(false);
    p.touch(tab.id, 'act'); // một công cụ còn chạy dở sau khi bị dừng
    await flush();
    expect(api.presenceOn.size).toBe(0);
  });

  it('lệnh gỡ không bị lệnh bật gửi trước đó chạy đè (xếp hàng theo tab)', async () => {
    const { api, tab, p } = make();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = api.setPresence.bind(api);
    api.setPresence = async (id, state) => {
      if (state.on) await gate; // lệnh "bật" bị chậm
      return real(id, state);
    };
    p.begin();
    p.touch(tab.id, 'act');
    p.end(); // gỡ ngay khi lệnh bật còn đang chờ
    release();
    await flush();
    await flush();
    expect(api.presenceOn.has(tab.id)).toBe(false);
  });

  it('cài đặt tắt: không hiện gì; tắt giữa chừng: gỡ ở nhịp kế tiếp', async () => {
    let on = false;
    const { api, tab, p } = make({ enabled: () => on });
    p.begin();
    p.touch(tab.id, 'act');
    await flush();
    expect(api.presenceLog).toHaveLength(0);
    on = true;
    p.touch(tab.id, 'act');
    await flush();
    expect(api.presenceOn.has(tab.id)).toBe(true);
    on = false;
    await vi.advanceTimersByTimeAsync(4_100);
    expect(api.presenceOn.has(tab.id)).toBe(false);
  });

  it('tab đã đóng: thôi gia hạn (không gọi mãi vào tab không còn)', async () => {
    const { api, tab, p } = make();
    p.begin();
    p.touch(tab.id, 'act');
    await flush();
    await api.closeTab(tab.id);
    await vi.advanceTimersByTimeAsync(4_100); // nhịp đầu: thấy tab đã mất → bỏ
    const n = api.presenceLog.length;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(api.presenceLog.length).toBe(n);
    expect(p.has(tab.id)).toBe(false);
  });
});
