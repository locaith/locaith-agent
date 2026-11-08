/**
 * Danh sách mô-đun tính năng của Locaith CLI (hooks, checkpoints/rewind, tác vụ nền, MCP, kỹ năng, lệnh tuỳ chỉnh, agent,
 * ký ức, kiểm chứng độc lập, luật quyền, phong cách đầu ra, rà soát…).
 *
 * LANE `cli-features` SỞ HỮU tệp này (lane `cli-rt` chỉ gọi `defaultFeatures()`, không sửa).
 * Mỗi mô-đun nằm trong một tệp riêng cùng thư mục và export một `FeatureModule` (xem ../contract.ts).
 *
 * Thứ tự gắn = thứ tự gọi RunExtension: luật quyền trước (chặn sớm), rồi hooks, checkpoints, tác vụ nền; `verify` đăng ký `last:true` nên luôn cuối.
 */

import type { FeatureModule } from '../contract';
import { agentsFeature } from './agents';
import { bgTasksFeature } from './bgTasks';
import { checkpointsFeature } from './checkpoints';
import { commandsFeature } from './commands';
import { hooksFeature } from './hooks';
import { mcpFeature } from './mcp';
import { memoryFeature } from './memory';
import { permissionsFeature } from './permissions';
import { pluginsFeature } from './plugins';
import { reviewFeature } from './review';
import { skillsFeature } from './skills';
import { verifyFeature } from './verify';

export function defaultFeatures(): FeatureModule[] {
  return [
    pluginsFeature, // trước skills/agents/commands/mcp: các mô-đun đó nghe sự kiện bật/tắt plugin
    permissionsFeature,
    hooksFeature,
    checkpointsFeature,
    bgTasksFeature,
    mcpFeature,
    skillsFeature,
    agentsFeature,
    commandsFeature,
    memoryFeature,
    reviewFeature,
    verifyFeature,
  ];
}

export {
  agentsFeature,
  bgTasksFeature,
  checkpointsFeature,
  commandsFeature,
  hooksFeature,
  mcpFeature,
  memoryFeature,
  permissionsFeature,
  pluginsFeature,
  reviewFeature,
  skillsFeature,
  verifyFeature,
};
export type { FeatureContextExt } from './ext';
