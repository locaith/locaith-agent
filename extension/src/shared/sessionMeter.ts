/**
 * (lane:sessions-ux) Đồng hồ ngữ cảnh + chi phí của phiên, và bảng chia nhỏ ngữ cảnh cho `/context`, bảng chi phí cho `/cost`.
 * Thuần tuý (không vscode/node) — dùng chung host, trình duyệt, Remote và kiểm thử.
 *
 * Nguyên tắc: không bịa số. Chi phí chỉ có khi danh mục model có giá thật (`ModelInfo.pricing`); token vào/ra lấy từ
 * `session.usageTotals` (số hãng báo); phần chia nhỏ ngữ cảnh là ƯỚC LƯỢNG và được ghi rõ là ước lượng.
 */

import type { PromptStats } from '../core/engine/promptStats';
import { t, type Lang } from '../core/engine/strings';
import { estimateBlockTokens } from '../core/engine/tokens';
import type { SessionState } from '../core/engine/types';
import type { ChatMessage, ModelInfo } from '../core/types';
import type { TItem, ViewState } from './protocol';
import type { SessionMeterView } from './sessionsUxTypes';

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

/** Đếm các lần nén và tổng kết quả công cụ đã lược từ thông báo nén (đứng riêng hoặc gắn trong lượt trả lời). */
export function compactionStats(transcript: readonly TItem[]): { compactions: number; clearedResults: number } {
  let compactions = 0;
  let clearedResults = 0;
  const add = (c: { clearedResults?: number } | undefined) => {
    if (!c) return;
    compactions++;
    clearedResults += typeof c.clearedResults === 'number' && c.clearedResults > 0 ? c.clearedResults : 0;
  };
  for (const it of transcript) {
    if (it.kind === 'notice') add(it.compact);
    else if (it.kind === 'assistant') for (const b of it.blocks) if (b.type === 'notice') add(b.compact);
  }
  return { compactions, clearedResults };
}

export function buildMeter(session: Pick<SessionState, 'usageTotals'>, transcript: readonly TItem[], pricing: ModelInfo['pricing'] | undefined): SessionMeterView {
  const input = session.usageTotals?.input ?? 0;
  const output = session.usageTotals?.output ?? 0;
  const cost = estimateCost(input, output, pricing);
  return { inputTokens: input, outputTokens: output, ...compactionStats(transcript), ...(cost !== undefined ? { costUsd: cost } : {}) };
}

export function findPricing(providers: ViewState['providers'] | undefined, provider: string, model: string): ModelInfo['pricing'] | undefined {
  return providers?.find((p) => p.id === provider)?.models.find((m) => m.id === model)?.pricing;
}

// ── /context ────────────────────────────────────────────────────────────────

export interface ContextBreakdown {
  system?: number;
  tools?: number;
  toolCount?: number;
  memory?: number;
  userText: number;
  assistantText: number;
  toolCalls: number;
  toolResults: number;
  /** Tổng ước lượng (system + công cụ + tin nhắn). */
  estimated: number;
}

export function contextBreakdown(messages: readonly ChatMessage[], stats: PromptStats | undefined): ContextBreakdown {
  const b: ContextBreakdown = { userText: 0, assistantText: 0, toolCalls: 0, toolResults: 0, estimated: 0 };
  for (const m of messages) {
    for (const blk of m.content) {
      const n = estimateBlockTokens(blk);
      if (blk.type === 'tool_result') b.toolResults += n;
      else if (blk.type === 'tool_use') b.toolCalls += n;
      else if (m.role === 'user') b.userText += n;
      else b.assistantText += n;
    }
  }
  if (stats) {
    b.system = Math.max(0, stats.systemTokens - stats.memoryTokens);
    b.memory = stats.memoryTokens;
    b.tools = stats.toolsTokens;
    b.toolCount = stats.toolCount;
  }
  b.estimated = (stats ? stats.systemTokens + stats.toolsTokens : 0) + b.userText + b.assistantText + b.toolCalls + b.toolResults;
  return b;
}

const fmt = (n: number, lang: Lang) => Math.round(n).toLocaleString(lang === 'vi' ? 'vi-VN' : 'en-US');
const pct = (n: number, total: number) => (total > 0 ? `${Math.round((n / total) * 100)}%` : '—');

/** Bảng markdown cho `/context`. */
export function contextReport(o: {
  lang: Lang;
  ctx: ViewState['context'];
  messages: readonly ChatMessage[];
  stats: PromptStats | undefined;
  meter: SessionMeterView;
}): string {
  const { lang } = o;
  const b = contextBreakdown(o.messages, o.stats);
  const total = b.estimated;
  const lines: string[] = [];
  const ratio = contextRatio(o.ctx);
  lines.push(`**${t(lang, 'sxCtxTitle')}**`);
  if (o.ctx && ratio !== null) lines.push(t(lang, 'sxCtxUsed', { used: fmt(o.ctx.usedTokens, lang), limit: fmt(o.ctx.limitTokens, lang), pct: `${Math.round(ratio * 100)}%` }));
  else lines.push(t(lang, 'sxCtxUnknown'));
  lines.push('');
  lines.push(`| ${t(lang, 'sxCtxPart')} | ${t(lang, 'sxCtxTokens')} | % |`);
  lines.push('|---|---:|---:|');
  const row = (label: string, n: number | undefined) => {
    if (n === undefined) lines.push(`| ${label} | ${t(lang, 'sxCtxNotMeasured')} | |`);
    else lines.push(`| ${label} | ~${fmt(n, lang)} | ${pct(n, total)} |`);
  };
  row(t(lang, 'sxCtxSystem'), b.system);
  row(b.toolCount !== undefined ? t(lang, 'sxCtxToolsN', { n: b.toolCount }) : t(lang, 'sxCtxTools'), b.tools);
  row(t(lang, 'sxCtxMemory'), b.memory);
  row(t(lang, 'sxCtxUser'), b.userText);
  row(t(lang, 'sxCtxAssistant'), b.assistantText);
  row(t(lang, 'sxCtxToolCalls'), b.toolCalls);
  row(t(lang, 'sxCtxToolResults'), b.toolResults);
  lines.push('');
  const notes: string[] = [t(lang, 'sxCtxEstimate')];
  if (!o.stats) notes.push(t(lang, 'sxCtxSendFirst'));
  if (o.meter.compactions > 0) notes.push(t(lang, 'sxCtxCompacted', { n: o.meter.compactions, cleared: o.meter.clearedResults }));
  if (ratio !== null && ratio > 0.6) notes.push(t(lang, 'sxCtxCompactHint'));
  lines.push(notes.join(' '));
  return lines.join('\n');
}

/** Bảng markdown cho `/cost`. */
export function costReport(o: { lang: Lang; meter: SessionMeterView; pricing: ModelInfo['pricing'] | undefined; model: string }): string {
  const { lang, meter } = o;
  const lines = [
    `**${t(lang, 'sxCostTitle')}**`,
    '',
    `- ${t(lang, 'sxCostIn')}: ${fmt(meter.inputTokens, lang)}`,
    `- ${t(lang, 'sxCostOut')}: ${fmt(meter.outputTokens, lang)}`,
  ];
  if (meter.costUsd !== undefined && o.pricing) {
    lines.push(`- ${t(lang, 'sxCostEst')}: **${formatUsd(meter.costUsd)}** — ${t(lang, 'sxCostRate', { model: o.model, in: o.pricing.inputPerM, out: o.pricing.outputPerM })}`);
    lines.push('', t(lang, 'sxCostNote'));
  } else {
    lines.push('', t(lang, 'sxCostNoPrice', { model: o.model }));
  }
  return lines.join('\n');
}
