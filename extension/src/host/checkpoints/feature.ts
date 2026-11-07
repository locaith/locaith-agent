/**
 * (lane:checkpoints-rewind) Phần keo giữa kho checkpoint / khôi phục và ChatController: ghi nhận lần ghi tệp của trợ lý, dựng
 * `ViewState.checkpoints`, xử lý các tin `rewind_*` / `checkpoint_diff` và lệnh `/rewind`.
 *
 * ChatController chỉ gọi vài điểm: `beginTurn` (khi tin người dùng mở lượt), `baseField` (baseView), `handle` (onMessage/handleRemote),
 * `registerSlash`, `removeSession`. Mọi thứ phụ thuộc VS Code đi qua `FeatureDeps` nên kiểm thử được bằng host giả.
 */

import * as path from 'node:path';
import type { Lang } from '../../core/engine/strings';
import type { SessionState } from '../../core/engine/types';
import { cutConversation, type ConversationCut } from '../../shared/rewindConversation';
import type { CheckpointSkip, CheckpointTurn, RewindPlanFile, RewindRecent, RewindScope, RewindView, RewindWhat } from '../../shared/checkpoints';
import type { UserItem, ViewState, WebviewMessage } from '../../shared/protocol';
import type { SlashRegistry } from '../slashRegistry';
import { applyPlan, insideWorkspace, planRestore, redoRestore, turnOriginal, type JournalEntry, type RestoreIO, type RestorePlan } from './restore';
import { CheckpointStore, type Snapshot } from './store';

export interface FeatureDeps {
  /** Thư mục gốc kho (globalStorage/checkpoints). Vắng = tính năng tắt (kiểm thử đơn vị, bản không có lưu trữ). */
  storageRoot: string | undefined;
  enabled(): boolean;
  lang(): Lang;
  roots(): string[];
  io: RestoreIO;
  session(): SessionState;
  view(): ViewState;
  patch(p: Partial<ViewState>): void;
  busy(): boolean;
  trusted(): boolean;
  toast(level: 'info' | 'warn' | 'error', text: string): void;
  /** Đưa chữ/tệp của tin người dùng về ô nhập. */
  draft(item: UserItem): void;
  save(): Promise<void>;
  /** Xin người dùng xác nhận qua đúng cổng quyền của khung chat (cũng trả lời được từ Remote). */
  askApproval(title: string, detail: string): Promise<boolean>;
  openDiff(rel: string, abs: string, before: string | null): Promise<void>;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  now?: () => number;
}

export type RewindMessage = Extract<WebviewMessage, { type: 'rewind_open' | 'rewind_plan' | 'rewind_apply' | 'rewind_cancel' | 'rewind_redo' | 'checkpoint_diff' }>;
export const REWIND_TYPES: ReadonlySet<string> = new Set(['rewind_open', 'rewind_plan', 'rewind_apply', 'rewind_cancel', 'rewind_redo', 'checkpoint_diff']);
export const isRewindMessage = (m: { type: string }): m is RewindMessage => REWIND_TYPES.has(m.type);

interface HeldPlan {
  sessionId: string;
  promptId: string;
  what: RewindWhat;
  scope: RewindScope;
  plan: RestorePlan | null;
  /** Tệp xung đột người dùng ĐÃ THẤY cảnh báo ở thẻ xem trước — chỉ những tệp này được phép ghi đè. */
  allow: Set<string>;
}

interface HeldRedo {
  sessionId: string;
  journal: JournalEntry[];
  turnIds: string[];
}

const MAX_VIEW_FILES = 200;
const RECENT = 8;

export class CheckpointFeature {
  readonly store: CheckpointStore | undefined;
  private current: { sessionId: string; promptId: string } | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private restoring = 0;
  private held: HeldPlan | null = null;
  private redo: HeldRedo | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly d: FeatureDeps) {
    this.store = d.storageRoot ? new CheckpointStore(d.storageRoot, d.now ? { now: d.now } : {}) : undefined;
  }

  private t(vi: string, en: string): string {
    return this.d.lang() === 'vi' ? vi : en;
  }

  /** Tính năng đang bật và có chỗ lưu. */
  supported(): boolean {
    return !!this.store && this.d.enabled();
  }

  /** Dọn kho cũ khi khởi động (nền, không chặn). */
  gc(): void {
    void this.store?.gc().catch(() => undefined);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Xoá hẳn dữ liệu checkpoint của một phiên (xoá vĩnh viễn khỏi Thùng rác). */
  removeSession(sessionId: string): Promise<void> {
    return this.store?.removeSession(sessionId) ?? Promise.resolve();
  }

  // ── ghi nhận ──────────────────────────────────────────────────────────────

  /** Một tin người dùng MỞ LƯỢT vừa xuất hiện: lượt này là «điểm quay lại». */
  beginTurn(promptId: string): void {
    if (!this.supported()) return;
    const s = this.d.session();
    this.current = { sessionId: s.id, promptId };
    const todos = s.todos.map((x) => ({ ...x }));
    this.enqueue(() => this.store!.beginTurn(s.id, promptId, todos)).then(() => this.schedule());
  }

  /** Gọi từ ToolHost.writeText SAU khi ghi thành công: `before` là nội dung trước đó (null = chưa có). */
  onWrite(abs: string, before: Snapshot, after: string): void {
    if (!this.supported() || this.restoring > 0 || !this.current) return;
    const cur = this.current;
    this.enqueue(async () => {
      const roots = this.d.roots();
      if (!(await insideWorkspace(abs, roots))) return; // chỉ theo dõi tệp trong workspace
      const root = roots.find((r) => !path.relative(path.resolve(r), path.resolve(abs)).startsWith('..')) ?? roots[0];
      const rel = path.relative(path.resolve(root), path.resolve(abs)).replace(/\\/g, '/');
      await this.store!.record(cur.sessionId, cur.promptId, { abs, rel, before, after });
    }).then(() => this.schedule());
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const run = this.tail.then(fn, fn).catch((e) => {
      this.d.log('warn', `Checkpoint: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    });
    this.tail = run;
    return run;
  }

  /** Chờ mọi lần ghi nhận đang treo xong (kiểm thử và trước khi khôi phục). */
  async flush(): Promise<void> {
    await this.tail;
  }

  private schedule(): void {
    if (this.timer || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, 120);
  }

  /** Đẩy `checkpoints` mới nhất lên giao diện (chỉ khi còn là phiên đang xem). */
  async refresh(): Promise<void> {
    if (!this.supported() || this.disposed) return;
    const sid = this.d.session().id;
    const turns = await this.store!.turns(sid);
    if (this.d.session().id !== sid) return;
    this.d.patch({ checkpoints: this.store!.summarize(turns) });
  }

  /** Trường `checkpoints` cho baseView: vắng = host không hỗ trợ. Phiên chưa nạp thì nạp nền rồi tự cập nhật. */
  baseField(): { checkpoints?: CheckpointTurn[] } {
    if (!this.supported()) return {};
    const cached = this.store!.cached(this.d.session().id);
    if (!cached) {
      void this.refresh();
      return { checkpoints: [] };
    }
    return { checkpoints: this.store!.summarize(cached) };
  }

  // ── tin từ giao diện / Remote ─────────────────────────────────────────────

  async handle(m: RewindMessage, origin: { remote?: string } = {}): Promise<void> {
    if (!this.supported()) return;
    // Bản Remote chỉ được dùng các bước xem trước/xác nhận; mở diff cần editor của VS Code.
    if (origin.remote && m.type === 'checkpoint_diff') return;
    await this.flush();
    switch (m.type) {
      case 'rewind_open':
        return this.open(m.promptId, m.list === true);
      case 'rewind_plan':
        return this.makePlan(m);
      case 'rewind_apply':
        return this.apply(origin);
      case 'rewind_cancel':
        this.held = null;
        this.d.patch({ rewind: null });
        return;
      case 'rewind_redo':
        return this.doRedo();
      case 'checkpoint_diff':
        return this.diff(m.promptId, m.rel);
    }
  }

  private fail(promptId: string, text: string, stage: RewindView['stage'] = 'menu'): void {
    this.d.patch({ rewind: { promptId, stage, error: text } });
  }

  private busyNote(): boolean {
    if (!this.d.busy()) return false;
    this.d.toast('info', this.t('Hãy dừng tác vụ đang chạy trước.', 'Stop the running task first.'));
    return true;
  }

  private async open(promptId: string, list: boolean): Promise<void> {
    if (this.busyNote()) return;
    const sid = this.d.session().id;
    const turns = await this.store!.turns(sid);
    if (!turns.some((t) => t.promptId === promptId)) return this.fail(promptId, this.t('Tin nhắn này không có điểm quay lại (cuộc trò chuyện cũ hoặc đã quá hạn lưu).', 'This message has no restore point (older conversation or past retention).'));
    this.held = null;
    this.d.patch({ rewind: { promptId, stage: 'menu', ...(list ? { recent: this.recent(turns) } : {}) } });
  }

  /** Các tin gần đây (có điểm quay lại), mới nhất trước. */
  recent(turns: readonly { promptId: string; files: unknown[] }[]): RewindRecent[] {
    const byId = new Map(turns.map((t) => [t.promptId, t.files.length]));
    const out: RewindRecent[] = [];
    const tr = this.d.view().transcript;
    for (let i = tr.length - 1; i >= 0 && out.length < RECENT; i--) {
      const it = tr[i];
      if (it.kind !== 'user' || it.steer || !byId.has(it.id)) continue;
      out.push({ promptId: it.id, text: it.text.replace(/\s+/g, ' ').trim().slice(0, 80), files: byId.get(it.id)! });
    }
    return out;
  }

  /** `/rewind`: mở thẻ với danh sách tin gần đây; chọn sẵn tin mới nhất. */
  openPicker(): boolean {
    if (!this.supported()) return false;
    const turns = this.store!.cached(this.d.session().id) ?? [];
    const recent = this.recent(turns);
    if (recent.length === 0) return false;
    this.held = null;
    this.d.patch({ rewind: { promptId: recent[0].promptId, stage: 'menu', recent } });
    return true;
  }

  private ctx(sessionId: string) {
    return { store: this.store!, sessionId, roots: this.d.roots(), io: this.d.io };
  }

  private async makePlan(m: Extract<RewindMessage, { type: 'rewind_plan' }>): Promise<void> {
    if (this.busyNote()) return;
    const what: RewindWhat = m.what === 'code' || m.what === 'conversation' || m.what === 'both' ? m.what : 'both';
    const scope: RewindScope = what === 'code' && m.scope === 'turn' ? 'turn' : 'from';
    const files = Array.isArray(m.files) ? m.files.filter((f): f is string => typeof f === 'string').slice(0, MAX_VIEW_FILES).map((f) => f.replace(/\\/g, '/')) : undefined;
    const sid = this.d.session().id;
    const turns = await this.store!.turns(sid);
    if (!turns.some((t) => t.promptId === m.promptId)) return this.fail(m.promptId, this.t('Không còn điểm quay lại cho tin này.', 'The restore point for this message is gone.'));
    if ((what === 'code' || what === 'both') && !this.d.trusted()) return this.fail(m.promptId, this.t('Workspace chưa được tin cậy — không khôi phục mã được.', 'The workspace is not trusted — code cannot be restored.'));

    let plan: RestorePlan | null = null;
    if (what !== 'conversation') plan = await planRestore(this.ctx(sid), m.promptId, { scope, ...(files ? { files } : {}) });
    let cut: ConversationCut | null = null;
    if (what !== 'code') {
      const r = cutConversation(this.d.session().messages, this.d.view().transcript, m.promptId);
      if ('error' in r) {
        return this.fail(
          m.promptId,
          r.error === 'compacted' ? this.t('Phần hội thoại này đã được nén nên không cắt lại tới đây được.', 'This part of the conversation was compacted and cannot be rewound to.') : this.t('Không tìm thấy tin này trong hội thoại.', 'Could not find this message in the conversation.'),
        );
      }
      cut = r;
    }
    const entries = plan?.entries ?? [];
    const allow = new Set(entries.filter((e) => e.conflict).map((e) => e.rel));
    this.held = { sessionId: sid, promptId: m.promptId, what, scope, plan, allow };
    const shown: RewindPlanFile[] = entries.slice(0, MAX_VIEW_FILES).map((e) => ({
      rel: e.rel,
      action: e.action,
      added: e.added,
      removed: e.removed,
      ...(e.conflict ? { conflict: true } : {}),
      ...(e.reason ? { reason: e.reason as CheckpointSkip } : {}),
    }));
    this.d.patch({
      rewind: {
        promptId: m.promptId,
        stage: 'plan',
        what,
        scope,
        files: shown,
        conflicts: allow.size,
        ...(cut ? { messages: cut.removedItems } : {}),
        ...(this.d.view().rewind?.recent ? { recent: this.d.view().rewind!.recent } : {}),
      },
    });
  }

  private async apply(origin: { remote?: string }): Promise<void> {
    const h = this.held;
    const sid = this.d.session().id;
    if (!h || h.sessionId !== sid) return this.fail(this.d.view().rewind?.promptId ?? '', this.t('Kế hoạch đã cũ — hãy mở lại «Quay lại».', 'The plan is stale — open “Rewind” again.'));
    if (this.busyNote()) return;
    const writes = (h.plan?.entries ?? []).filter((e) => e.action !== 'skip').length;
    if (writes > 0 && !this.d.trusted()) return this.fail(h.promptId, this.t('Workspace chưa được tin cậy — không khôi phục mã được.', 'The workspace is not trusted — code cannot be restored.'));
    // Điều khiển từ xa: ghi tệp phải qua đúng cổng quyền hiện có (chế độ Tự nhận sửa/Bỏ qua = đã đồng ý sửa tệp; còn lại hỏi ngay trong khung chat).
    if (origin.remote && writes > 0) {
      const mode = this.d.session().mode;
      if (mode !== 'bypass' && mode !== 'acceptEdits') {
        const ok = await this.d.askApproval(
          this.t(`Khôi phục ${writes} tệp về điểm đã chọn?`, `Restore ${writes} file(s) to the selected point?`),
          (h.plan?.entries ?? []).slice(0, 12).map((e) => `${e.action} ${e.rel}`).join('\n'),
        );
        if (!ok) return this.d.patch({ rewind: { ...(this.d.view().rewind ?? { promptId: h.promptId }), promptId: h.promptId, stage: 'plan', error: this.t('Chưa được cho phép.', 'Not approved.') } });
        if (this.busyNote()) return;
      }
    }
    // Cắt hội thoại: tính trước khi đụng tới đĩa, để lỗi (đã nén…) không để lại trạng thái nửa vời.
    let cut: ConversationCut | null = null;
    if (h.what !== 'code') {
      const r = cutConversation(this.d.session().messages, this.d.view().transcript, h.promptId);
      if ('error' in r) return this.fail(h.promptId, this.t('Không cắt được hội thoại tới tin này.', 'Could not rewind the conversation to this message.'));
      cut = r;
    }
    const prevRewind = this.d.view().rewind;
    this.d.patch({ rewind: { ...(prevRewind ?? { promptId: h.promptId }), promptId: h.promptId, stage: 'applying', what: h.what } });

    let restored = 0;
    let skipped = 0;
    if (h.plan) {
      this.restoring++;
      try {
        const res = await applyPlan(this.ctx(sid), h.plan, { allowConflicts: h.allow });
        restored = res.restored;
        skipped = res.skipped.length;
        this.redo = res.journal.length ? { sessionId: sid, journal: res.journal, turnIds: h.plan.turnIds } : null;
        const s = this.d.session();
        for (const j of res.journal) delete s.readFiles[j.abs]; // buộc đọc lại trước khi sửa tiếp: nội dung đã khác lần đọc cũ
        if (restored > 0 && skipped === 0) await this.store!.markUndone(sid, h.plan.turnIds, true);
      } finally {
        this.restoring--;
      }
    }

    if (cut) {
      const s = this.d.session();
      const turn = (await this.store!.turns(sid)).find((t) => t.promptId === h.promptId);
      s.messages = cut.keptMessages;
      s.options = undefined;
      const todos = turn?.todos ? turn.todos.map((x) => ({ ...x })) : s.todos;
      s.todos = todos;
      this.d.patch({ transcript: cut.keptTranscript, todos, options: undefined });
      // Chỉ bỏ bản ghi checkpoint khi cả mã cũng đã quay lại; «chỉ hội thoại» giữ lại để các lần quay lại SAU này vẫn khôi phục được tệp đã đổi.
      if (h.what === 'both') await this.store!.dropFrom(sid, h.promptId);
      this.d.draft(cut.item);
      await this.d.save();
    }
    this.held = null;
    await this.refresh();
    this.d.patch({
      rewind: {
        promptId: h.promptId,
        stage: 'done',
        what: h.what,
        scope: h.scope,
        restored,
        ...(skipped ? { skipped } : {}),
        ...(cut ? { messages: cut.removedItems } : {}),
        canRedo: !!this.redo,
      },
    });
  }

  private async doRedo(): Promise<void> {
    const r = this.redo;
    const sid = this.d.session().id;
    if (!r || r.sessionId !== sid) return this.fail(this.d.view().rewind?.promptId ?? '', this.t('Không còn gì để làm lại.', 'Nothing to redo.'), 'done');
    if (this.busyNote()) return;
    this.restoring++;
    let restored = 0;
    let skipped = 0;
    try {
      const res = await redoRestore(this.ctx(sid), r.journal);
      restored = res.restored;
      skipped = res.skipped.length;
      const s = this.d.session();
      for (const j of res.journal) delete s.readFiles[j.abs];
    } finally {
      this.restoring--;
    }
    this.redo = null;
    await this.store!.markUndone(sid, r.turnIds, false);
    await this.refresh();
    const promptId = this.d.view().rewind?.promptId ?? '';
    this.d.patch({ rewind: { promptId, stage: 'done', what: 'code', restored, redone: true, ...(skipped ? { skipped } : {}), canRedo: false } });
  }

  private async diff(promptId: string, rel: string): Promise<void> {
    const sid = this.d.session().id;
    const turn = (await this.store!.turns(sid)).find((t) => t.promptId === promptId);
    const f = turn?.files.find((x) => x.rel === rel);
    if (!f || !(await insideWorkspace(f.abs, this.d.roots()))) return this.d.toast('warn', this.t('Không mở được diff cho tệp này.', 'Cannot open a diff for this file.'));
    const before = await turnOriginal(this.store!, sid, promptId, rel);
    if (before === undefined) return this.d.toast('info', this.t('Tệp này không có bản gốc để so (quá lớn hoặc không phải văn bản).', 'No original to compare (too large or not text).'));
    await this.d.openDiff(rel, f.abs, before);
  }

  // ── /rewind ───────────────────────────────────────────────────────────────

  registerSlash(reg: SlashRegistry): void {
    reg.register({
      name: 'rewind',
      description: { vi: 'Quay lại một tin nhắn trước: khôi phục mã, hội thoại hoặc cả hai', en: 'Rewind to an earlier message: restore code, conversation or both' },
      needsIdle: true,
      run: (ctx) => {
        if (!this.supported()) return ctx.warn(this.t('Chưa bật checkpoint (cài đặt locaithAgent.checkpoints.enabled).', 'Checkpoints are off (setting locaithAgent.checkpoints.enabled).'));
        if (!this.openPicker()) ctx.info(this.t('Chưa có điểm quay lại nào trong cuộc trò chuyện này.', 'There is no restore point in this conversation yet.'));
      },
    });
  }
}
