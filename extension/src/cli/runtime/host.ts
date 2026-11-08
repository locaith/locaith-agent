/**
 * `ToolHost` của CLI: bọc `NodeToolHost` (đĩa, shell, mạng, tiến trình nền) và nối ba thứ phụ thuộc môi trường vào lõi chạy:
 *   • quyền (`requestPermission`) → runtime quyết định (hỏi giao diện hoặc từ chối khi không tương tác);
 *   • cài đặt (`setting`) → SettingsStore hợp nhất;
 *   • bí mật (`secret`) → biến môi trường / cài đặt người dùng (khoá tìm kiếm web…).
 */

import type { PermissionRequest } from '../../shared/protocol';
import { NodeToolHost } from '../../core/host/nodeHost';
import { NotUtf8Error, type PermissionDecision } from '../../core/engine/types';
import type { SettingsStore } from './config';
import type { LogLevel } from './util';

export type FileWriteSnapshot = string | null | { skipped: 'binary' | 'unreadable' };

export interface CliHostOptions {
  cwd: string;
  addDirs: string[];
  home: string;
  settings: SettingsStore;
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  decide(req: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision>;
  log(level: LogLevel, message: string): void;
}

/** Tên bí mật → biến môi trường thường dùng. */
const SECRET_ENV: Record<string, string[]> = {
  'search.brave': ['BRAVE_API_KEY', 'BRAVE_SEARCH_API_KEY'],
  'search.tavily': ['TAVILY_API_KEY'],
  'search.serper': ['SERPER_API_KEY'],
};

export class CliToolHost extends NodeToolHost {
  override readonly homeDir: string;
  private readonly roots: string[];
  private readonly extraRoots = new Set<string>();
  private readonly writeListeners = new Set<(abs: string, before: FileWriteSnapshot, after: string) => void>();
  private readonly permissionListeners = new Set<(req: PermissionRequest) => void>();

  constructor(private readonly o: CliHostOptions) {
    const roots = [o.cwd, ...o.addDirs.filter((d) => d && d !== o.cwd)];
    super({ roots, shellPreference: o.settings.get<string>('terminal.shell', 'auto'), fetchImpl: o.fetchImpl, onLog: (l, m) => o.log(l, m) });
    this.roots = roots;
    this.homeDir = o.home;
  }

  override workspaceRoots(): string[] {
    return this.roots;
  }

  /** Thêm một thư mục làm việc (`--add-dir`) khi đang chạy. */
  addRoot(dir: string): void {
    if (!this.roots.includes(dir)) this.roots.push(dir);
  }

  override extraReadRoots(): string[] {
    return [...this.extraRoots];
  }

  addReadRoot(dir: string): void {
    if (dir) this.extraRoots.add(dir);
  }

  onFileWrite(fn: (abs: string, before: FileWriteSnapshot, after: string) => void): void {
    this.writeListeners.add(fn);
  }

  onPermissionRequest(fn: (req: PermissionRequest) => void): void {
    this.permissionListeners.add(fn);
  }

  override async writeText(abs: string, content: string): Promise<void> {
    if (this.writeListeners.size === 0) return super.writeText(abs, content);
    let before: FileWriteSnapshot;
    try {
      before = await this.readText(abs);
    } catch (e) {
      before = { skipped: e instanceof NotUtf8Error ? 'binary' : 'unreadable' };
    }
    await super.writeText(abs, content);
    for (const fn of [...this.writeListeners]) {
      try {
        fn(abs, before, content);
      } catch (err) {
        this.o.log('warn', `Người nghe ghi tệp lỗi: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  override setting<T>(key: string, fallback: T): T {
    return this.o.settings.get<T>(key, fallback);
  }

  override async secret(name: string): Promise<string | undefined> {
    for (const e of SECRET_ENV[name] ?? []) {
      const v = this.o.env[e];
      if (v && v.trim()) return v.trim();
    }
    const generic = this.o.env[`LOCAITH_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
    if (generic && generic.trim()) return generic.trim();
    // Chỉ cài đặt NGƯỜI DÙNG mới được chứa bí mật (kho mã lạ không được tự đặt khoá tìm kiếm).
    const v = this.o.settings.getScoped<string>(`secrets.${name}`, 'user');
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  }

  override async requestPermission(req: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision> {
    for (const fn of [...this.permissionListeners]) {
      try {
        fn(req);
      } catch {
        /* người nghe lỗi không chặn việc xin quyền */
      }
    }
    return this.o.decide(req, signal);
  }
}
