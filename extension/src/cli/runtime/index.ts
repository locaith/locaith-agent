/**
 * Lõi chạy của Locaith CLI (không giao diện). Điểm vào duy nhất: `createRuntime(opts)` → `CliRuntime` (xem contract.ts, README.md).
 */

import type { CliRuntime, RuntimeOptions } from './contract';
import { Runtime, closeDispatcher } from './runtime';

export type * from './contract';
export { NotLoggedInError, cliConfigFile, clearLocaithKey, readLocaithKey, writeLocaithKey } from './auth';
export { isDirTrusted, trustDir, untrustDir } from './trust';
export { closeDispatcher };

/**
 * Dựng lõi chạy. Không gọi mạng khi khởi tạo (tài khoản/nhánh git làm mới ở nền).
 * Ném `NotLoggedInError` khi không có khoá nào dùng được (không Locaith, không hãng khác) và không có `providerOverride`.
 */
export async function createRuntime(opts: RuntimeOptions): Promise<CliRuntime> {
  const rt = new Runtime(opts);
  try {
    await rt.init();
  } catch (err) {
    await rt.dispose(true).catch(() => undefined);
    throw err;
  }
  return rt;
}
