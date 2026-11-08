/**
 * Mô-đun 1 — hooks (lệnh shell gắn vào vòng đời trợ lý, lược đồ Claude Code). Toàn bộ logic ở `core/hooks/*`; ở đây nối vào CLI:
 *   • nguồn: hook NGƯỜI DÙNG đọc từ `~/.locaith/settings.json` (chạy luôn); hook DỰ ÁN (`.locaith/settings*.json`, tuỳ chọn `.claude/…`)
 *     chỉ chạy khi thư mục đã tin cậy VÀ người dùng đã duyệt đúng nội dung (băm → `~/.locaith/hooks-approved.json`); không tương tác → không chạy;
 *   • RunExtension cho engine chính + agent con (PreToolUse/PostToolUse/Stop), SessionStart/UserPromptSubmit/PreCompact/Notification/SessionEnd
 *     qua các điểm móc tuỳ chọn của lõi (ext.ts); thiếu điểm móc thì rơi về `beforeModel` ở lượt đầu của lần chạy;
 *   • `/hooks` (liệt kê), `/hooks open [user]`, `/hooks trust`.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { registerStrings, t } from '../../i18n';
import { createNodeHookExecutor } from '../../../core/hooks/nodeExec';
import { hooksRunExtension } from '../../../core/hooks/runExtension';
import { HookService } from '../../../core/hooks/service';
import { HookSources, type HookConfirmRequest } from '../../../core/hooks/sources';
import type { RunExtension, RunHooks, RunScope } from '../../../core/engine/seams';
import type { FeatureContext, FeatureModule } from '../contract';
import { asExt, askUser, isSubAgentScope } from './ext';
import { getPath, readJsonFile, strList } from './settingsFile';

registerStrings('features', {
  vi: {
    'hooks.confirmTitle': 'Dự án này muốn chạy hook (lệnh shell) từ {rel}. Chỉ cho phép nếu bạn tin nguồn của dự án.',
    'hooks.confirmDetail': 'Các lệnh sẽ chạy với quyền của bạn:\n\n{lines}',
    'hooks.allow': 'Cho phép chạy',
    'hooks.deny': 'Không chạy',
    'hooks.needFolder': 'Hook của dự án nằm ở `.locaith/settings.json` — hãy chạy locaith trong thư mục dự án.',
    'hooks.opened': 'Đã mở {file} trong trình soạn thảo.',
    'hooks.blockedFallback': '[Hook UserPromptSubmit đã chặn tin nhắn này: {reason}. Dừng ngay, không gọi công cụ nào, chỉ báo lại cho người dùng.]',
  },
  en: {
    'hooks.confirmTitle': 'This project wants to run hooks (shell commands) from {rel}. Only allow it if you trust the project.',
    'hooks.confirmDetail': 'These commands will run with your permissions:\n\n{lines}',
    'hooks.allow': 'Allow',
    'hooks.deny': 'Do not run',
    'hooks.needFolder': 'Project hooks live in `.locaith/settings.json` — run locaith inside the project folder.',
    'hooks.opened': 'Opened {file} in the editor.',
    'hooks.blockedFallback': '[The UserPromptSubmit hook blocked this message: {reason}. Stop now, call no tools, just tell the user.]',
  },
});

/** Dịch vụ hook đã dựng — mô-đun khác (kiểm thử, lệnh) lấy qua đây. */
const services = new WeakMap<FeatureContext, HookService>();
export const hookServiceOf = (ctx: FeatureContext): HookService | undefined => services.get(ctx);

export function approvalsFile(home: string): string {
  return path.join(home, '.locaith', 'hooks-approved.json');
}

function readApprovals(home: string): Record<string, string> {
  const raw = readJsonFile(approvalsFile(home));
  const out: Record<string, string> = {};
  if (raw) for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') out[k] = v;
  return out;
}

function writeApprovals(home: string, data: Record<string, string>): void {
  const file = approvalsFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.rmSync(tmp, { force: true });
  }
}

export function buildHookService(ctx: FeatureContext): HookService {
  const lang = () => ctx.lang;
  let service!: HookService;
  const sources = new HookSources({
    userHooks: () => getPath(readJsonFile(ctx.settings.file('user')), 'hooks') ?? {},
    enabled: () => ctx.settings.get<boolean>('hooksEnabled', true) !== false,
    readClaude: () => ctx.settings.get<boolean>('hooksReadClaudeSettings', false) === true,
    workspaceRoot: () => ctx.cwd,
    trusted: () => ctx.isTrusted(),
    readFile: async (rel) => {
      const abs = path.resolve(ctx.cwd, rel);
      try {
        const real = await fs.promises.realpath(abs);
        const realRoot = await fs.promises.realpath(ctx.cwd);
        const back = path.relative(realRoot, real);
        if (back.startsWith('..') || path.isAbsolute(back)) return null; // `.locaith` là liên kết trỏ ra ngoài workspace
        return await fs.promises.readFile(real, 'utf8');
      } catch {
        return null;
      }
    },
    hash: (s) => crypto.createHash('sha256').update(s).digest('hex'),
    approvals: {
      get: (key) => readApprovals(ctx.home)[key],
      set: (key, hash) => writeApprovals(ctx.home, { ...readApprovals(ctx.home), [key]: hash }),
    },
    confirm: async (req: HookConfirmRequest) => {
      if (!ctx.interactive) return false;
      const ans = await askUser(ctx, {
        kind: 'confirm',
        title: t('features.hooks.confirmTitle', { rel: req.rel }, lang()),
        detail: t('features.hooks.confirmDetail', { lines: req.lines.map((l) => `• ${l}`).join('\n') }, lang()),
        yes: t('features.hooks.allow', undefined, lang()),
        no: t('features.hooks.deny', undefined, lang()),
        defaultYes: false,
        danger: true,
      });
      return ans === true;
    },
    log: (l, m) => ctx.log(l, m),
    note: (level, text) => service.notify(level, text),
    lang,
  });
  service = new HookService({
    sources,
    executor: createNodeHookExecutor(() => ctx.settings.get<string>('terminal.shell', 'auto')),
    cwd: () => ctx.cwd,
    sessionId: () => ctx.session().id,
    baseEnv: () => process.env,
    passEnv: () => strList(ctx.settings.get<unknown>('hooksPassEnv', [])),
    log: (l, m) => ctx.log(l, m),
    lang,
    hasHistory: () => ctx.session().messages.length > 0,
  });
  service.setNotifier((level, text) => ctx.toast(level, text));
  return service;
}

export const hooksFeature: FeatureModule = {
  name: 'hooks',
  attach(ctx) {
    const svc = buildHookService(ctx);
    services.set(ctx, svc);
    const ext = asExt(ctx);
    const wired = typeof ext.beforeSend === 'function';

    // ── RunExtension: chính + agent con (một đối tượng, tự nhận biết agent con bằng phiên khác phiên chính) ──
    const main = hooksRunExtension(() => svc);
    const sub = hooksRunExtension(() => svc, { subAgent: true });
    const combined: RunExtension = {
      id: 'hooks',
      begin(scope: RunScope) {
        const isSub = isSubAgentScope(ctx, scope);
        if (isSub) return sub.begin(scope);
        const hooks = main.begin(scope);
        if (!hooks || wired) return hooks;
        return withFallbackSubmit(svc, scope, hooks, ctx.lang);
      },
    };
    ctx.addRunExtension(combined, { subAgents: true });

    // ── SessionStart / UserPromptSubmit (trước khi gửi), PreCompact, Notification ──
    ext.beforeSend?.(async ({ text, signal }) => {
      const r = await svc.beforeSend(text, signal);
      return r.blocked ? { blocked: true, reason: r.reason } : undefined;
    });
    ext.onPermissionRequest?.((req) => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 30_000);
      void svc
        .notification(req.title || req.tool, 'permission_prompt', ac.signal)
        .catch(() => undefined)
        .finally(() => clearTimeout(timer));
    });
    ext.onBeforeCompact?.(({ trigger, signal }) => svc.preCompact(trigger, signal).catch(() => undefined));

    // ── SessionEnd: đổi phiên (clear) hoặc đóng (close) ──
    let currentId = ctx.session().id;
    ctx.onSessionChange((s) => {
      const prev = currentId;
      currentId = s.id;
      if (prev !== s.id) void svc.sessionEnd(prev, 'clear').catch(() => undefined);
    });
    ctx.onDispose(() => svc.sessionEnd(currentId, 'close', 5000).catch(() => undefined));

    // ── /hooks ──
    ctx.slash({
      name: 'hooks',
      description: {
        vi: 'Xem hook đang hiệu lực (lệnh shell gắn vào vòng đời trợ lý) — /hooks open, /hooks trust',
        en: 'Show active hooks (shell commands attached to the assistant lifecycle) — /hooks open, /hooks trust',
      },
      argHint: '[open [user]|trust]',
      needsIdle: false,
      async run(c) {
        const [sub0, arg] = c.args.trim().toLowerCase().split(/\s+/);
        if (sub0 === 'open') {
          let file: string;
          if (arg === 'user') {
            file = ctx.settings.file('user');
            if (!fs.existsSync(file)) {
              fs.mkdirSync(path.dirname(file), { recursive: true });
              fs.writeFileSync(file, `${JSON.stringify({ hooks: { PreToolUse: [] } }, null, 2)}\n`, 'utf8');
            }
          } else {
            file = ctx.settings.file('project');
            if (!fs.existsSync(path.dirname(file)) && !fs.existsSync(ctx.cwd)) return c.output(t('features.hooks.needFolder', undefined, c.lang), 'error');
            if (!fs.existsSync(file)) {
              fs.mkdirSync(path.dirname(file), { recursive: true });
              fs.writeFileSync(file, `${JSON.stringify({ hooks: { PreToolUse: [] } }, null, 2)}\n`, 'utf8');
            }
          }
          ctx.emit({ t: 'action', action: 'open_editor', payload: file });
          c.output(t('features.hooks.opened', { file }, c.lang), 'plain');
          return;
        }
        if (sub0 === 'trust') svc.reviewProjectHooks();
        c.output(await svc.describe(c.lang));
      },
    });
  },
};

/** Khi lõi chưa có `onBeforeSubmit`: chạy SessionStart/UserPromptSubmit ở `beforeModel` lần đầu của lần chạy. Bị chặn → ép model dừng, chặn mọi công cụ. */
function withFallbackSubmit(svc: HookService, scope: RunScope, base: RunHooks, lang: 'vi' | 'en'): RunHooks {
  let done = false;
  let blocked: string | undefined;
  const text = scope.input.map((b) => (b.type === 'text' ? b.text : '')).join('\n').trim();
  return {
    ...base,
    async beforeModel(turn) {
      const out: string[] = [];
      if (!done) {
        done = true;
        const r = await svc.beforeSend(text, scope.signal);
        if (r.blocked) {
          blocked = r.reason ?? '';
          out.push(t('features.hooks.blockedFallback', { reason: blocked }, lang));
        }
      }
      const more = await base.beforeModel?.(turn);
      return [...out, ...(more ?? [])];
    },
    async toolBefore(call, def, tctx) {
      if (blocked !== undefined) return { block: t('features.hooks.blockedFallback', { reason: blocked }, lang), state: 'denied' as const };
      return base.toolBefore?.(call, def, tctx);
    },
    async finalize(fin) {
      if (blocked !== undefined) return { action: 'halt' as const, notice: { level: 'warn' as const, text: t('features.hooks.blockedFallback', { reason: blocked }, lang) } };
      return base.finalize ? base.finalize(fin) : { action: 'accept' as const };
    },
  };
}
