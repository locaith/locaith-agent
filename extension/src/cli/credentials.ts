/**
 * Khoá tài khoản của CLI: biến môi trường `LOCAITH_API_KEY` (khuyến nghị cho máy chủ/CI) hoặc tệp `~/.locaith/cli.json` (quyền 600).
 * Không bao giờ in nguyên khoá; không truyền khoá qua dòng lệnh.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.LOCAITH_HOME?.trim() || os.homedir();
}

export function configFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(homeDir(env), '.locaith', 'cli.json');
}

export function readApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = (env.LOCAITH_API_KEY ?? env.LOCAITH_TOKEN ?? '').trim();
  if (fromEnv) return fromEnv;
  try {
    const j = JSON.parse(readFileSync(configFile(env), 'utf8')) as { apiKey?: unknown };
    return typeof j.apiKey === 'string' && j.apiKey.trim() ? j.apiKey.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Ghi khoá nguyên tử (tệp tạm + rename), quyền 600. Trả đường dẫn tệp. */
export function writeApiKey(key: string, env: NodeJS.ProcessEnv = process.env): string {
  const file = configFile(env);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ apiKey: key }, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* Windows: bỏ qua */
  }
  renameSync(tmp, file);
  return file;
}

/** Xoá khoá đã lưu (đăng xuất cục bộ). Trả true nếu có tệp để xoá. */
export function removeApiKey(env: NodeJS.ProcessEnv = process.env): boolean {
  const file = configFile(env);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

/** `lat_ab12…` + độ dài — đủ để người dùng nhận ra mà không lộ khoá. */
export function maskKey(key: string): string {
  return `${key.slice(0, 6)}… (${key.length})`;
}

/** Khoá của hãng khác (BYOK) có trong môi trường không — chỉ để quyết định có cần đăng nhập Locaith hay không. */
export function hasByokKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'DEEPSEEK_API_KEY', 'XAI_API_KEY', 'OPENROUTER_API_KEY'].some((k) => (env[k] ?? '').trim().length > 0);
}
