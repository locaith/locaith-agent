import { ToolRegistry } from '../../core/engine/toolRegistry';
import type { ToolDef } from '../../core/engine/types';
import type { SkillRegistry } from '../../core/skills/registry';
import { createArtifactTool, listArtifactTypesTool, updateArtifactTool } from '../../core/tools/artifact';
import { createSkillTools, exitPlanModeTool, scratchpadTool, todoWriteTool } from '../../core/tools/meta';
import type { PresenceKind } from '../presence';
import { createActionTools, createReadTools, type BrowserToolDeps } from './browserTools';
import { browserFetchUrlTool, browserWebSearchTool } from './webTools';

/** Công cụ nào chỉ ĐỌC trang, công cụ nào ĐIỀU KHIỂN trang — để viền sáng hiện đúng chữ ("đang đọc" / "đang điều khiển"). tab_open tự báo vì tab chỉ có sau khi mở. */
const PRESENCE_KIND: Record<string, PresenceKind> = {
  page_read: 'read',
  page_snapshot: 'read',
  page_screenshot: 'read',
  page_find: 'read',
  page_click: 'act',
  page_type: 'act',
  page_select: 'act',
  page_press_key: 'act',
  page_scroll: 'act',
  page_hover: 'act',
  page_wait: 'act',
  page_navigate: 'act',
};

/**
 * Chụp màn hình báo SAU khi chụp xong: viền sáng bị ẩn lúc chụp (ảnh gửi cho mô hình là trang sạch), nên không được để lệnh "hiện" của chính lần chụp này
 * chạy đua với lệnh ẩn — tab chưa có lớp phủ thì không có gì để ẩn, và lệnh hiện đến muộn sẽ vẽ lớp phủ lên đúng khung hình đang được chụp.
 */
const TOUCH_AFTER = new Set(['page_screenshot']);

/** Khi một công cụ trang THẬT SỰ chạy (đã qua kiểm tra + xin phép), báo cho người dùng biết tab đích đang được trợ lý làm việc. */
function withPresence(d: BrowserToolDeps, tool: ToolDef): ToolDef {
  const kind = PRESENCE_KIND[tool.name];
  if (!kind || !d.presence) return tool;
  const execute = tool.execute.bind(tool);
  const after = TOUCH_AFTER.has(tool.name);
  return {
    ...tool,
    async execute(input, ctx) {
      const id = (input as { tab_id?: number } | null)?.tab_id ?? d.scope.currentTabId;
      if (id !== undefined && !after) d.presence?.touch(id, kind);
      const res = await execute(input, ctx);
      // Chụp không được (tab nền…) thì chưa đọc gì: không hiện viền sáng.
      if (id !== undefined && after && !res.isError) d.presence?.touch(id, kind);
      return res;
    },
  };
}

/** Thứ tự đăng ký = thứ tự công cụ gửi cho model (giữ ổn định để tận dụng prompt-cache). */
export function createBrowserToolRegistry(opts: { skills: SkillRegistry } & BrowserToolDeps): ToolRegistry {
  const r = new ToolRegistry();
  const [loadSkill, searchSkills] = createSkillTools(opts.skills);
  r.register(todoWriteTool).register(loadSkill).register(searchSkills).register(browserWebSearchTool).register(browserFetchUrlTool);
  for (const t of createReadTools(opts)) r.register(withPresence(opts, t));
  r.register(scratchpadTool).register(exitPlanModeTool);
  // Công cụ thao tác lên trang: ẩn cho tới khi kỹ năng `browser-control` được nạp (tiết kiệm token + buộc đọc quy tắc an toàn trước).
  for (const t of createActionTools(opts)) r.register(withPresence(opts, t));
  // Công cụ artifact: ẩn cho tới khi kỹ năng `artifacts` được nạp.
  r.register(listArtifactTypesTool).register(createArtifactTool).register(updateArtifactTool);
  return r;
}
