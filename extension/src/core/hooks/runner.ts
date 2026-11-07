/**
 * Chạy các hook khớp của MỘT sự kiện: song song, đọc kết quả theo hợp đồng của Claude Code, gộp theo luật «chặn thắng».
 *
 * Hợp đồng thực thi:
 *   • stdin  = JSON `{ session_id, cwd, hook_event_name, ... }` (+ tool_name / tool_input / tool_response / prompt / stop_hook_active…);
 *   • exit 0 = ổn; stdout là JSON tuỳ chọn `{decision:'block'|'approve', reason, additionalContext, updatedInput, continue:false, stopReason}`
 *              (cũng nhận dạng `hookSpecificOutput.{permissionDecision,additionalContext,updatedInput}` của Claude Code);
 *   • exit 2 = CHẶN, stderr là phản hồi cho model;
 *   • exit khác / quá hạn / không khởi chạy được = lỗi KHÔNG chặn (thành cảnh báo).
 */

import { redactSecrets } from '../providers/http';
import type { Lang } from '../engine/strings';
import { claudeToolInput, claudeToolName, compileMatcher } from './config';
import { bi } from './lang';
import {
  HOOK_MAX_OUTPUT_CHARS,
  emptyOutcome,
  type HookEntry,
  type HookEvent,
  type HookExecResult,
  type HookExecutor,
  type HookOutcome,
  type HookRunRecord,
} from './types';

export interface HookRunnerOptions {
  executor: HookExecutor;
  cwd: string;
  signal: AbortSignal;
  log(level: 'info' | 'warn', message: string): void;
  /** Môi trường của tiến trình hook, đã lọc bí mật (xem env.ts). */
  buildEnv(entry: HookEntry): Record<string, string>;
  /**
   * Tên để so `matcher` (với công cụ: tên Locaith + tên Claude Code). `undefined` = sự kiện này không dùng matcher
   * (UserPromptSubmit, Stop…): mọi hook của sự kiện đều chạy.
   */
  matchNames?: readonly string[];
  /** Giá trị cụ thể cần che khỏi log/thông báo (ngoài các mẫu khoá phổ biến). */
  secrets?: readonly string[];
  lang?: Lang;
  /** Mốc thời gian (kiểm thử). */
  now?: () => number;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Chuỗi ngắn một dòng để hiện (đã che bí mật). */
function oneLine(text: string, max = 200, secrets: readonly string[] = []): string {
  const s = redactSecrets(text, secrets).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Chọn các hook khớp sự kiện + matcher, giữ thứ tự cấu hình. */
export function selectHooks(entries: readonly HookEntry[], event: HookEvent, matchNames?: readonly string[]): HookEntry[] {
  return entries.filter((e) => {
    if (e.event !== event) return false;
    if (!e.matcher || matchNames === undefined) return true;
    return compileMatcher(e.matcher).test(matchNames);
  });
}

/** Dựng JSON gửi qua stdin; hook từ `.claude/settings` nhận tên công cụ/đối số theo cách đặt tên của Claude Code. */
export function buildStdinPayload(entry: HookEntry, payload: Record<string, unknown>): string {
  let p = payload;
  if (entry.dialect === 'claude' && typeof payload.tool_name === 'string') {
    const input = isObj(payload.tool_input) ? payload.tool_input : {};
    p = { ...payload, tool_name: claudeToolName(payload.tool_name), tool_input: claudeToolInput(payload.tool_name, input) };
  }
  return JSON.stringify(p);
}

interface Interpreted {
  status: HookRecordStatus;
  message?: string;
  block?: string;
  approved?: boolean;
  context?: string[];
  updatedInput?: Record<string, unknown>;
  stop?: boolean;
  stopReason?: string;
  warn?: string[];
}
type HookRecordStatus = HookRunRecord['status'];

function tryJson(stdout: string): Record<string, unknown> | null {
  const s = stdout.trim();
  if (!s.startsWith('{')) return null;
  try {
    const v = JSON.parse(s);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function interpret(event: HookEvent, entry: HookEntry, res: HookExecResult, secrets: readonly string[], lang: Lang | undefined): Interpreted {
  if (res.error) return { status: 'error', message: oneLine(res.error, 200, secrets), warn: [bi(lang, `không chạy được: ${oneLine(res.error, 160, secrets)}`, `could not run: ${oneLine(res.error, 160, secrets)}`)] };
  if (res.timedOut) return { status: 'timeout', message: `${entry.timeoutSec}s`, warn: [bi(lang, `quá hạn ${entry.timeoutSec} giây — bỏ qua`, `timed out after ${entry.timeoutSec}s — skipped`)] };
  if (res.exitCode === 2) {
    const reason = str(res.stderr) ?? str(res.stdout) ?? bi(lang, 'hook chặn (mã thoát 2, không có lời giải thích)', 'hook blocked (exit code 2, no explanation)');
    return { status: 'block', message: oneLine(reason, 240, secrets), block: redactSecrets(reason, secrets).slice(0, 4000) };
  }
  if (res.exitCode !== 0) {
    const detail = oneLine(res.stderr || res.stdout || '', 160, secrets);
    return { status: 'warn', message: `exit ${res.exitCode}${detail ? `: ${detail}` : ''}`, warn: [bi(lang, `kết thúc với mã ${res.exitCode}`, `exited with code ${res.exitCode}`) + (detail ? `: ${detail}` : '')] };
  }

  const json = tryJson(res.stdout);
  if (!json) {
    // SessionStart / UserPromptSubmit: chữ trên stdout thành ngữ cảnh cho model (giống Claude Code).
    const text = res.stdout.trim();
    if (text && (event === 'SessionStart' || event === 'UserPromptSubmit')) return { status: 'ok', context: [redactSecrets(text, secrets).slice(0, 8000)] };
    return { status: 'ok' };
  }

  const out: Interpreted = { status: 'ok' };
  const hso = isObj(json.hookSpecificOutput) ? json.hookSpecificOutput : {};
  const decision = str(json.decision)?.toLowerCase();
  const permission = str(hso.permissionDecision)?.toLowerCase();
  if (decision === 'block' || permission === 'deny') {
    const reason = str(json.reason) ?? str(hso.permissionDecisionReason) ?? bi(lang, 'hook chặn (không có lý do)', 'hook blocked (no reason given)');
    out.status = 'block';
    out.block = redactSecrets(reason, secrets).slice(0, 4000);
    out.message = oneLine(reason, 240, secrets);
  } else if (decision === 'approve' || permission === 'allow') {
    out.approved = true;
  }
  const ctxText = str(json.additionalContext) ?? str(hso.additionalContext);
  if (ctxText) out.context = [redactSecrets(ctxText, secrets).slice(0, 8000)];
  const updated = isObj(json.updatedInput) ? json.updatedInput : isObj(hso.updatedInput) ? hso.updatedInput : undefined;
  if (updated) out.updatedInput = updated;
  if (json.continue === false) {
    out.stop = true;
    out.stopReason = str(json.stopReason) ? redactSecrets(str(json.stopReason)!, secrets).slice(0, 1000) : undefined;
  }
  const sys = str(json.systemMessage);
  if (sys) out.warn = [oneLine(sys, 300, secrets)];
  return out;
}

/** Chạy mọi hook khớp của `event` và gộp kết quả. Không bao giờ ném lỗi. */
export async function runHookEvent(entries: readonly HookEntry[], event: HookEvent, payload: Record<string, unknown>, o: HookRunnerOptions): Promise<HookOutcome> {
  const outcome = emptyOutcome();
  const picked = selectHooks(entries, event, o.matchNames);
  if (!picked.length) return outcome;
  const now = o.now ?? Date.now;
  const secrets = o.secrets ?? [];

  const results = await Promise.all(
    picked.map(async (entry) => {
      const started = now();
      let res: HookExecResult;
      try {
        const env = { ...o.buildEnv(entry) };
        res = await o.executor.exec({
          command: entry.command,
          cwd: o.cwd,
          env,
          stdin: buildStdinPayload(entry, { ...payload, hook_event_name: event, cwd: o.cwd }),
          timeoutMs: entry.timeoutSec * 1000,
          maxChars: HOOK_MAX_OUTPUT_CHARS,
          signal: o.signal,
        });
      } catch (err) {
        res = { exitCode: null, stdout: '', stderr: '', timedOut: false, error: err instanceof Error ? err.message : String(err) };
      }
      return { entry, res, ms: Math.max(0, now() - started) };
    }),
  );

  // Gộp THEO THỨ TỰ CẤU HÌNH (không theo thứ tự hoàn thành) để kết quả xác định.
  for (const { entry, res, ms } of results) {
    if (res.aborted || o.signal.aborted) continue;
    const it = interpret(event, entry, res, secrets, o.lang);
    const record: HookRunRecord = {
      event,
      source: entry.source,
      sourceLabel: entry.sourceLabel,
      name: entry.name,
      command: oneLine(entry.command, 240, secrets),
      status: it.status,
      exitCode: res.exitCode,
      ms,
      message: it.message,
      at: now(),
    };
    outcome.records.push(record);
    o.log(it.status === 'ok' || it.status === 'block' ? 'info' : 'warn', `[hook] ${event} · ${entry.name} · ${it.status} · ${ms} ms · ${record.command}`);
    if (it.block !== undefined) {
      outcome.blocked = true;
      outcome.reason = outcome.reason ? `${outcome.reason}\n${it.block}` : it.block;
    }
    if (it.approved) outcome.approved = true;
    if (it.context) outcome.additionalContext.push(...it.context);
    if (it.updatedInput) outcome.updatedInput = it.updatedInput;
    if (it.stop) {
      outcome.stop = true;
      if (it.stopReason) outcome.stopReason = outcome.stopReason ? `${outcome.stopReason}\n${it.stopReason}` : it.stopReason;
    }
    for (const w of it.warn ?? []) outcome.warnings.push(`${entry.name}: ${w}`);
  }
  // «Chặn thắng»: một hook chặn thì lời tán thành / sửa đối số của hook khác không còn tác dụng.
  if (outcome.blocked) {
    outcome.approved = false;
    outcome.updatedInput = undefined;
  }
  return outcome;
}
