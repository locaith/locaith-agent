/**
 * (lane:bg-tasks) Tiến trình chạy NỀN cho `run_command background:true` — phần phụ thuộc Node (child_process).
 *
 * - Dựng lệnh bằng cùng `buildSpawn` với lệnh đồng bộ (UTF-8 ép sẵn cho PowerShell/cmd, tệp .ps1 có BOM cho đường dẫn tiếng Việt).
 * - Dừng = giết CẢ CÂY theo PID: Windows `taskkill /PID <pid> /T /F`, POSIX gửi tín hiệu cho NHÓM tiến trình (`detached` → pgid = pid).
 *   Không bao giờ giết theo tên tiến trình (máy người dùng có dịch vụ node/python thật đang chạy).
 * - Mọi tiến trình còn sống bị giết khi tiến trình extension host thoát (lưới an toàn cuối, đồng bộ) — không để mồ côi.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import type { ProcessHandle, StartProcessOptions } from '../engine/types';
import { buildSpawn, childEnv, type ShellInfo, type SpawnSpec } from './shell';

const live = new Set<ChildProcess>();
let exitHookInstalled = false;

function killTreeSync(pid: number): void {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    /* đã thoát */
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const c of live) if (c.pid && c.exitCode === null && c.signalCode === null) killTreeSync(c.pid);
    live.clear();
  });
}

/** Số tiến trình nền còn sống do module này khởi (dùng cho test rò rỉ). */
export function liveBackgroundProcessCount(): number {
  return live.size;
}

function killTreeAsync(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      try {
        const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        const t = setTimeout(resolve, 8000);
        k.on('exit', () => {
          clearTimeout(t);
          resolve();
        });
        k.on('error', () => {
          clearTimeout(t);
          try {
            child.kill();
          } catch {
            /* đã thoát */
          }
          resolve();
        });
      } catch {
        resolve();
      }
    });
  }
  return new Promise((resolve) => {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        /* đã thoát */
      }
    }
    // Cho 1,5 s để dọn dẹp êm (server ghi log, đóng cổng), rồi giết hẳn cả nhóm.
    const t = setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* đã thoát */
      }
      resolve();
    }, 1500);
    child.once('exit', () => {
      clearTimeout(t);
      try {
        process.kill(-pid, 'SIGKILL'); // cháu chắt còn trong nhóm
      } catch {
        /* nhóm đã trống */
      }
      resolve();
    });
  });
}

export function startBackgroundProcess(shell: ShellInfo, o: StartProcessOptions): ProcessHandle {
  installExitHook();
  let spec: SpawnSpec | undefined;
  let child: ChildProcess;
  let done = false;
  const finish = (info: { exitCode: number | null; signal?: string | null; error?: string }) => {
    if (done) return;
    done = true;
    if (spec?.cleanup) fs.promises.rm(spec.cleanup, { force: true }).catch(() => undefined);
    o.onExit(info);
  };
  try {
    spec = buildSpawn(shell, o.command);
    child = spawn(spec.file, spec.args, {
      cwd: o.cwd,
      env: childEnv(),
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    queueMicrotask(() => finish({ exitCode: null, error: msg }));
    return { pid: undefined, kill: async () => undefined };
  }
  live.add(child);
  const decoder = (stream: NodeJS.ReadableStream | null) => {
    if (!stream) return;
    const dec = new TextDecoder('utf-8', { fatal: false });
    stream.on('data', (chunk: Buffer) => {
      const text = dec.decode(chunk, { stream: true });
      if (text) o.onData(text);
    });
    stream.on('end', () => {
      const tail = dec.decode();
      if (tail) o.onData(tail);
    });
  };
  decoder(child.stdout);
  decoder(child.stderr);
  child.on('error', (err) => {
    live.delete(child);
    finish({ exitCode: null, error: err.message });
  });
  child.on('exit', (code, signal) => {
    live.delete(child);
    // Như lệnh đồng bộ: 'close' có thể không bao giờ tới nếu một tiến trình cháu còn giữ ống — xả nốt đầu ra một chút rồi coi là xong.
    const t = setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish({ exitCode: code, signal });
    }, 400);
    t.unref?.();
    child.once('close', () => {
      clearTimeout(t);
      finish({ exitCode: code, signal });
    });
  });
  return {
    pid: child.pid,
    kill: () => killTreeAsync(child),
  };
}
