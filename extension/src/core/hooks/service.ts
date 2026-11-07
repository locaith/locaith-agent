/**
 * Dịch vụ hook của một cuộc trò chuyện: nạp nguồn (có kiểm tra tin cậy), chạy hook của từng sự kiện, nhớ kết quả gần nhất cho `/hooks`.
 * Không phụ thuộc `vscode` / `node:*` — phần chạy tiến trình thật và hộp xác nhận do host đưa vào (`HookServiceDeps`).
 */

import type { UiEvent } from '../../shared/protocol';
import { t, type Lang } from '../engine/strings';
import { buildHookEnv } from './env';
import { runHookEvent } from './runner';
import type { HookLoadResult, HookSources, HookSourceState } from './sources';
import { emptyOutcome, HOOK_EVENTS, type HookEntry, type HookEvent, type HookExecutor, type HookOutcome, type HookRunRecord } from './types';

export interface HookServiceDeps {
  sources: HookSources;
  executor: HookExecutor;
  /** Thư mục làm việc của hook = gốc workspace đầu tiên. Không có workspace → không chạy hook nào. */
  cwd(): string | undefined;
  sessionId(): string;
  /** `process.env` (hoặc tương đương) để lọc theo danh sách cho phép. */
  baseEnv(): Record<string, string | undefined>;
  /** Tên biến người dùng chủ động cho đi qua (`locaithAgent.hooksPassEnv`). */
  passEnv(): string[];
  /** Các giá trị bí mật cụ thể cần che trong log/thông báo. */
  secrets?(): string[];
  log(level: 'info' | 'warn', message: string): void;
  lang(): Lang;
  /** Phiên đã có tin nhắn trước đó (mở lại cuộc trò chuyện cũ) — để SessionStart biết là «resume». */
  hasHistory?(): boolean;
}

/** Chỗ để hiện kết quả hook ngay trong khung chat khi đang có một lần chạy. */
export interface HookRunSink {
  emit(ev: UiEvent): void;
  assistantId(): string;
  notice(level: 'info' | 'warn' | 'error', text: string): void;
}

const CACHE_TTL_MS = 1500;
const RECENT_MAX = 60;

export interface FireOptions {
  signal: AbortSignal;
  /** Tên để so matcher (xem HookRunnerOptions.matchNames). */
  matchNames?: readonly string[];
}

export class HookService {
  private cache: { at: number; value: Promise<HookLoadResult> } | null = null;
  private readonly recentRuns: HookRunRecord[] = [];
  private readonly startedSessions = new Set<string>();
  private sink: HookRunSink | null = null;
  private notifier: ((level: 'info' | 'warn' | 'error', text: string) => void) | null = null;
  private pendingContext: string[] = [];
  private pillSeq = 0;

  constructor(private readonly d: HookServiceDeps) {}

  /** Nạp nguồn (đệm 1,5 giây để các công cụ song song không đọc đĩa/hỏi xác nhận nhiều lần). */
  load(force = false): Promise<HookLoadResult> {
    const now = Date.now();
    if (!force && this.cache && now - this.cache.at < CACHE_TTL_MS) return this.cache.value;
    const value = this.d.sources.load().catch((err): HookLoadResult => {
      this.d.log('warn', `[hook] không nạp được cấu hình hook: ${err instanceof Error ? err.message : String(err)}`);
      return { entries: [], sources: [], warnings: [] };
    });
    this.cache = { at: now, value };
    return value;
  }

  /** `/hooks trust`: hỏi lại các nguồn dự án đã bị từ chối và nạp lại. */
  reviewProjectHooks(): void {
    this.d.sources.reviewAgain();
    this.invalidate();
  }

  /** Dùng khi cấu hình/tin cậy vừa đổi (`/hooks trust`). */
  invalidate(): void {
    this.cache = null;
  }

  /** Phiên này đã chạy SessionStart chưa? Gọi một lần: lần đầu trả false rồi ghi nhớ. */
  markSessionStarted(sessionId: string): boolean {
    if (this.startedSessions.has(sessionId)) return true;
    this.startedSessions.add(sessionId);
    return false;
  }

  /** Có hook nào cho sự kiện này không (rẻ: dùng cho đường nóng như Notification). */
  async has(event: HookEvent): Promise<boolean> {
    const { entries } = await this.load();
    return entries.some((e) => e.event === event);
  }

  async fire(event: HookEvent, payload: Record<string, unknown>, o: FireOptions): Promise<HookOutcome> {
    const cwd = this.d.cwd();
    if (!cwd) return emptyOutcome();
    let entries: HookEntry[];
    try {
      entries = (await this.load()).entries;
    } catch {
      return emptyOutcome();
    }
    if (!entries.some((e) => e.event === event)) return emptyOutcome();
    const outcome = await runHookEvent(entries, event, { session_id: this.d.sessionId(), ...payload }, {
      executor: this.d.executor,
      cwd,
      signal: o.signal,
      log: (l, m) => this.d.log(l, m),
      matchNames: o.matchNames,
      secrets: this.d.secrets?.() ?? [],
      lang: this.d.lang(),
      buildEnv: (entry) => buildHookEnv(this.d.baseEnv(), { passEnv: this.d.passEnv(), projectDir: cwd, entry, event }),
    });
    for (const r of outcome.records) {
      this.recentRuns.push(r);
      if (this.recentRuns.length > RECENT_MAX) this.recentRuns.shift();
    }
    return outcome;
  }

  recent(): readonly HookRunRecord[] {
    return this.recentRuns;
  }

  // ── hiển thị kết quả ─────────────────────────────────────────────────────────

  /** Thông báo ngoài lần chạy (UserPromptSubmit, SessionEnd…): host đưa vào khung chat. */
  setNotifier(fn: ((level: 'info' | 'warn' | 'error', text: string) => void) | null): void {
    this.notifier = fn;
  }

  /** Hiện một thông báo cho người dùng: trong lượt trả lời nếu đang chạy, không thì qua notifier của host. */
  notify(level: 'info' | 'warn' | 'error', text: string): void {
    if (this.sink) this.sink.notice(level, text);
    else this.notifier?.(level, text);
  }

  /** Extension gắn vào lần chạy hiện tại để kết quả hook hiện đúng trong lượt trả lời. */
  bindRun(sink: HookRunSink | null): void {
    this.sink = sink;
  }

  /**
   * Hiện kết quả: MỘT dòng gọn mỗi lần kích hoạt sự kiện (tên hook · ✓/✗ · ms) trong nhóm hoạt động của lượt trả lời,
   * và cảnh báo (không chặn) thành thông báo riêng. Hook chặn thì lời chặn tới model/người dùng qua đường của chính sự kiện đó.
   */
  report(event: HookEvent, outcome: HookOutcome): void {
    const lang = this.d.lang();
    if (this.sink && outcome.records.length) {
      const items = outcome.records.map((r) => {
        const key = r.status === 'ok' ? 'hookItemOk' : r.status === 'block' ? 'hookItemBlock' : r.status === 'timeout' ? 'hookItemTimeout' : 'hookItemFail';
        return t(lang, key, { name: r.name, ms: r.ms });
      });
      const id = this.sink.assistantId();
      this.sink.emit({ t: 'pill', id, pillId: `${id}:hook:${++this.pillSeq}`, text: t(lang, 'hookPill', { event, items: items.join(' · ') }), kind: 'working' });
    }
    const say = (level: 'info' | 'warn' | 'error', text: string) => this.notify(level, text);
    for (const w of outcome.warnings) say('warn', t(lang, 'hookWarn', { event, text: w }));
    if (outcome.stop) say('warn', t(lang, 'hookStopped', { event, reason: outcome.stopReason ? `: ${outcome.stopReason}` : '' }));
  }

  // ── vòng đời ngoài vòng lặp agent ─────────────────────────────────────────────

  /** Ngữ cảnh do hook SessionStart / UserPromptSubmit sinh ra, chờ extension nối vào lịch sử ở lần gọi model kế tiếp. */
  takePendingContext(): string[] {
    const out = this.pendingContext;
    this.pendingContext = [];
    return out;
  }

  /**
   * Trước khi gửi tin nhắn người dùng: SessionStart (lần đầu của phiên) rồi UserPromptSubmit.
   * `blocked` = hook từ chối tin nhắn (controller trả lại nội dung vào ô nhập và báo lý do).
   */
  async beforeSend(prompt: string, signal: AbortSignal): Promise<{ blocked: boolean; reason?: string }> {
    this.pendingContext = [];
    const lang = this.d.lang();
    if (!(await this.has('SessionStart')) && !(await this.has('UserPromptSubmit'))) {
      this.markSessionStarted(this.d.sessionId());
      return { blocked: false };
    }
    if (!this.markSessionStarted(this.d.sessionId())) {
      const src = this.d.hasHistory?.() ? 'resume' : 'startup';
      const o = await this.fire('SessionStart', { source: src }, { signal, matchNames: [src] });
      this.report('SessionStart', o);
      this.pendingContext.push(...o.additionalContext.map((c) => t(lang, 'hookNote', { event: 'SessionStart', text: c })));
    }
    const o = await this.fire('UserPromptSubmit', { prompt }, { signal });
    this.report('UserPromptSubmit', o);
    if (o.blocked) {
      this.pendingContext = [];
      return { blocked: true, reason: o.reason ?? t(lang, 'hookNoReason') };
    }
    this.pendingContext.push(...o.additionalContext.map((c) => t(lang, 'hookNote', { event: 'UserPromptSubmit', text: c })));
    return { blocked: false };
  }

  async preCompact(trigger: 'auto' | 'manual' | 'overflow', signal: AbortSignal): Promise<void> {
    const kind = trigger === 'manual' ? 'manual' : 'auto';
    const o = await this.fire('PreCompact', { trigger: kind }, { signal, matchNames: [kind] });
    this.report('PreCompact', o);
  }

  /** Người dùng đang phải làm gì đó (vd. duyệt xin quyền): Notification. */
  async notification(message: string, type: string, signal: AbortSignal): Promise<void> {
    const o = await this.fire('Notification', { message, notification_type: type }, { signal, matchNames: [type] });
    this.report('Notification', o);
  }

  /** Cuộc trò chuyện kết thúc (mở cuộc mới / xoá / đóng cửa sổ). Chờ tối đa vài giây, không bao giờ ném lỗi. */
  async sessionEnd(sessionId: string, reason: 'clear' | 'delete' | 'close', waitMs = 5000): Promise<void> {
    if (!this.startedSessions.has(sessionId)) return;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), waitMs);
    try {
      const o = await this.fire('SessionEnd', { session_id: sessionId, reason }, { signal: ac.signal, matchNames: [reason] });
      this.report('SessionEnd', o);
    } catch {
      /* SessionEnd không được làm hỏng việc dọn dẹp */
    } finally {
      clearTimeout(timer);
      this.startedSessions.delete(sessionId);
    }
  }

  /** Bản mô tả markdown cho `/hooks`: hook đang hiệu lực theo nguồn + kết quả lần chạy gần nhất. */
  async describe(lang: Lang): Promise<string> {
    const L = (vi: string, en: string) => (lang === 'en' ? en : vi);
    const res = await this.load(true);
    const out: string[] = [];
    out.push(`**Hooks**`);
    const stateText: Record<HookSourceState, string> = {
      active: L('đang chạy', 'active'),
      'needs-approval': L('chờ xác nhận — gõ `/hooks trust`', 'awaiting approval — type `/hooks trust`'),
      declined: L('đã từ chối — gõ `/hooks trust` để xem lại', 'declined — type `/hooks trust` to review'),
      untrusted: L('workspace chưa tin cậy — không chạy', 'workspace not trusted — not running'),
      disabled: L('đã tắt (locaithAgent.hooksEnabled)', 'disabled (locaithAgent.hooksEnabled)'),
      absent: L('không có', 'none'),
      error: L('lỗi tệp', 'file error'),
    };
    const shown = res.sources.filter((s) => s.state !== 'absent' || s.kind === 'user');
    for (const s of shown) {
      out.push('');
      out.push(`- **${s.label}** — ${stateText[s.state]}${s.count ? ` (${s.count})` : ''}`);
      const mine = res.entries.filter((e) => e.source === s.kind);
      const pending = s.state === 'active' ? mine : [];
      for (const e of pending) {
        const last = [...this.recentRuns].reverse().find((r) => r.event === e.event && r.source === e.source && r.name === e.name);
        const lastText = last ? ` — ${L('lần gần nhất', 'last run')}: ${statusMark(last)} ${last.ms} ms${last.message ? ` · ${last.message}` : ''}` : '';
        out.push(`  - \`${e.event}\`${e.matcher ? ` [${e.matcher}]` : ''} · ${e.name} · \`${truncate(e.command, 90)}\`${lastText}`);
      }
      for (const w of s.warnings) out.push(`  - ${L('Cảnh báo', 'Warning')}: ${w}`);
    }
    if (!res.entries.length) {
      out.push('');
      out.push(L('Chưa có hook nào đang hiệu lực.', 'No hooks are in effect.'));
    }
    out.push('');
    out.push(L(`Sự kiện hỗ trợ: ${HOOK_EVENTS.join(', ')}.`, `Supported events: ${HOOK_EVENTS.join(', ')}.`));
    out.push(L('`/hooks open` mở tệp cấu hình của dự án · `/hooks open user` mở cài đặt người dùng · `/hooks trust` xem lại hook dự án.', '`/hooks open` opens the project config · `/hooks open user` opens user settings · `/hooks trust` re-reviews project hooks.'));
    return out.join('\n');
  }
}

function statusMark(r: HookRunRecord): string {
  return r.status === 'ok' ? '✓' : r.status === 'block' ? '✗ (chặn)' : r.status === 'timeout' ? '✗ (quá hạn)' : '✗';
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
