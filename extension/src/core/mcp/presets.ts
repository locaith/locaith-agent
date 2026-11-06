/** Thư viện MCP dựng sẵn: bấm "Thêm" là ghi cấu hình vào cài đặt người dùng. Chỉ gồm gói phổ biến, chạy qua npx. */

import type { McpServerConfig } from './client';

export interface McpPreset {
  id: string;
  name: string;
  description: string;
  /** `${workspaceFolder}` được thay bằng thư mục workspace đầu tiên khi thêm. */
  config: McpServerConfig;
  needsWorkspace?: boolean;
}

export const MCP_PRESETS: McpPreset[] = [
  {
    id: 'filesystem',
    name: 'filesystem',
    description: 'Đọc/ghi tệp trong thư mục workspace qua MCP (server tham chiếu chính thức).',
    config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '${workspaceFolder}'] },
    needsWorkspace: true,
  },
  {
    id: 'memory',
    name: 'memory',
    description: 'Bộ nhớ dài hạn dạng đồ thị tri thức, lưu giữa các cuộc trò chuyện.',
    config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
  },
  {
    id: 'sequential-thinking',
    name: 'sequential-thinking',
    description: 'Công cụ suy luận từng bước có thể sửa/rẽ nhánh cho bài toán phức tạp.',
    config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
  },
  {
    id: 'playwright',
    name: 'playwright',
    description: 'Điều khiển trình duyệt thật bằng Playwright (mở trang, bấm, chụp ảnh, kiểm thử web).',
    config: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
  },
  {
    id: 'context7',
    name: 'context7',
    description: 'Tra tài liệu thư viện/framework mới nhất (Context7) ngay trong cuộc trò chuyện.',
    config: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
  },
];

export function presetConfig(p: McpPreset, workspaceFolder: string | undefined): McpServerConfig | null {
  if (p.needsWorkspace && !workspaceFolder) return null;
  return { ...p.config, args: (p.config.args ?? []).map((a) => a.split('${workspaceFolder}').join(workspaceFolder ?? '')) };
}
