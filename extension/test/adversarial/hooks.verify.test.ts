import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeKit, printsJson, tmpRoot } from '../helpers/hookKit';

describe('hooks — kiểm chứng đối kháng', () => {
  it('UserPromptSubmit trả {continue:false} phải chặn không gửi tin nhắn (theo đặc tả JSON continue:false)', async () => {
    const root = tmpRoot();
    const kit = makeKit({ root, userHooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: printsJson({ continue: false, stopReason: 'dừng hẳn' }) }] }] } });
    const r = await kit.service.beforeSend('xin chào', new AbortController().signal);
    expect(r.blocked).toBe(true);
  });

  it('lần chạy UserPromptSubmit/SessionStart ngoài vòng lặp phải hiện một dòng (tên, ✓, ms) cho người dùng', async () => {
    const root = tmpRoot();
    const kit = makeKit({ root, userHooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', name: 'myhook', command: printsJson({}) }] }] } });
    const seen: string[] = [];
    kit.service.setNotifier((_l, text) => seen.push(text));
    await kit.service.beforeSend('xin chào', new AbortController().signal);
    expect(seen.join('\n')).toContain('myhook');
  });

  it('agent con (runSubAgent) phải mang extension hook, nếu không PreToolUse bị vượt qua bằng công cụ agent', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/core/agents/runner.ts'), 'utf8');
    const block = src.slice(src.indexOf('new AgentEngine({'), src.indexOf('new AgentEngine({') + 600);
    expect(block).toMatch(/extensions/);
  });
});
