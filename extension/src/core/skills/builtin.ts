/**
 * Kỹ năng dựng sẵn. Các tệp SKILL.md ở thư mục `skills/` được esbuild nhúng thẳng vào bundle
 * (loader `.md` → text), nên không phải đọc đĩa lúc chạy.
 */

import artifacts from '../../../skills/artifacts/SKILL.md';
import webResearch from '../../../skills/web-research/SKILL.md';
import softwareEngineering from '../../../skills/software-engineering/SKILL.md';
import vietnameseWriting from '../../../skills/vietnamese-writing/SKILL.md';
import dataAnalysis from '../../../skills/data-analysis/SKILL.md';
import locaithBrand from '../../../skills/locaith-brand/SKILL.md';
import multiAgent from '../../../skills/multi-agent/SKILL.md';
import chromeBridge from '../../../skills/chrome-bridge/SKILL.md';
// Kỹ năng của riêng họ mô hình Locaith (frontmatter `providers: [locaith]`): chỉ hiện với Locaith-v5-flash / Locaith-v5-SI.
import soanThaoNd30 from '../../../skills/soan-thao-van-ban-nd30/SKILL.md';
import ghiNhoMemory from '../../../skills/ghi-nho-memory/SKILL.md';
// Sổ tay làm video của Locaith: dùng được với MỌI model (không gắn `providers`), và được nhắc mặc định cho họ Locaith (prompts/locaith.addendum.md).
import quyTrinhVideo from '../../../skills/quy-trinh-video-locaith/SKILL.md';
// (lane:loop-guards) Kỷ luật khi chạy dài: KHÔNG tự nạp mỗi lượt — model nạp khi cần, các chốt chặn bằng máy đã nằm trong engine.
import kyLuatAgent from '../../../skills/ky-luat-agent/SKILL.md';
// (lane:customer-bugs) Ảnh «Trước → Sau» khi làm giao diện; mở khoá công cụ show_before_after.
import uiTruocSau from '../../../skills/ui-truoc-sau/SKILL.md';
import { skillFromMarkdown, type SkillDef } from './registry';

const RAW: [string, string][] = [
  ['multi-agent', multiAgent],
  ['chrome-bridge', chromeBridge],
  ['artifacts', artifacts],
  ['web-research', webResearch],
  ['software-engineering', softwareEngineering],
  ['vietnamese-writing', vietnameseWriting],
  ['data-analysis', dataAnalysis],
  ['locaith-brand', locaithBrand],
  ['soan-thao-van-ban-nd30', soanThaoNd30],
  ['ghi-nho-memory', ghiNhoMemory],
  ['quy-trinh-video-locaith', quyTrinhVideo],
  ['ky-luat-agent', kyLuatAgent], // (lane:loop-guards)
  ['ui-truoc-sau', uiTruocSau],
];

export function builtinSkills(): SkillDef[] {
  const out: SkillDef[] = [];
  for (const [name, text] of RAW) {
    const def = skillFromMarkdown(text, name, 'builtin');
    if (def) out.push(def);
  }
  return out;
}
