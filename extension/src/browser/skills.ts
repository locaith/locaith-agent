/**
 * Kỹ năng dựng sẵn của bản trình duyệt: bỏ `software-engineering` (làm việc trên mã nguồn trong workspace), thêm `browser-control`,
 * và chỉnh các đoạn nhắc tới công cụ chỉ có ở VS Code (run_command…).
 */

import artifacts from '../../skills/artifacts/SKILL.md';
import browserControl from '../../skills/browser-control/SKILL.md';
import dataAnalysis from '../../skills/data-analysis/SKILL.md';
import locaithBrand from '../../skills/locaith-brand/SKILL.md';
import vietnameseWriting from '../../skills/vietnamese-writing/SKILL.md';
import webResearch from '../../skills/web-research/SKILL.md';
import { skillFromMarkdown, type SkillDef } from '../core/skills/registry';

const RAW: [string, string][] = [
  ['artifacts', artifacts],
  ['web-research', webResearch],
  ['browser-control', browserControl],
  ['vietnamese-writing', vietnameseWriting],
  ['data-analysis', dataAnalysis],
  ['locaith-brand', locaithBrand],
];

/** Bản trình duyệt không có công cụ chạy mã: thay lời khuyên "dùng run_command" bằng cách làm khả dụng. */
const NO_CODE_TOOL =
  '- **Không tính nhẩm số liệu quan trọng.** Trình duyệt không có công cụ chạy mã: tính từng bước và ghi vào `scratchpad`, kiểm tra chéo bằng một cách tính khác, hoặc dựng artifact HTML có JavaScript tự tính ngay trên màn hình để người dùng kiểm chứng.';

export function browserSkills(): SkillDef[] {
  const out: SkillDef[] = [];
  for (const [name, text] of RAW) {
    const def = skillFromMarkdown(text, name, 'builtin');
    if (!def) continue;
    if (def.name === 'data-analysis') def.body = def.body.replace(/^- \*\*Không tính nhẩm[^\n]*$/m, NO_CODE_TOOL);
    out.push(def);
  }
  return out;
}
