import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../../src/core/agents/definitions';
import { expandCustomCommand, parseCommandFile, type CustomCommand } from '../../src/core/commands/custom';
import { NodeToolHost } from '../../src/core/host/nodeHost';
import { makeWorkspace } from '../helpers/harness';

const cmd = (body: string): CustomCommand => ({ name: 't', description: 'd', allowedTools: [], disableModelInvocation: false, body, source: 'project', file: '/x/t.md' });
const signal = new AbortController().signal;

describe('adversarial commands-agents', () => {
  it('agent của dự án phải thắng agent cùng tên của người dùng (và .locaith thắng .claude)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-'));
    const ws = path.join(tmp, 'ws', '.locaith', 'agents');
    const usr = path.join(tmp, 'home', '.locaith', 'agents');
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(usr, { recursive: true });
    fs.writeFileSync(path.join(ws, 'helper.md'), '---\nname: helper\ndescription: PROJECT\n---\nproject body');
    fs.writeFileSync(path.join(usr, 'helper.md'), '---\nname: helper\ndescription: USER\n---\nuser body');
    const reg = new AgentRegistry();
    // cùng thứ tự mà extension.ts và commandsSlash.ts dùng: workspace trước, người dùng sau
    await reg.loadDirs(new NodeToolHost({ roots: [tmp] }), [
      { path: ws, source: 'workspace' },
      { path: usr, source: 'user' },
    ]);
    expect(reg.get('helper')?.description).toBe('PROJECT');
  });

  it('@liên-kết trong workspace trỏ ra ngoài (junction/symlink) không được nhúng tệp ngoài workspace', async () => {
    const w = makeWorkspace({});
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));
    fs.writeFileSync(path.join(outside, 'note.txt'), 'OUTSIDE-SECRET-123');
    try {
      fs.symlinkSync(outside, path.join(w, 'link'), 'junction');
    } catch {
      return; // không tạo được liên kết trên máy này
    }
    const host = new NodeToolHost({ roots: [w] });
    const r = await expandCustomCommand(cmd('đọc @link/note.txt'), '', { host, trusted: true, signal });
    expect(r.prompt).not.toContain('OUTSIDE-SECRET-123');
  });

  it('@.git/config (có thể chứa URL kèm token) không được nhúng', async () => {
    const w = makeWorkspace({ '.git/config': '[remote "origin"]\n url = https://user:TOKEN123@github.com/a/b.git\n' });
    const host = new NodeToolHost({ roots: [w] });
    const r = await expandCustomCommand(cmd('xem @.git/config'), '', { host, trusted: true, signal });
    expect(r.prompt).not.toContain('TOKEN123');
  });

  it('frontmatter CRLF vẫn đọc được description', () => {
    const p = parseCommandFile('---\r\ndescription: Mô tả CRLF\r\nallowed-tools: Read\r\n---\r\nthân', 'a.md', 'project', '/a.md');
    expect(p.warning).toBeUndefined();
    expect(p.command?.description).toBe('Mô tả CRLF');
    expect(p.command?.allowedTools).toEqual(['Read']);
  });
});
