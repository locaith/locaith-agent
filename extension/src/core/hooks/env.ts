/**
 * Môi trường của tiến trình hook: DANH SÁCH CHO PHÉP, không phải danh sách cấm.
 *
 * Hook chạy với quyền người dùng nhưng có thể do một kho mã lạ viết ra (đã được người dùng xác nhận) — khoá API của nhà cung cấp
 * đang nằm trong môi trường của VS Code không được rơi vào tay nó. Chỉ những biến cần để chạy chương trình thông thường được chép sang;
 * muốn thêm biến nào, người dùng khai báo tên ở `locaithAgent.hooksPassEnv` hoặc khai giá trị ở `env` của chính hook.
 */

import type { HookEntry } from './types';

const ALLOW_EXACT = new Set(
  [
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'TEMP', 'TMP', 'TMPDIR',
    'LANG', 'LANGUAGE', 'SHELL', 'USER', 'USERNAME', 'LOGNAME', 'USERDOMAIN', 'COMPUTERNAME', 'TZ', 'OS', 'PROCESSOR_ARCHITECTURE',
    'NUMBER_OF_PROCESSORS', 'PSMODULEPATH',
  ].map((s) => s.toUpperCase()),
);
const ALLOW_PREFIX = ['LC_', 'XDG_'];
/** Dù có nằm trong danh sách cho phép (hoặc do hook khai) thì tên giống khoá bí mật vẫn bị gỡ — trừ khi người dùng chủ động khai ở hooksPassEnv. */
const SECRETISH = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

export function buildHookEnv(
  base: Readonly<Record<string, string | undefined>>,
  opts: { passEnv?: readonly string[]; projectDir: string; entry: Pick<HookEntry, 'env' | 'dialect'>; event: string },
): Record<string, string> {
  const out: Record<string, string> = {};
  const pass = new Set((opts.passEnv ?? []).map((s) => s.toUpperCase()));
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    const up = k.toUpperCase();
    const allowed = ALLOW_EXACT.has(up) || ALLOW_PREFIX.some((p) => up.startsWith(p));
    if (allowed && !SECRETISH.test(k)) out[k] = v;
    else if (pass.has(up)) out[k] = v; // khai báo tường minh của người dùng
  }
  for (const [k, v] of Object.entries(opts.entry.env)) out[k] = v;
  out.LOCAITH_PROJECT_DIR = opts.projectDir;
  if (opts.entry.dialect === 'claude') out.CLAUDE_PROJECT_DIR = opts.projectDir;
  out.LOCAITH_HOOK_EVENT = opts.event;
  out.NO_COLOR = '1';
  return out;
}
