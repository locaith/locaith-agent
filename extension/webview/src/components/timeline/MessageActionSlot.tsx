/**
 * (lane:cc-timeline-ui) Ô thao tác ở góc trên-phải của tin người dùng. Hiện chứa nút «Sửa tin nhắn này» (khi có);
 * lane checkpoints-rewind gắn thêm biểu tượng quay lại vào đây — KHÔNG tự làm rewind ở lane này.
 * Mờ khi không rê chuột / không focus (components.css `.user-edit`, timeline-cc.css `.msg-actions`).
 */
import type { ComponentChildren } from 'preact';

export function MessageActionSlot({ children }: { children?: ComponentChildren }) {
  return (
    <span class="msg-actions" data-slot="message-actions">
      {children}
    </span>
  );
}
