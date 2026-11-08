/**
 * Danh sách mô-đun tính năng của Locaith CLI (hooks, checkpoints/rewind, tác vụ nền, MCP, kỹ năng, lệnh tuỳ chỉnh, agent,
 * ký ức, kiểm chứng độc lập, luật quyền, phong cách đầu ra, các lệnh gạch chéo dựng sẵn…).
 *
 * LANE `cli-features` SỞ HỮU tệp này (lane `cli-rt` chỉ gọi `defaultFeatures()`, không sửa).
 * Mỗi mô-đun nằm trong một tệp riêng cùng thư mục và export một `FeatureModule` (xem ../contract.ts).
 */

import type { FeatureModule } from '../contract';

export function defaultFeatures(): FeatureModule[] {
  return [];
}
