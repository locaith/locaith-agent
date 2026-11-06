import { describe, expect, it } from 'vitest';
import { MAX_IMAGE_B64, parseCommand } from '../src/core/remote/protocol';
import { MAX_ITEMS, capArgs, sanitizeEvent, sanitizeItem, sanitizePatch, toRemoteState } from '../src/core/remote/sanitize';
import type { AssistantItem, TItem, ToolBlock, UserItem, ViewState } from '../src/shared/protocol';

const HOST = { name: 'PC', vscode: '1.90.0', ext: '0.5.2', platform: 'win32' };

const tool = (over: Partial<ToolBlock> = {}): ToolBlock => ({ type: 'tool', id: 'c1', name: 'run_command', args: { command: 'npm test' }, state: 'done', startedAt: 1, ...over });
const asst = (blocks: AssistantItem['blocks']): AssistantItem => ({ kind: 'assistant', id: 'a1', provider: 'p', model: 'm', ts: 1, blocks, done: true });

describe('Remote — rút gọn dữ liệu gửi ra ngoài máy', () => {
  it('khối công cụ: bỏ ảnh thô (chỉ giữ số lượng), cắt kết quả/đối số dài, cắt diff', () => {
    const big = 'x'.repeat(10_000);
    const diffLines = Array.from({ length: 400 }, (_, i) => ({ t: '+' as const, s: `dòng ${i}` }));
    const t = tool({
      args: { path: 'a.ts', content: big, nested: { a: [1, 2, 3] }, n: 5, ok: true },
      output: big,
      images: [{ mediaType: 'image/png', data: 'AAAA'.repeat(50_000) }],
      diff: { path: 'a.ts', added: 400, removed: 0, hunks: [{ oldStart: 1, newStart: 1, lines: diffLines }] },
    });
    const out = sanitizeItem(asst([t])) as AssistantItem;
    const b = out.blocks[0] as ToolBlock & { imageCount?: number };
    expect((b as any).images).toBeUndefined();
    expect(b.imageCount).toBe(1);
    expect(String(b.args.content).length).toBeLessThan(700);
    expect(String(b.args.content)).toContain('[+');
    expect(b.args.nested).toBe('{"a":[1,2,3]}');
    expect(b.args).toMatchObject({ n: 5, ok: true });
    expect(b.output!.length).toBeLessThanOrEqual(2000);
    expect(b.output!.startsWith('…')).toBe(true);
    expect(b.diff!.hunks[0]!.lines).toHaveLength(160);
    expect(b.diff!.truncated).toBe(true);
    expect(JSON.stringify(out).length).toBeLessThan(12_000);
  });

  it('yêu cầu quyền: giữ nguyên các trường dùng để duyệt, cắt phần quá dài', () => {
    const p = { id: 'p1', callId: 'c1', tool: 'run_command', kind: 'command' as const, title: 'Cho phép chạy?', command: 'echo ' + 'a'.repeat(5000), canAllowSession: true, sessionLabel: 'Luôn cho phép' };
    const out = (sanitizeItem(asst([tool({ state: 'awaiting_permission', permission: p })])) as AssistantItem).blocks[0] as ToolBlock;
    expect(out.permission).toMatchObject({ id: 'p1', callId: 'c1', kind: 'command', canAllowSession: true, sessionLabel: 'Luôn cho phép' });
    expect(out.permission!.command!.length).toBeLessThan(2100);
  });

  it('tin của người dùng: bỏ dữ liệu ảnh thô và nội dung tệp tải lên, giữ ảnh thu nhỏ nhỏ và khoá ảnh', () => {
    const u: UserItem = {
      kind: 'user', id: 'u1', text: 'xem giúp', ts: 1,
      attachments: [
        { kind: 'image', label: 'a.png', mediaType: 'image/png', data: 'AAAA'.repeat(1000), thumb: 'BBBB', imgKey: 'k1' },
        { kind: 'image', label: 'b.png', mediaType: 'image/png', thumb: 'C'.repeat(30_000), imgKey: 'k2' },
        { kind: 'doc', label: 'bao-cao.pdf', doc: { kind: 'pdf', text: 'NỘI DUNG RIÊNG TƯ', pages: 3 } },
      ],
    };
    const out = sanitizeItem(u) as UserItem;
    expect((out.attachments[0] as any).data).toBeUndefined();
    expect(out.attachments[0]).toMatchObject({ thumb: 'BBBB', imgKey: 'k1' });
    expect(out.attachments[1]!.thumb).toBeUndefined();
    expect(out.attachments[2]!.doc).toEqual({ kind: 'pdf', pages: 3 });
    expect(JSON.stringify(out)).not.toContain('RIÊNG TƯ');
  });

  it('toRemoteState: không mang theo cài đặt/khoá/kỹ năng/thùng rác; transcript cắt còn MAX_ITEMS mục kèm số bị cắt; chỉ model của nhà cung cấp có khoá', () => {
    const items: TItem[] = Array.from({ length: MAX_ITEMS + 25 }, (_, i) => ({ kind: 'user', id: `u${i}`, text: `t${i}`, attachments: [], ts: i }));
    const view = {
      version: '0.5.2', sessionId: 's1', title: 'T', transcript: items, todos: [], running: true, provider: 'anthropic', model: 'm1', mode: 'default', thinkingLevel: 'high',
      providers: [
        { id: 'anthropic', label: 'Anthropic', kind: 'anthropic', baseUrl: 'https://x', hasKey: true, builtin: true, modelSource: 'live', models: [{ id: 'm1', label: 'M1', tier: 'top', contextWindow: 1e6 }] },
        { id: 'openai', label: 'OpenAI', kind: 'openai', baseUrl: 'https://y', hasKey: false, builtin: true, modelSource: 'live', models: [{ id: 'g', label: 'G' }] },
      ],
      settings: { language: 'vi' }, sessions: [{ id: 's1', title: 'T', updatedAt: 1, provider: 'anthropic', model: 'm1', messageCount: 3 }], trash: [{ id: 'x' }], workspace: { name: 'w', folders: ['C:/secret'] },
      context: { usedTokens: 10, limitTokens: 100 }, editor: { file: 'C:/secret/x.ts' }, skills: [{ id: 's' }], slashCommands: [], allowBypass: true,
    } as unknown as ViewState;
    const s = toRemoteState(view, HOST, { canBypass: false });
    expect(s.transcript).toHaveLength(MAX_ITEMS);
    expect(s.omitted).toBe(25);
    expect(s.transcript[0]!.id).toBe('u25');
    expect(s.providers.map((p) => p.id)).toEqual(['anthropic']);
    expect(s.providers[0]!.models[0]).toEqual({ id: 'm1', label: 'M1', tier: 'top' });
    expect(s).toMatchObject({ running: true, allowBypass: true, remoteCanBypass: false, mode: 'default', thinkingLevel: 'high' });
    const j = JSON.stringify(s);
    for (const secret of ['C:/secret', 'settings', 'trash', 'skills', 'editor', 'folders']) expect(j).not.toContain(secret);
  });

  it('sanitizePatch: chỉ giữ trường máy khách cần; bản vá rỗng → null; patch transcript được cắt như snapshot', () => {
    expect(sanitizePatch({ settings: {} as any, editor: null, skills: [] })).toBeNull();
    expect(sanitizePatch({ running: false, mode: 'plan', editor: null })).toEqual({ running: false, mode: 'plan' });
    const items: TItem[] = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => ({ kind: 'notice', id: `n${i}`, level: 'info', text: 'x', ts: i }));
    const p = sanitizePatch({ transcript: items })!;
    expect(p.transcript).toHaveLength(MAX_ITEMS);
    expect(p.omitted).toBe(1);
  });

  it('sanitizeEvent: tool_end bỏ ảnh thô; tool_start cắt đối số; user bỏ dữ liệu ảnh; sự kiện khác giữ nguyên', () => {
    const end = sanitizeEvent({ t: 'tool_end', id: 'a', callId: 'c', state: 'done', durationMs: 5, images: [{ mediaType: 'image/png', data: 'AAAA' }], output: 'y'.repeat(9000) }) as any;
    expect(end.images).toBeUndefined();
    expect(end.imageCount).toBe(1);
    expect(end.output.length).toBeLessThanOrEqual(2000);
    expect((sanitizeEvent({ t: 'tool_start', id: 'a', callId: 'c', name: 'write_file', args: { content: 'z'.repeat(5000) } }) as any).args.content.length).toBeLessThan(700);
    const u = sanitizeEvent({ t: 'user', id: 'u', text: 'hi', ts: 1, attachments: [{ kind: 'image', label: 'x', data: 'AAAA' }] }) as any;
    expect(u.attachments[0].data).toBeUndefined();
    const same = { t: 'text' as const, id: 'a', delta: 'abc' };
    expect(sanitizeEvent(same)).toBe(same);
  });

  it('capArgs: tối đa 24 khoá, giá trị lạ không làm hỏng', () => {
    const o: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) o[`k${i}`] = i;
    o.circ = (() => { const a: any = {}; a.a = a; return a; })();
    expect(Object.keys(capArgs(o)).length).toBeLessThanOrEqual(24);
    expect(() => capArgs({ c: o.circ })).not.toThrow();
  });
});

describe('Remote — parseCommand', () => {
  const ok = (v: unknown, canBypass = false) => parseCommand(v, { canBypass });
  it('send: giữ ảnh hợp lệ (png/jpeg/webp/gif), làm sạch nhãn, bỏ trường lạ', () => {
    const r = ok({ type: 'send', text: 'a', extra: 'x', attachments: [{ kind: 'image', label: 'ảnh\n1.png', mediaType: 'image/jpeg', data: 'QUJD', junk: 1 }] });
    expect(r).toEqual({ ok: true, cmd: { type: 'send', text: 'a', attachments: [{ kind: 'image', label: 'ảnh 1.png'.replace(' ', ''), mediaType: 'image/jpeg', data: 'QUJD' }] } });
  });
  it('send: chỉ có ảnh (không chữ) vẫn hợp lệ; quá cỡ base64 bị từ chối', () => {
    expect(ok({ type: 'send', text: '', attachments: [{ kind: 'image', label: 'a', mediaType: 'image/png', data: 'QUJD' }] }).ok).toBe(true);
    expect(ok({ type: 'send', text: 'a', attachments: [{ kind: 'image', label: 'a', mediaType: 'image/png', data: 'A'.repeat(MAX_IMAGE_B64 + 4) }] })).toEqual({ ok: false, error: 'bad_attachment' });
  });
  it('permission_response: feedback được cắt 2000 ký tự', () => {
    const r = ok({ type: 'permission_response', id: 'p', decision: 'deny', feedback: 'n'.repeat(5000) });
    expect(r.ok && r.cmd.type === 'permission_response' && r.cmd.feedback!.length).toBe(2000);
  });
  it('set_thinking nhận swarm; set_mode bypass tuỳ cờ', () => {
    expect(ok({ type: 'set_thinking', level: 'swarm' }).ok).toBe(true);
    expect(ok({ type: 'set_mode', mode: 'bypass' }, false)).toEqual({ ok: false, error: 'bypass_not_allowed' });
    expect(ok({ type: 'set_mode', mode: 'bypass' }, true).ok).toBe(true);
  });
});
