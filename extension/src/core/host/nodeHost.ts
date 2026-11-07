/**
 * Cài đặt `ToolHost` bằng Node thuần (fs, child_process, fetch).
 * - Dùng trực tiếp trong test và công cụ dòng lệnh.
 * - Lớp host VS Code kế thừa và chỉ ghi đè những chỗ cần API của VS Code (editor chưa lưu, quyền, bí mật, cấu hình).
 */

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import type { PermissionRequest } from '../../shared/protocol';
import { compileGlob } from '../fsutil/glob';
import { isSecretFile } from '../fsutil/paths';
import { walk } from '../fsutil/walk';
import { safeFetch } from '../tools/web/safeFetch';
import {
  NotUtf8Error,
  type DirEntry,
  type FileStat,
  type GrepHit,
  type GrepResult,
  type PermissionDecision,
  type RunCommandOptions,
  type RunCommandResult,
  type ProcessHandle,
  type StartProcessOptions,
  type ToolHost,
} from '../engine/types';
import { buildSpawn, childEnv, detectShell, type ShellInfo } from './shell';
import { startBackgroundProcess } from './bgProcess'; // (lane:bg-tasks)

export interface NodeHostOptions {
  roots: string[];
  extraReadRoots?: string[];
  settings?: Record<string, unknown>;
  secrets?: Record<string, string>;
  shellPreference?: string;
  fetchImpl?: typeof fetch;
  onPermission?: (req: PermissionRequest, signal: AbortSignal) => Promise<PermissionDecision>;
  onLog?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

const MAX_OUTPUT_CHARS = 400_000;
/** Mỗi tệp phải quét xong trong chừng này; cả lệnh grep có tổng ngân sách riêng. */
const SCAN_TIMEOUT_MS = 2500;
const GREP_TOTAL_BUDGET_MS = 30_000;

/**
 * Trả về hàm quét các dòng chạy BÊN TRONG một ngữ cảnh `vm` có hạn giờ. Biểu thức chính quy do model sinh ra như
 * `(a+)+$` có thể backtrack theo hàm mũ và treo cả tiến trình extension host; `vm` ngắt được việc thực thi đó.
 */
function createLineScanner(source: string, flags: string): (lines: string[]) => number[] {
  const sandbox = vm.createContext({ SRC: source, FLAGS: flags, lines: [] as string[] });
  vm.runInContext(
    'var re = new RegExp(SRC, FLAGS);' +
      'function scan(lines) { var out = []; for (var i = 0; i < lines.length; i++) { re.lastIndex = 0; if (re.test(lines[i])) out.push(i); } return out; }',
    sandbox,
    { timeout: 500 },
  );
  return (lines) => {
    sandbox.lines = lines;
    return Array.from(vm.runInContext('scan(lines)', sandbox, { timeout: SCAN_TIMEOUT_MS }) as number[]);
  };
}

export class NodeToolHost implements ToolHost {
  readonly platform: ToolHost['platform'];
  /** `~` của người dùng: nơi đặt ký ức dùng chung mọi dự án. */
  readonly homeDir: string = os.homedir();
  protected readonly shell: ShellInfo;
  /** Tệp bắt đầu bằng BOM: nhớ để ghi lại cho đúng (Excel/Notepad ở Việt Nam hay xuất CSV có BOM). */
  private readonly bomFiles = new Set<string>();

  constructor(protected readonly opts: NodeHostOptions) {
    this.shell = detectShell(opts.shellPreference ?? 'auto');
    this.platform = {
      os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux',
      shell: this.shell.kind,
      shellLabel: this.shell.label,
    };
  }

  workspaceRoots(): string[] {
    return this.opts.roots;
  }

  extraReadRoots(): string[] {
    return this.opts.extraReadRoots ?? [];
  }

  async stat(abs: string): Promise<FileStat | null> {
    try {
      const s = await fs.promises.stat(abs);
      return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return null;
    }
  }

  async readText(abs: string): Promise<string | null> {
    let buf: Buffer;
    try {
      buf = await fs.promises.readFile(abs);
    } catch {
      return null;
    }
    // Giải mã NGHIÊM NGẶT: byte không hợp lệ (Windows-1258 "Việt" = 56 69 EA F2 74) mà bị thay bằng U+FFFD rồi ghi lại
    // thì chữ có dấu mất vĩnh viễn chỉ sau một lần sửa không liên quan. ignoreBOM giữ nguyên BOM ở đầu để ta ghi nhớ nó.
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
    } catch {
      throw new NotUtf8Error(abs);
    }
    if (text.charCodeAt(0) === 0xfeff) {
      this.bomFiles.add(abs);
      text = text.slice(1);
    }
    return text;
  }

  async readBytes(abs: string): Promise<Uint8Array> {
    return fs.promises.readFile(abs);
  }

  async writeText(abs: string, content: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    const out = this.bomFiles.has(abs) && content.charCodeAt(0) !== 0xfeff ? '﻿' + content : content;
    await fs.promises.writeFile(abs, out, 'utf8');
  }

  async readDir(abs: string): Promise<DirEntry[]> {
    const entries = await fs.promises.readdir(abs, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
  }

  async glob(o: { pattern: string; cwd: string; limit: number; signal: AbortSignal }): Promise<string[]> {
    const m = compileGlob(o.pattern, false);
    const out: string[] = [];
    for await (const e of walk({ root: o.cwd, signal: o.signal })) {
      if (m.test(e.rel)) {
        out.push(e.rel);
        if (out.length >= o.limit) break;
      }
    }
    return out;
  }

  async grep(o: {
    pattern: string;
    cwd: string;
    glob?: string;
    ignoreCase: boolean;
    context: number;
    limit: number;
    signal: AbortSignal;
  }): Promise<GrepResult> {
    const flags = o.ignoreCase ? 'i' : '';
    // Mẫu hỏng cú pháp → tìm đúng nguyên văn (model hay quên thoát dấu `(`, `[`…).
    let source = o.pattern;
    try {
      new RegExp(source, flags);
    } catch {
      source = o.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    const scan = createLineScanner(source, flags);
    const matcher = o.glob ? compileGlob(o.glob, true) : null;
    const hits: GrepHit[] = [];
    const started = Date.now();
    let filesScanned = 0;
    let skippedSecret = 0;
    let truncated = false;
    let regexTimedOut = false;

    outer: for await (const e of walk({ root: o.cwd, signal: o.signal })) {
      if (matcher && !matcher.test(e.rel)) continue;
      // Nội dung .env / khoá riêng không đi vào kết quả tìm kiếm: đọc chúng phải qua read_file, nơi có hỏi người dùng.
      if (isSecretFile(e.abs)) {
        skippedSecret++;
        continue;
      }
      let st: fs.Stats;
      try {
        st = await fs.promises.stat(e.abs);
      } catch {
        continue;
      }
      if (st.size > 2_000_000) continue;
      let buf: Buffer;
      try {
        buf = await fs.promises.readFile(e.abs);
      } catch {
        continue;
      }
      if (buf.subarray(0, 4096).includes(0)) continue; // nhị phân
      filesScanned++;
      const lines = buf.toString('utf8').split(/\r?\n/);
      let matched: number[];
      try {
        matched = scan(lines);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw err;
        regexTimedOut = true;
        truncated = true;
        break;
      }
      for (const i of matched) {
        const hit: GrepHit = { path: e.rel, line: i + 1, text: lines[i].slice(0, 400) };
        if (o.context > 0) {
          hit.before = lines.slice(Math.max(0, i - o.context), i).map((l) => l.slice(0, 400));
          hit.after = lines.slice(i + 1, i + 1 + o.context).map((l) => l.slice(0, 400));
        }
        hits.push(hit);
        if (hits.length >= o.limit) {
          truncated = true;
          break outer;
        }
      }
      if (filesScanned >= 20_000 || Date.now() - started > GREP_TOTAL_BUDGET_MS) {
        truncated = true;
        break;
      }
    }
    return { hits, truncated, filesScanned, skippedSecret, regexTimedOut };
  }

  runCommand(o: RunCommandOptions): Promise<RunCommandResult> {
    return new Promise((resolve) => {
      const spec = buildSpawn(this.shell, o.command);
      let child;
      try {
        child = spawn(spec.file, spec.args, {
          cwd: o.cwd,
          env: childEnv(),
          windowsHide: true,
          windowsVerbatimArguments: spec.windowsVerbatimArguments,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        });
      } catch (err) {
        resolve({
          exitCode: null,
          output: `Không khởi chạy được shell: ${err instanceof Error ? err.message : String(err)}`,
          timedOut: false,
          aborted: false,
          truncated: false,
        });
        return;
      }

      let output = '';
      let truncated = false;
      let timedOut = false;
      let aborted = false;
      let settled = false;
      let exited = false;
      let exitCode: number | null = null;
      let backstop: ReturnType<typeof setTimeout> | undefined;

      // MỖI luồng một bộ giải mã: một ký tự UTF-8 nhiều byte ("ệ") bị cắt giữa hai khúc của stdout, rồi một khúc stderr
      // xen vào, sẽ làm hỏng cả hai nếu dùng chung bộ giải mã có trạng thái.
      const makePush = () => {
        const decoder = new TextDecoder('utf-8', { fatal: false });
        return {
          push(chunk: Buffer) {
            const text = decoder.decode(chunk, { stream: true });
            if (!text) return;
            if (output.length < MAX_OUTPUT_CHARS) output += text;
            else truncated = true;
            o.onData(text);
          },
          flush() {
            const tail = decoder.decode();
            if (tail && output.length < MAX_OUTPUT_CHARS) output += tail;
          },
        };
      };
      const outPush = makePush();
      const errPush = makePush();
      child.stdout?.on('data', outPush.push);
      child.stderr?.on('data', errPush.push);

      const killTree = () => {
        const pid = child.pid;
        if (!pid) return;
        try {
          if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
          else process.kill(-pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            /* đã thoát */
          }
        }
      };

      // Sau khi giết cây tiến trình, KHÔNG chờ vô hạn sự kiện 'close': một tiến trình cháu tách rời vẫn giữ ống mở thì
      // 'close' không bao giờ tới, lệnh treo tới lúc công cụ bị cắt sau 10 phút và mất cả đầu ra.
      const killAndSettleSoon = () => {
        killTree();
        backstop ??= setTimeout(() => finish(exited ? exitCode : null), 2000);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killAndSettleSoon();
      }, o.timeoutMs);
      const onAbort = () => {
        aborted = true;
        killAndSettleSoon();
      };
      if (o.signal.aborted) onAbort();
      else o.signal.addEventListener('abort', onAbort, { once: true });

      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (backstop) clearTimeout(backstop);
        o.signal.removeEventListener('abort', onAbort);
        if (spec.cleanup) fs.promises.rm(spec.cleanup, { force: true }).catch(() => undefined);
        outPush.flush();
        errPush.flush();
        // Giải phóng ống để tiến trình cháu (nếu còn) không giữ tài nguyên của ta.
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolve({ exitCode: code, output, timedOut, aborted, truncated });
      };
      child.on('error', (err) => {
        output += `\n${err.message}`;
        finish(null);
      });
      // Shell đã thoát nhưng 'close' có thể không bao giờ tới nếu một tiến trình cháu còn giữ ống (`nohup …&`, `Start-Process`):
      // cho thêm một khoảng ngắn để xả nốt đầu ra rồi coi lệnh là đã xong.
      child.on('exit', (code) => {
        exited = true;
        exitCode = code;
        setTimeout(() => finish(code), 400).unref?.();
      });
      child.on('close', (code) => finish(code));
    });
  }

  // (lane:bg-tasks) tiến trình nền: xem bgProcess.ts
  startProcess(o: StartProcessOptions): ProcessHandle {
    return startBackgroundProcess(this.shell, o);
  }

  fetch(url: string, init?: RequestInit): Promise<Response> {
    return (this.opts.fetchImpl ?? fetch)(url, init);
  }

  fetchPublic(url: URL, init: { headers?: Record<string, string>; signal?: AbortSignal }, allowPrivate: boolean): Promise<Response> {
    // Test truyền fetchImpl giả → dùng nó; ngoài đời thật luôn đi qua đường ghim IP.
    if (this.opts.fetchImpl) return this.opts.fetchImpl(url.toString(), { redirect: 'manual', headers: init.headers, signal: init.signal });
    return safeFetch(url, { headers: init.headers, signal: init.signal, allowPrivate });
  }

  setting<T>(key: string, fallback: T): T {
    const v = this.opts.settings?.[key];
    return v === undefined ? fallback : (v as T);
  }

  async secret(name: string): Promise<string | undefined> {
    return this.opts.secrets?.[name];
  }

  async requestPermission(req: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision> {
    if (this.opts.onPermission) return this.opts.onPermission(req, signal);
    return { decision: 'deny', feedback: 'Không có kênh xác nhận.' };
  }

  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.opts.onLog?.(level, message);
  }
}
