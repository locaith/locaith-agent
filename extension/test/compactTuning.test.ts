import { describe, expect, it } from 'vitest';
import { compactNoticeOf, type CompactResult } from '../src/core/engine/compaction';
import { AUTO_CAP_TOKENS, compactTuningFrom, DEFAULT_COMPACT_TUNING, effectiveCompactThreshold, formatTokens } from '../src/core/engine/compactTuning';
import { DEFAULT_ENGINE_SETTINGS } from '../src/core/engine/types';
import { sanitizeContext, sanitizePatch, toRemoteState } from '../src/core/remote/sanitize';
import type { ViewState } from '../src/shared/protocol';

describe('ngưỡng nén hiệu dụng (trần tuyệt đối cho cửa sổ lớn)', () => {
  const T = DEFAULT_COMPACT_TUNING;

  it('cửa sổ ≤ 400k: hành vi cũ (compactAt × cửa sổ), không bị trần', () => {
    expect(effectiveCompactThreshold(200_000, 0.8, T)).toBe(160_000);
    expect(effectiveCompactThreshold(128_000, undefined, T)).toBe(102_400);
    expect(effectiveCompactThreshold(400_000, 0.95, T)).toBe(380_000); // 400k không phải "> 400k"
  });

  it('cửa sổ > 400k và người dùng KHÔNG tự đặt compactAtPercent → trần 300k', () => {
    expect(effectiveCompactThreshold(1_000_000, 0.8, T)).toBe(AUTO_CAP_TOKENS);
    expect(effectiveCompactThreshold(1_000_000, 0.9, T)).toBe(300_000);
    expect(effectiveCompactThreshold(2_000_000, undefined, T)).toBe(300_000);
  });

  it('người dùng tự đặt compactAtPercent → tôn trọng, không áp trần tự động', () => {
    expect(effectiveCompactThreshold(1_000_000, 0.8, { ...T, compactAtUserSet: true })).toBe(800_000);
  });

  it('compactAtTokens > 0 → min(phần trăm × cửa sổ, trần), áp cho mọi cửa sổ, cả khi người dùng đặt phần trăm', () => {
    expect(effectiveCompactThreshold(1_000_000, 0.8, { ...T, compactAtTokens: 500_000, compactAtUserSet: true })).toBe(500_000);
    expect(effectiveCompactThreshold(200_000, 0.8, { ...T, compactAtTokens: 100_000 })).toBe(100_000);
    expect(effectiveCompactThreshold(200_000, 0.8, { ...T, compactAtTokens: 999_999 })).toBe(160_000); // trần cao hơn → phần trăm thắng
  });

  it('compactAt bị kẹp 0,5–0,95', () => {
    expect(effectiveCompactThreshold(100_000, 0.1, T)).toBe(50_000);
    expect(effectiveCompactThreshold(100_000, 1.5, T)).toBe(95_000);
  });
});

describe('đọc tham số từ cài đặt', () => {
  it('mặc định an toàn khi thiếu; kẹp miền giá trị; mục tiêu lược luôn thấp hơn ngưỡng bắt đầu', () => {
    expect(compactTuningFrom(undefined)).toEqual(DEFAULT_COMPACT_TUNING);
    expect(compactTuningFrom(DEFAULT_ENGINE_SETTINGS)).toEqual(DEFAULT_COMPACT_TUNING);
    const t = compactTuningFrom({ clearToolResultsAtPercent: 150, keepRecentMessages: 1, compactAtTokens: -5, compactAtUserSet: true });
    expect(t.clearAtPercent).toBe(90);
    expect(t.clearTargetPercent).toBe(30);
    expect(t.keepRecentMessages).toBe(4);
    expect(t.compactAtTokens).toBe(0);
    expect(t.compactAtUserSet).toBe(true);
    const low = compactTuningFrom({ clearToolResultsAtPercent: 20 });
    expect(low.clearTargetPercent).toBe(10);
    expect(compactTuningFrom({ clearToolResultsAtPercent: 0 }).clearTargetPercent).toBe(0);
    expect(compactTuningFrom({ clearToolResultsAtPercent: Number.NaN }).clearAtPercent).toBe(40);
  });
});

describe('định dạng số token và dòng thông báo', () => {
  it('formatTokens', () => {
    expect(formatTokens(968_000)).toBe('968k');
    expect(formatTokens(1_234_567, 'vi')).toBe('1,2M');
    expect(formatTokens(1_234_567, 'en')).toBe('1.2M');
    expect(formatTokens(12_000_000)).toBe('12M');
    expect(formatTokens(850)).toBe('850');
    expect(formatTokens(-3)).toBe('0');
  });

  const base: CompactResult = { pruned: 0, summarizedMessages: 0, mode: 'auto', tokensBefore: 1_000_000, tokensAfter: 32_000, tokensFreed: 968_000 };

  it('có tóm tắt → «Đã nén cuộc trò chuyện · tự động · giải phóng 968k token» kèm CompactInfo thật', () => {
    const r = compactNoticeOf('vi', { ...base, summarizedMessages: 41, pruned: 12, summary: 'S'.repeat(3000) });
    expect(r!.text).toBe('Đã nén cuộc trò chuyện · tự động · giải phóng 968k token');
    expect(r!.compact).toMatchObject({ mode: 'auto', tokensFreed: 968_000, summarizedMessages: 41, clearedResults: 12 });
    expect(r!.compact.summary!.length).toBeLessThanOrEqual(1501);
    expect(compactNoticeOf('en', { ...base, summarizedMessages: 3, mode: 'manual' })!.text).toBe('Compacted chat · manual · 968k tokens freed');
    expect(compactNoticeOf('vi', { ...base, summarizedMessages: 3, mode: 'overflow' })!.text).toContain('· tràn ngữ cảnh ·');
  });

  it('chỉ lược → dòng «Đã lược N kết quả công cụ cũ…»; không làm gì → null', () => {
    const r = compactNoticeOf('vi', { ...base, pruned: 7, tokensFreed: 5000 });
    expect(r!.text).toBe('Đã lược 7 kết quả công cụ cũ để giữ ngữ cảnh gọn — đọc lại được khi cần');
    expect(r!.compact).toEqual({ mode: 'auto', tokensFreed: 5000, clearedResults: 7 });
    expect('summarizedMessages' in r!.compact).toBe(false);
    expect(compactNoticeOf('vi', base)).toBeNull();
  });
});

describe('ViewState.context ra Remote: trường mới đi qua có kiểm soát', () => {
  it('sanitizeContext: chỉ các trường đã liệt kê, số nguyên không âm, bỏ trường lạ', () => {
    const dirty = { usedTokens: 12.7, limitTokens: -1, percent: 1e9, clearedResults: 3.9, compactions: Number.NaN, secret: 'x' } as unknown as ViewState['context'];
    expect(sanitizeContext(dirty)).toEqual({ usedTokens: 12, limitTokens: 0, percent: 999, clearedResults: 3 });
    expect(sanitizeContext(null)).toBeNull();
    expect(sanitizeContext({ usedTokens: 1, limitTokens: 2 })).toEqual({ usedTokens: 1, limitTokens: 2 }); // bản cũ không có khoá rỗng
  });

  it('sanitizePatch và toRemoteState đều dùng bộ lọc đó', () => {
    const ctx = { usedTokens: 10, limitTokens: 100, percent: 10, clearedResults: 2, compactions: 1 };
    expect(sanitizePatch({ context: ctx })).toEqual({ context: ctx });
    const view = { transcript: [], todos: [], running: false, provider: 'p', model: 'm', mode: 'default', thinkingLevel: 'medium', providers: [], sessions: [], context: { ...ctx, extra: 1 }, allowBypass: false, sessionId: 's', title: 't' } as unknown as ViewState;
    const state = toRemoteState(view, { name: 'h', vscode: '1', ext: '1', platform: 'win32' }, { canBypass: false });
    expect(state.context).toEqual(ctx);
  });
});
