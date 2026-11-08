/**
 * Menu gợi ý cho ô nhập: `/lệnh` (danh sách từ runtime) và `@tệp` (rt.complete). Phần thuần: phát hiện ngữ cảnh gõ, lọc, xếp hạng,
 * trạng thái chọn có cuộn, áp dụng gợi ý vào văn bản.
 */

import type { SlashCommandInfo } from '../../shared/protocol';

export interface Range {
  start: number;
  end: number;
}

export interface MenuItem {
  label: string;
  insert: string;
  detail?: string;
}

export type MenuKind = 'slash' | 'file';

/** `/` ở đầu văn bản và con trỏ còn trong token đầu → { query (không gồm /), range }. */
export function slashContext(text: string, cursor: number): { query: string; range: Range } | null {
  if (!text.startsWith('/')) return null;
  const m = /^\/[^\s]*/.exec(text);
  if (!m) return null;
  if (cursor > m[0].length) return null;
  return { query: m[0].slice(1), range: { start: 0, end: m[0].length } };
}

/** `@token` ngay trước con trỏ (đứng đầu hoặc sau khoảng trắng). */
export function fileContext(text: string, cursor: number): { query: string; range: Range } | null {
  let i = cursor;
  while (i > 0 && !/\s/.test(text[i - 1])) i--;
  const tok = text.slice(i, cursor);
  if (!tok.startsWith('@')) return null;
  return { query: tok.slice(1), range: { start: i, end: cursor } };
}

/** Lọc + xếp hạng lệnh: tiền tố trước, rồi chứa chuỗi; trong mỗi nhóm theo bảng chữ cái. */
export function filterSlash(cmds: readonly SlashCommandInfo[], query: string): MenuItem[] {
  const q = query.toLowerCase();
  const seen = new Set<string>();
  const pre: SlashCommandInfo[] = [];
  const sub: SlashCommandInfo[] = [];
  for (const c of cmds) {
    const n = c.name.replace(/^\//, '');
    if (seen.has(n)) continue;
    seen.add(n);
    const ln = n.toLowerCase();
    if (!q || ln.startsWith(q)) pre.push(c);
    else if (ln.includes(q) || c.description.toLowerCase().includes(q)) sub.push(c);
  }
  const byName = (a: SlashCommandInfo, b: SlashCommandInfo): number => a.name.localeCompare(b.name);
  return [...pre.sort(byName), ...sub.sort(byName)].map((c) => {
    const n = c.name.replace(/^\//, '');
    return { label: '/' + n, insert: '/' + n + ' ', detail: c.description };
  });
}

export function applyCompletion(text: string, range: Range, insert: string): { text: string; cursor: number } {
  const t = text.slice(0, range.start) + insert + text.slice(range.end);
  return { text: t, cursor: range.start + insert.length };
}

/** Trạng thái menu: danh sách + chọn + cửa sổ cuộn. */
export class Menu {
  items: MenuItem[] = [];
  sel = 0;
  top = 0;
  kind: MenuKind = 'slash';
  range: Range = { start: 0, end: 0 };
  constructor(readonly windowSize = 7) {}

  set(kind: MenuKind, items: MenuItem[], range: Range): void {
    const keep = this.kind === kind ? this.items[this.sel]?.label : undefined;
    this.kind = kind;
    this.items = items;
    this.range = range;
    const k = keep ? items.findIndex((x) => x.label === keep) : -1;
    this.sel = k >= 0 ? k : 0;
    this.top = 0;
    this.fit();
  }

  clear(): void {
    this.items = [];
    this.sel = 0;
    this.top = 0;
  }

  get open(): boolean {
    return this.items.length > 0;
  }

  move(d: number): void {
    if (!this.items.length) return;
    this.sel = (this.sel + d + this.items.length) % this.items.length;
    this.fit();
  }

  private fit(): void {
    if (this.sel < this.top) this.top = this.sel;
    if (this.sel >= this.top + this.windowSize) this.top = this.sel - this.windowSize + 1;
  }

  get current(): MenuItem | undefined {
    return this.items[this.sel];
  }

  get visible(): { item: MenuItem; index: number }[] {
    return this.items.slice(this.top, this.top + this.windowSize).map((item, i) => ({ item, index: this.top + i }));
  }
}
