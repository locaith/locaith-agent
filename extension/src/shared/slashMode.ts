/**
 * Phần thuần (không phụ thuộc `vscode`) của lệnh gạch chéo đổi chế độ quyền: bảng bí danh và cách «gấp» chuỗi người dùng gõ.
 * `isBypassSlash` dùng ở cổng Remote để `/mode bypass` trong nội dung một tin `send` không vòng qua chốt `remote.allowBypass` (lệnh `set_mode` đã bị `parseCommand` chặn,
 * nhưng lệnh gạch chéo đi thẳng tới `setMode`, nơi chỉ kiểm cài đặt cục bộ).
 */

import type { PermissionMode } from './protocol';

/** Bỏ dấu, hạ chữ thường, chỉ giữ chữ-số: «Bỏ-Qua», «by pass» → gần như nhau khi so khớp. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export const MODE_ALIASES: Record<string, PermissionMode> = {
  default: 'default',
  hoi: 'default',
  ask: 'default',
  acceptedits: 'acceptEdits',
  accept: 'acceptEdits',
  nhan: 'acceptEdits',
  plan: 'plan',
  'ke-hoach': 'plan',
  kehoach: 'plan',
  bypass: 'bypass',
};

/** `/mode bypass` (kể cả viết hoa, thừa khoảng trắng hay có dấu) trong nội dung một tin — cùng cách `handleSlash` hiểu lệnh. */
export function isBypassSlash(text: unknown): boolean {
  const t = String(text ?? '').trim();
  if (!t.startsWith('/')) return false;
  const [cmd = '', ...rest] = t.slice(1).split(/\s+/);
  return cmd.toLowerCase() === 'mode' && MODE_ALIASES[fold(rest.join(' '))] === 'bypass';
}

/**
 * Lệnh gạch chéo đổi QUYỀN / thực thi (lane:perm-rules, hooks, commands-agents) — chỉ gõ được ngay tại VS Code. Qua Remote (nội dung một tin `send`) chúng
 * thành đường vòng quanh các chốt mà lệnh Remote chính thức không có: thêm luật `allow`, «tin» luật allow của workspace hoặc hook của dự án (hook chạy
 * lệnh shell), tạo tệp agent. Cùng tinh thần với `isBypassSlash`.
 */
export function isLocalOnlySlash(text: unknown): boolean {
  const t = String(text ?? '').trim();
  if (!t.startsWith('/')) return false;
  const [cmd = '', verb = ''] = t.slice(1).split(/\s+/);
  const c = cmd.toLowerCase();
  const v = verb.toLowerCase();
  if (c === 'permissions') return ['allow', 'ask', 'deny', 'remove', 'rm', 'xoa', 'xoá', 'trust', 'tin'].includes(v);
  if (c === 'hooks') return ['open', 'trust'].includes(v);
  if (c === 'agents') return ['new', 'tao', 'create'].includes(v);
  return false;
}
