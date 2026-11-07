/**
 * (lane:sessions-ux) Phần TÍNH thuần của đồng hồ ngữ cảnh/chi phí — không import gì ngoài kiểu,
 * để webview dùng được mà không kéo bảng chuỗi của engine.
 */

import type { ModelInfo } from '../core/types';
import type { ViewState } from './protocol';

export type MeterTone = 'ok' | 'warn' | 'danger';

/** Ngưỡng màu của chip: > 60% vàng, > 80% đỏ. */
export function meterTone(ratio: number): MeterTone {
  return ratio > 0.8 ? 'danger' : ratio > 0.6 ? 'warn' : 'ok';
}

export function contextRatio(ctx: ViewState['context'] | undefined): number | null {
  if (!ctx || !(ctx.limitTokens > 0)) return null;
  return Math.max(0, Math.min(1, ctx.usedTokens / ctx.limitTokens));
}

/** Chi phí ước tính (USD) — undefined nếu không có giá. */
export function estimateCost(input: number, output: number, pricing: ModelInfo['pricing'] | undefined): number | undefined {
  if (!pricing || !Number.isFinite(pricing.inputPerM) || !Number.isFinite(pricing.outputPerM)) return undefined;
  return (Math.max(0, input) * pricing.inputPerM + Math.max(0, output) * pricing.outputPerM) / 1e6;
}

export function formatUsd(v: number): string {
  if (v === 0) return '$0';
  if (v < 0.01) return '<$0.01';
  return `$${v < 10 ? v.toFixed(2) : v.toFixed(1)}`;
}
