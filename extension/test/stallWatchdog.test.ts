import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CALL_MAX_SECONDS, StallError, autoStallMs, resolveStallPolicy, thinkingFactor, watchStream } from '../src/core/engine/stallWatchdog';
import type { ProviderEvent } from '../src/core/types';

/** (lane:output-timeouts · B04) Watchdog theo bậc: ngưỡng theo cỡ ngữ cảnh × mức suy luận; hàng chờ không tính; huỷ riêng lần gọi. */
describe('stallWatchdog — ngưỡng', () => {
  it('bậc theo cỡ ngữ cảnh: <32k 20 s · 32–200k 45 s · 200–600k 70 s · >600k 90 s (mức off/low ×1)', () => {
    expect(autoStallMs(0, 'off')).toBe(20_000);
    expect(autoStallMs(31_999, 'low')).toBe(20_000);
    expect(autoStallMs(32_000, 'low')).toBe(45_000);
    expect(autoStallMs(199_999, 'off')).toBe(45_000);
    expect(autoStallMs(200_000, 'off')).toBe(70_000);
    expect(autoStallMs(600_000, 'off')).toBe(90_000);
    expect(autoStallMs(2_000_000, undefined)).toBe(90_000);
  });

  it('hệ số theo mức suy luận: medium ×1,5 · high ×2,5 · max/swarm ×4', () => {
    expect(thinkingFactor('off')).toBe(1);
    expect(thinkingFactor('medium')).toBe(1.5);
    expect(autoStallMs(10_000, 'medium')).toBe(30_000);
    expect(autoStallMs(100_000, 'high')).toBe(112_500);
    expect(autoStallMs(100_000, 'max')).toBe(180_000);
    expect(autoStallMs(100_000, 'swarm')).toBe(180_000);
  });

  it("cài đặt: 'auto' theo phiên · 0 tắt · số giây cố định; trần tổng mặc định 600 s và không nhỏ hơn ngưỡng im lặng", () => {
    const s = { lastContextTokens: 50_000, thinkingLevel: 'medium' as const };
    expect(resolveStallPolicy({ modelStallSeconds: 'auto' }, s)).toEqual({ stallMs: 67_500, totalMs: DEFAULT_CALL_MAX_SECONDS * 1000 });
    expect(resolveStallPolicy({}, s)?.stallMs).toBe(67_500);
    expect(resolveStallPolicy({ modelStallSeconds: 0 }, s)).toBeNull();
    expect(resolveStallPolicy({ modelStallSeconds: 30, modelCallMaxSeconds: 120 }, s)).toEqual({ stallMs: 30_000, totalMs: 120_000 });
    expect(resolveStallPolicy({ modelStallSeconds: 1 }, s)?.stallMs).toBe(5_000); // sàn 5 s
    // swarm bật bằng cờ riêng → ×4
    expect(resolveStallPolicy({}, { lastContextTokens: 0, thinkingLevel: 'low', swarm: true })?.stallMs).toBe(80_000);
    // trần tổng không bao giờ nhỏ hơn ngưỡng im lặng
    expect(resolveStallPolicy({ modelStallSeconds: 300, modelCallMaxSeconds: 60 }, s)?.totalMs).toBe(300_000);
  });
});

const hangForever = (signal?: AbortSignal) =>
  new Promise<never>((_, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });

describe('stallWatchdog — watchStream (fake timers)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('im lặng quá ngưỡng → onTimeout được gọi NGAY rồi ném StallError(stall); sự kiện trước đó vẫn đã được chuyển', async () => {
    const ac = new AbortController();
    async function* src(): AsyncGenerator<ProviderEvent> {
      yield { type: 'text_delta', text: 'Đã có ' };
      await hangForever(ac.signal);
    }
    const seen: ProviderEvent[] = [];
    let timedOut: StallError | null = null;
    const run = (async () => {
      for await (const ev of watchStream(src(), { stallMs: 5_000, totalMs: 600_000 }, { onTimeout: (e) => { timedOut = e; ac.abort(); } })) seen.push(ev);
    })();
    const failed = run.catch((e) => e);
    await vi.advanceTimersByTimeAsync(4_900);
    expect(timedOut).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    const err = await failed;
    expect(err).toBeInstanceOf(StallError);
    expect((err as StallError).kind).toBe('stall');
    expect((err as StallError).limitMs).toBe(5_000);
    expect(timedOut).toBe(err);
    expect(seen).toEqual([{ type: 'text_delta', text: 'Đã có ' }]);
  });

  it('mỗi sự kiện tới đặt lại đồng hồ im lặng: luồng chảy chậm nhưng đều không bị ngắt', async () => {
    async function* src(): AsyncGenerator<ProviderEvent> {
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 4_000));
        yield { type: 'text_delta', text: `${i}` };
      }
      yield { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, message: { role: 'assistant', content: [] } };
    }
    const seen: string[] = [];
    const run = (async () => {
      for await (const ev of watchStream(src(), { stallMs: 5_000, totalMs: 600_000 }, { onTimeout: () => undefined })) seen.push(ev.type);
    })();
    await vi.advanceTimersByTimeAsync(25_000);
    await run;
    expect(seen).toEqual(['text_delta', 'text_delta', 'text_delta', 'text_delta', 'text_delta', 'done']);
  });

  it('thời gian đứng HÀNG CHỜ của cổng (sau sự kiện queue/retry) KHÔNG tính vào im lặng lẫn trần tổng', async () => {
    async function* src(): AsyncGenerator<ProviderEvent> {
      yield { type: 'queue', position: 3, ahead: 2, attempt: 1, waitMs: 60_000, retryAt: Date.now() + 60_000 };
      await new Promise((r) => setTimeout(r, 60_000)); // đứng hàng 60 s — gấp 12 lần ngưỡng
      yield { type: 'retry', attempt: 1, maxAttempts: 3, delayMs: 30_000, reason: 'busy' };
      await new Promise((r) => setTimeout(r, 30_000)); // nhà cung cấp ngủ trước khi thử lại
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, message: { role: 'assistant', content: [] } };
    }
    const seen: string[] = [];
    let timedOut = false;
    const run = (async () => {
      for await (const ev of watchStream(src(), { stallMs: 5_000, totalMs: 20_000 }, { onTimeout: () => { timedOut = true; } })) seen.push(ev.type);
    })();
    await vi.advanceTimersByTimeAsync(95_000);
    await run;
    expect(timedOut).toBe(false);
    expect(seen).toEqual(['queue', 'retry', 'text_delta', 'done']);
  });

  it('vượt trần TỔNG dù vẫn có sự kiện đều → StallError(total)', async () => {
    const ac = new AbortController();
    async function* src(): AsyncGenerator<ProviderEvent> {
      for (let i = 0; i < 100; i++) {
        if (ac.signal.aborted) throw new Error('aborted');
        await new Promise((r) => setTimeout(r, 1_000));
        yield { type: 'thinking_delta', text: '.' };
      }
    }
    const run = (async () => {
      for await (const _ of watchStream(src(), { stallMs: 5_000, totalMs: 12_000 }, { onTimeout: () => ac.abort() })) void _;
    })();
    const failed = run.catch((e) => e);
    await vi.advanceTimersByTimeAsync(13_000);
    const err = await failed;
    expect(err).toBeInstanceOf(StallError);
    expect((err as StallError).kind).toBe('total');
    expect((err as StallError).limitMs).toBe(12_000);
  });
});
