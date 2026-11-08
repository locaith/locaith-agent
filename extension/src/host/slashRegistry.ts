/**
 * Sổ đăng ký lệnh gạch chéo (`/lệnh`) của khung chat.
 *
 * Vì sao có: các lệnh dựng sẵn nằm trong một `switch` khổng lồ của ChatController — mỗi tính năng mới (rewind, hooks, verify,
 * lệnh tuỳ chỉnh của người dùng…) phải sửa cùng chỗ đó. Sổ này cho phép tính năng đăng ký lệnh của mình từ tệp riêng, và cho
 * phép NẠP ĐỘNG (lệnh `.locaith/commands/*.md`, lệnh MCP) theo nguồn: `replaceSource('project', defs)` thay cả nhóm một lần.
 *
 * Thứ tự ưu tiên khi trùng tên: lệnh dựng sẵn của controller (switch) > đăng ký trực tiếp ('builtin') > 'project' > 'user' >
 * 'plugin' > 'mcp'. Controller tra sổ này ở nhánh `default` của `handleSlash`, TRƯỚC lệnh plugin cũ.
 */

import type { Lang } from '../core/engine/strings';
import type { SlashCommandInfo } from '../shared/protocol';

export type SlashSource = 'builtin' | 'project' | 'user' | 'plugin' | 'mcp';

const PRIORITY: Record<SlashSource, number> = { builtin: 0, project: 1, user: 2, plugin: 3, mcp: 4 };

/** Những gì một lệnh được phép làm với khung chat. Controller dựng bản này cho mỗi lần gọi. */
export interface SlashContext {
  /** Phần chữ sau tên lệnh (đã cắt khoảng trắng đầu/cuối). */
  readonly args: string;
  readonly lang: Lang;
  /** Hiện một thông báo (markdown) ngay trong khung chat. */
  info(text: string): void;
  warn(text: string): void;
  /** Chạy MỘT lượt agent với nội dung này như thể người dùng gõ (không lưu dòng lệnh gạch chéo). */
  runPrompt(text: string, opts?: { model?: string }): Promise<void>; // (lane:commands-agents) opts.model = đổi model CHỈ cho lượt này
  /** Trợ lý đang bận (đang chạy hoặc chuẩn bị chạy). */
  readonly busy: boolean;
}

export interface SlashCommandDef {
  /** Tên không có dấu `/`, chữ thường (có thể chứa `:` hoặc `__` cho không gian tên). */
  name: string;
  description: { vi: string; en: string };
  /** Gợi ý đối số hiện trong menu, ví dụ `<tên model>`. */
  argHint?: string;
  source?: SlashSource;
  /**
   * true (mặc định) = chỉ chạy khi trợ lý rảnh; đang bận thì controller báo "hãy dừng trước" mà không gọi `run`.
   * false = chạy được cả lúc đang bận (ví dụ `/tasks`, `/context`: chỉ đọc).
   */
  needsIdle?: boolean;
  run(ctx: SlashContext): Promise<void> | void;
}

export class SlashRegistry {
  private readonly defs = new Map<string, SlashCommandDef & { source: SlashSource }>();
  private readonly listeners = new Set<() => void>();

  /** Đăng ký (hoặc thay) một lệnh. Trả về hàm gỡ. */
  register(def: SlashCommandDef): () => void {
    const name = normalize(def.name);
    if (!name) throw new Error('Tên lệnh gạch chéo không hợp lệ');
    const entry = { ...def, name, source: def.source ?? 'builtin' };
    this.defs.set(name, entry);
    this.changed();
    return () => {
      if (this.defs.get(name) === entry) {
        this.defs.delete(name);
        this.changed();
      }
    };
  }

  /** Thay TOÀN BỘ lệnh của một nguồn bằng danh sách mới (dùng cho nạp động). */
  replaceSource(source: SlashSource, defs: readonly SlashCommandDef[]): void {
    for (const [k, v] of this.defs) if (v.source === source) this.defs.delete(k);
    for (const d of defs) {
      const name = normalize(d.name);
      if (!name) continue;
      const existing = this.defs.get(name);
      // Trùng tên với nguồn ưu tiên cao hơn → giữ cái cũ.
      if (existing && PRIORITY[existing.source] <= PRIORITY[source]) continue;
      this.defs.set(name, { ...d, name, source });
    }
    this.changed();
  }

  get(name: string): (SlashCommandDef & { source: SlashSource }) | undefined {
    return this.defs.get(normalize(name));
  }

  has(name: string): boolean {
    return this.defs.has(normalize(name));
  }

  /** Danh sách cho menu `/` của giao diện. */
  list(lang: Lang): SlashCommandInfo[] {
    return [...this.defs.values()]
      .sort((a, b) => PRIORITY[a.source] - PRIORITY[b.source] || a.name.localeCompare(b.name))
      .map((d) => ({ name: d.name, description: describe(d, lang) }));
  }

  /** Nghe thay đổi (để làm mới menu). Trả về hàm huỷ. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* người nghe lỗi không được làm hỏng đăng ký */
      }
    }
  }
}

function normalize(name: string): string {
  return String(name ?? '')
    .trim()
    .replace(/^\//, '')
    .toLowerCase();
}

function describe(d: SlashCommandDef, lang: Lang): string {
  const base = lang === 'en' ? d.description.en || d.description.vi : d.description.vi || d.description.en;
  // Mô tả đã nêu cách dùng ("… — /tên [đối số]") thì khỏi nối gợi ý đối số lần nữa.
  const hint = d.argHint && !base.includes(`/${d.name}`) ? ` ${d.argHint}` : '';
  const tag =
    d.source === 'project' ? (lang === 'en' ? ' (project)' : ' (dự án)') : d.source === 'user' ? (lang === 'en' ? ' (user)' : ' (cá nhân)') : d.source === 'plugin' ? ' (plugin)' : '';
  return `${base}${hint ? ' —' + hint : ''}${tag}`;
}
