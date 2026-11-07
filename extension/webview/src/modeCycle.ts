/**
 * (lane:perm-rules) Shift+Tab trong ô nhập xoay vòng chế độ quyền như Claude Code: default → acceptEdits → plan → default.
 * `bypass` KHÔNG nằm trong vòng (phải chọn chủ ý qua bộ chọn + hộp xác nhận); đang ở bypass thì Shift+Tab đưa về default.
 */

import type { PermissionMode } from '../../src/shared/protocol';

export const MODE_CYCLE: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan'];

export function nextMode(current: PermissionMode): PermissionMode {
  const i = MODE_CYCLE.indexOf(current);
  if (i < 0) return 'default';
  return MODE_CYCLE[(i + 1) % MODE_CYCLE.length];
}

/** Phím tắt đổi chế độ: Shift+Tab, không kèm Ctrl/Alt/Meta, chỉ khi không có menu @/ / đang mở. */
export function isModeCycleKey(e: { key: string; shiftKey: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }): boolean {
  return e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
}
