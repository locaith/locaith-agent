/**
 * Các mảnh giao diện thuần (nhận dữ liệu → trả về mảng dòng đã có ANSI): khung, ô nhập, dải trạng thái, spinner, bảng việc, menu gợi ý, bảng phím tắt.
 * Mọi dòng trả về có độ rộng hiển thị ≤ `width`.
 */

import type { PermissionMode, TodoItem } from '../../shared/protocol';
import type { RuntimeStatus } from '../runtime/contract';
import { t as tr } from '../i18n';
import type { Editor } from './editor';
import { fmtDuration, fmtTokens } from './format';
import { SPINNER_VERBS } from './strings';
import type { Menu } from './suggest';
import type { Theme } from './theme';
import { padEnd, stringWidth, truncateAnsi, truncatePlain } from './width';

// ───────────────────────── khung ─────────────────────────

export interface BoxOptions {
  border?: (s: string) => string;
  title?: string;
  /** Chữ nhỏ trên viền dưới (gợi ý phím). */
  hint?: string;
  /** Tô gradient thương hiệu cho viền trên. */
  gradientTop?: boolean;
}

/** Khung bo tròn: mỗi dòng nội dung được đệm/cắt đúng độ rộng. */
export function box(rows: string[], width: number, th: Theme, o: BoxOptions = {}): string[] {
  const g = th.g;
  const border = o.border ?? th.faint;
  const inner = Math.max(1, width - 4);
  const horiz = (n: number): string => g.h.repeat(Math.max(0, n));
  let top: string;
  if (o.title) {
    const title = truncatePlain(o.title, Math.max(1, width - 6));
    const fill = width - 2 - 3 - stringWidth(title);
    top = border(g.tl + g.h + ' ') + th.bold(title) + border(' ' + horiz(fill) + g.tr);
  } else if (o.gradientTop && th.caps.color !== 'none') {
    top = th.gradient(g.tl + horiz(width - 2) + g.tr);
  } else top = border(g.tl + horiz(width - 2) + g.tr);
  let bottom: string;
  if (o.hint) {
    const hint = truncatePlain(o.hint, Math.max(1, width - 6));
    const fill = width - 2 - 3 - stringWidth(hint);
    bottom = border(g.bl + g.h + ' ') + th.muted(hint) + border(' ' + horiz(fill) + g.br);
  } else bottom = border(g.bl + horiz(width - 2) + g.br);
  const body = rows.map((r) => {
    const cut = stringWidth(r) > inner ? truncateAnsi(r, inner) : r;
    return border(g.v) + ' ' + padEnd(cut, inner) + ' ' + border(g.v);
  });
  return [top, ...body, bottom];
}

// ───────────────────────── ô nhập ─────────────────────────

export interface InputBoxOptions {
  editor: Editor;
  width: number;
  theme: Theme;
  shell: boolean;
  placeholder: string;
  maxRows?: number;
  focused?: boolean;
  /** Tìm ngược (Ctrl+R): hiện truy vấn thay cho văn bản. */
  search?: { query: string; match: string | null; failed: boolean };
  /** Tin đã dán/đính kèm (hiện dưới dạng chip ở viền trên). */
  chips?: string[];
}

export function renderInputBox(o: InputBoxOptions): string[] {
  const { theme: th, width } = o;
  const maxRows = o.maxRows ?? 8;
  const textW = Math.max(4, width - 4 - 2); // viền+đệm (4) và dấu nhắc (2)
  const prompt = o.shell ? th.warn('!') : th.brand(th.g.prompt);
  const border = o.shell ? th.warn : o.focused === false ? th.faint : th.brand2;
  let rows: string[];
  if (o.search) {
    const label = th.muted(tr('tui.search.title')) + ' ';
    const q = th.bold(o.search.query) + th.inverse(' ');
    const found = o.search.match === null ? (o.search.failed ? th.err(tr('tui.search.fail')) : '') : th.plain(o.search.match.split('\n')[0]);
    return box([truncateAnsi(label + th.brand('(') + q + th.brand(')') + ' ' + found, width - 4)], width, th, { border: th.brand2, hint: 'Enter · Esc · Ctrl+R' });
  }
  const ed = o.editor;
  if (ed.empty) {
    const ph = th.faint(truncatePlain(o.shell ? tr('tui.prompt.shell') : o.placeholder, textW - 1));
    rows = [prompt + ' ' + th.inverse(' ') + ph];
  } else {
    const r = ed.renderRows(textW, th.inverse, o.focused !== false);
    let start = 0;
    if (r.rows.length > maxRows) start = Math.min(r.rows.length - maxRows, Math.max(0, r.cursorRow - maxRows + 1));
    const view = r.rows.slice(start, start + maxRows);
    rows = view.map((line, i) => (i === 0 ? (start === 0 ? prompt : th.faint(th.g.up)) + ' ' : '  ') + line);
  }
  const hint = o.chips && o.chips.length ? o.chips.join('  ') : undefined;
  return box(rows, width, th, { border, hint });
}

// ───────────────────────── dải trạng thái ─────────────────────────

export interface FooterOptions {
  width: number;
  theme: Theme;
  status: RuntimeStatus | null;
  running: boolean;
  /** Gợi ý tạm (toast) thay cho gợi ý mặc định. */
  toast?: { level: 'info' | 'warn' | 'error'; text: string } | null;
  ctrlCArmed?: boolean;
  ctrlDArmed?: boolean;
  esc2Armed?: boolean;
  empty: boolean;
  expanded: boolean;
  /** Đang mở hộp thoại: bỏ gợi ý trái. */
  dialog?: boolean;
  shell?: boolean;
  showShortcutsHint?: boolean;
}

export function modeLabel(mode: PermissionMode, th: Theme): string | null {
  switch (mode) {
    case 'acceptEdits':
      return th.ok(`${th.g.modeArrows} ${tr('tui.mode.acceptEdits')}`);
    case 'plan':
      return th.brand(`${th.caps.unicode ? '⏸' : '||'} ${tr('tui.mode.plan')}`);
    case 'bypass':
      return th.err(`${th.g.modeArrows} ${tr('tui.mode.bypass')}`);
    default:
      return null;
  }
}

function shortModel(m: string): string {
  return m.replace(/^models\//, '').replace(/-\d{8}$/, '');
}

export function renderFooter(o: FooterOptions): string {
  const { theme: th, width, status } = o;
  const W = width - 1;
  // phải: model · ngữ cảnh · nhánh
  const right: string[] = [];
  if (status) {
    if (status.model) right.push(th.muted(shortModel(status.model)));
    if (status.context && status.context.window > 0) {
      const p = Math.round(status.context.percent);
      const txt = tr('tui.ctx', { p });
      right.push(p >= 95 ? th.err(txt) : p >= 80 ? th.warn(txt) : th.muted(txt));
    }
    if (status.gitBranch) right.push(th.muted(`${th.g.branch} ${status.gitBranch}`));
  }
  const sep = th.faint(` ${th.g.sep} `);
  // trái
  let left = '';
  if (o.toast) {
    const st = o.toast.level === 'error' ? th.err : o.toast.level === 'warn' ? th.warn : th.muted;
    left = st(o.toast.text);
  } else if (o.ctrlCArmed) left = th.warn(tr('tui.hint.ctrlc'));
  else if (o.ctrlDArmed) left = th.warn(tr('tui.hint.ctrld'));
  else if (o.esc2Armed) left = th.warn(tr('tui.hint.esc2'));
  else if (!o.dialog) {
    const parts: string[] = [];
    const ml = status ? modeLabel(status.mode, th) : null;
    if (ml) parts.push(ml + th.faint(` (${tr('tui.mode.change')})`));
    if (o.running) parts.push(th.muted(tr('tui.hint.stop')));
    else if (o.empty && !ml) parts.push(th.muted(tr('tui.hint.shortcuts')));
    else if (!o.empty && !ml) parts.push(th.faint(`${tr('tui.hint.send')} ${th.g.sep} ${tr('tui.hint.multiline')}`));
    if (o.expanded) parts.push(th.muted(tr('tui.hint.expanded')));
    left = parts.join(sep);
  }
  // bớt phần phải cho vừa
  let r = right.slice();
  const fit = (): boolean => stringWidth(left) + 2 + stringWidth(r.join(sep)) <= W;
  while (r.length && !fit()) r.pop();
  const rs = r.join(sep);
  if (!fit()) left = truncateAnsi(left, Math.max(0, W - stringWidth(rs) - 1));
  const gap = Math.max(1, W - stringWidth(left) - stringWidth(rs));
  return truncateAnsi(left + ' '.repeat(gap) + rs, W);
}

// ───────────────────────── spinner ─────────────────────────

export interface SpinnerOptions {
  theme: Theme;
  width: number;
  lang: 'vi' | 'en';
  frame: number;
  elapsedMs: number;
  tokens: number;
  /** Nhãn cụ thể (thinking / tên công cụ…); thiếu → từ xoay vòng. */
  label?: string;
  /** Đang suy nghĩ (đổi nhãn). */
  thinking?: boolean;
  animate?: boolean;
  /** Không hiện «(12s · …)». */
  bare?: boolean;
}

export function spinnerVerb(lang: 'vi' | 'en', elapsedMs: number, seed: number): string {
  const list = SPINNER_VERBS[lang];
  return list[(seed + Math.floor(elapsedMs / 4000)) % list.length];
}

export function renderSpinner(o: SpinnerOptions): string {
  const th = o.theme;
  const frames = th.g.spinner;
  const glyph = frames[o.frame % frames.length];
  const verb = o.label ?? (o.thinking ? tr('tui.thinking.now') : tr('tui.working'));
  const text = verb + th.g.ellipsis;
  const phase = ((o.frame * 0.035) % 1.4) - 0.2;
  const shimmer = o.animate === false ? th.gradient(text) : th.shimmer(text, phase);
  if (o.bare) return truncateAnsi(`${th.brand(glyph)} ${shimmer}`, o.width - 1);
  const meta: string[] = [fmtDuration(o.elapsedMs, o.lang, true)];
  if (o.tokens > 0) meta.push(`${th.g.down} ${fmtTokens(o.tokens, o.lang)} token`);
  meta.push(tr('tui.spinner.stop'));
  const tail = th.muted(`(${meta.join(` ${th.g.sep} `)})`);
  return truncateAnsi(`${th.brand(glyph)} ${shimmer} ${tail}`, o.width - 1);
}

// ───────────────────────── bảng việc ─────────────────────────

export function renderTodos(todos: readonly TodoItem[], th: Theme, width: number, maxRows = 6): string[] {
  if (!todos.length) return [];
  const g = th.g;
  const firstPrefix = '  ' + th.muted(g.result) + ' ';
  const rest = '    ';
  // chọn cửa sổ quanh việc đang làm
  let start = 0;
  const active = todos.findIndex((x) => x.status === 'in_progress');
  if (todos.length > maxRows) start = Math.max(0, Math.min(todos.length - maxRows, (active < 0 ? todos.findIndex((x) => x.status === 'pending') : active) - 1));
  const slice = todos.slice(start, start + maxRows);
  const rows = slice.map((x) => {
    const mark = x.status === 'completed' ? th.ok(g.todo.completed) : x.status === 'in_progress' ? th.brand(g.todo.in_progress) : x.status === 'blocked' ? th.err(g.todo.blocked) : th.muted(g.todo.pending);
    const title = x.status === 'completed' ? th.strike(th.muted(x.title)) : x.status === 'in_progress' ? th.bold(x.title) : x.title;
    const note = x.status === 'blocked' && x.note ? th.err(` — ${x.note}`) : '';
    return mark + ' ' + title + note;
  });
  const out = rows.map((r, i) => truncateAnsi((i === 0 ? firstPrefix : rest) + r, width - 1));
  const hidden = todos.length - slice.length;
  if (hidden > 0) out.push(rest + th.muted(tr('tui.todos.more', { n: hidden })));
  return out;
}

// ───────────────────────── menu gợi ý ─────────────────────────

export function renderMenu(menu: Menu, th: Theme, width: number): string[] {
  if (!menu.open) return [];
  const vis = menu.visible;
  const labelW = Math.min(Math.max(...vis.map((v) => stringWidth(v.item.label))), Math.max(12, Math.floor(width * 0.5)));
  const out = vis.map(({ item, index }) => {
    const sel = index === menu.sel;
    const label = padEnd(truncatePlain(item.label, labelW), labelW);
    const room = Math.max(0, width - 1 - 4 - labelW - 2);
    const detail = item.detail && room > 6 ? truncatePlain(item.detail.replace(/\s+/g, ' '), room) : '';
    const mark = sel ? th.brand(th.g.caret) : ' ';
    const line = `${mark} ${sel ? th.bold(th.brand(label)) : label}  ${sel ? th.plain(detail) : th.muted(detail)}`;
    return truncateAnsi(sel ? th.selected(padEnd(line, width - 1)) : line, width - 1);
  });
  if (menu.items.length > vis.length) out.push(th.faint(`  (${menu.sel + 1}/${menu.items.length})`));
  return out;
}

// ───────────────────────── phím tắt (?) ─────────────────────────

export function renderShortcuts(th: Theme, width: number): string[] {
  const keys = ['help.enter', 'help.newline', 'help.esc', 'help.ctrlc', 'help.ctrld', 'help.history', 'help.edit', 'help.mode', 'help.slash', 'help.expand', 'help.redraw'];
  const items = keys.map((k) => tr('tui.' + k));
  const colW = Math.floor((width - 2) / 2);
  const out: string[] = [th.bold(' ' + tr('tui.help.title'))];
  for (let i = 0; i < items.length; i += 2) {
    const a = ' ' + truncatePlain(items[i], colW - 1);
    const b = items[i + 1] ? truncatePlain(items[i + 1], colW - 1) : '';
    out.push(th.muted(padEnd(a, colW)) + th.muted(b));
  }
  return out.map((l) => truncateAnsi(l, width - 1));
}
