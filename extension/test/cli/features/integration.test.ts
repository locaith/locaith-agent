// @ts-nocheck — dùng harness của lane cli-rt qua import động nên kiểu là any
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defaultFeatures } from '../../../src/cli/runtime/features';
import { FakeProvider, textTurn, toolTurn } from '../../helpers/fakeProvider';
import { script as hookScript, exits, TEST_SHELL } from '../../helpers/hookKit';

/**
 * Tích hợp với lõi THẬT của lane cli-rt (createRuntime + harness của nó). Chỉ chạy khi `test/cli/runtime/harness.ts` có mặt (sau khi gộp hai nhánh);
 * ở nhánh `feat/cli-features` riêng lẻ thì bị bỏ qua.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const harnessFile = path.resolve(HERE, '../runtime/harness.ts');
const HAS_RT = fs.existsSync(harnessFile) && fs.existsSync(path.resolve(HERE, '../../../src/cli/runtime/runtime.ts'));
let harness: (o?: any) => Promise<any>;
let cleanupDirs: () => void;
let waitFor: (cond: () => boolean, ms?: number, what?: string) => Promise<void>;
type Harness = any;
beforeAll(async () => {
  if (!HAS_RT) return;
  const m: any = await import(/* @vite-ignore */ harnessFile);
  ({ harness, cleanupDirs, waitFor } = m);
});
const SERVER = fileURLToPath(new URL('./fixtures/fake-mcp-server.cjs', import.meta.url));
afterEach(() => cleanupDirs?.());

/** Tự trả lời mọi `ask` theo hàng đợi (đúng thứ tự xuất hiện). */
function autoAnswer(h: Harness, answers: (string | boolean | null)[]): { asked: unknown[] } {
  const asked: unknown[] = [];
  h.rt.on((e: any) => {
    if (e.t === 'ask') {
      asked.push(e.ask);
      const a = answers.length ? answers.shift()! : null;
      queueMicrotask(() => h.rt.answer(e.ask.id, a));
    }
  });
  return { asked };
}

const opts = { features: defaultFeatures(), userSettings: { 'terminal.shell': TEST_SHELL } as Record<string, unknown> };

describe.skipIf(!HAS_RT)('tích hợp: mô-đun tính năng + lõi cli-rt', () => {
  it('mọi lệnh của lane có trong menu, chạy được và không lỗi gắn', async () => {
    const h = await harness({ ...opts, script: [] });
    const names = h.rt.slashCommands().map((c) => c.name);
    for (const n of ['rewind', 'tasks', 'hooks', 'mcp', 'skills', 'agents', 'permissions', 'memory', 'init', 'review', 'simplify', 'security-review', 'output-style', 'verify', 'fork', 'plugins']) expect(names, `thiếu /${n}`).toContain(n);
    for (const n of ['tasks', 'hooks', 'mcp', 'skills', 'agents', 'permissions', 'memory', 'output-style', 'plugins']) {
      const before = h.outputs().length;
      await h.rt.submit(`/${n}`);
      expect(h.outputs().length, `/${n} không in gì`).toBeGreaterThan(before);
    }
    expect(h.toasts().filter((t) => /lỗi khi gắn|failed to attach/i.test(t))).toEqual([]);
    expect(h.events.filter((e) => e.t === 'output' && (e as { kind?: string }).kind === 'error')).toEqual([]);
    await h.cleanup();
  });

  it('checkpoint + /rewind chạy trên phiên thật: ghi tệp bằng công cụ, rewind cả mã lẫn hội thoại', async () => {
    const h = await harness({ ...opts, files: { 'a.txt': 'goc' }, script: [toolTurn([{ name: 'write_file', input: { path: 'n.txt', content: 'moi' } }]), textTurn('Đã sửa.'), textTurn('Lượt hai xong.')], autoPermission: () => ({ decision: 'allow' }) });
    await h.rt.submit('sửa a.txt');
    await h.rt.idle();
    expect(fs.readFileSync(path.join(h.cwd, 'n.txt'), 'utf8')).toBe('moi');
    await waitFor(() => h.rt.status().changedFiles === 1, 3000, 'changedFiles');
    await h.rt.submit('lượt hai');
    await h.rt.idle();
    const ans = { asked: [] as unknown[] };
    h.rt.on((e: any) => {
      if (e.t === 'ask') ans.asked.push(e.ask);
    });
    // chọn lượt đầu → cả hai → xác nhận
    const turnsAsked = (): string => '';
    void turnsAsked;
    const first = h.rt.submit('/rewind');
    await waitFor(() => ans.asked.length >= 1, 3000, 'ask chọn lượt');
    const pick = ans.asked[0] as { items: { id: string; label: string }[] };
    expect(pick.items.map((i) => i.label)).toEqual(['lượt hai', 'sửa a.txt']);
    h.rt.answer((pick as unknown as { id: string }).id, pick.items[1].id);
    await waitFor(() => ans.asked.length >= 2, 3000, 'ask chọn gì');
    h.rt.answer((ans.asked[1] as { id: string }).id, 'both');
    await waitFor(() => ans.asked.length >= 3, 3000, 'ask xác nhận');
    h.rt.answer((ans.asked[2] as { id: string }).id, true);
    await first;
    await waitFor(() => h.events.some((e) => e.t === 'replay' && (e as { reason: string }).reason === 'rewind'), 3000, 'replay rewind');
    expect(fs.existsSync(path.join(h.cwd, 'n.txt'))).toBe(false);
    const replay = h.events.filter((e) => e.t === 'replay').pop() as { items: unknown[] };
    expect(replay.items).toEqual([]);
    expect(h.events.some((e) => e.t === 'action' && (e as { action: string; payload?: string }).action === 'insert' && (e as { payload?: string }).payload === 'sửa a.txt')).toBe(true);
    await h.cleanup();
  });

  it('hook PreToolUse (cài đặt người dùng) chặn công cụ trong lượt thật; luật deny cũng chặn', async () => {
    const h = await harness({
      ...opts,
      userSettings: { 'terminal.shell': TEST_SHELL, hooks: { PreToolUse: [{ matcher: 'write_file', hooks: [{ type: 'command', command: exits(2, 'hook cấm ghi') }] }] }, permissions: { deny: ['read_file(secret.txt)'] } },
      files: { 'secret.txt': 'MAT-KHAU', 'a.txt': 'x' },
      script: [toolTurn([{ name: 'write_file', input: { path: 'b.txt', content: 'x' } }, { name: 'read_file', input: { path: 'secret.txt' } }]), textTurn('Xong.')],
      autoPermission: () => ({ decision: 'allow' }),
    });
    await h.rt.submit('làm đi');
    await h.rt.idle();
    expect(fs.existsSync(path.join(h.cwd, 'b.txt'))).toBe(false);
    const second = JSON.stringify(h.provider.requests[1].messages);
    expect(second).toContain('hook cấm ghi');
    expect(second).not.toContain('MAT-KHAU');
    await h.cleanup();
  });

  it('hook UserPromptSubmit chặn tin nhắn trước khi tới model (beforeSend của lõi)', async () => {
    const h = await harness({
      ...opts,
      userSettings: { 'terminal.shell': TEST_SHELL, hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookScript(`process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('tin bị cấm');process.exit(2);});`) }] }] } },
      script: [textTurn('không được gọi')],
    });
    await h.rt.submit('xin chào');
    await h.rt.idle();
    expect(h.provider.requests).toHaveLength(0);
    const notices = h.events.filter((e) => e.t === 'ui' && (e as { ev: { t: string } }).ev.t === 'notice').map((e) => (e as unknown as { ev: { text: string } }).ev.text);
    expect(notices.join(String.fromCharCode(10))).toMatch(/tin bị cấm/);
    await h.cleanup();
  });

  it('MCP stdio giả: công cụ vào registry của lượt thật và model gọi được', async () => {
    const h = await harness({
      ...opts,
      userSettings: { 'terminal.shell': TEST_SHELL, mcpServers: { fake: { command: process.execPath, args: [SERVER] } } },
      script: [toolTurn([{ name: 'mcp__fake__get_echo', input: { text: 'alo' } }]), textTurn('Xong.')],
      autoPermission: () => ({ decision: 'allow' }),
    });
    await waitFor(() => /fake/.test(h.rt.status().notices.join('') + JSON.stringify(h.provider.requests)) || true, 100);
    // chờ server khởi động nền
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      await h.rt.submit('/mcp');
      if (/2 công cụ/.test(h.outputs().pop() ?? '')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await h.rt.submit('gọi echo');
    await h.rt.idle();
    expect(h.provider.requests[0].tools.map((t) => t.name)).toContain('mcp__fake__get_echo');
    expect(JSON.stringify(h.provider.requests[1].messages)).toContain('get_echo:alo');
    await h.cleanup();
  });

  it('kỹ năng/agent/lệnh tuỳ chỉnh từ thư mục; lệnh chạy một lượt agent', async () => {
    const h = await harness({ ...opts, script: [textTurn('Đã chào Tuấn.')], files: { '.locaith/commands/chao.md': 'Chào $ARGUMENTS giúp tôi', '.locaith/skills/ky-nang-x/SKILL.md': '---\nname: ky-nang-x\ndescription: Kỹ năng thử\n---\nNội dung\n', '.locaith/agents/ag-x.md': '---\nname: ag-x\ndescription: Agent thử\n---\nBạn là ag-x\n' } });
    expect(h.rt.slashCommands().map((c) => c.name)).toContain('chao');
    await h.rt.submit('/skills');
    expect(h.outputs().pop()).toContain('ky-nang-x');
    await h.rt.submit('/agents');
    expect(h.outputs().pop()).toContain('ag-x');
    await h.rt.submit('/chao Tuấn');
    await h.rt.idle();
    expect(JSON.stringify(h.provider.requests[0].messages)).toContain('Chào Tuấn giúp tôi');
    await h.cleanup();
  });

  it('tác vụ nền thật qua công cụ + /tasks; đóng thì dừng sạch', async () => {
    const file = path.join(process.cwd(), `.tmp-bg-${Date.now()}.js`);
    fs.writeFileSync(file, "console.log('san sang');setInterval(()=>{},1000);");
    try {
      const h = await harness({ ...opts, script: [toolTurn([{ name: 'run_command', input: { command: `node "${file}"`, background: true } }]), textTurn('Đã chạy nền.')], autoPermission: () => ({ decision: 'allow' }) });
      await h.rt.submit('chạy server');
      await h.rt.idle();
      await waitFor(() => h.rt.status().bgTasks.running === 1, 5000, 'bgTasks running');
      await h.rt.submit('/tasks');
      expect(h.outputs().pop()).toContain('bg1');
      await h.cleanup();
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('verify: agent kiểm tra chạy bằng provider thật của lượt (always)', async () => {
    const provider = new FakeProvider([
      () => textTurn('Đã làm X.'),
      () => toolTurn([{ name: 'submit_verdict', input: { verdict: 'pass' } }]),
      () => textTurn('.'),
    ]);
    const h = await harness({ ...opts, provider, userSettings: { 'terminal.shell': TEST_SHELL, agent: { verify: 'always' } } });
    await h.rt.submit('làm X');
    await h.rt.idle();
    expect(provider.requests.length).toBeGreaterThanOrEqual(2);
    expect(provider.requests[1].tools.map((t) => t.name)).toContain('submit_verdict');
    await h.cleanup();
  });
});
