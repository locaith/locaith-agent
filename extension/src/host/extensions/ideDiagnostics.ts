/**
 * (lane:ide-context) Đăng ký phía VS Code cho phản hồi chẩn đoán sau khi sửa tệp (logic ở src/core/ide/editDiagnostics.ts).
 * Cài đặt `locaithAgent.agent.editDiagnostics`: 'errors' (mặc định) | 'all' | 'off' — đọc lại ở đầu mỗi lần chạy.
 */

import type { RunExtension } from '../../core/engine/seams';
import { EDIT_DIAG_SETTING, editDiagnosticsExtension, editDiagnosticsMode } from '../../core/ide/editDiagnostics';
import type { HostExtensionContext } from '../hostExtensions';

export function ideDiagnosticsExtension(ctx: HostExtensionContext): RunExtension {
  return editDiagnosticsExtension({ mode: () => editDiagnosticsMode(ctx.deps.config.get<unknown>(EDIT_DIAG_SETTING, 'errors')) });
}
