/**
 * (lane:perm-rules) RunExtension «luật quyền bền»: nối bộ luật allow/ask/deny (shared/permissionRules.ts) vào móc `permissionRule` của engine.
 *
 * Dùng chung mọi bề mặt: không import `vscode` hay `node:*`. Nguồn luật và cách chuẩn hoá đường dẫn thật (symlink, hoa/thường…) do bề mặt
 * truyền vào — bản VS Code: `src/host/extensions/permissionRules.ts` (đọc cài đặt theo cấp người dùng/workspace + workspace trust).
 */

import type { ToolUseBlock } from '../../types';
import { evaluateRules, rawSubject, suggestRules, type Rule, type RuleSubject } from '../../../shared/permissionRules';
import type { PermissionAdvice, RunExtension } from '../seams';
import { t } from '../strings';
import type { ToolContext, ToolDef, ToolHost } from '../types';

/** Ảnh chụp bộ luật tại một thời điểm (nguồn gọi lại mỗi lệnh gọi công cụ → thêm luật giữa lượt chạy có hiệu lực ngay). */
export interface RuleSnapshot {
  rules: readonly Rule[];
  /** Số luật allow do workspace đề xuất mà người dùng chưa xác nhận (để nhắc một lần mỗi phiên). */
  workspaceAllowPending?: number;
  /** Workspace chưa tin cậy: nguồn đã bỏ hết luật allow; chỉ nhắc người dùng. */
  untrusted?: boolean;
}

export interface ResolvedForRules {
  /** Đường dẫn tương đối POSIX trong workspace (khi `inWorkspace`). */
  rel: string;
  /** Đường dẫn tuyệt đối (dấu `/`). */
  abs: string;
  inWorkspace: boolean;
}

export interface PermissionRulesOptions {
  source(): RuleSnapshot;
  /** Chuẩn hoá đường dẫn thật (bản VS Code/CLI: resolveUserPathReal). Thiếu → chuẩn hoá thuần theo chuỗi (bản trình duyệt không có tệp). */
  resolvePath?(host: ToolHost, raw: string): Promise<ResolvedForRules>;
}

/** Chuẩn hoá thuần theo chuỗi: tương đối không có `..` = trong workspace; tuyệt đối hoặc có `..` = ngoài. */
export function resolvePathPlain(raw: string): ResolvedForRules {
  const p = String(raw ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  const isAbs = p.startsWith('/') || /^[A-Za-z]:\//.test(p) || p.startsWith('~');
  const dotdot = p.split('/').some((s) => s === '..');
  if (isAbs || dotdot) return { rel: p, abs: p, inWorkspace: false };
  return { rel: p || '.', abs: p, inWorkspace: true };
}

/** Phiên đã được nhắc về luật allow của workspace (một lần mỗi phiên, không lưu). */
const notified = new WeakSet<object>();

export function permissionRulesExtension(opts: PermissionRulesOptions): RunExtension {
  return {
    id: 'permission-rules',
    begin(scope) {
      const snap = opts.source();
      if (!notified.has(scope.session)) {
        if (snap.untrusted) {
          notified.add(scope.session);
          scope.notice('warn', t(scope.lang, 'rulesUntrusted'));
        } else if (snap.workspaceAllowPending) {
          notified.add(scope.session);
          scope.notice('info', t(scope.lang, 'rulesWorkspacePending', { n: snap.workspaceAllowPending }));
        }
      }
      return {
        async permissionRule(call: ToolUseBlock, def: ToolDef, ctx: ToolContext): Promise<PermissionAdvice> {
          const { rules } = opts.source();
          const input = (call.input ?? {}) as Record<string, unknown>;
          const raw = rawSubject(def.name, input);
          let subject: RuleSubject;
          let info: { rel?: string; inWorkspace?: boolean } = {};
          if (raw.kind === 'rawPath') {
            let r: ResolvedForRules;
            try {
              r = opts.resolvePath ? await opts.resolvePath(ctx.host, raw.path) : resolvePathPlain(raw.path);
            } catch {
              r = { rel: raw.path, abs: raw.path, inWorkspace: false };
            }
            subject = { kind: 'path', rel: r.rel, abs: r.abs.replace(/\\/g, '/'), inWorkspace: r.inWorkspace };
            info = { rel: r.rel, inWorkspace: r.inWorkspace };
          } else subject = raw;
          const hit = rules.length ? evaluateRules(rules, def.name, subject, { caseInsensitivePaths: ctx.host.platform.os === 'windows' }) : null;
          const suggest = suggestRules(def.name, input, info);
          return { ...(hit ? { hit } : {}), ...(suggest.length ? { suggest } : {}) };
        },
      };
    },
  };
}
