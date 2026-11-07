import { createAgentTools } from '../agents/tools';
import type { AgentServices } from '../agents/runner';
import { createChromeTool, type ChromeCaller } from '../chrome/tools';
import type { SkillRegistry } from '../skills/registry';
import { ToolRegistry } from '../engine/toolRegistry';
import type { ToolHost } from '../engine/types';
import { showBeforeAfterTool } from './beforeAfter';
import { createArtifactTool, listArtifactTypesTool, updateArtifactTool } from './artifact';
import { editFileTool, globTool, grepTool, listDirTool, readFileTool, writeFileTool } from './fs';
import { createSkillTools, exitPlanModeTool, offerOptionsTool, rememberTool, scratchpadTool, todoWriteTool, type MarketSearch } from './meta';
import { createTerminalTool } from './terminal';
import { fetchUrlTool, webSearchTool } from './web/web';

export interface ToolRegistryOptions {
  skills: SkillRegistry;
  host: ToolHost;
  /** Có = đăng ký `agent` và `workflow_run` (ẩn). Bản trình duyệt không truyền. */
  agents?: Omit<AgentServices, 'registry'>;
  /** Tìm trong Chợ kỹ năng để `search_skills` gợi ý kỹ năng chưa thêm. */
  market?: MarketSearch;
  /** Cầu nối tới Chrome của người dùng (chỉ bản VS Code). Có = đăng ký công cụ `chrome` (ẩn, mở bằng kỹ năng chrome-bridge). */
  chrome?: ChromeCaller;
  /** Nhà cung cấp của phiên hiện tại: để danh mục `load_skill` chỉ liệt kê kỹ năng dùng được với họ mô hình đó (xem SkillDef.providers). */
  currentProvider?: () => string | undefined;
}

/** Thứ tự đăng ký = thứ tự công cụ gửi cho model (giữ ổn định để tận dụng prompt-cache). */
export function createToolRegistry(opts: ToolRegistryOptions): ToolRegistry {
  const r = new ToolRegistry();
  const [loadSkill, searchSkills] = createSkillTools(opts.skills, opts.market, opts.currentProvider);
  r.register(todoWriteTool)
    .register(offerOptionsTool)
    .register(rememberTool)
    .register(loadSkill)
    .register(searchSkills)
    .register(webSearchTool)
    .register(fetchUrlTool)
    .register(readFileTool)
    .register(listDirTool)
    .register(globTool)
    .register(grepTool)
    .register(editFileTool)
    .register(writeFileTool)
    .register(createTerminalTool(opts.host))
    .register(scratchpadTool)
    .register(exitPlanModeTool);
  // Agent con: `agent` luôn có; `workflow_run` ẩn cho tới khi kỹ năng `multi-agent` được nạp.
  if (opts.agents) for (const t of createAgentTools({ ...opts.agents, registry: () => r })) r.register(t);
  if (opts.chrome) r.register(createChromeTool(opts.chrome) as never);
  // Công cụ ẩn: chỉ mở khi kỹ năng `artifacts` được nạp.
  r.register(listArtifactTypesTool).register(createArtifactTool).register(updateArtifactTool);
  // (lane:customer-bugs) Công cụ ẩn: chỉ mở khi kỹ năng `ui-truoc-sau` được nạp.
  r.register(showBeforeAfterTool);
  return r;
}

export * from './artifact';
export * from './beforeAfter';
export * from './fs';
export * from './meta';
export * from './terminal';
export * from './web/web';
