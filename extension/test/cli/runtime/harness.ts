import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRuntime } from '../../../src/cli/runtime';
import type { CliRuntime, RuntimeEvent, RuntimeOptions } from '../../../src/cli/runtime';
import type { PermissionDecision } from '../../../src/core/engine/types';
import type { ProviderEvent } from '../../../src/core/types';
import { FakeProvider, type Step } from '../../helpers/fakeProvider';

/** Biến môi trường sạch: không để khoá/cài đặt thật của máy rò vào kiểm thử. */
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/_API_KEY$|_TOKEN$|^LOCAITH_|^GOOGLE_|^XAI_/i.test(k)) continue;
    env[k] = v;
  }
  return { ...env, LOCAITH_NO_DISPATCHER_CLOSE: '1', ...extra };
}

export interface Harness {
  rt: CliRuntime;
  provider: FakeProvider;
  events: RuntimeEvent[];
  home: string;
  cwd: string;
  /** Tự động trả lời xin quyền: hàm trả quyết định (mặc định allow). */
  perms: PermissionDecision[];
  uiTypes(): string[];
  texts(): string;
  outputs(): string[];
  toasts(): string[];
  cleanup(): Promise<void>;
}

const dirs: string[] = [];

export function tmpDir(prefix = 'lc-rt-'): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

export function cleanupDirs(): void {
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows có thể còn giữ tệp: bỏ qua */
    }
  }
}

export interface HarnessOpts extends Partial<RuntimeOptions> {
  /** Mỗi phần tử: bước (hàm) hoặc danh sách sự kiện của một lượt (textTurn/toolTurn). */
  script?: Array<Step | ProviderEvent[]>;
  files?: Record<string, string>;
  /** Cài đặt người dùng ghi sẵn vào ~/.locaith/settings.json. */
  userSettings?: Record<string, unknown>;
  projectSettings?: Record<string, unknown>;
  /** Tự động xử lý yêu cầu xin quyền theo hàng quyết định này (mặc định không tự trả lời). */
  autoPermission?: (req: import('../../../src/shared/protocol').PermissionRequest) => PermissionDecision | null;
  provider?: FakeProvider;
}

export async function harness(o: HarnessOpts = {}): Promise<Harness> {
  const home = o.home ?? tmpDir('lc-home-');
  const cwd = o.cwd ?? tmpDir('lc-cwd-');
  for (const [rel, text] of Object.entries(o.files ?? { 'sample.txt': 'ALPHA\nBETA\n' })) {
    const abs = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  if (o.userSettings) {
    fs.mkdirSync(path.join(home, '.locaith'), { recursive: true });
    fs.writeFileSync(path.join(home, '.locaith', 'settings.json'), JSON.stringify(o.userSettings));
  }
  if (o.projectSettings) {
    fs.mkdirSync(path.join(cwd, '.locaith'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.locaith', 'settings.json'), JSON.stringify(o.projectSettings));
  }
  const provider = o.provider ?? new FakeProvider((o.script ?? []).map((s) => (typeof s === 'function' ? s : () => s)));
  const { script: _s, files: _f, userSettings: _u, projectSettings: _p, autoPermission, provider: _pr, ...rest } = o;
  const events: RuntimeEvent[] = [];
  const perms: PermissionDecision[] = [];
  const rt = await createRuntime({
    cwd,
    home,
    version: '9.9.9-test',
    interactive: true,
    trusted: true,
    providerOverride: provider,
    model: 'test-model',
    env: cleanEnv(),
    features: [],
    ...rest,
  });
  rt.on((e) => {
    events.push(e);
    if (e.t === 'permission' && autoPermission) {
      const d = autoPermission(e.request);
      if (d) {
        perms.push(d);
        queueMicrotask(() => rt.respondPermission(e.request.id, d));
      }
    }
  });
  return {
    rt,
    provider,
    events,
    home,
    cwd,
    perms,
    uiTypes: () => events.filter((e) => e.t === 'ui').map((e) => (e as { ev: { t: string } }).ev.t),
    texts: () =>
      events
        .filter((e) => e.t === 'ui' && (e as { ev: { t: string } }).ev.t === 'text')
        .map((e) => (e as unknown as { ev: { delta: string } }).ev.delta)
        .join(''),
    outputs: () => events.filter((e) => e.t === 'output').map((e) => (e as { text: string }).text),
    toasts: () => events.filter((e) => e.t === 'toast').map((e) => (e as { text: string }).text),
    cleanup: async () => {
      await rt.dispose();
    },
  };
}

export async function waitFor(cond: () => boolean, ms = 5000, what = 'điều kiện'): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`Hết giờ chờ ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
