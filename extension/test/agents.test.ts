import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentRegistry, agentFromMarkdown, builtinAgents, parseAgentModel, parseAgentTools } from '../src/core/agents/definitions';
import { buildSubRegistry, resolveChain, subAgentThinking, type AgentServices } from '../src/core/agents/runner';
import { Semaphore } from '../src/core/agents/semaphore';
import { DEFAULT_ENGINE_SETTINGS } from '../src/core/engine/types';
import { NodeToolHost } from '../src/core/host/nodeHost';
import { AUTO_PROVIDER_ID, ModelPool, type OrchestrationMode } from '../src/core/orchestration/pool';
import { builtinSkills } from '../src/core/skills/builtin';
import { SkillRegistry } from '../src/core/skills/registry';
import { createToolRegistry } from '../src/core/tools';
import type { LLMProvider, ModelInfo } from '../src/core/types';
import { FakeProvider, textTurn, toolTurn } from './helpers/fakeProvider';
import { eventsOf, makeHarness, makeWorkspace } from './helpers/harness';

function services(provider: LLMProvider, mode: OrchestrationMode = 'off', list: { id: string; label: string; hasKey: boolean; models: ModelInfo[]; p: LLMProvider }[] = []): Omit<AgentServices, 'registry'> {
  return {
    pool: new ModelPool({ summaries: async () => list, get: (id) => list.find((x) => x.id === id)?.p ?? provider }),
    agents: new AgentRegistry(),
    skills: new SkillRegistry(builtinSkills()),
    mode: () => mode,
    engineSettings: () => ({ ...DEFAULT_ENGINE_SETTINGS }),
    provider: () => provider,
    contextWindow: () => 128_000,
    log: () => {},
    limiter: new Semaphore(4),
    writeLock: new Semaphore(1),
  };
}

describe('định nghĩa agent', () => {
  it('đọc tệp .md kiểu Claude Code: tên công cụ Claude → tên của chúng ta, model opus/sonnet/haiku → hạng', () => {
    const a = agentFromMarkdown('---\nname: Code Reviewer\ndescription: Soát mã\ntools: Read, Grep, Glob, Bash\nmodel: opus\nmaxTurns: 7\nthinking: high\n---\nBạn là người soát mã.', 'x', 'workspace')!;
    expect(a).toMatchObject({ name: 'code-reviewer', tier: 'top', maxTurns: 7, thinking: 'high', source: 'workspace' });
    expect(a.tools).toEqual(['read_file', 'grep', 'glob', 'run_command']);
    expect(a.prompt).toBe('Bạn là người soát mã.');
  });

  it('mặc định chỉ đọc; all/readonly/tên cụ thể; model "nhà-cung-cấp:model" cố định', () => {
    expect(parseAgentTools(undefined)).toBe('readonly');
    expect(parseAgentTools('all')).toBe('all');
    expect(parseAgentTools('*')).toBe('all');
    expect(parseAgentTools('read-only')).toBe('readonly');
    expect(parseAgentTools(['read_file', 'mcp__db__*'])).toEqual(['read_file', 'mcp__db__*']);
    expect(parseAgentModel('inherit')).toEqual({ tier: 'inherit' });
    expect(parseAgentModel('haiku')).toEqual({ tier: 'fast' });
    expect(parseAgentModel('deepseek:deepseek-reasoner')).toEqual({ tier: 'inherit', model: 'deepseek:deepseek-reasoner' });
  });

  it('AgentRegistry nạp thư mục; agent ngoài ghi đè agent dựng sẵn cùng tên', async () => {
    const dir = makeWorkspace({ 'agents/explore.md': '---\ndescription: Do thám riêng\nmodel: top\n---\nvai trò riêng', 'agents/db.md': '---\ndescription: Chuyên CSDL\ntools: all\n---\nx', 'agents/README.txt': 'bỏ qua' });
    const reg = new AgentRegistry();
    const host = new NodeToolHost({ roots: [] });
    const res = await reg.loadDirs(host, [{ path: path.join(dir, 'agents'), source: 'workspace' }]);
    expect(res).toEqual({ loaded: 2, errors: [] });
    expect(reg.get('explore')).toMatchObject({ description: 'Do thám riêng', tier: 'top', source: 'workspace' });
    expect(reg.get('db')?.tools).toBe('all');
    expect(reg.list().length).toBe(builtinAgents().length + 1);
    expect(reg.catalog()).toContain('db (inherit, all)');
  });
});

describe('thu hẹp công cụ cho agent con', () => {
  const p = new FakeProvider([]);
  const host = new NodeToolHost({ roots: [makeWorkspace()] });
  const reg = createToolRegistry({ skills: new SkillRegistry(builtinSkills()), host, agents: services(p) });

  it('chỉ đọc: có read_file/grep/web; KHÔNG có ghi/chạy lệnh/agent/workflow/todo', () => {
    const names = buildSubRegistry(reg, { tools: 'readonly' }, 'default').all().map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(['read_file', 'grep', 'glob', 'list_dir', 'web_search', 'fetch_url', 'scratchpad']));
    for (const bad of ['edit_file', 'write_file', 'run_command', 'agent', 'workflow_run', 'todo_write', 'exit_plan_mode']) expect(names).not.toContain(bad);
  });

  it('all: có ghi/chạy lệnh nhưng vẫn không có agent/workflow (không tự sinh agent con); chế độ kế hoạch ⇒ vẫn chỉ đọc', () => {
    const all = buildSubRegistry(reg, { tools: 'all' }, 'default').all().map((d) => d.name);
    expect(all).toEqual(expect.arrayContaining(['edit_file', 'write_file', 'run_command']));
    for (const bad of ['agent', 'workflow_run', 'todo_write', 'exit_plan_mode']) expect(all).not.toContain(bad);
    const plan = buildSubRegistry(reg, { tools: 'all' }, 'plan').all().map((d) => d.name);
    for (const bad of ['edit_file', 'write_file', 'run_command']) expect(plan).not.toContain(bad);
  });

  it('danh sách tên có thể dùng ký tự đại diện (mcp__*)', () => {
    const r = createToolRegistry({ skills: new SkillRegistry(builtinSkills()), host, agents: services(p) });
    r.register({ name: 'mcp__db__query', description: 'x', inputSchema: { type: 'object' }, risk: 'exec', concurrencySafe: false, execute: async () => ({ content: '' }) });
    const names = buildSubRegistry(r, { tools: ['read_file', 'mcp__db__*'] }, 'default').all().map((d) => d.name);
    expect(names.sort()).toEqual(['mcp__db__query', 'read_file']);
  });
});

describe('resolveChain — chọn đích cho agent con', () => {
  const anth = new FakeProvider([]);
  const deep = new FakeProvider([]);
  const A: ModelInfo[] = [{ id: 'opus', label: 'opus', tier: 'top', reasoning: true }, { id: 'sonnet', label: 'sonnet', tier: 'balanced' }, { id: 'haiku', label: 'haiku', tier: 'fast' }];
  const D: ModelInfo[] = [{ id: 'deepseek-v4-flash', label: 'flash' }, { id: 'deepseek-chat', label: 'chat' }, { id: 'deepseek-reasoner', label: 'reasoner' }];
  const list = [
    { id: 'anthropic', label: 'Anthropic', hasKey: true, models: A, p: anth as LLMProvider },
    { id: 'deepseek', label: 'DeepSeek', hasKey: true, models: D, p: deep as LLMProvider },
  ];
  const parent = { provider: 'deepseek', model: 'deepseek-chat' };
  const svc = (mode: OrchestrationMode) => services(deep, mode, list);

  it('tắt điều phối: luôn dùng đúng model của phiên cha (dữ liệu không rời hãng đã chọn)', async () => {
    const s = svc('off');
    const chain = await resolveChain({ ...s }, { tier: 'top' }, undefined, parent);
    expect(chain.map((t) => `${t.providerId}:${t.model}`)).toEqual(['deepseek:deepseek-chat']);
  });

  it('failover: model của cha đứng đầu, hãng khác (cùng hạng) làm dự phòng', async () => {
    const chain = await resolveChain(svc('failover'), { tier: 'top' }, undefined, parent);
    expect(chain.map((t) => `${t.providerId}:${t.model}`)).toEqual(['deepseek:deepseek-chat', 'anthropic:sonnet']);
  });

  it('auto: chọn theo hạng trong toàn kho; tier "inherit" thì kế thừa; model cố định được tôn trọng', async () => {
    const s = svc('auto');
    expect((await resolveChain(s, { tier: 'top' }, undefined, parent)).map((t) => `${t.providerId}:${t.model}`)).toEqual(['deepseek:deepseek-reasoner', 'anthropic:opus']);
    expect((await resolveChain(s, { tier: 'fast' }, undefined, parent))[0]).toMatchObject({ providerId: 'deepseek', model: 'deepseek-v4-flash' });
    expect((await resolveChain(s, { tier: 'top' }, 'inherit', parent)).map((t) => t.model)[0]).toBe('deepseek-chat');
    expect((await resolveChain(s, { tier: 'inherit', model: 'anthropic:haiku' }, undefined, parent)).map((t) => `${t.providerId}:${t.model}`)).toEqual(['anthropic:haiku']);
    // khoá chưa nhập → bỏ model cố định, quay về kế thừa
    expect((await resolveChain(s, { tier: 'inherit', model: 'openai:gpt-5' }, undefined, parent))[0].providerId).toBe('deepseek');
  });

  it('phiên cha dùng Locaith Auto: agent con vẫn lấy đích thật từ kho', async () => {
    const chain = await resolveChain(svc('auto'), { tier: 'inherit' }, undefined, { provider: AUTO_PROVIDER_ID, model: 'auto' });
    expect(chain.length).toBeGreaterThan(0);
    expect(chain.every((t) => t.providerId !== AUTO_PROVIDER_ID)).toBe(true);
  });
});

describe('công cụ agent (đầu-cuối với engine thật)', () => {
  it('agent con chạy ở phiên riêng, chỉ có công cụ chỉ đọc, và chỉ báo cáo cuối quay về luồng chính', async () => {
    const provider = new FakeProvider([
      () => toolTurn([{ name: 'agent', input: { description: 'Tìm hằng số', prompt: 'Tìm MAX_RETRY trong dự án', agent_type: 'explore' } }]),
      () => textTurn('Tìm thấy: src/a.ts:3 — MAX_RETRY = 5'),
      () => textTurn('Hằng số nằm ở src/a.ts.'),
    ]);
    const h = makeHarness([], { provider, files: { 'src/a.ts': 'export const MAX_RETRY = 5;\n' }, agents: services(provider) });
    const res = await h.run('MAX_RETRY ở đâu?');
    expect(res.stopReason).toBe('end_turn');

    const end = eventsOf(h.events, 'tool_end').find((e) => e.output?.includes('agent «explore»'));
    expect(end?.output).toContain('Tìm thấy: src/a.ts:3');
    expect(end?.state).toBe('done');

    const sub = provider.requests[1];
    expect(JSON.stringify(sub.messages[0])).toContain('Tìm MAX_RETRY trong dự án');
    expect(JSON.stringify(sub.messages[0])).toContain('nhiem_vu');
    const subTools = sub.tools.map((t) => t.name);
    expect(subTools).toContain('read_file');
    for (const bad of ['agent', 'edit_file', 'write_file', 'run_command', 'workflow_run']) expect(subTools).not.toContain(bad);
    // hội thoại của luồng chính KHÔNG chứa các bước trung gian của agent con
    const mainMsgs = JSON.stringify(provider.requests[2].messages);
    expect(mainMsgs).toContain('Tìm thấy: src/a.ts:3');
    expect(provider.requests[2].messages.length).toBe(3); // user, assistant(tool_use), user(tool_result)
  });

  it('agent_type sai → lỗi kèm danh sách loại hiện có', async () => {
    const provider = new FakeProvider([() => toolTurn([{ name: 'agent', input: { description: 'x', prompt: 'y', agent_type: 'khong-co' } }]), () => textTurn('ok')]);
    const h = makeHarness([], { provider, agents: services(provider) });
    await h.run('thử');
    const end = eventsOf(h.events, 'tool_end')[0];
    expect(end.state).toBe('error');
    expect(end.output).toContain('explore');
  });

  it('agent "general" ghi tệp: thẻ xin phép được chuyển lên luồng chính (callId có tiền tố) và tệp chỉ được tạo sau khi duyệt', async () => {
    const provider = new FakeProvider([
      () => toolTurn([{ name: 'agent', input: { description: 'Tạo tệp', prompt: 'Tạo out.txt', agent_type: 'general' } }]),
      () => toolTurn([{ name: 'write_file', input: { path: 'out.txt', content: 'xin chào' } }]),
      () => textTurn('Đã tạo out.txt'),
      () => textTurn('Xong.'),
    ]);
    const h = makeHarness([], { provider, agents: services(provider), decide: () => 'allow' });
    await h.run('tạo tệp');
    expect(h.permissionRequests.length).toBeGreaterThanOrEqual(1);
    expect(fs.readFileSync(path.join(h.dir, 'out.txt'), 'utf8')).toBe('xin chào');
    const perm = eventsOf(h.events, 'tool_permission')[0];
    expect(perm.callId).toContain('~');
    expect(perm.request.callId).toBe(perm.callId);
  });

  it('bị từ chối thì agent con không ghi được và báo lại', async () => {
    const provider = new FakeProvider([
      () => toolTurn([{ name: 'agent', input: { description: 'Tạo tệp', prompt: 'Tạo out.txt', agent_type: 'general' } }]),
      () => toolTurn([{ name: 'write_file', input: { path: 'out.txt', content: 'x' } }]),
      () => textTurn('Không được phép ghi.'),
      () => textTurn('Người dùng từ chối.'),
    ]);
    const h = makeHarness([], { provider, agents: services(provider), decide: () => 'deny' });
    await h.run('tạo tệp');
    expect(fs.existsSync(path.join(h.dir, 'out.txt'))).toBe(false);
  });
});

describe('workflow_run (đầu-cuối: kỹ năng multi-agent → duyệt → worker → agent con)', () => {
  it('ẩn cho tới khi nạp kỹ năng multi-agent; chạy cần duyệt; kết quả gọn quay về, báo cáo agent con không vào ngữ cảnh chính', async () => {
    const provider = new FakeProvider([
      () => textTurn('chưa nạp kỹ năng'), // lượt dò công cụ: bên dưới kiểm tra danh sách công cụ của lượt đầu
    ]);
    // lượt 1: kiểm tra workflow_run chưa có
    const h0 = makeHarness([], { provider, agents: services(provider) });
    await h0.run('chào');
    expect(provider.requests[0].tools.map((t) => t.name)).toContain('agent');
    expect(provider.requests[0].tools.map((t) => t.name)).not.toContain('workflow_run');

    const p2 = new FakeProvider([
      () => toolTurn([{ name: 'load_skill', input: { skill_name: 'multi-agent' } }]),
      () => toolTurn([{ name: 'workflow_run', input: { description: 'thử', script: 'phase("A"); const r = await agent("việc A", { agent: "explore" }); store.put("ghi-chu", { n: 1 }); return { text: r.text, ok: r.ok };' } }]),
      () => textTurn('KẾT QUẢ A'),
      () => textTurn('Đã xong workflow.'),
    ]);
    const h = makeHarness([], { provider: p2, agents: services(p2) });
    const res = await h.run('chạy workflow');
    expect(res.stopReason).toBe('end_turn');
    expect(h.permissionRequests.some((r) => r.tool === 'workflow_run' && r.title.includes('workflow'))).toBe(true);
    expect(p2.requests[1].tools.map((t) => t.name)).toContain('workflow_run'); // đã mở khoá
    const subTools = p2.requests[2].tools.map((t) => t.name);
    expect(subTools).not.toContain('workflow_run');
    expect(subTools).not.toContain('agent');
    const end = eventsOf(h.events, 'tool_end').find((e) => e.output?.includes('Workflow xong'));
    expect(end?.output).toContain('"text": "KẾT QUẢ A"');
    expect(end?.output).toContain('1 agent');
    expect(h.session.scratchpad[Object.keys(h.session.scratchpad).find((k) => k.endsWith(':ghi-chu'))!]).toBe('{"n":1}');
  });

  it('người dùng từ chối duyệt thì không chạy gì', async () => {
    const p = new FakeProvider([
      () => toolTurn([{ name: 'load_skill', input: { skill_name: 'multi-agent' } }]),
      () => toolTurn([{ name: 'workflow_run', input: { description: 'thử', script: 'return 1;' } }]),
      () => textTurn('Bạn đã từ chối.'),
    ]);
    const h = makeHarness([], { provider: p, agents: services(p), decide: (r) => (r.tool === 'workflow_run' ? 'deny' : 'allow') });
    await h.run('chạy');
    const end = eventsOf(h.events, 'tool_end').find((e) => e.state === 'denied');
    expect(end).toBeTruthy();
    expect(p.requests.length).toBe(3); // không có lượt nào của agent con
  });
});

describe('mức suy luận của agent con', () => {
  it('không bao giờ thấp hơn phiên cha; swarm ⇒ mọi agent con chạy max', () => {
    // swarm = mức suy luận sâu nhất của luồng chính ⇒ cả bầy cũng max
    expect(subAgentThinking('swarm', 'low')).toBe('max');
    expect(subAgentThinking('swarm', 'medium')).toBe('max');
    expect(subAgentThinking('swarm', 'high')).toBe('max');
    expect(subAgentThinking('swarm', 'max')).toBe('max');
    // phiên cha max: định nghĩa agent chỉ được NÂNG, không được hạ
    expect(subAgentThinking('max', 'low')).toBe('max');
    // định nghĩa agent cao hơn phiên cha vẫn được tôn trọng
    expect(subAgentThinking('medium', 'high')).toBe('high');
    // phiên cha thấp: agent con không tự nâng lên (giữ chi phí như khai báo)
    expect(subAgentThinking('medium', 'low')).toBe('medium');
    expect(subAgentThinking('off', 'low')).toBe('low');
  });

  it('phiên swarm: lượt của luồng chính và của agent con đều gửi thinking mức max', async () => {
    const provider = new FakeProvider([
      () => toolTurn([{ name: 'agent', input: { description: 'Tìm', prompt: 'tìm MAX_RETRY', agent_type: 'explore' } }]),
      () => textTurn('Tìm thấy: src/a.ts:3'),
      () => textTurn('Xong.'),
    ]);
    const h = makeHarness([], { provider, agents: services(provider), files: { 'src/a.ts': 'export const MAX_RETRY = 5;\n' } });
    h.session.thinkingLevel = 'swarm';
    await h.run('tìm MAX_RETRY');
    expect(provider.requests[0].thinking?.level).toBe('max'); // luồng chính
    expect(provider.requests[1].thinking?.level).toBe('max'); // agent con «explore» (định nghĩa khai low)
  });
});

