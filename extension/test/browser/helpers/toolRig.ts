import { ToolDispatcher } from '../../../src/core/engine/dispatcher';
import { newSession, type PermissionDecision, type SessionState } from '../../../src/core/engine/types';
import { SkillRegistry } from '../../../src/core/skills/registry';
import type { ToolUseBlock } from '../../../src/core/types';
import type { PermissionMode, PermissionRequest, UiEvent } from '../../../src/shared/protocol';
import { BrowserToolHost } from '../../../src/browser/host';
import { Presence, type PresenceSink } from '../../../src/browser/presence';
import { browserSkills } from '../../../src/browser/skills';
import { createBrowserToolRegistry } from '../../../src/browser/tools';
import { TabScope } from '../../../src/browser/tools/policy';
import { FakeBrowserApi } from './fakeApi';

export interface Rig {
  api: FakeBrowserApi;
  /** Presence THẬT (đang trong một lượt chạy) khi dựng với `presence: 'real'`. */
  presence?: Presence;
  scope: TabScope;
  session: SessionState;
  asked: PermissionRequest[];
  events: UiEvent[];
  decide: { value: PermissionDecision['decision'] };
  run(name: string, input: Record<string, unknown>): Promise<{ content: string; isError?: boolean; images?: unknown[] }>;
  tools(): string[];
}

export const SHOP = 'https://shop.vn/trang';
export const BANK = 'https://online.vietcombank.com.vn/';

/** Bộ công cụ trình duyệt chạy qua ToolDispatcher thật, với trình duyệt giả và người dùng giả (quyết định đặt qua `decide`). */
export function rig(mode: PermissionMode = 'default', extra: { presence?: PresenceSink | 'real' | 'real-off'; focusTabs?: boolean } = {}): Rig {
  const api = new FakeBrowserApi();
  const real = extra.presence === 'real' || extra.presence === 'real-off' ? new Presence({ api, enabled: () => extra.presence === 'real', lang: () => 'vi' }) : undefined;
  real?.begin();
  const sink = real ?? (typeof extra.presence === 'object' ? extra.presence : undefined);
  const scope = new TabScope();
  const skills = new SkillRegistry(browserSkills());
  const registry = createBrowserToolRegistry({ skills, api, scope, presence: sink, focusTabs: () => extra.focusTabs === true });
  const asked: PermissionRequest[] = [];
  const events: UiEvent[] = [];
  const decide = { value: 'allow' as PermissionDecision['decision'] };
  const host = new BrowserToolHost({
    askPermission: async (req) => {
      asked.push(req);
      return { decision: decide.value };
    },
    log: () => undefined,
  });
  const dispatcher = new ToolDispatcher({ registry, host, emit: (e) => events.push(e), language: 'vi', parallel: true });
  const session = newSession({ id: 's', provider: 'p', model: 'm', mode });
  session.loadedSkills.push('browser-control'); // đã nạp kỹ năng → công cụ thao tác khả dụng
  let n = 0;
  return {
    api,
    presence: real,
    scope,
    session,
    asked,
    events,
    decide,
    tools: () => registry.active(session, skills.unlockedTools(session.loadedSkills)).map((d) => d.name),
    async run(name, input) {
      const call: ToolUseBlock = { type: 'tool_use', id: `c${++n}`, name, input };
      const available = new Set(registry.active(session, skills.unlockedTools(session.loadedSkills)).map((d) => d.name));
      const [res] = await dispatcher.runBatch({ calls: [call], session, assistantId: 'a', signal: new AbortController().signal, available });
      return res;
    },
  };
}

export const readPage = (url = SHOP, title = 'Cửa hàng') => ({ ok: true, url, title, scroll: { y: 0, max: 100, vh: 800 }, text: 'Nội dung trang', totalChars: 14, start: 0, end: 14, selection: '', hasPassword: false, hasPayment: false });

export const describeOf = (over: Record<string, unknown> = {}) => ({
  ok: true,
  ref: 7,
  tag: 'button',
  role: 'button',
  name: 'Đặt hàng',
  sensitive: null,
  disabled: false,
  submitLike: false,
  formSensitive: false,
  page: { url: SHOP, hasPassword: false, hasPayment: false },
  ...over,
});
