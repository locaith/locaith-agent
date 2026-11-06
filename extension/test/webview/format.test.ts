import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatCompact,
  formatContextWindow,
  formatDecimal,
  formatDuration,
  formatInt,
  formatPercent,
  formatRelativeTime,
} from '../../webview/src/format';

describe('định dạng số theo vi-VN', () => {
  it('dấu chấm ngăn nghìn, dấu phẩy thập phân', () => {
    expect(formatInt(1234567, 'vi')).toBe('1.234.567');
    expect(formatDecimal(1234.5, 'vi')).toBe('1.234,5');
    expect(formatInt(1234567, 'en')).toBe('1,234,567');
  });
  it('formatCompact: k và M với dấu phẩy thập phân', () => {
    expect(formatCompact(12400, 'vi')).toBe('12,4k');
    expect(formatCompact(12400, 'en')).toBe('12.4k');
    expect(formatCompact(1_250_000, 'vi')).toBe('1,3M');
    expect(formatCompact(742, 'vi')).toBe('742');
  });
  it('formatContextWindow', () => {
    expect(formatContextWindow(200_000, 'vi')).toBe('200k');
    expect(formatContextWindow(1_048_576, 'vi')).toBe('1M');
    expect(formatContextWindow(1_000_000, 'vi')).toBe('1M');
    expect(formatContextWindow(1_050_000, 'en')).toBe('1.05M');
    expect(formatContextWindow(1_050_000, 'vi')).toBe('1,05M');
    expect(formatContextWindow(500_000, 'vi')).toBe('500k');
    expect(formatContextWindow(undefined, 'vi')).toBe('');
  });
  it('formatPercent & formatBytes', () => {
    expect(formatPercent(0.4236, 'vi')).toBe('42%');
    expect(formatBytes(500, 'vi')).toBe('500 B');
    expect(formatBytes(1536, 'vi')).toBe('1,5 KB');
    expect(formatBytes(5 * 1024 * 1024, 'en')).toBe('5 MB');
  });
});

describe('formatDuration', () => {
  it('mili-giây, giây lẻ, giây tròn, phút', () => {
    expect(formatDuration(420, 'vi')).toBe('420 ms');
    expect(formatDuration(1234, 'vi')).toBe('1,2 s');
    expect(formatDuration(1234, 'en')).toBe('1.2 s');
    expect(formatDuration(42_000, 'vi')).toBe('42 s');
    expect(formatDuration(125_000, 'vi')).toBe('2 phút 5 giây');
    expect(formatDuration(125_000, 'en')).toBe('2m 5s');
  });
});

describe('formatRelativeTime', () => {
  const now = Date.UTC(2026, 9, 29, 12, 0, 0);
  it('vừa xong dưới 45 giây', () => {
    expect(formatRelativeTime(now - 10_000, now, 'vi')).toBe('vừa xong');
    expect(formatRelativeTime(now - 10_000, now, 'en')).toBe('just now');
  });
  it('phút / giờ / ngày bằng tiếng Việt', () => {
    expect(formatRelativeTime(now - 5 * 60_000, now, 'vi')).toBe('5 phút trước');
    expect(formatRelativeTime(now - 3 * 3600_000, now, 'vi')).toBe('3 giờ trước');
    expect(formatRelativeTime(now - 86400_000, now, 'vi')).toBe('hôm qua');
    expect(formatRelativeTime(now - 5 * 86400_000, now, 'vi')).toBe('5 ngày trước');
  });
  it('tháng trước', () => {
    expect(formatRelativeTime(now - 40 * 86400_000, now, 'vi')).toMatch(/tháng/);
  });
});
