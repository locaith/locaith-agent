/**
 * Kho công cụ. Công cụ nền luôn có; công cụ `hidden` chỉ lộ ra sau khi skill tương ứng được nạp
 * (Trụ cột 2 — nạp công cụ lũy tiến). Thứ tự ổn định để giữ prompt-cache.
 */

import type { ToolSpec } from '../types';
import type { SessionState, ToolDef } from './types';

export function isPlanSafe(def: ToolDef): boolean {
  if (def.planSafe !== undefined) return def.planSafe;
  return def.risk === 'read' || def.risk === 'network' || def.risk === 'meta';
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();

  register(def: ToolDef): this {
    if (this.tools.has(def.name)) throw new Error(`Công cụ trùng tên: ${def.name}`);
    this.tools.set(def.name, def);
    return this;
  }

  /** Gỡ một công cụ (công cụ MCP đến/đi khi server bật/tắt). Trả về true nếu có gỡ. */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  all(): ToolDef[] {
    return [...this.tools.values()];
  }

  /** Công cụ đang khả dụng cho phiên: nền + đã mở khoá, lọc theo chế độ quyền. */
  active(session: SessionState, unlocked: ReadonlySet<string>): ToolDef[] {
    const out: ToolDef[] = [];
    for (const def of this.tools.values()) {
      if (def.onlyInMode && def.onlyInMode !== session.mode) continue;
      if (def.hidden && !def.onlyInMode && !unlocked.has(def.name)) continue;
      if (session.mode === 'plan' && !isPlanSafe(def) && def.onlyInMode !== 'plan') continue;
      out.push(def);
    }
    return out;
  }

  specs(session: SessionState, unlocked: ReadonlySet<string>): ToolSpec[] {
    return this.active(session, unlocked).map((d) => ({
      name: d.name,
      description: d.description,
      inputSchema: d.inputSchema,
      eagerInput: d.streamsContent === true,
    }));
  }
}
