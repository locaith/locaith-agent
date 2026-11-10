import { describe, expect, it } from 'vitest';
import { ToolDispatcher } from '../src/core/engine/dispatcher';
import { ToolRegistry } from '../src/core/engine/toolRegistry';
import { newSession, type ToolDef } from '../src/core/engine/types';
import type { ToolUseBlock } from '../src/core/types';

/**
 * (0.7.7) Trần thời gian MỖI công cụ (mặc định 10 phút) cắt cả `agent` và `workflow_run`: lệnh báo «Hết thời gian chờ» trong khi workflow vẫn chạy mồ côi ngầm.
 * `timeoutMs: null` = không trần (chỉ nút Dừng); số = trần riêng của công cụ; không đặt = mặc định chung (`toolTimeoutMs`).
 */
function slowTool(name: string, ms: number, timeoutMs?: number | null): ToolDef {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    risk: 'read',
    concurrencySafe: true,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    async execute() {
      await new Promise((r) => setTimeout(r, ms));
      return { content: `${name} xong` };
    },
  };
}

async function run(tools: ToolDef[], name: string, toolTimeoutMs: number, signal = new AbortController().signal) {
  const registry = new ToolRegistry();
  for (const t of tools) registry.register(t);
  const host = { log: () => undefined, askPermission: async () => ({ decision: 'allow' as const }) } as never;
  const d = new ToolDispatcher({ registry, host, emit: () => undefined, language: 'vi', parallel: true, toolTimeoutMs });
  const session = newSession({ id: 's', provider: 'p', model: 'm' });
  const call: ToolUseBlock = { type: 'tool_use', id: 'c1', name, input: {} };
  const [res] = await d.runBatch({ calls: [call], session, assistantId: 'a', signal, available: new Set(tools.map((t) => t.name)) });
  return res;
}

describe('trần thời gian của công cụ', () => {
  it('mặc định: công cụ chạy lâu hơn toolTimeoutMs bị cắt («Hết thời gian chờ»)', async () => {
    const r = await run([slowTool('cham', 300)], 'cham', 60);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Hết thời gian chờ/);
  });

  it('timeoutMs: null → KHÔNG bị cắt dù vượt toolTimeoutMs (agent / workflow_run)', async () => {
    const r = await run([slowTool('agent', 300, null)], 'agent', 60);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('agent xong');
  });

  it('timeoutMs: số → dùng trần riêng thay cho trần chung', async () => {
    const dai = await run([slowTool('dai', 250, 2000)], 'dai', 60); // chung 60 ms nhưng riêng 2 s → qua
    expect(dai.isError).toBeFalsy();
    const ngan = await run([slowTool('ngan', 400, 80)], 'ngan', 10_000); // chung 10 s nhưng riêng 80 ms → cắt
    expect(ngan.isError).toBe(true);
  });

  it('công cụ không trần vẫn dừng được bằng nút Dừng (signal)', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 40);
    const r = await run([slowTool('agent', 5000, null)], 'agent', 60, ac.signal);
    expect(r.isError).toBe(true);
    expect(r.content).not.toContain('agent xong');
  });
});

describe('agent và workflow_run không bị cắt ở 10 phút', () => {
  it('cả hai khai báo timeoutMs: null', async () => {
    const { createAgentTools } = await import('../src/core/agents/tools');
    const tools = createAgentTools({ agents: { catalog: () => '', get: () => undefined }, engineSettings: () => ({ language: 'vi' }) } as never);
    expect(tools.map((t) => [t.name, t.timeoutMs])).toEqual([
      ['agent', null],
      ['workflow_run', null],
    ]);
  });
});
