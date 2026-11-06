/**
 * Bio-Memory-Locaith (Bio-Agent OS) — bộ nhớ dài hạn của chính Locaith, cắm vào trợ lý qua MCP.
 *
 * MỘT nguồn dữ liệu duy nhất cho mọi cuộc trò chuyện và mọi cửa sổ VS Code: một thư mục `~/.locaith/bio-memory/data` (SQLite, chế độ WAL cho phép nhiều
 * tiến trình cùng đọc/ghi) và một `workspace-id` cố định. Nhờ vậy ký ức không phụ thuộc phiên, thư mục dự án hay lần nén ngữ cảnh: trước khi chi tiết cũ bị nén
 * khỏi ngữ cảnh, bản tóm tắt được ghi vào đây (xem ChatController.saveCompactionToMemory), và hướng dẫn "hãy recall trước khi trả lời" do chính server gửi
 * được đưa vào system prompt của MỌI model.
 * Cài vào môi trường Python RIÊNG (không đụng Python hệ thống). Không import `vscode`: mọi thứ phụ thuộc môi trường được tiêm vào.
 */

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { BIO_SERVER_NAME } from '../core/mcp/catalog';
import { bioPaths, installBio, type InstallResult, type Runner } from '../core/mcp/bioInstall';
import type { McpServerEntry } from '../core/mcp/manager';
import type { BioStatus } from '../shared/protocol';

export const BIO_WORKSPACE_ID = 'locaith';
/** Công cụ chỉ đọc: chạy không hỏi. `store_memory` / `consolidate` vẫn xin phép như mọi công cụ MCP khác. */
export const BIO_AUTO_ALLOW = ['recall', 'list_rules', 'memory_status'];
const ENABLED_KEY = 'locaithAgent.bio.enabled';
/** Người dùng đã bấm «Đừng hỏi lại» ở dải tự bật cho model Locaith-v5 → không tự cài/bật nữa (vẫn tự bật được ở Chợ → MCP). */
const AUTO_DECLINED_KEY = 'locaithAgent.bio.autoDeclined';

export interface BioDeps {
  /** `~/.locaith/bio-memory` */
  root: string;
  memento: { get<T>(k: string, d: T): T; update(k: string, v: unknown): PromiseLike<void> | void };
  log(level: 'debug' | 'info' | 'warn' | 'error', msg: string): void;
  /** Báo giao diện cập nhật (trạng thái cài đặt, dòng nhật ký). */
  onChange(): void;
  runner?: Runner;
  platform?: NodeJS.Platform;
}

export class BioMemoryService {
  private installing = false;
  private lastError: string | undefined;
  private logLines: string[] = [];
  private abort: AbortController | null = null;

  constructor(private readonly d: BioDeps) {}

  private get paths() {
    return bioPaths(this.d.root, this.d.platform);
  }

  get dataDir(): string {
    return this.paths.data;
  }

  installed(): boolean {
    return existsSync(this.paths.exe);
  }

  enabled(): boolean {
    return this.d.memento.get<boolean>(ENABLED_KEY, false) && this.installed();
  }

  status(): BioStatus {
    const base = { enabled: this.enabled(), dataDir: this.dataDir, ...(this.logLines.length ? { log: this.logLines.slice(-6) } : {}) };
    if (this.installing) return { ...base, state: 'installing', message: 'Đang cài đặt…' };
    if (this.lastError) return { ...base, state: 'error', message: this.lastError };
    return { ...base, state: this.installed() ? 'ready' : 'none' };
  }

  /** Mục để nạp vào McpManager khi đã bật; null nếu chưa cài/chưa bật. */
  entry(): McpServerEntry | null {
    if (!this.enabled()) return null;
    return {
      name: BIO_SERVER_NAME,
      scope: 'connector',
      origin: 'Bio-Memory-Locaith',
      label: 'Bio-Memory-Locaith',
      autoAllow: BIO_AUTO_ALLOW,
      cfg: {
        command: this.paths.exe,
        args: ['serve-mcp', '--workspace-id', BIO_WORKSPACE_ID],
        env: { STORAGE_DIR: this.paths.data, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        cwd: this.d.root,
      },
    };
  }

  /** Cài (hoặc cập nhật) rồi bật. An toàn khi gọi lại: lần đang chạy được giữ nguyên. */
  async install(): Promise<InstallResult> {
    if (this.installing) return { ok: false, message: 'Đang cài đặt, vui lòng đợi.' };
    this.installing = true;
    this.lastError = undefined;
    this.logLines = [];
    this.abort = new AbortController();
    this.d.onChange();
    try {
      await mkdir(this.paths.data, { recursive: true });
      const r = await installBio({
        root: this.d.root,
        platform: this.d.platform,
        runner: this.d.runner,
        signal: this.abort.signal,
        log: (line) => {
          const t = line.trim();
          if (!t) return;
          this.logLines.push(t.slice(0, 200));
          if (this.logLines.length > 40) this.logLines.shift();
          this.d.onChange();
        },
      });
      if (r.ok) {
        await this.d.memento.update(ENABLED_KEY, true);
        this.d.log('info', `Đã cài Bio-Memory-Locaith: ${r.exe}`);
      } else {
        this.lastError = r.message;
        this.d.log('warn', `Cài Bio-Memory-Locaith thất bại: ${r.message}`);
      }
      return r;
    } finally {
      this.installing = false;
      this.abort = null;
      this.d.onChange();
    }
  }

  cancelInstall(): void {
    this.abort?.abort();
  }

  autoDeclined(): boolean {
    return this.d.memento.get<boolean>(AUTO_DECLINED_KEY, false) === true;
  }

  async setAutoDeclined(v: boolean): Promise<void> {
    await this.d.memento.update(AUTO_DECLINED_KEY, v === true);
  }

  async setEnabled(on: boolean): Promise<void> {
    await this.d.memento.update(ENABLED_KEY, on);
    this.d.onChange();
  }

  /** Dữ liệu nằm ở đây — người dùng có thể sao lưu bằng cách chép thư mục này. */
  dataFile(): string {
    return path.join(this.paths.data, 'bio_agent_os.db');
  }
}
