/**
 * Hiển thị TRUNG THỰC một server MCP ở chỗ người dùng quyết định cho nó chạy (server của dự án / plugin chỉ chạy sau khi được duyệt).
 *
 * Trước đây dòng lệnh bị cắt cứng ở 200 (extension) / 300 (CLI) ký tự mà không báo, `args` nối bằng dấu cách (không thấy ranh giới đối số), còn `cwd`
 * và `env` — cũng nằm trong dấu vân tay được duyệt, và `NODE_OPTIONS=--require …` đủ để chạy mã khác — không hiện ở đâu cả. Một `.mcp.json` độc hại chỉ cần
 * đẩy phần nguy hiểm ra sau ký tự thứ 200 là người duyệt không thấy gì. Giờ: lệnh đầy đủ (trần 4.000 ký tự, cắt thì có dấu hiệu NHÌN THẤY ĐƯỢC), đối số có
 * khoảng trắng/dấu nháy được bọc ngoặc kép, ký tự vô hình/đổi chiều chữ bị phơi ra (⟦U+202E⟧), và các dòng phụ cho cwd / biến môi trường / tên header.
 */

import { describeCommand } from '../../shared/commandView';
import type { McpServerConfig } from './client';

export const MAX_SERVER_VIEW_CHARS = 4000;

/** Tên biến/header trông như bí mật: giá trị hiện «•••» (tên vẫn hiện, để biết server nhận thứ gì). */
const SECRET_NAME = /(token|secret|passw|pwd|api[_-]?key|\bkey\b|auth|credential|cookie|bearer|private)/i;
/** Đối số «sạch»: không cần bọc ngoặc kép (không khoảng trắng, nháy, ký tự điều khiển). */
const PLAIN_TOKEN = /^[\w@%+=:,./\\~-]+$/;

const exposed = (s: string): string => describeCommand(s).text;

/** Bọc ngoặc kép để HIỂN THỊ: chỉ thoát dấu nháy kép và xuống dòng/tab (không nhân đôi dấu `\` — đường dẫn Windows phải đọc ra đúng như cũ). */
const doubleQuoted = (v: string): string => `"${v.replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`;

/** Một token của dòng lệnh: giữ nguyên nếu sạch, còn lại bọc ngoặc kép (thoát xuống dòng, dấu nháy) và phơi ký tự ẩn — thấy đúng ranh giới từng đối số. */
export function quoteToken(s: string): string {
  const v = exposed(s);
  return v.length > 0 && v === s && PLAIN_TOKEN.test(v) ? v : doubleQuoted(v);
}

export interface ServerApprovalView {
  /** Dòng lệnh (stdio) hoặc địa chỉ (http): đầy đủ tới `MAX_SERVER_VIEW_CHARS`; cắt thì có dấu hiệu nhìn thấy được ở cuối. */
  command: string;
  /** Dòng phụ: cwd, biến môi trường (giá trị bí mật bị che), tên header. Rỗng nếu server không đặt gì. */
  extra: string[];
  /** `command` hoặc `extra` đã bị cắt vì quá dài. */
  truncated: boolean;
}

export function describeServerForApproval(cfg: McpServerConfig, max: number = MAX_SERVER_VIEW_CHARS, maskEnv: readonly string[] = []): ServerApprovalView {
  let truncated = false;
  const cut = (s: string): string => {
    if (s.length <= max) return s;
    truncated = true;
    return `${s.slice(0, max)} … (+${s.length - max} ký tự nữa / more chars — mở tệp cấu hình / open the config file)`;
  };

  let command: string;
  if (cfg.url) {
    const u = exposed(cfg.url);
    command = cut(/\s/.test(u) ? doubleQuoted(u) : u);
  } else {
    const parts = [cfg.command, ...(cfg.args ?? [])].filter((x): x is string => typeof x === 'string').map(quoteToken);
    command = cut(parts.join(' '));
  }

  const extra: string[] = [];
  if (cfg.cwd) extra.push(cut(`cwd: ${quoteToken(cfg.cwd)}`));
  const env = Object.entries(cfg.env ?? {});
  if (env.length) {
    extra.push(cut(`env: ${env.map(([k, v]) => `${exposed(k)}=${SECRET_NAME.test(k) || maskEnv.includes(k) ? '•••' : quoteToken(String(v))}`).join(' ')}`));
  }
  const headers = Object.keys(cfg.headers ?? {});
  if (headers.length) extra.push(cut(`headers: ${headers.map((h) => exposed(h)).join(', ')} (giá trị ẩn)`));
  return { command, extra, truncated };
}
