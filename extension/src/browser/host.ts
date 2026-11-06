import type { DirEntry, FileStat, GrepResult, PermissionDecision, RunCommandResult, ToolHost } from '../core/engine/types';
import type { PermissionRequest } from '../shared/protocol';
import type { LogLevel } from '../core/types';

const NO_FS = 'Không hỗ trợ trong trình duyệt (không có hệ thống tệp hay terminal).';

function detectOs(): 'windows' | 'mac' | 'linux' {
  const p = ((navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? '').toLowerCase();
  return p.includes('mac') ? 'mac' : p.includes('linux') || p.includes('cros') ? 'linux' : 'windows';
}

export interface BrowserHostOptions {
  askPermission(req: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision>;
  log(level: LogLevel, message: string): void;
  fetchImpl?: typeof fetch;
  secret?(name: string): Promise<string | undefined>;
}

/**
 * ToolHost của trình duyệt: không có hệ thống tệp/terminal (các công cụ đó không được đăng ký nên không bao giờ gọi tới),
 * chỉ cung cấp mạng, xin phép và nhật ký.
 */
export class BrowserToolHost implements ToolHost {
  readonly platform = { os: detectOs(), shell: 'none', shellLabel: 'none' };

  constructor(private readonly o: BrowserHostOptions) {}

  workspaceRoots(): string[] {
    return [];
  }
  extraReadRoots(): string[] {
    return [];
  }

  async stat(): Promise<FileStat | null> {
    return null;
  }
  async readText(): Promise<string | null> {
    throw new Error(NO_FS);
  }
  async readBytes(): Promise<Uint8Array> {
    throw new Error(NO_FS);
  }
  async writeText(): Promise<void> {
    throw new Error(NO_FS);
  }
  async readDir(): Promise<DirEntry[]> {
    throw new Error(NO_FS);
  }
  async glob(): Promise<string[]> {
    throw new Error(NO_FS);
  }
  async grep(): Promise<GrepResult> {
    throw new Error(NO_FS);
  }
  async runCommand(): Promise<RunCommandResult> {
    throw new Error(NO_FS);
  }

  fetch(url: string, init?: RequestInit): Promise<Response> {
    return (this.o.fetchImpl ?? fetch)(url, init);
  }

  setting<T>(key: string, fallback: T): T {
    // Bản trình duyệt chỉ dùng DuckDuckGo (không cần khoá) và không bao giờ cho đọc mạng nội bộ.
    if (key === 'search.backend') return 'duckduckgo' as T;
    if (key === 'fetch.allowPrivateNetwork') return false as T;
    return fallback;
  }

  async secret(name: string): Promise<string | undefined> {
    return this.o.secret?.(name);
  }

  requestPermission(req: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision> {
    return this.o.askPermission(req, signal);
  }

  log(level: LogLevel, message: string): void {
    this.o.log(level, message);
  }
}
