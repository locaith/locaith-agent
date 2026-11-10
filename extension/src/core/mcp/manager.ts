/**
 * Quản lý các server MCP: cấu hình (cài đặt người dùng, `.mcp.json` của workspace, plugin), vòng đời tiến trình,
 * và đăng ký công cụ `mcp__<server>__<tool>` vào kho công cụ của mọi cuộc trò chuyện đang mở.
 *
 * Tin cậy: server khai báo ở CÀI ĐẶT NGƯỜI DÙNG tự chạy; server đến từ workspace hoặc plugin chỉ chạy sau khi người dùng bật
 * (lưu theo băm cấu hình — đổi lệnh là phải duyệt lại), vì mở một kho mã lạ không được phép tự khởi chạy chương trình.
 * Mọi lệnh gọi công cụ vẫn xin phép từng công cụ (có "cho phép trong phiên này").
 */

import { createHash } from 'node:crypto';
import type { ToolRegistry } from '../engine/toolRegistry';
import type { ToolDef } from '../engine/types';
import { describeServer } from './catalog';
import { describeServerForApproval } from './display';
import { McpClient, type McpAuth, type McpClientHooks, type McpServerConfig, type McpStatus, type McpToolInfo } from './client';

export type McpScope = 'user' | 'workspace' | 'plugin' | 'connector';

export interface McpServerEntry {
  name: string;
  cfg: McpServerConfig;
  scope: McpScope;
  /** Nguồn hiển thị: đường dẫn `.mcp.json` hoặc tên plugin. */
  origin?: string;
  /** Cấp tiêu đề xác thực cho server HTTP (OAuth/token). */
  auth?: McpAuth;
  /** Tên hiển thị (nếu khác tên khoá). */
  label?: string;
  /** Server do chính Locaith viết/cài: các công cụ trong `autoAllow` chạy không hỏi (chỉ đọc); còn lại vẫn hỏi như thường. */
  autoAllow?: string[];
  /** Đổi giá trị này (ví dụ khi đăng nhập lại) để buộc khởi động lại server dù cấu hình giữ nguyên. */
  rev?: string;
  /** (0.7.7) Tên biến môi trường mang giá trị BÍ MẬT do người dùng nhập khi kết nối: giao diện hiện «•••» dù tên biến không có chữ KEY/TOKEN/SECRET. */
  maskEnv?: string[];
}

export interface McpServerStatus {
  name: string;
  scope: McpScope;
  origin?: string;
  transport: 'stdio' | 'http';
  status: McpStatus;
  error?: string;
  approved: boolean;
  /** Dòng lệnh / địa chỉ ĐẦY ĐỦ (xem display.ts) — chỗ người dùng quyết định cho chạy nên không được cắt âm thầm. */
  summary: string;
  /** Dòng phụ cũng thuộc về thứ sẽ chạy: cwd, biến môi trường (giá trị bí mật bị che), tên header. */
  detail?: string;
  /** summary/detail đã bị cắt vì quá dài (có dấu hiệu nhìn thấy được ở cuối). */
  truncated?: boolean;
  tools: { name: string; description: string; group: McpToolGroup; policy: McpToolPolicy }[];
  /** Mức mặc định cho cả nhóm (đọc / ghi) — công cụ nào chưa đặt riêng thì theo mức này. */
  groupPolicy: Record<McpToolGroup, McpToolPolicy>;
  /** Tên dễ hiểu và lưu ý nguồn gốc (ví dụ "Memory (Anthropic) — không phải Bio-Memory của Locaith"). */
  label?: string;
  note?: string;
  catalogId?: string;
  hasInstructions?: boolean;
}

/** Mức quyền cho một công cụ MCP: chạy luôn / hỏi trước / tắt hẳn. */
export type McpToolPolicy = 'allow' | 'ask' | 'deny';
/** Nhóm công cụ: chỉ đọc hay có thể thay đổi dữ liệu (để đặt mức chung cho cả nhóm). */
export type McpToolGroup = 'read' | 'write';

export interface McpPolicyStore {
  get(): Record<string, McpToolPolicy>;
  set(v: Record<string, McpToolPolicy>): Promise<void> | void;
}

export interface McpApprovalStore {
  get(): string[];
  set(v: string[]): Promise<void> | void;
}

const slug = (s: string): string => s.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'x';
const hash = (s: string, n = 8): string => createHash('sha1').update(s).digest('hex').slice(0, n);

export function mcpToolName(server: string, tool: string): string {
  const base = `mcp__${slug(server)}__${slug(tool)}`;
  return base.length <= 64 ? base : `${base.slice(0, 55)}_${hash(base, 8)}`;
}

function normalizeSchema(s: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(s ?? {}) };
  delete out.$schema;
  if (out.type !== 'object') return { type: 'object', properties: {} };
  if (!out.properties) out.properties = {};
  return out;
}

export class McpManager {
  private entries = new Map<string, McpServerEntry>();
  /** Mức quyền người dùng đặt cho từng công cụ / từng nhóm (`server\0tool`, `server\0~read`). */
  private readonly policy = new Map<string, McpToolPolicy>();
  private readonly clients = new Map<string, McpClient>();
  private readonly registries = new Set<ToolRegistry>();
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  constructor(
    private readonly deps: {
      log: McpClientHooks['log'];
      approvals: McpApprovalStore;
      /** Mức quyền từng công cụ (khoá `server\u0000tool`, mức nhóm `server\u0000~read`). */
      toolPolicy?: McpPolicyStore;
      version?: string;
      workspaceTrusted?: () => boolean;
      clientFactory?: (name: string, cfg: McpServerConfig, hooks: McpClientHooks) => McpClient;
    },
  ) {
    for (const [k, v] of Object.entries(deps.toolPolicy?.get() ?? {})) this.policy.set(k, v);
  }

  /** Khoá lưu mức quyền: riêng một công cụ, hoặc mức chung của một nhóm. */
  private static key(server: string, tool: string | null, group: McpToolGroup | null): string {
    return tool ? `${server}\u0000${tool}` : `${server}\u0000~${group ?? 'read'}`;
  }

  /** Chỉ đọc hay có thể ghi: ưu tiên `annotations` của server, không có thì đoán theo tên công cụ. */
  groupOf(info: { name: string; annotations?: Record<string, unknown> }): McpToolGroup {
    if (info.annotations?.readOnlyHint === true) return 'read';
    if (info.annotations?.destructiveHint === true) return 'write';
    return /^(get|list|search|read|query|count|aggregate|describe|fetch|find|filter|show|status|inspect|export|download|preview|check|resolve|lookup)_/i.test(info.name) ? 'read' : 'write';
  }

  policyFor(server: string, tool: string, group: McpToolGroup): McpToolPolicy {
    return this.policy.get(McpManager.key(server, tool, group)) ?? this.policy.get(McpManager.key(server, null, group)) ?? 'ask';
  }

  /** Người dùng đổi mức quyền: `tool` = null nghĩa là đặt cho cả nhóm. */
  async setToolPolicy(server: string, tool: string | null, group: McpToolGroup | null, mode: McpToolPolicy): Promise<void> {
    const k = McpManager.key(server, tool, group);
    if (mode === 'ask') this.policy.delete(k);
    else this.policy.set(k, mode);
    const rec: Record<string, McpToolPolicy> = {};
    for (const [key, v] of this.policy) rec[key] = v;
    await this.deps.toolPolicy?.set(rec);
    this.resetTools(server);
    this.changed();
  }

  private fingerprint(e: McpServerEntry): string {
    return `${e.scope}:${e.name}:${hash(JSON.stringify(e.cfg) + (e.rev ?? ''), 12)}`;
  }

  isApproved(e: McpServerEntry): boolean {
    if (e.scope === 'user' || e.scope === 'connector') return true; // do chính người dùng khai báo / chủ động kết nối
    if (e.scope === 'workspace' && this.deps.workspaceTrusted && !this.deps.workspaceTrusted()) return false;
    return this.deps.approvals.get().includes(this.fingerprint(e));
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private changed(): void {
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        /* người nghe lỗi không được làm hỏng quản lý */
      }
    }
  }

  /** Gắn một kho công cụ; trả về hàm gỡ. Công cụ hiện có được đăng ký ngay. */
  attach(registry: ToolRegistry): () => void {
    this.registries.add(registry);
    this.syncRegistry(registry);
    return () => {
      this.registries.delete(registry);
    };
  }

  private regState = new WeakMap<ToolRegistry, Map<string, string[]>>();

  private syncRegistry(registry: ToolRegistry): void {
    const state = this.regState.get(registry) ?? new Map<string, string[]>();
    this.regState.set(registry, state);
    for (const [server, names] of [...state]) {
      const c = this.clients.get(server);
      if (!c || c.status !== 'running') {
        for (const n of names) registry.unregister(n);
        state.delete(server);
      }
    }
    for (const [server, c] of this.clients) {
      if (c.status !== 'running' || state.has(server)) continue;
      const names: string[] = [];
      for (const info of c.tools) {
        const def = this.makeTool(server, c, info, this.entries.get(server)?.autoAllow?.includes(info.name) === true);
        if (registry.get(def.name)) continue;
        registry.register(def);
        names.push(def.name);
      }
      state.set(server, names);
    }
  }

  private syncAll(): void {
    for (const r of this.registries) this.syncRegistry(r);
    this.changed();
  }

  private makeTool(server: string, client: McpClient, info: McpToolInfo, auto = false): ToolDef {
    const name = mcpToolName(server, info.name);
    const group = this.groupOf(info);
    const chosen = this.policyFor(server, info.name, group);
    // Server do Locaith cài (Bio-Memory) tự cho chạy các công cụ chỉ đọc trong `autoAllow`, trừ khi người dùng đổi mức.
    const pol: McpToolPolicy = auto && chosen === 'ask' ? 'allow' : chosen;
    const allow = pol === 'allow';
    const deny = pol === 'deny';
    return {
      name,
      description: `[MCP · ${server}] ${(info.description ?? info.name).slice(0, 1500)}`,
      inputSchema: normalizeSchema(info.inputSchema),
      risk: allow || deny ? 'read' : 'exec',
      concurrencySafe: allow,
      permission: allow || deny ? undefined : async (input) => {
        return {
          kind: 'other',
          title: `Cho phép gọi ${server} › ${info.name}?`,
          detail: JSON.stringify(input ?? {}, null, 2).slice(0, 1500),
          sessionKey: `mcp:${server}:${info.name}`,
          sessionLabel: `Luôn cho phép ${server} › ${info.name} trong phiên này`,
        };
      },
      async execute(input, ctx) {
        if (deny) {
          return { content: `Bạn đã tắt công cụ "${info.name}" của ${server}. Bật lại ở Chợ → MCP → Quyền công cụ nếu muốn dùng.`, isError: true };
        }
        if (client.status !== 'running') return { content: `Server MCP "${server}" không còn chạy (${client.error ?? client.status}).`, isError: true };
        const r = await client.callTool(info.name, (input ?? {}) as Record<string, unknown>, { signal: ctx.signal });
        return {
          content: r.text || '(không có nội dung)',
          isError: r.isError,
          images: r.images.map((i) => ({ type: 'image' as const, mediaType: i.mediaType, data: i.data })),
          summary: info.name,
        };
      },
    };
  }

  /** Đặt lại toàn bộ cấu hình: dừng server bị xoá/đổi, tự chạy các server đã được tin cậy. */
  async configure(next: McpServerEntry[]): Promise<void> {
    const map = new Map<string, McpServerEntry>();
    for (const e of next) if (!map.has(e.name)) map.set(e.name, e); // trùng tên: bản đầu thắng (người dùng > workspace > plugin)
    const old = this.entries;
    this.entries = map;
    for (const [name, o] of old) {
      const n = map.get(name);
      if (!n || this.fingerprint(n) !== this.fingerprint(o) || !this.isApproved(n)) await this.stopOne(name);
    }
    this.syncAll();
    await Promise.all([...map.values()].filter((e) => this.isApproved(e) && !this.clients.has(e.name)).map((e) => this.startOne(e.name).catch(() => undefined)));
  }

  private async startOne(name: string): Promise<void> {
    const e = this.entries.get(name);
    if (!e || this.disposed) return;
    if (!this.isApproved(e)) throw new Error('Server chưa được bạn bật.');
    const make = this.deps.clientFactory ?? ((n, c, h) => new McpClient(n, c, h));
    const client = make(name, e.cfg, {
      log: this.deps.log,
      version: this.deps.version,
      auth: e.auth,
      onToolsChanged: () => {
        void client.listTools().then((t) => {
          client.tools = t;
          this.resetTools(name);
        }, () => undefined);
      },
    });
    this.clients.set(name, client);
    this.changed();
    try {
      await client.start();
    } catch (err) {
      this.deps.log('warn', `MCP "${name}" không khởi động được: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.syncAll();
  }

  private resetTools(name: string): void {
    for (const r of this.registries) {
      const state = this.regState.get(r);
      for (const n of state?.get(name) ?? []) r.unregister(n);
      state?.delete(name);
    }
    this.syncAll();
  }

  private async stopOne(name: string): Promise<void> {
    const c = this.clients.get(name);
    this.clients.delete(name);
    if (c) await c.close();
    this.syncAll();
  }

  /** Người dùng bấm Bật: lưu duyệt (nếu cần) rồi chạy. */
  async enable(name: string): Promise<void> {
    const e = this.entries.get(name);
    if (!e) return;
    if (!this.isApproved(e)) {
      const fp = this.fingerprint(e);
      await this.deps.approvals.set([...new Set([...this.deps.approvals.get(), fp])].slice(-200));
    }
    if (this.clients.get(name)?.status === 'running') return;
    await this.stopOne(name);
    await this.startOne(name);
  }

  /** Người dùng bấm Tắt: dừng và thu hồi duyệt. */
  async disable(name: string): Promise<void> {
    const e = this.entries.get(name);
    if (e && e.scope !== 'user') {
      const fp = this.fingerprint(e);
      await this.deps.approvals.set(this.deps.approvals.get().filter((x) => x !== fp));
    }
    await this.stopOne(name);
  }

  async restart(name: string): Promise<void> {
    await this.stopOne(name);
    await this.startOne(name);
  }

  /** Chỉ dẫn do các server đang chạy gửi kèm (đưa vào system prompt, có gắn nhãn nguồn). */
  instructions(): { server: string; text: string }[] {
    const out: { server: string; text: string }[] = [];
    for (const [name, c] of this.clients) if (c.status === 'running' && c.instructions) out.push({ server: name, text: c.instructions });
    return out;
  }

  /** Gọi trực tiếp một công cụ của server đang chạy (ví dụ lưu tóm tắt vào Bio-Memory trước khi nén ngữ cảnh). */
  async callByName(server: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; isError: boolean }> {
    const c = this.clients.get(server);
    if (!c || c.status !== 'running') throw new Error(`Server MCP "${server}" không chạy.`);
    return c.callTool(tool, args, { signal });
  }

  status(): McpServerStatus[] {
    return [...this.entries.values()].map((e) => {
      const c = this.clients.get(e.name);
      const approved = this.isApproved(e);
      return {
        name: e.name,
        scope: e.scope,
        origin: e.origin,
        transport: e.cfg.url ? 'http' : 'stdio',
        status: c?.status ?? 'stopped',
        error: c?.error,
        approved,
        ...(() => {
          const v = describeServerForApproval(e.cfg, undefined, e.maskEnv);
          return { summary: v.command, ...(v.extra.length ? { detail: v.extra.join('\n') } : {}), ...(v.truncated ? { truncated: true } : {}) };
        })(),
        ...(() => {
          const d = describeServer(e.cfg);
          return { label: e.label ?? d.label, note: d.note, catalogId: d.catalogId };
        })(),
        hasInstructions: !!c?.instructions,
        tools: (c?.status === 'running' ? c.tools : []).map((t) => {
          const group = this.groupOf(t);
          return { name: t.name, description: (t.description ?? '').slice(0, 200), group, policy: this.policyFor(e.name, t.name, group) };
        }),
        groupPolicy: { read: this.policyFor(e.name, '', 'read'), write: this.policyFor(e.name, '', 'write') },
      };
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.clients.keys()].map((n) => this.stopOne(n)));
    this.listeners.clear();
  }
}
