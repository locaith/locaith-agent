/**
 * Dựng một ChatController THẬT (bản VS Code) với phụ thuộc giả, chạy bằng Node thuần (module 'vscode' là bản stub của test).
 * Dùng để kiểm các hành vi nằm ở lớp controller: tuần tự hoá lượt chạy (turnLock), Dừng → "tiếp tục", hàng đợi tin nhắn.
 *
 * Mọi thứ không liên quan tới lượt chạy là thao tác rỗng; những gì controller đọc để chạy engine (cấu hình, nhà cung cấp, kho phiên…)
 * được giả có chủ đích bên dưới. Nhà cung cấp là FakeProvider: test điều khiển được thời điểm model "nghĩ xong".
 */
import * as fs from 'node:fs';
import { DEFAULT_ENGINE_SETTINGS, type SessionState } from '../../src/core/engine/types';
import { builtinSkills } from '../../src/core/skills/builtin';
import { SkillRegistry } from '../../src/core/skills/registry';
import type { HostMessage, TItem, UiEvent, ViewState } from '../../src/shared/protocol';
import { ChatController, type ControllerDeps } from '../../src/host/chatController';
import { FakeProvider, type Step } from './fakeProvider';
import { workspace } from './vscode-stub';
import { makeWorkspace } from './harness';

/** Đối tượng giả: thuộc tính không khai báo là hàm không làm gì (trả undefined). `then` luôn undefined để không bị `await` nhầm là Promise. */
function autoFake<T extends object>(overrides: Record<string, unknown> = {}): T {
  return new Proxy(overrides, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return prop in target ? target[prop] : () => undefined;
    },
  }) as T;
}

export interface ControllerHarnessOptions {
  /** Kịch bản của nhà cung cấp giả. */
  script: Step[];
  /** Ghi đè cài đặt engine (mặc định: maxTurns 8, tiếng Việt). */
  settings?: Partial<typeof DEFAULT_ENGINE_SETTINGS>;
  /** Tệp có sẵn trong workspace tạm. */
  files?: Record<string, string>;
}

export interface ControllerHarness {
  ctl: ChatController;
  provider: FakeProvider;
  dir: string;
  /** Mọi tin host → webview, theo thứ tự (chỉ đọc). */
  posted: HostMessage[];
  /** Sự kiện UI ("user", "assistant_start", "notice"…) đã đi qua controller, theo thứ tự. */
  events: UiEvent[];
  logs: string[];
  /** Gửi một tin như người dùng gõ vào ô nhập (qua đúng đường của webview/Remote). */
  send(text: string): Promise<void>;
  stop(): void;
  view(): ViewState;
  session(): SessionState;
  /** Chữ các tin người dùng đang hiện trong transcript (bản HIỂN THỊ). */
  shownUserTexts(): string[];
  /** Chờ tới khi controller hết bận (không chạy, không chuẩn bị chạy) hoặc quá hạn. */
  idle(timeoutMs?: number): Promise<void>;
  dispose(): void;
}

export function makeControllerHarness(opts: ControllerHarnessOptions): ControllerHarness {
  const dir = makeWorkspace(opts.files);
  workspace.workspaceFolders = [{ uri: { fsPath: dir, scheme: 'file' }, name: 'ws' }];
  workspace.isTrusted = true;
  const logs: string[] = [];
  const provider = new FakeProvider(opts.script);
  const settings = { ...DEFAULT_ENGINE_SETTINGS, language: 'vi' as const, maxTurns: 8, ...opts.settings };

  const deps = {
    context: { globalState: { get: () => undefined, update: async () => undefined }, extension: { packageJSON: { version: '0.0.0-test' } }, subscriptions: [] },
    logger: { log: (level: string, msg: string) => void logs.push(`${level}: ${msg}`) },
    config: autoFake({
      get: (_k: string, def: unknown) => def,
      language: () => 'vi',
      engine: () => settings,
      defaultModelSetting: () => ({ provider: 'fake', model: 'fake-1' }),
      defaultMode: () => 'default',
      defaultThinking: () => 'medium',
      allowBypass: () => false,
      remoteAllowBypass: () => false,
      orchestrationMode: () => 'off',
      summarizerEnabled: () => false,
      agentsMaxConcurrent: () => 2,
      debug: () => false,
      artifactsAutoOpen: () => 'off',
      ui: () => ({}),
    }),
    secrets: autoFake({ get: async () => undefined }),
    providers: autoFake({
      has: () => true,
      hasKey: async () => true,
      get: () => provider,
      resolveModel: async (_p: string, m: string) => m,
      contextWindow: () => 200_000,
      fastTarget: async () => null,
      summaries: async () => [],
      defaultModel: () => 'fake-1',
      registry: autoFake({ descriptors: async () => [] }),
      refresh: async () => undefined,
    }),
    skills: new SkillRegistry(builtinSkills()),
    skillDirs: () => [],
    store: autoFake({ save: async () => undefined, listAll: async () => [], listTrash: async () => [], load: async () => null }),
    artifacts: autoFake(),
    diffs: autoFake(),
    editor: autoFake({ current: () => null, selection: () => undefined }),
    files: autoFake(),
    pool: autoFake({ rank: async () => [], providers: async () => [], describe: async () => [] }),
    agents: autoFake(),
    mcp: autoFake({ attach: () => () => undefined, instructions: () => [], status: () => [] }),
    market: autoFake({ search: async () => [] }),
    marketService: autoFake({ bioAutoNeeded: () => false }),
    plugins: autoFake({ commands: () => [], command: () => undefined }),
    chrome: autoFake({ status: () => ({ paired: false }), pairRequest: () => undefined, onChange: undefined }),
    onRunStateChanged: () => undefined,
  } as unknown as ControllerDeps;

  const ctl = new ChatController(deps, 'tab');
  const posted: HostMessage[] = [];
  const events: UiEvent[] = [];
  ctl.addMirror((m) => {
    posted.push(m);
    if (m.type === 'events') events.push(...m.events);
  });

  const harness: ControllerHarness = {
    ctl,
    provider,
    dir,
    posted,
    events,
    logs,
    send: (text) => ctl.handleRemote({ type: 'send', text, attachments: [] }),
    stop: () => ctl.stop(),
    view: () => ctl.snapshot().view,
    session: () => ctl.snapshot().session,
    shownUserTexts: () => ctl.snapshot().view.transcript.filter((i: TItem): i is Extract<TItem, { kind: 'user' }> => i.kind === 'user').map((i) => i.text),
    async idle(timeoutMs = 10_000) {
      const t0 = Date.now();
      // `busy` là private: dùng dấu hiệu công khai — không đang chạy — rồi nhường vòng sự kiện cho phần dọn của runAgentTurn.
      while (Date.now() - t0 < timeoutMs) {
        if (!ctl.isRunning) {
          await new Promise((r) => setTimeout(r, 40));
          if (!ctl.isRunning && !(ctl as unknown as { starting: boolean }).starting) return;
        } else await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`controller vẫn bận sau ${timeoutMs} ms`);
    },
    dispose() {
      ctl.dispose();
      workspace.workspaceFolders = undefined;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* thư mục tạm: không dọn được thì thôi */
      }
    },
  };
  return harness;
}
