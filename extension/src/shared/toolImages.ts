/**
 * Ảnh do công cụ gửi lên giao diện (lane:customer-bugs): khoá để Remote xin ảnh đầy đủ bằng `get_image`, và tra ảnh trong transcript đang mở.
 * Thuần tuý, không import 'vscode' / 'node:*'.
 */
import { imageKey } from './transcriptRebuild';
import type { ToolImage, TItem } from './protocol';

/** Tối đa bấy nhiêu khoá cho mỗi khối công cụ (khớp trần 4 ảnh của dispatcher). */
export const MAX_TOOL_IMAGE_KEYS = 4;

export function toolImageKeys(images: readonly ToolImage[] | undefined): string[] {
  return (images ?? [])
    .filter((i) => i && typeof i.data === 'string' && i.data.length > 0)
    .slice(0, MAX_TOOL_IMAGE_KEYS)
    .map((i) => imageKey(i.data));
}

/** Tìm trong transcript đang mở ảnh của một khối công cụ theo khoá (ảnh của công cụ chỉ nằm ở đây, không nằm trong lịch sử gửi model). */
export function findToolImage(transcript: readonly TItem[], key: string): ToolImage | undefined {
  if (!key) return undefined;
  for (const it of transcript) {
    if (it.kind !== 'assistant') continue;
    for (const b of it.blocks) {
      if (b.type !== 'tool' || !b.images) continue;
      for (const im of b.images) if (im && typeof im.data === 'string' && imageKey(im.data) === key) return im;
    }
  }
  return undefined;
}
