/** Việc đang làm của lệnh mới nhất trên dòng tóm tắt «N lệnh gọi công cụ» — thuần túy (không JSX) để test được. */
import type { ToolBlock } from '../../../../src/shared/protocol';
import type { Lang } from '../../format';
import { describeTool } from '../../toolLabels';

/** «Đang đọc a.ts…» hoặc «Đang tìm kiếm trên web: truy vấn». */
export function latestLabel(lang: Lang, b: ToolBlock | undefined): string {
  if (!b) return '';
  const d = describeTool(lang, b.name, b.args, b.state);
  // Nhãn của công cụ tệp/URL đã nêu đích («Đang đọc a.ts…») → không lặp lại đường dẫn dài; truy vấn/lệnh thì cần thêm để biết đang làm gì.
  if (!d.detail || d.detailKind === 'path' || d.detailKind === 'url') return d.label;
  return `${d.label.replace(/…$/, '')}: ${d.detail}`;
}
