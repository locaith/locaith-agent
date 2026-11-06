/**
 * Nạp tệp hướng dẫn dự án (LOCAITH.md, AGENTS.md…) từ thư mục gốc workspace.
 * Tách riêng khỏi context.ts vì phần này phụ thuộc hệ thống tệp (Node): bản trình duyệt không có workspace và không nạp module này.
 */

import * as path from 'node:path';
import { isSecretFile, resolveUserPathReal } from '../fsutil/paths';
import type { ToolHost } from './types';

/** Tìm tệp hướng dẫn dự án đầu tiên có trong thư mục gốc workspace. */
export async function loadProjectInstructions(
  host: ToolHost,
  names: string[],
  maxChars = 20_000,
): Promise<{ file: string; text: string } | null> {
  const root = host.workspaceRoots()[0];
  if (!root) return null;
  for (const name of names) {
    if (typeof name !== 'string' || !name.trim() || name.length > 300) continue;
    // Nội dung tệp này đi thẳng vào system prompt gửi cho nhà cung cấp: chỉ nhận tệp THẬT SỰ nằm trong workspace
    // (kể cả sau khi theo liên kết) và không phải tệp chứa bí mật — `../../.ssh/id_rsa` hay `.env` bị bỏ qua.
    const r = await resolveUserPathReal(host, path.join(root, name));
    if (r.zone !== 'workspace' || r.suspicious || isSecretFile(r.abs) || isSecretFile(r.real)) continue;
    let text: string | null = null;
    try {
      text = await host.readText(r.abs);
    } catch {
      continue; // không phải UTF-8: bỏ qua, không nạp chữ vỡ vào system prompt
    }
    if (text && text.trim()) {
      return { file: name, text: text.length > maxChars ? text.slice(0, maxChars) + '\n[… đã cắt bớt]' : text };
    }
  }
  return null;
}
