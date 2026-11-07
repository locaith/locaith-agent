import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HookService } from '../../src/core/hooks/service';
import { HookSources, type HookConfirmRequest } from '../../src/core/hooks/sources';
import { createNodeHookExecutor } from '../../src/core/hooks/nodeExec';
import type { HooksConfig } from '../../src/core/hooks/types';

/** Shell nhanh cho test (PowerShell trên Windows khởi động chậm hàng chục giây khi máy tải). */
export const TEST_SHELL = process.platform === 'win32' ? 'cmd' : 'sh';

export const executor = createNodeHookExecutor(() => TEST_SHELL);

let counter = 0;
const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-hook-scripts-'));

/** Ghi một script node nhỏ và trả về dòng lệnh `node "đường dẫn"` chạy được trên cmd / sh. */
export function script(body: string): string {
  const file = path.join(scriptDir, `h${++counter}.js`);
  fs.writeFileSync(file, body, 'utf8');
  return `node "${file}"`;
}

/** Hook ghi toàn bộ stdin vào tệp, rồi thoát với mã cho trước (mặc định 0). */
export function recordStdin(outFile: string, exitCode = 0, extra = ''): string {
  return script(`let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{require('fs').appendFileSync(${JSON.stringify(outFile)},d+'\\n');${extra}process.exit(${exitCode});});`);
}

export function exits(code: number, stderr = '', stdout = ''): string {
  return script(`process.stdin.resume();process.stdin.on('end',()=>{${stderr ? `process.stderr.write(${JSON.stringify(stderr)});` : ''}${stdout ? `process.stdout.write(${JSON.stringify(stdout)});` : ''}process.exit(${code});});`);
}

export function printsJson(obj: unknown): string {
  return exits(0, '', JSON.stringify(obj));
}

export interface KitOptions {
  root: string;
  userHooks?: HooksConfig;
  trusted?: boolean;
  readClaude?: boolean;
  enabled?: boolean;
  approve?: (req: HookConfirmRequest) => boolean;
  approvals?: Map<string, string>;
  passEnv?: string[];
  sessionId?: () => string;
  baseEnv?: Record<string, string | undefined>;
}

export function makeKit(o: KitOptions) {
  const approvals = o.approvals ?? new Map<string, string>();
  const confirms: HookConfirmRequest[] = [];
  const notes: string[] = [];
  const logs: string[] = [];
  const sources = new HookSources({
    userHooks: () => o.userHooks,
    enabled: () => o.enabled ?? true,
    readClaude: () => o.readClaude ?? false,
    workspaceRoot: () => o.root,
    trusted: () => o.trusted ?? true,
    readFile: async (rel) => {
      try {
        return fs.readFileSync(path.join(o.root, rel), 'utf8');
      } catch {
        return null;
      }
    },
    hash: (s) => crypto.createHash('sha256').update(s).digest('hex'),
    approvals: { get: (k) => approvals.get(k), set: (k, h) => void approvals.set(k, h) },
    confirm: async (req) => {
      confirms.push(req);
      return o.approve ? o.approve(req) : true;
    },
    log: (l, m) => logs.push(`${l}: ${m}`),
    note: (_l, text) => notes.push(text),
    lang: () => 'vi',
  });
  const service = new HookService({
    sources,
    executor,
    cwd: () => o.root,
    sessionId: o.sessionId ?? (() => 's1'),
    baseEnv: () => o.baseEnv ?? process.env,
    passEnv: () => o.passEnv ?? [],
    log: (l, m) => logs.push(`${l}: ${m}`),
    lang: () => 'vi',
  });
  return { sources, service, approvals, confirms, notes, logs };
}

export function writeProjectHooks(root: string, hooks: HooksConfig, rel = '.locaith/settings.json', extra: Record<string, unknown> = {}): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify({ ...extra, hooks }, null, 2), 'utf8');
}

export const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nd-hook-ws-'));
