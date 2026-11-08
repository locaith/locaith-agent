/**
 * Mô-đun 2 — checkpoints + /rewind. Chụp BẢN GỐC của tệp trước khi trợ lý ghi lần đầu trong mỗi lượt (bọc `host.writeText`), kho ở
 * `~/.locaith/checkpoints/<phiên>/` (host/checkpoints/store.ts), cài đặt `checkpoints.enabled` (mặc định bật).
 *   • `status.changedFiles` = số tệp đổi trong lượt gần nhất (thanh «N tệp đã đổi»);
 *   • `/rewind` chọn lượt → chọn khôi phục mã / hội thoại / cả hai → xem trước từng tệp → xác nhận; tệp bị sửa SAU lần trợ lý ghi
 *     (xung đột) mặc định bị bỏ qua, chỉ ghi đè khi người dùng thấy cảnh báo và đồng ý rõ ràng;
 *   • `/rewind last` hoàn tác mã của lượt gần nhất (đường tắt cho thanh «N tệp đã đổi»), `/rewind redo` làm lại lần khôi phục vừa rồi;
 *   • khôi phục hội thoại cắt `session.messages` về trước tin đã chọn (đếm từ cuối, kiểm lại chữ) và phát `replay` reason 'rewind'.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { newId } from '../../../shared/transcript';
import { isTurnStart, rebuildTranscript, stripWrappers } from '../../../shared/transcriptRebuild';
import { applyPlan, fsRestoreIO, insideWorkspace, planRestore, redoRestore, type JournalEntry, type RestoreCtx, type RestorePlan } from '../../../host/checkpoints/restore';
import { CheckpointStore, sessionKey, type Snapshot, type StoredTurn } from '../../../host/checkpoints/store';
import type { ToolHost } from '../../../core/engine/types';
import type { RunExtension } from '../../../core/engine/seams';
import type { FeatureContext, FeatureModule, SlashRunContext } from '../contract';
import { asExt, askSlash, makeTr, oneLine } from './ext';

const tr = makeTr('rewind', {
  disabled: ['Chưa bật checkpoint (cài đặt `checkpoints.enabled`).', 'Checkpoints are off (setting `checkpoints.enabled`).'],
  nothing: ['Chưa có điểm quay lại nào trong cuộc trò chuyện này.', 'There is no restore point in this conversation yet.'],
  pickTurn: ['Quay lại tin nhắn nào?', 'Rewind to which message?'],
  pickWhat: ['Khôi phục gì?', 'Restore what?'],
  whatBoth: ['Cả mã và hội thoại', 'Code and conversation'],
  whatCode: ['Chỉ mã (tệp trở về như trước tin này)', 'Code only (files go back to before this message)'],
  whatConv: ['Chỉ hội thoại (giữ nguyên tệp)', 'Conversation only (keep files)'],
  files: ['{n} tệp', '{n} file(s)'],
  noFiles: ['không đổi tệp', 'no file changes'],
  undone: ['đã hoàn tác', 'undone'],
  cutNote: ['hội thoại đã cắt', 'conversation cut'],
  previewHead: ['**Xem trước khôi phục mã** ({n} tệp):', '**Restore preview** ({n} file(s)):'],
  noCodeChange: ['Mã đã đúng như điểm này — không có tệp nào cần khôi phục.', 'Code already matches this point — no file to restore.'],
  conflictWarn: ['{n} tệp đã bị sửa SAU lần trợ lý ghi (bạn hoặc lệnh shell). Ghi đè chúng?', '{n} file(s) were changed AFTER the assistant wrote them (by you or a shell command). Overwrite them?'],
  conflictYes: ['Ghi đè', 'Overwrite'],
  conflictNo: ['Bỏ qua các tệp đó', 'Skip those files'],
  confirmTitle: ['Khôi phục {n} tệp và/hoặc cắt hội thoại tới điểm đã chọn?', 'Restore {n} file(s) and/or rewind the conversation to the selected point?'],
  confirmYes: ['Khôi phục', 'Restore'],
  confirmNo: ['Huỷ', 'Cancel'],
  cancelled: ['Đã huỷ, không thay đổi gì.', 'Cancelled, nothing changed.'],
  needTrust: ['Thư mục chưa được tin cậy — không khôi phục mã được.', 'The folder is not trusted — code cannot be restored.'],
  noInteractive: ['`/rewind` cần giao diện tương tác để xác nhận.', '`/rewind` needs an interactive session to confirm.'],
  compacted: ['Phần hội thoại này đã được nén hoặc không khớp nên không cắt lại tới đây được. Chỉ khôi phục mã.', 'This part of the conversation was compacted or does not match, so it cannot be rewound. Restoring code only.'],
  done: ['Đã khôi phục {restored} tệp{skipped}{conv}.', 'Restored {restored} file(s){skipped}{conv}.'],
  skipped: [', bỏ qua {n} tệp', ', skipped {n} file(s)'],
  conv: ['; hội thoại đã quay lại trước tin «{text}»', '; conversation rewound to before “{text}”'],
  canRedo: ['Gõ `/rewind redo` để làm lại.', 'Type `/rewind redo` to redo.'],
  redone: ['Đã làm lại: {restored} tệp{skipped}.', 'Redone: {restored} file(s){skipped}.'],
  nothingRedo: ['Không còn gì để làm lại.', 'Nothing to redo.'],
  lastNone: ['Lượt gần nhất không đổi tệp nào (hoặc đã hoàn tác).', 'The latest turn changed no files (or it was already undone).'],
  usage: ['Dùng: `/rewind` (chọn điểm), `/rewind last` (hoàn tác mã của lượt gần nhất), `/rewind redo`.', 'Usage: `/rewind` (pick a point), `/rewind last` (undo the latest turn’s code), `/rewind redo`.'],
  busy: ['Hãy dừng tác vụ đang chạy trước.', 'Stop the running task first.'],
  reasonConflict: ['đã bị sửa sau đó', 'changed afterwards'],
  reasonOutside: ['ngoài thư mục làm việc', 'outside the workspace'],
  reasonBinary: ['tệp nhị phân', 'binary file'],
  reasonLarge: ['quá lớn', 'too large'],
  reasonBlob: ['mất bản gốc', 'original is missing'],
  reasonUnreadable: ['không đọc được', 'unreadable'],
});

interface PromptRec {
  promptId: string;
  text: string;
  ts: number;
  /** Hội thoại của lượt này đã bị cắt khỏi `messages` (khôi phục hội thoại): vẫn còn bản chụp tệp nhưng không cắt hội thoại tới đây được nữa. */
  cut?: boolean;
}

type What = 'code' | 'conversation' | 'both';

export class CheckpointFeature {
  readonly store: CheckpointStore;
  private current: { sessionId: string; promptId: string } | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private redo: { sessionId: string; journal: JournalEntry[]; turnIds: string[] } | null = null;
  private changed = 0;
  private statusRef: { refresh(): void } | null = null;
  private restoring = 0;

  constructor(private readonly ctx: FeatureContext) {
    this.store = new CheckpointStore(path.join(ctx.home, '.locaith', 'checkpoints'));
  }

  enabled(): boolean {
    return this.ctx.settings.get<boolean>('checkpoints.enabled', true) !== false;
  }

  private roots(): string[] {
    return this.ctx.host.workspaceRoots();
  }

  setStatus(ref: { refresh(): void }): void {
    this.statusRef = ref;
  }

  changedFiles(): number {
    return this.enabled() ? this.changed : 0;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const run = this.tail.then(fn, fn).catch((e) => {
      this.ctx.log('warn', `Checkpoint: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    });
    this.tail = run;
    return run;
  }

  /** Chờ mọi lần ghi nhận đang treo xong. */
  async flush(): Promise<void> {
    await this.tail;
  }

  // ── sidecar: chữ tin nhắn của từng lượt ──
  private promptsFile(sessionId: string): string {
    return path.join(this.store.root, sessionKey(sessionId), 'prompts.json');
  }

  private readPrompts(sessionId: string): PromptRec[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.promptsFile(sessionId), 'utf8')) as unknown;
      return Array.isArray(raw) ? raw.filter((r): r is PromptRec => !!r && typeof (r as PromptRec).promptId === 'string') : [];
    } catch {
      return [];
    }
  }

  private writePrompts(sessionId: string, recs: PromptRec[]): void {
    const file = this.promptsFile(sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(recs), 'utf8');
  }

  // ── ghi nhận ──
  beginTurn(promptId: string, text: string): void {
    if (!this.enabled()) return;
    const s = this.ctx.session();
    this.current = { sessionId: s.id, promptId };
    const todos = s.todos.map((x) => ({ ...x }));
    void this.enqueue(async () => {
      await this.store.beginTurn(s.id, promptId, todos);
      const recs = this.readPrompts(s.id);
      if (!recs.some((r) => r.promptId === promptId)) {
        recs.push({ promptId, text: text.slice(0, 600), ts: Date.now() });
        this.writePrompts(s.id, recs.slice(-60));
      }
    }).then(() => this.recount());
  }

  onWrite(abs: string, before: Snapshot, after: string): void {
    if (!this.enabled() || this.restoring > 0 || !this.current) return;
    const cur = this.current;
    void this.enqueue(async () => {
      const roots = this.roots();
      if (!(await insideWorkspace(abs, roots))) return; // chỉ theo dõi tệp trong workspace
      const root = roots.find((r) => !path.relative(path.resolve(r), path.resolve(abs)).startsWith('..')) ?? roots[0];
      const rel = path.relative(path.resolve(root), path.resolve(abs)).replace(/\\/g, '/');
      await this.store.record(cur.sessionId, cur.promptId, { abs, rel, before, after });
    }).then(() => this.recount());
  }

  /** Cập nhật số «tệp đã đổi» của lượt gần nhất cho dải trạng thái. */
  async recount(): Promise<void> {
    if (!this.enabled()) return;
    const sid = this.ctx.session().id;
    const turns = await this.store.turns(sid);
    const last = turns[turns.length - 1];
    const n = last && !last.undone ? last.files.length : 0;
    if (this.ctx.session().id === sid && n !== this.changed) {
      this.changed = n;
      this.statusRef?.refresh();
    }
  }

  onSessionChange(): void {
    this.current = null;
    this.changed = 0;
    this.redo = null;
    this.statusRef?.refresh();
    void this.recount();
  }

  private rctx(sessionId: string): RestoreCtx {
    return { store: this.store, sessionId, roots: this.roots(), io: fsRestoreIO };
  }

  // ── /rewind ──
  private reasonText(lang: 'vi' | 'en', reason: string | undefined): string {
    switch (reason) {
      case 'conflict': return tr(lang, 'reasonConflict');
      case 'outside': return tr(lang, 'reasonOutside');
      case 'binary': return tr(lang, 'reasonBinary');
      case 'too_large': return tr(lang, 'reasonLarge');
      case 'missing_blob': return tr(lang, 'reasonBlob');
      case 'unreadable': return tr(lang, 'reasonUnreadable');
      default: return reason ?? '';
    }
  }

  private previewMarkdown(plan: RestorePlan, lang: 'vi' | 'en'): string {
    const lines = plan.entries.slice(0, 60).map((e) => {
      if (e.action === 'skip') return `- ${e.rel} — ${this.reasonText(lang, e.reason)}`;
      const warn = e.conflict ? `⚠ ${tr(lang, 'reasonConflict')} · ` : '';
      return `- ${warn}**${e.action}** \`${e.rel}\` (+${e.added} −${e.removed})`;
    });
    const more = plan.entries.length > 60 ? `\n… +${plan.entries.length - 60}` : '';
    return `${tr(lang, 'previewHead', { n: plan.entries.length })}\n${lines.join('\n')}${more}`;
  }

  private turnItems(turns: StoredTurn[], lang: 'vi' | 'en') {
    const recs = new Map(this.readPrompts(this.ctx.session().id).map((r) => [r.promptId, r]));
    return [...turns].reverse().slice(0, 25).map((t) => {
      const rec = recs.get(t.promptId);
      const bits = [t.files.length ? tr(lang, 'files', { n: t.files.length }) : tr(lang, 'noFiles')];
      if (t.undone) bits.push(tr(lang, 'undone'));
      if (rec?.cut) bits.push(tr(lang, 'cutNote'));
      return { id: t.promptId, label: oneLine(rec?.text || t.promptId, 70), detail: bits.join(' · ') };
    });
  }

  /** Điểm vào chung của `/rewind`. */
  async run(c: SlashRunContext): Promise<void> {
    const lang = c.lang;
    if (!this.enabled()) return c.output(tr(lang, 'disabled'), 'plain');
    if (this.ctx.isBusy()) return c.output(tr(lang, 'busy'), 'plain');
    await this.flush();
    const arg = c.args.trim().toLowerCase();
    if (arg === 'redo') return this.doRedo(c);
    if (arg === 'last' || arg === 'undo') return this.undoLast(c);
    if (arg) return c.output(tr(lang, 'usage'), 'plain');
    if (!this.ctx.interactive) return c.output(tr(lang, 'noInteractive'), 'plain');

    const sid = this.ctx.session().id;
    const turns = await this.store.turns(sid);
    if (!turns.length) return c.output(tr(lang, 'nothing'), 'plain');
    const promptId = await askSlash(c, { kind: 'pick', title: tr(lang, 'pickTurn'), items: this.turnItems(turns, lang), searchable: true, allowCancel: true });
    if (typeof promptId !== 'string') return c.output(tr(lang, 'cancelled'), 'plain');
    const cutOk = !this.readPrompts(sid).find((r) => r.promptId === promptId)?.cut;
    const items = [
      ...(cutOk ? [{ id: 'both', label: tr(lang, 'whatBoth') }] : []),
      { id: 'code', label: tr(lang, 'whatCode') },
      ...(cutOk ? [{ id: 'conversation', label: tr(lang, 'whatConv') }] : []),
    ];
    const what = await askSlash(c, { kind: 'pick', title: tr(lang, 'pickWhat'), items, allowCancel: true });
    if (what !== 'both' && what !== 'code' && what !== 'conversation') return c.output(tr(lang, 'cancelled'), 'plain');
    await this.restore(c, promptId, what, 'from');
  }

  private async undoLast(c: SlashRunContext): Promise<void> {
    const sid = this.ctx.session().id;
    const turns = await this.store.turns(sid);
    const last = [...turns].reverse().find((t) => t.files.length > 0);
    if (!last || last.undone || last !== turns[turns.length - 1]) return c.output(tr(c.lang, 'lastNone'), 'plain');
    await this.restore(c, last.promptId, 'code', 'turn');
  }

  /** Lập kế hoạch → xem trước → xác nhận → áp dụng. */
  private async restore(c: SlashRunContext, promptId: string, what: What, scope: 'from' | 'turn'): Promise<void> {
    const lang = c.lang;
    const sid = this.ctx.session().id;
    if (what !== 'conversation' && !this.ctx.isTrusted()) return c.output(tr(lang, 'needTrust'), 'error');
    if (!this.ctx.interactive) return c.output(tr(lang, 'noInteractive'), 'plain');

    let plan: RestorePlan | null = null;
    if (what !== 'conversation') {
      plan = await planRestore(this.rctx(sid), promptId, { scope });
      if (plan.entries.length) c.output(this.previewMarkdown(plan, lang), 'markdown');
      else if (what === 'code') return c.output(tr(lang, 'noCodeChange'), 'plain');
    }
    let cut: ReturnType<CheckpointFeature['planCut']> | null = null;
    if (what !== 'code') {
      cut = this.planCut(promptId);
      if ('error' in cut) {
        c.output(tr(lang, 'compacted'), 'plain');
        if (what === 'conversation') return;
        cut = null;
        what = 'code';
      }
    }
    const conflicts = (plan?.entries ?? []).filter((e) => e.conflict);
    let allow = new Set<string>();
    if (conflicts.length) {
      const ans = await askSlash(c, { kind: 'confirm', title: tr(lang, 'conflictWarn', { n: conflicts.length }), detail: conflicts.map((e) => `• ${e.rel}`).join('\n'), yes: tr(lang, 'conflictYes'), no: tr(lang, 'conflictNo'), defaultYes: false, danger: true });
      if (ans === true) allow = new Set(conflicts.map((e) => e.rel));
    }
    const writes = (plan?.entries ?? []).filter((e) => e.action !== 'skip' && (!e.conflict || allow.has(e.rel))).length;
    const ok = await askSlash(c, { kind: 'confirm', title: tr(lang, 'confirmTitle', { n: writes }), yes: tr(lang, 'confirmYes'), no: tr(lang, 'confirmNo'), defaultYes: false });
    if (ok !== true) return c.output(tr(lang, 'cancelled'), 'plain');

    let restored = 0;
    let skipped = 0;
    if (plan) {
      this.restoring++;
      try {
        const res = await applyPlan(this.rctx(sid), plan, { allowConflicts: allow });
        restored = res.restored;
        skipped = res.skipped.length;
        this.redo = res.journal.length ? { sessionId: sid, journal: res.journal, turnIds: plan.turnIds } : null;
        const s = this.ctx.session();
        for (const j of res.journal) delete s.readFiles[j.abs]; // buộc đọc lại trước khi sửa tiếp
        if (restored > 0 && skipped === 0) await this.store.markUndone(sid, plan.turnIds, true);
      } finally {
        this.restoring--;
      }
    }

    let convText = '';
    if (cut && !('error' in cut)) {
      const s = this.ctx.session();
      const turn = (await this.store.turns(sid)).find((t) => t.promptId === promptId);
      s.messages = cut.kept;
      s.lastContextTokens = 0; // số đo của lịch sử DÀI đã bị cắt sẽ làm đồng hồ ngữ cảnh sai
      s.options = undefined;
      if (turn?.todos) s.todos = turn.todos.map((x) => ({ ...x }));
      // Các lượt từ điểm này về sau không còn trong `messages`: đánh dấu để đếm-từ-cuối không tính chúng nữa.
      const recs = this.readPrompts(sid);
      const at = recs.findIndex((r) => r.promptId === promptId);
      const fullyBack = what === 'both' && skipped === 0;
      if (at >= 0) this.writePrompts(sid, fullyBack ? recs.slice(0, at) : recs.map((r, i) => (i >= at ? { ...r, cut: true } : r)));
      if (fullyBack) await this.store.dropFrom(sid, promptId);
      this.ctx.emit({ t: 'replay', items: rebuildTranscript(s.messages), reason: 'rewind' });
      await asExt(this.ctx).saveSession?.();
      asExt(this.ctx).setDraft?.(cut.text);
      convText = tr(lang, 'conv', { text: oneLine(cut.text, 50) });
    }
    await this.recount();
    const msg = tr(lang, 'done', { restored, skipped: skipped ? tr(lang, 'skipped', { n: skipped }) : '', conv: convText });
    c.output(this.redo ? `${msg} ${tr(lang, 'canRedo')}` : msg, 'plain');
  }

  /** Tính điểm cắt hội thoại (không đụng gì): đếm từ cuối các lượt còn trong `messages`, rồi kiểm lại chữ. */
  planCut(promptId: string): { kept: import('../../../core/types').ChatMessage[]; text: string; at: number } | { error: 'compacted' | 'not_found' } {
    const s = this.ctx.session();
    const recs = this.readPrompts(s.id).filter((r) => !r.cut);
    const idx = recs.findIndex((r) => r.promptId === promptId);
    if (idx < 0) return { error: 'not_found' };
    const after = recs.length - 1 - idx;
    const starts: number[] = [];
    s.messages.forEach((m, i) => {
      if (isTurnStart(m)) starts.push(i);
    });
    const at = starts.length - 1 - after;
    if (at < 0) return { error: 'compacted' };
    const m = s.messages[starts[at]];
    const msgText = stripWrappers(m.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n')).replace(/\s+/g, ' ').trim();
    const want = stripWrappers(recs[idx].text).replace(/\s+/g, ' ').trim();
    const head = want.slice(0, 40);
    if (head && !msgText.startsWith(head) && !want.startsWith(msgText.slice(0, 40))) return { error: 'compacted' };
    return { kept: s.messages.slice(0, starts[at]), text: recs[idx].text, at: starts[at] };
  }

  private async doRedo(c: SlashRunContext): Promise<void> {
    const lang = c.lang;
    const r = this.redo;
    const sid = this.ctx.session().id;
    if (!r || r.sessionId !== sid) return c.output(tr(lang, 'nothingRedo'), 'plain');
    this.restoring++;
    let restored = 0;
    let skipped = 0;
    try {
      const res = await redoRestore(this.rctx(sid), r.journal);
      restored = res.restored;
      skipped = res.skipped.length;
      for (const j of res.journal) delete this.ctx.session().readFiles[j.abs];
    } finally {
      this.restoring--;
    }
    this.redo = null;
    await this.store.markUndone(sid, r.turnIds, false);
    await this.recount();
    c.output(tr(lang, 'redone', { restored, skipped: skipped ? tr(lang, 'skipped', { n: skipped }) : '' }), 'plain');
  }
}

const instances = new WeakMap<FeatureContext, CheckpointFeature>();
export const checkpointFeatureOf = (ctx: FeatureContext): CheckpointFeature | undefined => instances.get(ctx);

const WRAPPED = Symbol.for('locaith.checkpoints.wrapped');

/** Bọc `host.writeText` để chụp bản gốc. Trả về hàm gỡ. */
function wrapHost(host: ToolHost, feature: CheckpointFeature): () => void {
  const h = host as ToolHost & { [WRAPPED]?: unknown };
  const orig = host.writeText.bind(host);
  host.writeText = async (abs, content) => {
    let before: Snapshot = null;
    if (feature.enabled()) {
      try {
        const r = await fsRestoreIO.read(abs);
        before = r;
      } catch {
        before = { skipped: 'unreadable' };
      }
    }
    await orig(abs, content);
    feature.onWrite(abs, before, content);
  };
  h[WRAPPED] = true;
  return () => {
    host.writeText = orig;
    delete h[WRAPPED];
  };
}

export const checkpointsFeature: FeatureModule = {
  name: 'checkpoints',
  attach(ctx) {
    const feature = new CheckpointFeature(ctx);
    instances.set(ctx, feature);
    void feature.store.gc().catch(() => undefined);
    const unwrap = wrapHost(ctx.host, feature);

    const ext: RunExtension = {
      id: 'checkpoints',
      begin(scope) {
        if (scope.session !== ctx.session()) return undefined; // agent con: ghi tệp của nó đi vào lượt hiện tại của luồng chính
        const text = scope.input.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        feature.beginTurn(newId('u'), stripWrappers(text) || text);
        return undefined;
      },
    };
    ctx.addRunExtension(ext, { subAgents: true });

    feature.setStatus(
      ctx.addStatusContributor((s) => {
        const n = feature.changedFiles();
        if (n > 0) s.changedFiles = n;
      }),
    );
    ctx.onSessionChange(() => feature.onSessionChange());
    void feature.recount();

    ctx.slash({
      name: 'rewind',
      description: {
        vi: 'Quay lại một tin nhắn trước: khôi phục mã, hội thoại hoặc cả hai — /rewind last hoàn tác lượt gần nhất',
        en: 'Rewind to an earlier message: restore code, conversation or both — /rewind last undoes the latest turn',
      },
      argHint: '[last|redo]',
      needsIdle: true,
      run: (c) => feature.run(c),
    });

    return () => {
      unwrap();
    };
  },
};
