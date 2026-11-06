/** Giữ tệp đính kèm qua lần ẩn/hiện webview (chuyển tab, đổi sidebar): thuần tuý, có ngân sách để không phình trạng thái. */

import type { AttachmentInfo } from '../../src/shared/protocol';

/** Tổng ký tự JSON tối đa cho phần đính kèm trong trạng thái webview (~15 MB). Vượt thì bỏ bớt tệp CŨ NHẤT và báo. */
export const ATTACH_STATE_BUDGET = 15_000_000;

export interface KeptAttachments {
  kept: AttachmentInfo[];
  /** Số tệp bị bỏ vì quá lớn (cũ nhất trước) — giao diện báo cho người dùng biết. */
  dropped: number;
}

/**
 * Toàn bộ tệp đính kèm (ảnh, tài liệu, vùng chọn, tab) được giữ nguyên — ảnh gồm cả dữ liệu và bản thu nhỏ.
 * Chỉ khi vượt ngân sách mới bỏ bớt, và bỏ từ tệp CŨ NHẤT để tệp vừa thêm vẫn còn.
 */
export function persistableAttachments(list: readonly AttachmentInfo[], budget = ATTACH_STATE_BUDGET): KeptAttachments {
  const kept: AttachmentInfo[] = [];
  let used = 0;
  let dropped = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i];
    let size: number;
    try {
      size = JSON.stringify(a).length;
    } catch {
      size = 0;
    }
    if (used + size > budget) {
      dropped++;
      continue;
    }
    used += size;
    kept.unshift(a);
  }
  return { kept, dropped };
}
