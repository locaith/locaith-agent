import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentEngine, type EngineDeps } from '../../src/core/engine/engine';
import { loadProjectInstructions } from '../../src/core/engine/instructions';
import { Summarizer } from '../../src/core/engine/summarizer';
import { DEFAULT_ENGINE_SETTINGS, newSession, type EngineSettings, type SessionState } from '../../src/core/engine/types';
import { NodeToolHost } from '../../src/core/host/nodeHost';
import { builtinSkills } from '../../src/core/skills/builtin';
import { SkillRegistry } from '../../src/core/skills/registry';
import { createToolRegistry, type ToolRegistryOptions } from '../../src/core/tools';
import { userText, type ContentBlock, type LLMProvider } from '../../src/core/types';
import type { PermissionRequest, UiEvent } from '../../src/shared/protocol';
import { FakeProvider, type Step } from './fakeProvider';

export function makeWorkspace(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-agent-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

export interface Harness {
  dir: string;
  host: NodeToolHost;
  provider: FakeProvider;
  engine: AgentEngine;
  session: SessionState;
  events: UiEvent[];
  permissionRequests: PermissionRequest[];
  skills: SkillRegistry;
  run(text: string, signal?: AbortSignal): ReturnType<AgentEngine['run']>;
}

export interface HarnessOptions {
  files?: Record<string, string>;
  settings?: Partial<EngineSettings>;
  /** Mức suy luận của phiên (mặc định 'medium'). */
  thinkingLevel?: SessionState['thinkingLevel'];
  hostSettings?: Record<string, unknown>;
  secrets?: Record<string, string>;
  /** Quyết định cho mọi yêu cầu xin phép (mặc định: allow). */
  decide?: (req: PermissionRequest) => 'allow' | 'allow_session' | 'deny';
  summarizer?: boolean;
  thinkTags?: boolean;
  fetchImpl?: typeof fetch;
  provider?: FakeProvider;
  eventDelayMs?: number;
  /** Bật công cụ agent con / workflow (dịch vụ điều phối do test dựng). */
  agents?: ToolRegistryOptions['agents'];
  market?: ToolRegistryOptions['market'];
  chrome?: ToolRegistryOptions['chrome'];
  /** Hàng đợi tin nhắn người dùng (steering) cho engine. */
  takeQueued?: EngineDeps['takeQueued'];
  /** Ghi đè/bổ sung phụ thuộc của engine (ví dụ onQueue, onConsentRequired của mô hình Locaith). */
  engineDeps?: Partial<EngineDeps>;
  /** Id nhà cung cấp của phiên (mặc định 'fake'). */
  sessionProvider?: string;
  /** Kho kỹ năng thay cho kho dựng sẵn (kiểm thử kỹ năng riêng của một họ mô hình). */
  skillsRegistry?: SkillRegistry;
  /** (lane:bg-tasks) Shell của host thật (test tiến trình nhanh hơn với 'cmd' trên Windows). */
  shellPreference?: string;
}

export function makeHarness(script: Step[], opts: HarnessOptions = {}): Harness {
  const dir = makeWorkspace(opts.files);
  const events: UiEvent[] = [];
  const permissionRequests: PermissionRequest[] = [];
  const host = new NodeToolHost({
    roots: [dir],
    settings: opts.hostSettings,
    shellPreference: opts.shellPreference,
    secrets: opts.secrets,
    fetchImpl: opts.fetchImpl,
    onPermission: async (req) => {
      permissionRequests.push(req);
      return { decision: opts.decide ? opts.decide(req) : 'allow' };
    },
  });
  const skills = opts.skillsRegistry ?? new SkillRegistry(builtinSkills());
  const registry = createToolRegistry({ skills, host, agents: opts.agents, market: opts.market, chrome: opts.chrome, currentProvider: () => session.provider });
  const provider = opts.provider ?? new FakeProvider(script, { eventDelayMs: opts.eventDelayMs });
  const summarizer = opts.summarizer ? new Summarizer({ provider, model: 'fake-fast', language: 'vi' }) : null;
  const settings: EngineSettings = { ...DEFAULT_ENGINE_SETTINGS, ...opts.settings };
  const deps: EngineDeps = {
    provider,
    summarizer,
    registry,
    skills,
    host,
    settings,
    emit: (e) => events.push(e),
    thinkTags: opts.thinkTags,
    loadInstructions: (names) => loadProjectInstructions(host, names),
    takeQueued: opts.takeQueued,
    ...opts.engineDeps,
  };
  const engine = new AgentEngine(deps);
  const session = newSession({ id: 's1', provider: opts.sessionProvider ?? 'fake', model: 'fake-1', thinkingLevel: opts.thinkingLevel ?? 'medium' });
  return {
    dir,
    host,
    provider,
    engine,
    session,
    events,
    permissionRequests,
    skills,
    run(text, signal = new AbortController().signal) {
      const content: ContentBlock[] = userText(text).content;
      return engine.run({ session, content, signal });
    },
  };
}

export function eventsOf<T extends UiEvent['t']>(events: UiEvent[], t: T): Extract<UiEvent, { t: T }>[] {
  return events.filter((e): e is Extract<UiEvent, { t: T }> => e.t === t);
}

export type { LLMProvider };
