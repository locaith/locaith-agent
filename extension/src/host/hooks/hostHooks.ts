/**
 * Dựng HookService cho một ChatController trong VS Code (lane:hooks): nối cài đặt người dùng, tin cậy workspace, hộp xác nhận,
 * kho nhớ xác nhận (globalState) và tiến trình thật vào phần lõi không phụ thuộc môi trường (src/core/hooks).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { createNodeHookExecutor } from '../../core/hooks/nodeExec';
import { HookService } from '../../core/hooks/service';
import { HookSources, type HookConfirmRequest } from '../../core/hooks/sources';
import type { SessionState } from '../../core/engine/types';
import type { ControllerDeps } from '../chatController';
import type { VsCodeToolHost } from '../vscodeHost';

const APPROVAL_KEY = 'locaithAgent.hooks.approved';

export interface HookHostContext {
  deps: ControllerDeps;
  host: VsCodeToolHost;
  session(): SessionState;
}

/** Mỗi ToolHost (tức mỗi ChatController) có đúng một dịch vụ hook, dùng chung cho extension chạy-trong-vòng-lặp và cho controller. */
const services = new WeakMap<object, HookService>();

export function hookServiceFor(ctx: HookHostContext): HookService {
  const existing = services.get(ctx.host);
  if (existing) return existing;
  const { deps, host } = ctx;
  const lang = () => deps.config.language();
  let service!: HookService;

  const sources = new HookSources({
    userHooks: () => deps.config.get<unknown>('hooks', {}),
    enabled: () => deps.config.get<boolean>('hooksEnabled', true) !== false,
    readClaude: () => deps.config.get<boolean>('hooksReadClaudeSettings', false) === true,
    workspaceRoot: () => host.workspaceRoots()[0],
    trusted: () => vscode.workspace.isTrusted,
    readFile: async (rel) => {
      const root = host.workspaceRoots()[0];
      if (!root) return null;
      const abs = path.resolve(root, rel);
      // đường dẫn cố định, nhưng vẫn chặn trường hợp .locaith là liên kết trỏ ra ngoài workspace
      try {
        const real = await fs.promises.realpath(abs);
        const realRoot = await fs.promises.realpath(root);
        if (path.relative(realRoot, real).startsWith('..') || path.isAbsolute(path.relative(realRoot, real))) return null;
        return await fs.promises.readFile(real, 'utf8');
      } catch {
        return null;
      }
    },
    hash: (s) => crypto.createHash('sha256').update(s).digest('hex'),
    approvals: {
      get: (key) => (deps.context.globalState.get<Record<string, string>>(APPROVAL_KEY, {}) ?? {})[key],
      set: async (key, hash) => {
        const all = { ...(deps.context.globalState.get<Record<string, string>>(APPROVAL_KEY, {}) ?? {}) };
        all[key] = hash;
        await deps.context.globalState.update(APPROVAL_KEY, all);
      },
    },
    confirm: (req) => confirmProjectHooks(req, lang()),
    log: (l, m) => host.log(l, m),
    note: (level, text) => service.notify(level, text),
    lang,
  });

  service = new HookService({
    sources,
    executor: createNodeHookExecutor(() => deps.config.get<string>('terminal.shell', 'auto')),
    cwd: () => host.workspaceRoots()[0],
    sessionId: () => ctx.session().id,
    baseEnv: () => process.env,
    passEnv: () => deps.config.get<string[]>('hooksPassEnv', []).filter((s) => typeof s === 'string'),
    log: (l, m) => host.log(l, m),
    lang,
    hasHistory: () => ctx.session().messages.length > 0,
  });
  // Notification: một yêu cầu xin quyền vừa hiện ra → báo hook (không chờ, không chặn việc xin quyền).
  host.permissionListener = (req) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30_000);
    void service
      .notification(req.title || req.tool, 'permission_prompt', ac.signal)
      .catch(() => undefined)
      .finally(() => clearTimeout(timer));
  };

  services.set(ctx.host, service);
  return service;
}

/** Hộp xác nhận: liệt kê ĐẦY ĐỦ từng lệnh sẽ chạy với quyền của bạn. */
async function confirmProjectHooks(req: HookConfirmRequest, lang: 'vi' | 'en'): Promise<boolean> {
  const vi = lang !== 'en';
  const allow = vi ? 'Cho phép chạy' : 'Allow';
  const message = vi
    ? `Dự án này muốn chạy hook (lệnh shell) từ ${req.rel}. Chỉ cho phép nếu bạn tin nguồn của dự án.`
    : `This project wants to run hooks (shell commands) from ${req.rel}. Only allow it if you trust the project.`;
  const detail = (vi ? 'Các lệnh sẽ chạy với quyền của bạn:\n\n' : 'These commands will run with your permissions:\n\n') + req.lines.map((l) => `• ${l}`).join('\n');
  const pick = await vscode.window.showWarningMessage(message, { modal: true, detail }, allow);
  return pick === allow;
}
