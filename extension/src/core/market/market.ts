/**
 * Chợ kỹ năng: kho kỹ năng đóng gói sẵn trong extension (`market/index.json` + `market/skills.zip`, dựng bằng
 * scripts/build-market.mjs từ kho AI-Skills, chỉ gồm kỹ năng có giấy phép cho phép phân phối lại).
 * "Thêm" = giải nén đúng một kỹ năng vào `~/.locaith/skills/<tên>` — từ đó mọi model đều gọi được qua `load_skill`.
 * Mỗi thư mục do Chợ cài có tệp đánh dấu `.locaith-market.json` nên chỉ gỡ được những gì Chợ đã cài.
 */

import { unzipSync } from 'fflate';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { foldVi } from '../skills/registry';

export interface MarketSkill {
  id: string;
  name: string;
  description: string;
  group: 'anthropic' | 'vendor' | 'community';
  repo: string;
  license: string;
  files: number;
  bytes: number;
}

export interface MarketResult {
  ok: boolean;
  message: string;
  path?: string;
}

export const MARKER = '.locaith-market.json';
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,120}$/;

export class SkillMarket {
  private cache: MarketSkill[] | null = null;

  /** `dir` = thư mục `market/` trong extension; `installRoot` = thư mục kỹ năng của người dùng. */
  constructor(
    private readonly dir: string,
    private readonly installRoot: string,
  ) {}

  async index(): Promise<MarketSkill[]> {
    if (this.cache) return this.cache;
    try {
      const raw = JSON.parse(await readFile(path.join(this.dir, 'index.json'), 'utf8')) as unknown;
      this.cache = Array.isArray(raw)
        ? raw.filter((s): s is MarketSkill => !!s && typeof s === 'object' && typeof (s as MarketSkill).id === 'string' && ID_RE.test((s as MarketSkill).id))
        : [];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  /** Id các kỹ năng đã được Chợ cài (đọc tệp đánh dấu). */
  async installedIds(): Promise<Set<string>> {
    const out = new Set<string>();
    let names: string[] = [];
    try {
      names = await readdir(this.installRoot);
    } catch {
      return out;
    }
    for (const n of names) {
      try {
        const m = JSON.parse(await readFile(path.join(this.installRoot, n, MARKER), 'utf8')) as { id?: string };
        if (typeof m.id === 'string') out.add(m.id);
      } catch {
        /* không phải thư mục của Chợ */
      }
    }
    return out;
  }

  async install(id: string): Promise<MarketResult> {
    if (!ID_RE.test(id)) return { ok: false, message: 'Mã kỹ năng không hợp lệ.' };
    const item = (await this.index()).find((s) => s.id === id);
    if (!item) return { ok: false, message: `Chợ không có kỹ năng "${id}".` };
    const target = path.join(this.installRoot, item.name);
    // Thư mục đã có mà không phải do chính Chợ cài (không có dấu, hoặc dấu của kỹ năng khác) → của người dùng, không ghi đè.
    if (await stat(target).then(() => true, () => false)) {
      let own = false;
      try {
        own = (JSON.parse(await readFile(path.join(target, MARKER), 'utf8')) as { id?: string }).id === id;
      } catch {
        own = false;
      }
      if (!own) return { ok: false, message: `Đã có thư mục "${item.name}" trong kho kỹ năng của bạn (không phải do Chợ cài). Đổi tên hoặc xoá nó trước.` };
    }
    let files: Record<string, Uint8Array>;
    try {
      const zip = await readFile(path.join(this.dir, 'skills.zip'));
      files = unzipSync(new Uint8Array(zip), { filter: (f) => f.name.startsWith(`${id}/`) });
    } catch (err) {
      return { ok: false, message: `Không đọc được kho kỹ năng đóng gói: ${err instanceof Error ? err.message : String(err)}` };
    }
    const names = Object.keys(files).filter((n) => !n.endsWith('/'));
    if (!names.some((n) => n === `${id}/SKILL.md`)) return { ok: false, message: 'Gói kỹ năng thiếu SKILL.md.' };
    const stage = `${target}.tmp-${process.pid}`;
    try {
      await rm(stage, { recursive: true, force: true });
      for (const n of names) {
        const rel = n.slice(id.length + 1);
        const abs = path.resolve(stage, rel);
        if (!rel || path.isAbsolute(rel) || (abs !== path.resolve(stage) && !abs.startsWith(path.resolve(stage) + path.sep))) continue; // chặn "../"
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, files[n]);
      }
      await writeFile(path.join(stage, MARKER), JSON.stringify({ id, name: item.name, repo: item.repo, license: item.license, installedAt: Date.now() }, null, 2));
      await rm(target, { recursive: true, force: true });
      await mkdir(this.installRoot, { recursive: true });
      const { rename } = await import('node:fs/promises');
      await rename(stage, target);
    } catch (err) {
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      return { ok: false, message: `Không cài được: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { ok: true, message: `Đã thêm kỹ năng "${item.name}".`, path: target };
  }

  async uninstall(id: string): Promise<MarketResult> {
    if (!ID_RE.test(id)) return { ok: false, message: 'Mã kỹ năng không hợp lệ.' };
    const item = (await this.index()).find((s) => s.id === id);
    const name = item?.name ?? id;
    const target = path.join(this.installRoot, name);
    try {
      const marker = JSON.parse(await readFile(path.join(target, MARKER), 'utf8')) as { id?: string };
      if (marker.id !== id) return { ok: false, message: 'Thư mục này không do Chợ cài nên không gỡ.' };
    } catch {
      return { ok: false, message: 'Kỹ năng này chưa được Chợ cài (hoặc đã bị gỡ).' };
    }
    await rm(target, { recursive: true, force: true });
    return { ok: true, message: `Đã gỡ kỹ năng "${name}".` };
  }

  /** Tìm trong Chợ (cho mô hình gợi ý "Chợ có kỹ năng X, hãy bấm Thêm"). Không dấu, không phân biệt hoa thường. */
  async search(query: string, limit = 5, skip: ReadonlySet<string> = new Set()): Promise<MarketSkill[]> {
    const tokens = foldVi(query).split(/[^a-z0-9]+/).filter((t) => t.length > 1);
    if (tokens.length === 0) return [];
    const scored: { s: MarketSkill; score: number }[] = [];
    for (const s of await this.index()) {
      if (skip.has(s.name) || skip.has(s.id)) continue;
      const name = foldVi(s.name);
      const desc = foldVi(s.description);
      let score = 0;
      for (const t of tokens) {
        if (name === t) score += 10;
        else if (name.includes(t)) score += 5;
        if (desc.includes(t)) score += 1;
      }
      if (score > 0) scored.push({ s, score });
    }
    scored.sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name));
    return scored.slice(0, limit).map((x) => x.s);
  }
}
