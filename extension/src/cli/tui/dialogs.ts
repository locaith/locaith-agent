/**
 * Hộp thoại thay ô nhập khi cần quyết định: xin quyền, chọn từ danh sách (có tìm kiếm), xác nhận, nhập một dòng.
 * Mỗi hộp là một máy trạng thái nhỏ: `render(width, maxRows)` → dòng; `key(k)` → chưa xong / xong kèm giá trị. Không có I/O.
 */

import type { PermissionRequest } from '../../shared/protocol';
import type { AskRequest, PickItem } from '../runtime/contract';
import { t as tr } from '../i18n';
import { renderDiff } from './diff';
import { Editor } from './editor';
import type { Key } from './keys';
import { isPrintable } from './keys';
import { renderMarkdown } from './markdown';
import './strings';
import type { Theme } from './theme';
import { box } from './widgets';
import { padEnd, stringWidth, truncateAnsi, truncatePlain, wrapAnsi } from './width';

export type Outcome<T> = { done: false } | { done: true; value: T };
const PENDING = { done: false } as const;

export interface Dialog<T> {
  render(width: number, maxRows: number): string[];
  key(k: Key): Outcome<T>;
  paste(text: string): void;
}

// ─────────────────────────── xin quyền ───────────────────────────

export interface PermDecision {
  decision: 'allow' | 'allow_session' | 'deny';
  feedback?: string;
}

type PermChoice = 'allow' | 'allow_session' | 'deny_feedback';

export class PermissionDialog implements Dialog<PermDecision> {
  private sel = 0;
  private mode: 'choose' | 'reason' = 'choose';
  private readonly reason = new Editor();
  private readonly choices: PermChoice[];

  constructor(
    readonly req: PermissionRequest,
    private readonly th: Theme,
  ) {
    this.choices = req.canAllowSession ? ['allow', 'allow_session', 'deny_feedback'] : ['allow', 'deny_feedback'];
  }

  private label(c: PermChoice): string {
    switch (c) {
      case 'allow':
        return tr('tui.perm.yes');
      case 'allow_session': {
        const r = this.req;
        const what = r.suggest?.[0];
        if (what) return tr('tui.perm.session', { what: '`' + what + '`' });
        if (r.sessionLabel) return r.sessionLabel;
        return tr('tui.perm.session.generic');
      }
      default:
        return tr('tui.perm.no');
    }
  }

  private content(width: number, budget: number): string[] {
    const th = this.th;
    const r = this.req;
    const inner = width - 4;
    const out: string[] = [];
    out.push(th.bold(r.title || tr('tui.perm.title.tool', { tool: r.tool })));
    if (r.detail) for (const l of wrapAnsi(th.muted(r.detail), inner).slice(0, 4)) out.push(l);
    let body: string[] = [];
    if (r.command) {
      const lines = r.command.replace(/\r\n?/g, '\n').split('\n');
      body = lines.slice(0, 6).map((l, i) => (i === 0 ? th.muted('$ ') : '  ') + th.code(truncatePlain(l, inner - 2)));
      if (lines.length > 6) body.push(th.muted(tr('tui.tool.more.plain', { n: lines.length - 6 })));
    }
    if (r.diff) body = renderDiff(r.diff, { width: inner, theme: th, maxLines: 10, moreLabel: (n) => tr('tui.tool.more.plain', { n }) });
    if (r.planMarkdown) {
      const md = renderMarkdown(r.planMarkdown, { width: inner, theme: th });
      body = md.slice(0, 16);
      if (md.length > 16) body.push(th.muted(tr('tui.tool.more.plain', { n: md.length - 16 })));
    }
    if (body.length) {
      out.push('');
      const room = Math.max(3, budget - out.length - 1);
      if (body.length > room) body = [...body.slice(0, room - 1), th.muted(tr('tui.tool.more.plain', { n: body.length - room + 1 }))];
      out.push(...body);
    }
    if (r.rule) out.push(th.faint(tr('tui.perm.rule', { rule: r.rule })));
    return out;
  }

  render(width: number, maxRows: number): string[] {
    const th = this.th;
    const inner = width - 4;
    const optionRows = this.choices.length + (this.mode === 'reason' ? 2 : 0);
    const budget = Math.max(6, maxRows - 2 - optionRows - 1);
    const rows = this.content(width, budget);
    rows.push('');
    if (this.mode === 'choose') {
      this.choices.forEach((c, i) => {
        const on = i === this.sel;
        const n = `${i + 1}. `;
        const text = this.label(c);
        const line = (on ? th.brand(th.g.caret) : ' ') + ' ' + (on ? th.bold(n + text) : th.muted(n) + text);
        rows.push(truncateAnsi(line, inner));
      });
    } else {
      rows.push(th.warn(tr('tui.perm.reason')));
      const r = this.reason.renderRows(Math.max(4, inner - 2), th.inverse);
      rows.push(th.brand(th.g.caret) + ' ' + (r.rows[r.cursorRow] ?? ''));
    }
    const kindLabel = tr('tui.perm.kind.' + this.req.kind);
    return box(rows, width, th, { title: kindLabel, hint: tr('tui.perm.keys'), border: th.warn });
  }

  private decide(c: PermChoice): Outcome<PermDecision> {
    if (c === 'allow') return { done: true, value: { decision: 'allow' } };
    if (c === 'allow_session') return { done: true, value: { decision: 'allow_session' } };
    this.mode = 'reason';
    return PENDING;
  }

  key(k: Key): Outcome<PermDecision> {
    if (this.mode === 'reason') {
      if (k.name === 'escape') return { done: true, value: { decision: 'deny' } };
      if (k.name === 'enter') {
        const fb = this.reason.text.trim();
        return { done: true, value: fb ? { decision: 'deny', feedback: fb } : { decision: 'deny' } };
      }
      applyLineKey(this.reason, k);
      return PENDING;
    }
    if (k.name === 'escape') return { done: true, value: { decision: 'deny' } };
    if (k.name === 'up' || (k.name === 'tab' && k.shift)) this.sel = (this.sel + this.choices.length - 1) % this.choices.length;
    else if (k.name === 'down' || k.name === 'tab') this.sel = (this.sel + 1) % this.choices.length;
    else if (k.name === 'enter') return this.decide(this.choices[this.sel]);
    else if (isPrintable(k) && k.text) {
      const ch = k.text.toLowerCase();
      if (/^[1-9]$/.test(ch)) {
        const c = this.choices[Number(ch) - 1];
        if (c) return this.decide(c);
      }
      if (ch === 'y') return this.decide('allow');
      if (ch === 'a' && this.req.canAllowSession) return this.decide('allow_session');
      if (ch === 'n' || ch === 'd') return { done: true, value: { decision: 'deny' } };
    } else if (k.ctrl && k.text === 'c') return { done: true, value: { decision: 'deny' } };
    return PENDING;
  }

  paste(text: string): void {
    if (this.mode === 'reason') this.reason.insert(text.replace(/\n/g, ' '));
  }
}

/** Xử lý phím cho ô nhập MỘT dòng (dùng cho lý do từ chối, hộp nhập). */
export function applyLineKey(ed: Editor, k: Key): void {
  if (isPrintable(k)) ed.insert(k.text ?? '');
  else if (k.name === 'backspace') (k.ctrl ? ed.deleteWordBack() : ed.backspace());
  else if (k.name === 'delete') ed.del();
  else if (k.name === 'left') (k.ctrl || k.alt ? ed.wordLeft() : ed.left());
  else if (k.name === 'right') (k.ctrl || k.alt ? ed.wordRight() : ed.right());
  else if (k.name === 'home') ed.home();
  else if (k.name === 'end') ed.end();
  else if (k.ctrl && k.text) {
    switch (k.text) {
      case 'a': ed.home(); break;
      case 'e': ed.end(); break;
      case 'k': ed.killToEnd(); break;
      case 'u': ed.killToStart(); break;
      case 'w': ed.deleteWordBack(); break;
      case 'y': ed.yank(); break;
      default: break;
    }
  } else if (k.alt && k.text) {
    if (k.text === 'b') ed.wordLeft();
    else if (k.text === 'f') ed.wordRight();
    else if (k.text === 'd') ed.deleteWordForward();
  }
}

// ─────────────────────────── chọn từ danh sách ───────────────────────────

type PickReq = Extract<AskRequest, { kind: 'pick' }>;

interface DispRow {
  header?: string;
  item?: PickItem;
  idx?: number;
}

function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
}

export function filterPickItems(items: readonly PickItem[], query: string): PickItem[] {
  const q = norm(query).trim();
  if (!q) return items.slice();
  const words = q.split(/\s+/);
  return items.filter((it) => {
    const hay = norm(`${it.label} ${it.detail ?? ''} ${it.group ?? ''}`);
    return words.every((w) => hay.includes(w));
  });
}

export class PickDialog implements Dialog<string | string[] | null> {
  private query = new Editor();
  private filtered: PickItem[];
  private sel = 0;
  private top = 0;
  private readonly marked = new Set<string>();
  private readonly searchable: boolean;

  constructor(
    private readonly req: PickReq,
    private readonly th: Theme,
  ) {
    this.filtered = req.items.slice();
    this.searchable = req.searchable ?? req.items.length > 10;
    const cur = this.filtered.findIndex((x) => x.current);
    this.sel = cur >= 0 ? cur : 0;
    if (req.multi) for (const it of req.items) if (it.current) this.marked.add(it.id);
  }

  private refilter(): void {
    const keep = this.filtered[this.sel]?.id;
    this.filtered = filterPickItems(this.req.items, this.query.text);
    const k = this.filtered.findIndex((x) => x.id === keep);
    this.sel = k >= 0 ? k : 0;
    this.top = 0;
  }

  private display(): { rows: DispRow[]; selRow: number } {
    const rows: DispRow[] = [];
    let last: string | undefined;
    let selRow = 0;
    this.filtered.forEach((it, i) => {
      if (it.group && it.group !== last) rows.push({ header: it.group });
      last = it.group ?? last;
      if (i === this.sel) selRow = rows.length;
      rows.push({ item: it, idx: i });
    });
    return { rows, selRow };
  }

  render(width: number, maxRows: number): string[] {
    const th = this.th;
    const inner = width - 4;
    const out: string[] = [];
    if (this.req.hint) out.push(th.muted(truncatePlain(this.req.hint, inner)));
    if (this.searchable) {
      const q = this.query.renderRows(Math.max(4, inner - 8), th.inverse);
      out.push(th.muted(tr('tui.pick.search')) + (q.rows[0] ?? ''));
      out.push('');
    }
    const { rows, selRow } = this.display();
    const height = Math.max(3, Math.min(rows.length || 1, maxRows - 2 - out.length - 1, 14));
    if (selRow < this.top) this.top = selRow;
    if (selRow >= this.top + height) this.top = selRow - height + 1;
    if (this.top > 0 && rows[this.top]?.item && rows[this.top - 1]?.header) this.top--;
    const labelW = Math.min(Math.max(8, ...this.filtered.map((x) => stringWidth(x.label))), Math.floor(inner * 0.6));
    if (!rows.length) out.push(th.muted(tr('tui.pick.none')));
    for (const r of rows.slice(this.top, this.top + height)) {
      if (r.header !== undefined) {
        out.push(th.faint(`${th.g.h}${th.g.h} `) + th.muted(truncatePlain(r.header, inner - 4)));
        continue;
      }
      const it = r.item!;
      const on = r.idx === this.sel;
      const mark = this.req.multi ? (this.marked.has(it.id) ? th.ok(th.g.todo.completed) : th.muted(th.g.todo.pending)) + ' ' : '';
      const cur = it.current && !this.req.multi ? th.ok(' ' + th.g.check) : '';
      const label = padEnd(truncatePlain(it.label, labelW), labelW);
      const room = Math.max(0, inner - 2 - stringWidth(mark) - labelW - 3);
      const detail = it.detail && room > 6 ? truncatePlain(it.detail.replace(/\s+/g, ' '), room) : '';
      const line = `${on ? th.brand(th.g.caret) : ' '} ${mark}${on ? th.bold(th.brand(label)) : label}${cur}  ${on ? th.plain(detail) : th.muted(detail)}`;
      out.push(truncateAnsi(on ? th.selected(padEnd(line, inner)) : line, inner));
    }
    if (rows.length > height) out.push(th.faint(`  ${Math.min(this.sel + 1, this.filtered.length)}/${this.filtered.length}`));
    return box(out, width, th, { title: this.req.title, hint: tr(this.req.multi ? 'tui.pick.keys.multi' : 'tui.pick.keys'), border: th.brand2 });
  }

  key(k: Key): Outcome<string | string[] | null> {
    const n = this.filtered.length;
    if (k.name === 'escape' || (k.ctrl && k.text === 'c')) return this.req.allowCancel === false && k.name === 'escape' ? PENDING : { done: true, value: null };
    if (k.name === 'up' || (k.ctrl && k.text === 'p')) this.sel = n ? (this.sel + n - 1) % n : 0;
    else if (k.name === 'down' || (k.ctrl && k.text === 'n')) this.sel = n ? (this.sel + 1) % n : 0;
    else if (k.name === 'pageup') this.sel = Math.max(0, this.sel - 8);
    else if (k.name === 'pagedown') this.sel = Math.min(Math.max(0, n - 1), this.sel + 8);
    else if (k.name === 'home' && !this.searchable) this.sel = 0;
    else if (k.name === 'end' && !this.searchable) this.sel = Math.max(0, n - 1);
    else if (k.name === 'tab') this.sel = n ? (this.sel + (k.shift ? n - 1 : 1)) % n : 0;
    else if (k.name === 'enter') {
      if (this.req.multi) return { done: true, value: [...this.marked] };
      const it = this.filtered[this.sel];
      return it ? { done: true, value: it.id } : PENDING;
    } else if (this.req.multi && isPrintable(k) && k.text === ' ' && !this.query.text) {
      const it = this.filtered[this.sel];
      if (it) (this.marked.has(it.id) ? this.marked.delete(it.id) : this.marked.add(it.id));
    } else if (this.searchable) {
      const before = this.query.text;
      applyLineKey(this.query, k);
      if (this.query.text !== before) this.refilter();
    }
    return PENDING;
  }

  paste(text: string): void {
    if (!this.searchable) return;
    this.query.insert(text.replace(/\s+/g, ' '));
    this.refilter();
  }
}

// ─────────────────────────── xác nhận ───────────────────────────

type ConfirmReq = Extract<AskRequest, { kind: 'confirm' }>;

export class ConfirmDialog implements Dialog<boolean | null> {
  private yes: boolean;
  constructor(
    private readonly req: ConfirmReq,
    private readonly th: Theme,
  ) {
    this.yes = req.defaultYes !== false && !req.danger;
    if (req.defaultYes === true) this.yes = true;
  }

  render(width: number): string[] {
    const th = this.th;
    const inner = width - 4;
    const rows: string[] = [];
    if (this.req.detail) rows.push(...wrapAnsi(th.muted(this.req.detail), inner), '');
    const yesL = ` ${this.req.yes ?? tr('tui.confirm.yes')} `;
    const noL = ` ${this.req.no ?? tr('tui.confirm.no')} `;
    const btn = (label: string, on: boolean, danger: boolean): string => (on ? (danger ? th.err : th.brand)(th.inverse(label)) : th.muted(label));
    rows.push(btn(yesL, this.yes, false) + '   ' + btn(noL, !this.yes, !!this.req.danger));
    return box(rows, width, th, { title: this.req.title, hint: tr('tui.confirm.keys'), border: this.req.danger ? th.err : th.brand2 });
  }

  key(k: Key): Outcome<boolean | null> {
    if (k.name === 'escape' || (k.ctrl && k.text === 'c')) return { done: true, value: null };
    if (k.name === 'left' || k.name === 'right' || k.name === 'tab' || k.name === 'up' || k.name === 'down') this.yes = !this.yes;
    else if (k.name === 'enter') return { done: true, value: this.yes };
    else if (isPrintable(k) && k.text) {
      const c = k.text.toLowerCase();
      if (c === 'y' || c === 'c') return { done: true, value: true }; // y / c(ó)
      if (c === 'n' || c === 'k') return { done: true, value: false }; // n / k(hông)
    }
    return PENDING;
  }

  paste(): void {
    /* không dùng */
  }
}

// ─────────────────────────── nhập một dòng ───────────────────────────

type InputReq = Extract<AskRequest, { kind: 'input' }>;

export class InputDialog implements Dialog<string | null> {
  readonly ed = new Editor();
  constructor(
    private readonly req: InputReq,
    private readonly th: Theme,
  ) {
    if (req.initial) this.ed.setText(req.initial);
  }

  render(width: number): string[] {
    const th = this.th;
    const inner = width - 4;
    const rows: string[] = [];
    if (this.req.detail) rows.push(...wrapAnsi(th.muted(this.req.detail), inner).slice(0, 4), '');
    let shown: string;
    if (this.req.secret) {
      const masked = new Editor();
      masked.setText('•'.repeat([...this.ed.text].length), '•'.repeat([...this.ed.text.slice(0, this.ed.cursor)].length).length);
      shown = masked.renderRows(Math.max(4, inner - 2), th.inverse).rows[0] ?? '';
    } else {
      // hiển thị cuộn ngang: giữ con trỏ trong tầm nhìn
      const w = Math.max(4, inner - 2);
      const before = this.ed.text.slice(0, this.ed.cursor);
      let start = 0;
      while (stringWidth(before.slice(start)) >= w - 1) start++;
      const view = new Editor();
      view.setText(this.ed.text.slice(start), this.ed.cursor - start);
      shown = view.renderRows(Math.max(4, w + 1000), th.inverse).rows[0] ?? '';
      shown = truncateAnsi(shown, w);
    }
    if (!this.ed.text && this.req.placeholder) shown = th.inverse(' ') + th.faint(this.req.placeholder);
    rows.push(th.brand(th.g.caret) + ' ' + shown);
    return box(rows, width, th, { title: this.req.title, hint: tr('tui.input.keys'), border: th.brand2 });
  }

  key(k: Key): Outcome<string | null> {
    if (k.name === 'escape' || (k.ctrl && k.text === 'c')) return { done: true, value: null };
    if (k.name === 'enter') return { done: true, value: this.ed.text };
    applyLineKey(this.ed, k);
    return PENDING;
  }

  paste(text: string): void {
    this.ed.insert(text.replace(/\s*\n\s*/g, ' ').trim());
  }
}

export function makeAskDialog(req: AskRequest, th: Theme): Dialog<string | string[] | boolean | null> {
  switch (req.kind) {
    case 'pick':
      return new PickDialog(req, th);
    case 'confirm':
      return new ConfirmDialog(req, th);
    default:
      return new InputDialog(req, th);
  }
}
