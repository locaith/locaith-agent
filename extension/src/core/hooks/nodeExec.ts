/**
 * Chạy lệnh hook bằng tiến trình thật (Node). CHỈ host VS Code / CLI / test import tệp này — bản Chrome không có shell.
 *
 * Dùng cùng shell và cách dựng lệnh như công cụ `run_command` (UTF-8 trên Windows…), nhưng:
 *   • ghi JSON vào stdin của hook;
 *   • môi trường do bên gọi dựng sẵn (danh sách cho phép), KHÔNG trộn process.env;
 *   • stdout/stderr tách riêng và bị cắt ở `maxChars`.
 */

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { buildSpawn, detectShell } from '../host/shell';
import type { HookExecResult, HookExecSpec, HookExecutor } from './types';

export function createNodeHookExecutor(shellPreference: () => string = () => 'auto'): HookExecutor {
  return {
    exec(spec: HookExecSpec): Promise<HookExecResult> {
      return new Promise((resolve) => {
        let child: ReturnType<typeof spawn>;
        let cleanup: string | undefined;
        try {
          const sp = buildSpawn(detectShell(shellPreference()), spec.command);
          cleanup = sp.cleanup;
          child = spawn(sp.file, sp.args, {
            cwd: spec.cwd,
            env: spec.env,
            windowsHide: true,
            windowsVerbatimArguments: sp.windowsVerbatimArguments,
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
          });
        } catch (err) {
          if (cleanup) fs.promises.rm(cleanup, { force: true }).catch(() => undefined);
          resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false, error: err instanceof Error ? err.message : String(err) });
          return;
        }

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let aborted = false;
        let settled = false;
        let exited = false;
        let exitCode: number | null = null;
        let backstop: ReturnType<typeof setTimeout> | undefined;

        const collect = (which: 'out' | 'err') => {
          const decoder = new TextDecoder('utf-8', { fatal: false });
          return (chunk: Buffer) => {
            const text = decoder.decode(chunk, { stream: true });
            if (which === 'out') {
              if (stdout.length < spec.maxChars) stdout += text;
            } else if (stderr.length < spec.maxChars) stderr += text;
          };
        };
        child.stdout?.on('data', collect('out'));
        child.stderr?.on('data', collect('err'));

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
        const killAndSettleSoon = () => {
          killTree();
          backstop ??= setTimeout(() => finish(exited ? exitCode : null), 2000);
        };
        const timer = setTimeout(() => {
          timedOut = true;
          killAndSettleSoon();
        }, spec.timeoutMs);
        const onAbort = () => {
          aborted = true;
          killAndSettleSoon();
        };
        if (spec.signal.aborted) onAbort();
        else spec.signal.addEventListener('abort', onAbort, { once: true });

        const finish = (code: number | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (backstop) clearTimeout(backstop);
          spec.signal.removeEventListener('abort', onAbort);
          if (cleanup) fs.promises.rm(cleanup, { force: true }).catch(() => undefined);
          child.stdout?.destroy();
          child.stderr?.destroy();
          resolve({ exitCode: timedOut || aborted ? null : code, stdout, stderr, timedOut, aborted });
        };
        child.on('error', (err) => {
          stderr += `\n${err.message}`;
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            if (backstop) clearTimeout(backstop);
            spec.signal.removeEventListener('abort', onAbort);
            if (cleanup) fs.promises.rm(cleanup, { force: true }).catch(() => undefined);
            resolve({ exitCode: null, stdout, stderr, timedOut: false, error: err.message });
          }
        });
        child.on('exit', (code) => {
          exited = true;
          exitCode = code;
          setTimeout(() => finish(code), 400).unref?.();
        });
        child.on('close', (code) => finish(code));

        // stdin: hook không đọc stdin thì EPIPE là bình thường — nuốt lỗi.
        child.stdin?.on('error', () => undefined);
        try {
          child.stdin?.end(spec.stdin);
        } catch {
          /* tiến trình đã thoát */
        }
      });
    },
  };
}
