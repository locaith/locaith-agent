/**
 * Khoá tài khoản Locaith của CLI: `LOCAITH_API_KEY` (hoặc `LOCAITH_TOKEN`) → `~/.locaith/cli.json` (quyền 600).
 * Giữ NGUYÊN cơ chế của CLI 0.3.x (tệp, tên trường `apiKey`) để `locaith login` cũ và mới dùng chung.
 * Không bao giờ in khoá ra log/màn hình.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isPlainObject, readJsonFile, writeFileAtomic } from './util';

export function cliConfigFile(home: string): string {
  return path.join(home, '.locaith', 'cli.json');
}

/** Khoá Locaith đang dùng được (env trước, tệp sau). */
export function readLocaithKey(home: string, env: NodeJS.ProcessEnv): string | undefined {
  const e = (env.LOCAITH_API_KEY ?? env.LOCAITH_TOKEN ?? '').trim();
  if (e) return e;
  const j = readJsonFile<{ apiKey?: unknown }>(cliConfigFile(home));
  return typeof j?.apiKey === 'string' && j.apiKey.trim() ? j.apiKey.trim() : undefined;
}

/** Khoá có đến từ biến môi trường (không xoá được bằng /logout)? */
export function locaithKeyFromEnv(env: NodeJS.ProcessEnv): boolean {
  return !!(env.LOCAITH_API_KEY ?? env.LOCAITH_TOKEN ?? '').trim();
}

/** Ghi khoá vào tệp cấu hình (giữ các trường khác nếu có). Trả đường dẫn tệp. */
export function writeLocaithKey(home: string, key: string): string {
  const file = cliConfigFile(home);
  const cur = readJsonFile<unknown>(file);
  const base = isPlainObject(cur) ? cur : {};
  writeFileAtomic(file, `${JSON.stringify({ ...base, apiKey: key.trim() }, null, 2)}\n`, 0o600);
  return file;
}

/** Xoá khoá khỏi tệp (đăng xuất). Trả true nếu đã có khoá để xoá. */
export function clearLocaithKey(home: string): boolean {
  const file = cliConfigFile(home);
  const cur = readJsonFile<unknown>(file);
  if (!isPlainObject(cur) || typeof cur.apiKey !== 'string') return false;
  const { apiKey: _drop, ...rest } = cur;
  if (Object.keys(rest).length === 0) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      writeFileAtomic(file, '{}\n', 0o600);
    }
  } else writeFileAtomic(file, `${JSON.stringify(rest, null, 2)}\n`, 0o600);
  return true;
}

/** Chưa có khoá nào dùng được (không Locaith, không hãng khác). Thông điệp hướng dẫn vi/en. */
export class NotLoggedInError extends Error {
  readonly code = 'not_logged_in';
  readonly vi: string;
  readonly en: string;

  constructor(lang: 'vi' | 'en' = 'vi', detail?: { configFile?: string }) {
    const file = detail?.configFile ?? '~/.locaith/cli.json';
    const vi = `Chưa đăng nhập Locaith. Chạy \`locaith login\` (mở trình duyệt, bấm «Cho phép»), hoặc đặt biến môi trường LOCAITH_API_KEY / ghi { "apiKey": "lat_…" } vào ${file}. Muốn dùng khoá hãng khác: đặt ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY hoặc XAI_API_KEY.`;
    const en = `Not logged in to Locaith. Run \`locaith login\` (opens the browser, click “Allow”), or set LOCAITH_API_KEY / write { "apiKey": "lat_…" } to ${file}. To use another vendor's key set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY or XAI_API_KEY.`;
    super(lang === 'en' ? en : vi);
    this.name = 'NotLoggedInError';
    this.vi = vi;
    this.en = en;
  }
}
