/**
 * (lane:sessions-ux) Số đo phần "cố định" của ngữ cảnh ở lần gọi model gần nhất: system prompt, định nghĩa công cụ, khối ký ức.
 * Engine ghi lại MỘT dòng mỗi vòng (xem engine.ts, tìm `recordPromptStats`); lệnh `/context` đọc để chia nhỏ ngữ cảnh.
 * Giữ trong WeakMap theo đối tượng phiên: không lưu xuống đĩa, không rò bộ nhớ khi phiên bị thay.
 * Chỉ là ƯỚC LƯỢNG (estimateTokens), không phải số hãng báo.
 */

import type { ToolSpec } from '../types';
import type { SessionState } from './types';
import { estimateTokens } from './tokens';

export interface PromptStats {
  systemTokens: number;
  toolsTokens: number;
  toolCount: number;
  /** Phần ký ức nằm TRONG system prompt (đã tính trong systemTokens). */
  memoryTokens: number;
  at: number;
}

const stats = new WeakMap<SessionState, PromptStats>();

export function recordPromptStats(session: SessionState, system: string, specs: readonly ToolSpec[], memory: string | null | undefined): void {
  try {
    let tools = 0;
    for (const s of specs) tools += estimateTokens(s.name) + estimateTokens(s.description) + estimateTokens(JSON.stringify(s.inputSchema ?? {})) + 8;
    stats.set(session, {
      systemTokens: estimateTokens(system),
      toolsTokens: tools,
      toolCount: specs.length,
      memoryTokens: memory ? estimateTokens(memory) : 0,
      at: Date.now(),
    });
  } catch {
    /* chỉ là số đo hiển thị — không bao giờ làm hỏng lần chạy */
  }
}

export function getPromptStats(session: SessionState): PromptStats | undefined {
  return stats.get(session);
}
