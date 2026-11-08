import type { CleanupAction, CleanupStatsView } from '../../src/shared/protocol';
import type { I18nKey } from './i18n';

/**
 * (0.7.2) Mô hình thuần của thẻ «Dọn dẹp bộ nhớ» trong Cài đặt: danh sách việc dọn, số ngày mặc định, và dòng số liệu của từng việc.
 * Webview CHỈ gửi `cleanup_run`; hộp xác nhận ghi rõ dung lượng do host hiện (webview không tự xoá được gì).
 */
export interface CleanupRowDef {
  action: CleanupAction;
  /** Có ô nhập số ngày không («cũ hơn N ngày»). */
  days: boolean;
  defaultDays: number;
  label: I18nKey;
  hint: I18nKey;
  button: I18nKey;
}

export const CLEANUP_ROWS: readonly CleanupRowDef[] = [
  { action: 'images', days: true, defaultDays: 30, label: 'cleanup.images', hint: 'cleanup.images.hint', button: 'cleanup.run.images' },
  { action: 'sessions', days: true, defaultDays: 90, label: 'cleanup.sessions', hint: 'cleanup.sessions.hint', button: 'cleanup.run.sessions' },
  { action: 'trash', days: false, defaultDays: 0, label: 'cleanup.trash', hint: 'cleanup.trash.hint', button: 'cleanup.run.trash' },
  { action: 'checkpoints', days: true, defaultDays: 7, label: 'cleanup.checkpoints', hint: 'cleanup.checkpoints.hint', button: 'cleanup.run.checkpoints' },
];

/** Số ngày người dùng gõ → số nguyên 1–3650; rỗng/sai → mặc định. */
export function parseDays(raw: string, fallback: number): number {
  const n = Math.floor(Number(String(raw).trim().replace(',', '.')));
  return Number.isFinite(n) && n >= 1 && n <= 3650 ? n : fallback;
}

/** Số đo hiện cạnh từng việc dọn (null = chưa có số liệu). */
export function rowFigure(action: CleanupAction, s: CleanupStatsView | undefined): { count: number; bytes: number } | null {
  if (!s) return null;
  switch (action) {
    case 'images':
      return s.images;
    case 'sessions':
      return s.sessions;
    case 'trash':
      return s.trash;
    case 'checkpoints':
      return { count: s.checkpoints.sessions, bytes: s.checkpoints.bytes };
  }
}
