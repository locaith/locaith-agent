/**
 * Lệnh `/hooks` (lane:hooks): liệt kê hook đang hiệu lực theo nguồn kèm kết quả lần chạy gần nhất.
 *   /hooks             → danh sách
 *   /hooks open        → mở (tạo nếu chưa có) .locaith/settings.json của dự án
 *   /hooks open user   → mở cài đặt người dùng tại locaithAgent.hooks
 *   /hooks trust       → xem lại / cho phép hook của dự án (hỏi xác nhận lại các nguồn đã từ chối)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { HookService } from '../../core/hooks/service';
import type { SlashRegistry } from '../slashRegistry';

export interface HooksSlashHost {
  hookService(): HookService;
}

export function registerHooksSlash(slash: SlashRegistry, ctl: HooksSlashHost): void {
  slash.register({
    name: 'hooks',
    description: { vi: 'Xem hook đang hiệu lực (lệnh shell gắn vào vòng đời trợ lý) — /hooks open, /hooks trust', en: 'Show active hooks (shell commands attached to the assistant lifecycle) — /hooks open, /hooks trust' },
    argHint: '[open|trust]',
    needsIdle: false,
    async run(ctx) {
      const svc = ctl.hookService();
      const [sub, arg] = ctx.args.trim().toLowerCase().split(/\s+/);
      if (sub === 'open') {
        if (arg === 'user') {
          await vscode.commands.executeCommand('workbench.action.openSettings', 'locaithAgent.hooks');
          return;
        }
        const root = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'file')?.uri.fsPath;
        if (!root) {
          ctx.warn(ctx.lang === 'en' ? 'Open a folder first: project hooks live in `.locaith/settings.json`.' : 'Hãy mở một thư mục trước: hook của dự án nằm ở `.locaith/settings.json`.');
          return;
        }
        const file = path.join(root, '.locaith', 'settings.json');
        if (!fs.existsSync(file)) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, `${JSON.stringify({ hooks: { PreToolUse: [] } }, null, 2)}\n`, 'utf8');
        }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        await vscode.window.showTextDocument(doc, { preview: false });
        return;
      }
      if (sub === 'trust') {
        svc.reviewProjectHooks();
        ctx.info(await svc.describe(ctx.lang));
        return;
      }
      ctx.info(await svc.describe(ctx.lang));
    },
  });
}
