/**
 * Skill Registry — Trụ cột 2: "Documentation-as-Tool-Output" + nạp kỹ năng lũy tiến.
 *
 * System prompt gốc chỉ chứa danh mục ngắn (tên + một dòng mô tả). Khi gặp bài toán cần, model gọi
 * `load_skill(name)`: toàn bộ hướng dẫn thiết kế của kỹ năng được trả về NGAY TRONG kết quả công cụ,
 * kèm việc mở khoá các công cụ con. Nhờ vậy câu chat thông thường không phải gánh hàng chục nghìn token vô ích.
 *
 * Định dạng SKILL.md tương thích với skill của Claude: frontmatter `name`, `description` (+ `unlocks`, `tags`).
 */

import type { ToolHost } from '../engine/types';

export type SkillSource = 'builtin' | 'workspace' | 'user';

export interface SkillDef {
  name: string;
  description: string;
  tags: string[];
  /** Nội dung hướng dẫn (Markdown) trả về cho model khi nạp. */
  body: string;
  /** Tên các công cụ ẩn được mở khoá khi nạp kỹ năng này. */
  unlocks: string[];
  source: SkillSource;
  /** Thư mục chứa SKILL.md (kỹ năng ngoài bộ dựng sẵn). */
  dir?: string;
  /** Tệp đi kèm trong thư mục kỹ năng (đường dẫn tương đối) — model đọc bằng read_file khi cần. */
  files?: string[];
  /**
   * Chỉ dành cho các nhà cung cấp này (id, ví dụ `providers: [locaith]` — kỹ năng riêng của họ mô hình Locaith). Không khai báo = mọi nhà cung cấp.
   * Với nhà cung cấp khác kỹ năng KHÔNG hiện trong danh mục, `load_skill` coi như không tồn tại và công cụ nó mở khoá không mở.
   */
  providers?: string[];
}

/** Kỹ năng này dùng được với nhà cung cấp `providerId` không? Kỹ năng có `providers` mà không biết nhà cung cấp hiện tại thì KHÔNG dùng (an toàn mặc định). */
export function skillAllowedFor(s: Pick<SkillDef, 'providers'>, providerId?: string): boolean {
  if (!s.providers || s.providers.length === 0) return true;
  return !!providerId && s.providers.includes(providerId.toLowerCase());
}

export interface ParsedMarkdown {
  meta: Record<string, string | string[]>;
  body: string;
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/** Đọc frontmatter YAML tối giản: `key: value`, `key: [a, b]`, danh sách `- item`, khối `>`/`|`. */
export function parseSkillMarkdown(text: string): ParsedMarkdown {
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (!m) return { meta: {}, body: src.trim() };

  const meta: Record<string, string | string[]> = {};
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const raw = kv[2].trim();
    if (raw === '' || /^[>|][+-]?$/.test(raw)) {
      // Khối nhiều dòng hoặc danh sách gạch đầu dòng: gom các dòng thụt lề phía sau.
      const folded = raw.startsWith('>') ;
      const items: string[] = [];
      const parts: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || /^\s*-\s+/.test(lines[i + 1]))) {
        i++;
        const line = lines[i];
        const li = /^\s*-\s+(.*)$/.exec(line);
        if (li) items.push(stripQuotes(li[1]));
        else parts.push(line.trim());
      }
      if (items.length > 0) meta[key] = items;
      else meta[key] = parts.join(folded ? ' ' : '\n').trim();
    } else if (raw.startsWith('[') && raw.endsWith(']')) {
      meta[key] = raw
        .slice(1, -1)
        .split(',')
        .map((s) => stripQuotes(s))
        .filter(Boolean);
    } else {
      meta[key] = stripQuotes(raw);
    }
  }
  return { meta, body: src.slice(m[0].length).trim() };
}

function asList(v: string | string[] | undefined): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return v
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function slugifyName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** Bỏ dấu + hạ chữ thường: "Dựng báo cáo" khớp "dung bao cao". */
export function foldVi(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase();
}

export function skillFromMarkdown(
  text: string,
  fallbackName: string,
  source: SkillSource,
  extra?: Pick<SkillDef, 'dir' | 'files'>,
): SkillDef | null {
  const { meta, body } = parseSkillMarkdown(text);
  const name = slugifyName(String(meta.name ?? fallbackName));
  if (!name) return null;
  const description = String(meta.description ?? '').replace(/\s+/g, ' ').trim() || body.split('\n').find((l) => l.trim()) || name;
  const providers = asList(meta.providers)
    .map((p) => p.trim().toLowerCase())
    .filter((p) => /^[a-z0-9][a-z0-9-]{0,40}$/.test(p));
  return {
    name,
    description: description.slice(0, 400),
    tags: asList(meta.tags),
    unlocks: asList(meta.unlocks),
    body,
    source,
    ...(providers.length ? { providers } : {}),
    ...extra,
  };
}

export interface SkillDirSpec {
  path: string;
  source: Exclude<SkillSource, 'builtin'>;
}

export class SkillRegistry {
  private readonly skills = new Map<string, SkillDef>();
  private readonly builtin: SkillDef[];

  constructor(builtin: SkillDef[]) {
    this.builtin = builtin;
    for (const s of builtin) this.skills.set(s.name, s);
  }

  /** Quét lại các thư mục kỹ năng của workspace/người dùng; kỹ năng ngoài ghi đè kỹ năng dựng sẵn trùng tên. */
  async loadDirs(host: ToolHost, dirs: SkillDirSpec[]): Promise<{ loaded: number; errors: string[] }> {
    this.skills.clear();
    for (const s of this.builtin) this.skills.set(s.name, s);
    let loaded = 0;
    const errors: string[] = [];
    for (const dir of dirs) {
      let entries;
      try {
        const st = await host.stat(dir.path);
        if (!st?.isDirectory) continue;
        entries = await host.readDir(dir.path);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory) continue;
        const skillDir = joinPath(dir.path, entry.name);
        try {
          const text = await host.readText(joinPath(skillDir, 'SKILL.md'));
          if (text == null) continue;
          let files: string[] = [];
          try {
            files = (await host.readDir(skillDir)).filter((e) => !e.isDirectory && e.name !== 'SKILL.md').map((e) => e.name);
          } catch {
            /* thư mục con không bắt buộc */
          }
          const def = skillFromMarkdown(text, entry.name, dir.source, { dir: skillDir, files });
          if (def) {
            this.skills.set(def.name, def);
            loaded++;
          }
        } catch (err) {
          errors.push(`${skillDir}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return { loaded, errors };
  }

  /** Các kỹ năng dùng được với nhà cung cấp `providerId` (kỹ năng riêng của một họ mô hình chỉ hiện với họ đó). */
  list(providerId?: string): SkillDef[] {
    return [...this.skills.values()].filter((s) => skillAllowedFor(s, providerId));
  }

  get(name: string, providerId?: string): SkillDef | undefined {
    const found = this.skills.get(name) ?? this.skills.get(slugifyName(name));
    return found && skillAllowedFor(found, providerId) ? found : undefined;
  }

  /** Tìm theo từ khoá, không phân biệt dấu. */
  search(query: string, limit = 5, providerId?: string): SkillDef[] {
    const tokens = foldVi(query)
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1);
    if (tokens.length === 0) return this.list(providerId).slice(0, limit);
    const scored: { s: SkillDef; score: number }[] = [];
    for (const s of this.list(providerId)) {
      const name = foldVi(s.name);
      const desc = foldVi(s.description);
      const tags = s.tags.map(foldVi);
      let score = 0;
      for (const tk of tokens) {
        if (name === tk) score += 10;
        else if (name.includes(tk)) score += 5;
        if (tags.some((tg) => tg === tk || tg.includes(tk))) score += 4;
        if (desc.includes(tk)) score += 1;
      }
      if (score > 0) scored.push({ s, score });
    }
    scored.sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name));
    return scored.slice(0, limit).map((x) => x.s);
  }

  /** Tập tên công cụ được mở khoá bởi các kỹ năng đã nạp (kỹ năng riêng của họ mô hình khác thì không mở gì). */
  unlockedTools(loaded: readonly string[], providerId?: string): Set<string> {
    const out = new Set<string>();
    for (const name of loaded) {
      const s = this.skills.get(name);
      if (s && skillAllowedFor(s, providerId)) for (const tool of s.unlocks) out.add(tool);
    }
    return out;
  }

  /** Danh mục ngắn đưa vào mô tả công cụ load_skill. */
  catalog(providerId?: string): string {
    return this.list(providerId)
      .map((s) => `- ${s.name}: ${s.description}`)
      .join('\n');
  }
}

function joinPath(a: string, b: string): string {
  const sep = a.includes('\\') && !a.includes('/') ? '\\' : '/';
  return a.endsWith('/') || a.endsWith('\\') ? a + b : a + sep + b;
}
