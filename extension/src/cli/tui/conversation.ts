/**
 * Trình bày hội thoại: biến luồng `UiEvent` thành DÒNG ĐÃ HOÀN CHỈNH (in vào scrollback) + vài dòng «sống» (văn bản đang stream,
 * lệnh đang chạy). Dùng lại `applyEvent` của extension (shared/transcript.ts) để giữ mô hình; không chứa I/O.
 *
 * Thứ tự in theo thứ tự khối của lượt trả lời: khối chữ in dần theo dòng; khối công cụ chỉ in khi đã xong (đầu + kết quả);
 * ≥ 3 lệnh đọc/tìm liền nhau được gom thành một dòng.
 */

import type { ABlock, AssistantItem, CompactInfo, TItem, ToolBlock, UiEvent, VerifyInfo } from '../../shared/protocol';
import { applyEvent } from '../../shared/transcript';
import { t as tr, type Lang } from '../i18n';
import { fmtDuration, fmtTokens } from './format';
import { MarkdownStream, renderMarkdown } from './markdown';
import './strings';
import type { Theme } from './theme';
import { describeCall, isGroupable, renderToolBlock, renderToolGroup, renderToolLive, type ToolRenderOptions } from './toolFormat';
import { padEnd, truncateAnsi, wrapAnsi } from './width';

export interface ConvOptions {
  theme: Theme;
  width(): number;
  cwd(): string;
  expanded(): boolean;
  lang(): Lang;
  print(lines: string[]): void;
}

type Kind = 'user' | 'text' | 'tool' | 'think' | 'notice' | 'misc';

const SETTLED: ReadonlySet<string> = new Set(['done', 'error', 'denied', 'cancelled']);

export class Conversation {
  items: TItem[] = [];
  private cur: { id: string; cursor: number; startedAt: number } | null = null;
  private stream: MarkdownStream | null = null;
  private streamIdx = -1;
  private streamFed = 0;
  private pendingGroup: ToolBlock[] = [];
  private lastKind: Kind | null = null;
  private usageOut = 0;
  private streamChars = 0;
  /** Lệnh gần nhất có kết quả bị rút gọn (Ctrl+O in đầy đủ). */
  lastExpandable: ToolBlock | null = null;
  /** Số lượt người dùng đã gửi (để quyết định gợi ý «tiếp tục phiên» khi thoát). */
  userMessages = 0;

  constructor(private readonly o: ConvOptions) {}

  private get th(): Theme {
    return this.o.theme;
  }

  private toolOpts(extra: Partial<ToolRenderOptions> = {}): ToolRenderOptions {
    return { theme: this.th, width: this.o.width(), cwd: this.o.cwd(), expanded: this.o.expanded(), ...extra };
  }

  // ───────────── in ra scrollback ─────────────

  private emit(kind: Kind, lines: string[], spaced = true): void {
    if (!lines.length) return;
    const out: string[] = [];
    if (spaced && this.lastKind !== null && !(this.lastKind === kind && (kind === 'tool' || kind === 'notice' || kind === 'think')) && !(kind === 'tool' && this.lastKind === 'think')) out.push('');
    out.push(...lines);
    this.lastKind = kind;
    this.o.print(out);
  }

  /** Dòng trống đầu tiên của vùng sống tách khỏi nội dung đã in. */
  get hasPrinted(): boolean {
    return this.lastKind !== null;
  }

  reset(): void {
    this.items = [];
    this.cur = null;
    this.stream = null;
    this.streamIdx = -1;
    this.streamFed = 0;
    this.pendingGroup = [];
    this.lastKind = null;
    this.usageOut = 0;
    this.streamChars = 0;
    this.lastExpandable = null;
  }

  // ───────────── sự kiện ─────────────

  ui(ev: UiEvent): void {
    switch (ev.t) {
      case 'user': {
        this.finishAssistant();
        this.items = applyEvent(this.items, ev);
        this.userMessages++;
        this.emit('user', this.renderUser(ev.text, ev.attachments.map((a) => a.label || a.kind), !!ev.steer));
        return;
      }
      case 'assistant_start': {
        this.finishAssistant();
        this.items = applyEvent(this.items, ev);
        this.cur = { id: ev.id, cursor: 0, startedAt: ev.ts || Date.now() };
        this.usageOut = 0;
        this.streamChars = 0;
        return;
      }
      case 'text':
      case 'thinking':
        this.streamChars += ev.delta.length;
        this.items = applyEvent(this.items, ev);
        this.advance(false);
        return;
      case 'usage':
        this.usageOut += ev.usage.outputTokens || 0;
        this.streamChars = 0;
        this.items = applyEvent(this.items, ev);
        return;
      case 'pill':
      case 'tasks':
      case 'skill':
      case 'tool_start':
      case 'tool_progress':
      case 'agent_progress':
      case 'tool_permission':
      case 'tool_end':
      case 'artifact':
        this.items = applyEvent(this.items, ev);
        this.advance(false);
        return;
      case 'assistant_end': {
        this.items = applyEvent(this.items, ev);
        this.advance(true);
        const a = this.assistant();
        this.finishAssistant();
        if (a) this.printTurnFooter(a);
        return;
      }
      case 'notice': {
        if (ev.id && this.cur && ev.id === this.cur.id) {
          this.items = applyEvent(this.items, ev);
          this.advance(false);
        } else {
          this.items = applyEvent(this.items, ev);
          this.emitNotice(ev.level, ev.text, ev.compact, ev.verify);
        }
        return;
      }
      default:
        // run_state, mode, todos, options: không ảnh hưởng hội thoại in ra
        this.items = applyEvent(this.items, ev);
    }
  }

  private assistant(): AssistantItem | null {
    if (!this.cur) return null;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.kind === 'assistant' && it.id === this.cur.id) return it;
    }
    return null;
  }

  /** Kết thúc lượt trả lời hiện tại: xả mọi thứ còn lại. */
  private finishAssistant(): void {
    if (!this.cur) return;
    this.advance(true);
    this.cur = null;
    this.stream = null;
    this.streamIdx = -1;
  }

  private printTurnFooter(a: AssistantItem): void {
    const ms = (a.endedAt ?? Date.now()) - a.ts;
    const tok = a.usage?.outputTokens ?? 0;
    if (ms < 8000 || a.stopReason === 'tool_use') return;
    const th = this.th;
    const parts = [tr('tui.worked', { t: fmtDuration(ms, this.o.lang()) })];
    if (tok > 0) parts.push(`${th.g.down} ${fmtTokens(tok, this.o.lang())} token`);
    this.emit('misc', ['  ' + th.faint(`${th.g.think} ${parts.join(` ${th.g.sep} `)}`)], true);
  }

  /** Tiến hành in các khối đã chắc chắn của lượt hiện tại. */
  private advance(final: boolean): void {
    const a = this.assistant();
    if (!a || !this.cur) return;
    const blocks = a.blocks;
    let i = this.cur.cursor;
    for (; i < blocks.length; i++) {
      const b = blocks[i];
      const last = i === blocks.length - 1 && !final && !a.done;
      let stop = false;
      switch (b.type) {
        case 'text': {
          this.flushGroup();
          if (!this.stream || this.streamIdx !== i) {
            this.stream = new MarkdownStream({ width: this.o.width(), theme: this.th, firstPrefix: this.th.brand(this.th.g.bullet) + ' ', prefix: '  ' });
            this.streamIdx = i;
            this.streamFed = 0;
            if (this.lastKind !== null) this.o.print(['']);
          }
          if (b.text.length < this.streamFed) this.streamFed = b.text.length; // harness lùi câu bị cắt: không thể gỡ phần đã in
          const delta = b.text.slice(this.streamFed);
          this.streamFed = b.text.length;
          const out = delta ? this.stream.push(delta) : [];
          if (!last) out.push(...this.stream.finish());
          if (out.length) {
            this.lastKind = 'text';
            this.o.print(out);
          }
          if (!last) {
            this.stream = null;
            this.streamIdx = -1;
            this.lastKind = 'text';
          } else stop = true;
          break;
        }
        case 'thinking':
          if (last) {
            stop = true;
            break;
          }
          this.flushGroup();
          this.emit('think', this.renderThinking(b));
          break;
        case 'tool': {
          if (SETTLED.has(b.state)) this.commitTool(b);
          else {
            const grouping = this.pendingGroup.length > 0 && this.pendingGroup[0].name === b.name && isGroupableName(b.name);
            if (!grouping) this.flushGroup();
            stop = true;
          }
          break;
        }
        case 'pill':
          break;
        case 'tasks':
          this.flushGroup();
          this.emit('tool', [`${this.th.ok(this.th.g.bullet)} ${this.th.muted(tr('tui.tool.tasks.added', { list: b.added.join(', ') }))}`]);
          break;
        case 'skill':
          this.flushGroup();
          this.emit('tool', [`${this.th.ok(this.th.g.bullet)} ${this.th.muted(tr('tui.tool.skill.loaded', { name: b.skill }))}`]);
          break;
        case 'artifact':
          if (b.state === 'ready' || final) {
            this.flushGroup();
            this.emit('tool', [`${this.th.ok(this.th.g.bullet)} ${tr('tui.tool.artifact', { title: b.title })}`]);
          } else stop = true;
          break;
        case 'notice':
          this.flushGroup();
          if (b.verify?.state === 'running' && !final) {
            stop = true;
            break;
          }
          this.emitNotice(b.level, b.text, b.compact, b.verify);
          break;
        default:
          break;
      }
      if (stop) break;
    }
    this.cur.cursor = i;
    if (final) this.flushGroup();
  }

  private commitTool(b: ToolBlock): void {
    if (describeCall(b.name, b.args).hidden) return;
    if (isGroupable(b) && !this.o.expanded()) {
      if (this.pendingGroup.length && this.pendingGroup[0].name !== b.name) this.flushGroup();
      this.pendingGroup.push(b);
      return;
    }
    this.flushGroup();
    const lines = renderToolBlock(b, this.toolOpts());
    if (lines.length) this.emit('tool', lines);
    this.markExpandable(b);
  }

  private markExpandable(b: ToolBlock): void {
    const lines = (b.output ?? '').split('\n').length;
    if (lines > 8 || (b.diff && b.diff.hunks.reduce((n, h) => n + h.lines.length, 0) > 12)) this.lastExpandable = b;
  }

  private flushGroup(): void {
    if (!this.pendingGroup.length) return;
    const g = this.pendingGroup;
    this.pendingGroup = [];
    const grouped = renderToolGroup(g, this.toolOpts());
    if (grouped) {
      this.emit('tool', grouped);
      return;
    }
    const lines: string[] = [];
    for (const b of g) lines.push(...renderToolBlock(b, this.toolOpts()));
    this.emit('tool', lines);
  }

  // ───────────── các loại dòng ─────────────

  renderUser(text: string, attachments: string[] = [], steer = false): string[] {
    const th = this.th;
    const w = this.o.width();
    const rows: string[] = [];
    const body = wrapAnsi(text.replace(/\t/g, '  '), w - 3);
    body.forEach((r, i) => rows.push((i === 0 ? th.brand(steer ? '›' : th.g.prompt) : ' ') + ' ' + r));
    for (const a of attachments) rows.push('  ' + th.muted(`[${a}]`));
    return rows.map((r) => th.userLine(padEnd(truncateAnsi(r, w), w)));
  }

  private renderThinking(b: Extract<ABlock, { type: 'thinking' }>): string[] {
    const th = this.th;
    const dur = b.durationMs && b.durationMs >= 1000 ? tr('tui.thought', { t: fmtDuration(b.durationMs, this.o.lang()) }) : tr('tui.thought.short');
    const head = th.muted(`${th.g.think} ${dur}`);
    if (!this.o.expanded() || !b.text.trim()) return [head];
    const body = wrapAnsi(th.italic(th.faint(b.text.trim())), this.o.width() - 4, { first: '  ', rest: '  ' });
    return [head, ...body.slice(0, 60)];
  }

  renderNotice(level: 'info' | 'warn' | 'error', text: string, compact?: CompactInfo, verify?: VerifyInfo): string[] {
    const th = this.th;
    const w = this.o.width();
    if (compact) {
      const key = compact.mode === 'auto' ? 'tui.compact.auto' : compact.mode === 'overflow' ? 'tui.compact.overflow' : 'tui.compact.manual';
      const parts = [tr(key)];
      if (compact.tokensFreed) parts.push(tr('tui.compact.freed', { n: fmtTokens(compact.tokensFreed, this.o.lang()) }));
      if (compact.clearedResults) parts.push(tr('tui.compact.cleared', { n: compact.clearedResults }));
      return [th.brand(th.g.think) + ' ' + th.muted(parts.join(` ${th.g.sep} `))];
    }
    if (verify) {
      const st = verify.state;
      const label = st === 'running' ? tr('tui.verify.running', { r: verify.round, m: verify.maxRounds }) : tr('tui.verify.' + st);
      const mark = st === 'pass' ? th.ok(th.g.ok) : st === 'fail' ? th.err(th.g.fail) : st === 'running' ? th.brand(th.g.think) : th.warn('!');
      const out = [`${mark} ${st === 'fail' ? th.err(label) : th.muted(label)}${verify.durationMs ? th.faint(` (${fmtDuration(verify.durationMs, this.o.lang(), true)})`) : ''}`];
      const items = [...(verify.defects ?? []), ...(verify.missing ?? []), ...(verify.unverifiedClaims ?? [])];
      items.slice(0, 5).forEach((x) => out.push(...wrapAnsi(x, w - 4, { first: '  ' + th.muted(th.g.listBullet) + ' ', rest: '    ' })));
      if (verify.reason) out.push('  ' + th.faint(verify.reason));
      return out.map((l) => truncateAnsi(l, w));
    }
    if (level === 'error') {
      const rows = wrapAnsi(th.err(text), w - 2, { first: th.err(th.g.fail) + ' ', rest: '  ' });
      return [...rows, '  ' + th.faint(tr('tui.error.hint'))];
    }
    if (level === 'warn') return wrapAnsi(th.warn(text), w - 2, { first: th.warn('!') + ' ', rest: '  ' });
    return wrapAnsi(th.muted(text), w - 2, { first: th.muted(th.g.sep) + ' ', rest: '  ' });
  }

  private emitNotice(level: 'info' | 'warn' | 'error', text: string, compact?: CompactInfo, verify?: VerifyInfo): void {
    this.emit('notice', this.renderNotice(level, text, compact, verify));
  }

  /** Khối `output` của lệnh gạch chéo. */
  output(text: string, kind: 'markdown' | 'plain' | 'error' = 'markdown', title?: string): void {
    this.flushGroup();
    const th = this.th;
    const w = this.o.width();
    const lines: string[] = [];
    if (title) lines.push('  ' + th.bold(th.brand(title)));
    if (kind === 'error') lines.push(...wrapAnsi(th.err(text), w - 2, { first: th.err(th.g.fail) + ' ', rest: '  ' }));
    else if (kind === 'plain') lines.push(...wrapAnsi(text, w - 2, { first: '  ', rest: '  ' }));
    else lines.push(...renderMarkdown(text, { width: w, theme: th, firstPrefix: '  ', prefix: '  ' }));
    this.emit('notice', lines);
  }

  /** In dòng người dùng đã gõ (lệnh gạch chéo / shell) vì runtime không phát `user` cho chúng. */
  echo(text: string, countAsMessage = false): void {
    this.flushGroup();
    if (countAsMessage) this.userMessages++;
    this.emit('user', this.renderUser(text));
  }

  /** Đánh dấu «đã in gì đó» (khung chào…) để các khối sau cách một dòng trống. */
  markPrinted(): void {
    this.lastKind = 'misc';
  }

  // ───────────── dựng lại (resume / fork / rewind) ─────────────

  /** Dòng tĩnh của một danh sách mục (không đụng trạng thái sống). */
  renderItems(items: readonly TItem[]): string[] {
    const out: string[] = [];
    // dùng một Conversation phụ để tái dùng mọi đường in
    const sub = new Conversation({ ...this.o, print: (l) => out.push(...l) });
    for (const it of items) {
      if (it.kind === 'user') sub.emitUserItem(it.text, it.attachments.map((a) => a.label || a.kind), !!it.steer);
      else if (it.kind === 'notice') sub.emitNotice(it.level, it.text, it.compact, it.verify);
      else sub.emitAssistantItem(it);
    }
    sub.flushGroup();
    return out;
  }

  private emitUserItem(text: string, atts: string[], steer: boolean): void {
    this.flushGroup();
    this.emit('user', this.renderUser(text, atts, steer));
  }

  private emitAssistantItem(a: AssistantItem): void {
    // lệnh còn «đang chạy» trong phiên đã lưu = bị ngắt giữa chừng
    const blocks = a.blocks.map((b) => (b.type === 'tool' && !SETTLED.has(b.state) ? ({ ...b, state: 'cancelled' } as ToolBlock) : b));
    const copy: AssistantItem = { ...a, blocks, done: true };
    this.items = [...this.items, copy];
    this.cur = { id: a.id, cursor: 0, startedAt: a.ts };
    this.advance(true);
    this.cur = null;
    this.stream = null;
    this.streamIdx = -1;
  }

  // ───────────── vùng sống ─────────────

  /** Dòng sống do hội thoại: chữ đang stream + công cụ đang chạy + nhóm đang chờ. */
  live(): string[] {
    const out: string[] = [];
    if (this.stream) out.push(...this.stream.partial());
    const a = this.assistant();
    if (this.pendingGroup.length) {
      const g = renderToolGroup(this.pendingGroup, this.toolOpts());
      if (g) out.push(...g);
      else for (const b of this.pendingGroup) out.push(...renderToolBlock(b, this.toolOpts()));
    }
    if (a && this.cur) {
      const pending = a.blocks.slice(this.cur.cursor).filter((b): b is ToolBlock => b.type === 'tool' && !SETTLED.has(b.state));
      const frame = Math.floor(Date.now() / 120);
      const spin = this.th.g.spinner[frame % this.th.g.spinner.length];
      const show = pending.slice(-4);
      if (pending.length > show.length) out.push('  ' + this.th.muted(tr('tui.tool.running.more', { n: pending.length - show.length })));
      for (const b of show) out.push(...renderToolLive(b, this.toolOpts({ spin })));
      // suy nghĩ đang diễn ra ở chế độ mở rộng
      const lastB = a.blocks[a.blocks.length - 1];
      if (this.o.expanded() && lastB?.type === 'thinking' && !a.done) {
        const rows = wrapAnsi(this.th.italic(this.th.faint(lastB.text.trim())), this.o.width() - 4, { first: '  ', rest: '  ' });
        out.push(...rows.slice(-4));
      }
    }
    return out;
  }

  /** Gợi ý cho spinner: đang suy nghĩ? tên việc? */
  spinnerHint(): { thinking: boolean; label?: string } {
    const a = this.assistant();
    if (!a || a.done) return { thinking: false };
    const last = a.blocks[a.blocks.length - 1];
    if (last?.type === 'pill' && last.active) return { thinking: last.kind === 'thinking', label: last.text.replace(/[….]+$/, '') };
    const running = a.blocks.filter((b): b is ToolBlock => b.type === 'tool' && (b.state === 'running' || b.state === 'awaiting_permission'));
    if (running.length) {
      const v = describeCall(running[running.length - 1].name, running[running.length - 1].args, this.o.cwd());
      return { thinking: false, label: tr('tui.spin.tool', { tool: v.title }) };
    }
    if (last?.type === 'thinking') return { thinking: true };
    return { thinking: false };
  }

  /** Token đã/đang tạo trong lượt (ước lượng phần đang stream). */
  get runTokens(): number {
    return this.usageOut + Math.ceil(this.streamChars / 4);
  }

  resetRunMeters(): void {
    this.usageOut = 0;
    this.streamChars = 0;
  }

  /** Ctrl+O: in đầy đủ kết quả bị rút gọn gần nhất. */
  expandLast(): boolean {
    const b = this.lastExpandable;
    if (!b) return false;
    this.flushGroup();
    const lines = renderToolBlock(b, this.toolOpts({ expanded: true }));
    this.emit('tool', lines);
    this.lastExpandable = null;
    return true;
  }

  /** Đang có gì chưa in xong (stream/công cụ)? */
  get busy(): boolean {
    return !!this.stream || this.pendingGroup.length > 0;
  }
}

function isGroupableName(name: string): boolean {
  return ['read_file', 'glob', 'grep', 'list_dir', 'web_search', 'fetch_url'].includes(name);
}
