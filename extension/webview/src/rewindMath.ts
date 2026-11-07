/** (lane:checkpoints-rewind) Phần tính toán thuần của giao diện Quay lại (tách khỏi component để kiểm thử không cần DOM). */
import type { CheckpointTurn } from '../../src/shared/checkpoints';

/** Số tệp (rel) khác nhau mà các lượt từ `promptId` về sau đã sửa — số tệp «Khôi phục mã» sẽ chạm tới. */
export function filesFrom(checkpoints: readonly CheckpointTurn[], promptId: string): number {
  const i = checkpoints.findIndex((c) => c.promptId === promptId);
  if (i < 0) return 0;
  const seen = new Set<string>();
  for (const c of checkpoints.slice(i)) for (const f of c.files) seen.add(f.rel);
  return seen.size;
}
