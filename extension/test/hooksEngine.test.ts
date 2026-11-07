import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolResultBlock } from '../src/core/types';
import { coreRunExtensions } from '../src/core/engine/extensions';
import { hooksRunExtension } from '../src/core/hooks/runExtension';
import type { HookService } from '../src/core/hooks/service';
import type { HooksConfig } from '../src/core/hooks/types';
import { eventsOf, makeHarness, type Harness, type HarnessOptions } from './helpers/harness';
import { textTurn, toolTurn, type Step } from './helpers/fakeProvider';
import { exits, makeKit, printsJson, recordStdin, script, TEST_SHELL, tmpRoot, writeProjectHooks } from './helpers/hookKit';

/** Dựng engine THẬT với extension hook (hook cấp người dùng) và dịch vụ hook trỏ vào workspace của harness. */
function withHooks(steps: Step[], hooks: HooksConfig, opts: { files?: Record<string, string>; decide?: HarnessOptions['decide'] } = {}) {
  let svc!: HookService;
  const h = makeHarness(steps, {
    files: opts.files,
    hostSettings: { 'terminal.shell': TEST_SHELL },
    decide: opts.decide,
    engineDeps: { extensions: [...coreRunExtensions(), hooksRunExtension(() => svc)] },
    settings: { maxTurns: 40 },
  });
  const kit = makeKit({ root: h.dir, userHooks: hooks });
  svc = kit.service;
  return { h, svc, kit };
}

const toolResults = (h: Harness, reqIndex: number): ToolResultBlock[] =>
  h.provider.requests[reqIndex].messages.flatMap((m) => m.content.filter((b): b is ToolResultBlock => b.type === 'tool_result'));

const resultText = (r: ToolResultBlock): string => (typeof r.content === 'string' ? r.content : JSON.stringify(r.content));

describe('hooks — PreToolUse trong engine thật', () => {
  it('exit 2 chặn công cụ: công cụ KHÔNG chạy, model nhận lý do của hook', async () => {
    const { h } = withHooks(
      [() => toolTurn([{ name: 'write_file', input: { path: 'out.txt', content: 'x' } }]), () => textTurn('đã hiểu')],
      { PreToolUse: [{ matcher: 'write_file', hooks: [{ type: 'command', command: exits(2, 'không được ghi vào out.txt') }] }] },
    );
    await h.run('ghi file');
    expect(fs.existsSync(path.join(h.dir, 'out.txt'))).toBe(false);
    const r = toolResults(h, 1)[0];
    expect(r.isError).toBe(true);
    expect(resultText(r)).toContain('không được ghi vào out.txt');
    expect(resultText(r)).toContain('PreToolUse');
  });

  it('matcher không khớp → công cụ chạy bình thường', async () => {
    const { h } = withHooks(
      [() => toolTurn([{ name: 'write_file', input: { path: 'out.txt', content: 'x' } }]), () => textTurn('xong')],
      { PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: exits(2, 'chặn') }] }] },
    );
    await h.run('ghi file');
    expect(fs.readFileSync(path.join(h.dir, 'out.txt'), 'utf8')).toBe('x');
  });

  it('tên kiểu Claude Code (Write) khớp write_file', async () => {
    const { h } = withHooks(
      [() => toolTurn([{ name: 'write_file', input: { path: 'out.txt', content: 'x' } }]), () => textTurn('xong')],
      { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: exits(2, 'chặn Write') }] }] },
    );
    await h.run('ghi file');
    expect(fs.existsSync(path.join(h.dir, 'out.txt'))).toBe(false);
  });

  it('updatedInput: công cụ chạy với đối số đã sửa (và đối số được kiểm lại theo schema)', async () => {
    const { h } = withHooks(
      [() => toolTurn([{ name: 'write_file', input: { path: 'goc.txt', content: 'a' } }]), () => textTurn('xong')],
      { PreToolUse: [{ hooks: [{ type: 'command', command: printsJson({ updatedInput: { path: 'da-sua.txt', content: 'b' } }) }] }] },
    );
    await h.run('ghi file');
    expect(fs.existsSync(path.join(h.dir, 'goc.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(h.dir, 'da-sua.txt'), 'utf8')).toBe('b');
    expect(resultText(toolResults(h, 1)[0])).toContain('đã chỉnh đối số');
  });

  it('updatedInput sai schema → bị từ chối, công cụ không chạy', async () => {
    const { h } = withHooks(
      [() => toolTurn([{ name: 'write_file', input: { path: 'goc.txt', content: 'a' } }]), () => textTurn('xong')],
      { PreToolUse: [{ hooks: [{ type: 'command', command: printsJson({ updatedInput: { path: 5 } }) }] }] },
    );
    await h.run('ghi file');
    expect(fs.existsSync(path.join(h.dir, 'goc.txt'))).toBe(false);
    expect(toolResults(h, 1)[0].isError).toBe(true);
  });

  it("'approve' KHÔNG vượt hộp xin quyền: lệnh ghi tệp vẫn hỏi, từ chối thì không chạy", async () => {
    const { h } = withHooks(
      [() => toolTurn([{ name: 'write_file', input: { path: 'out.txt', content: 'x' } }]), () => textTurn('xong')],
      { PreToolUse: [{ hooks: [{ type: 'command', command: printsJson({ decision: 'approve' }) }] }] },
      { decide: () => 'deny' },
    );
    await h.run('ghi file');
    expect(h.permissionRequests.length).toBe(1);
    expect(fs.existsSync(path.join(h.dir, 'out.txt'))).toBe(false);
  });

  it('hook chạy TRƯỚC khi hỏi quyền: hook chặn thì không có hộp xin quyền nào', async () => {
    const { h } = withHooks(
      [() => toolTurn([{ name: 'write_file', input: { path: 'out.txt', content: 'x' } }]), () => textTurn('xong')],
      { PreToolUse: [{ hooks: [{ type: 'command', command: exits(2, 'no') }] }] },
    );
    await h.run('ghi file');
    expect(h.permissionRequests.length).toBe(0);
  });

  it('hiện MỘT dòng gọn mỗi lần hook chạy (tên · ✓ · ms) trong lượt trả lời', async () => {
    const { h } = withHooks(
      [() => toolTurn([{ name: 'read_file', input: { path: 'a.txt' } }]), () => textTurn('xong')],
      { PreToolUse: [{ hooks: [{ type: 'command', command: exits(0), name: 'kiem-tra' }] }] },
      { files: { 'a.txt': 'x' } },
    );
    await h.run('đọc');
    const pills = eventsOf(h.events, 'pill').filter((p) => p.text.startsWith('Hook PreToolUse'));
    expect(pills).toHaveLength(1);
    expect(pills[0].text).toMatch(/^Hook PreToolUse · kiem-tra ✓ \d+ ms$/);
  });

  it('hook lỗi (exit 1) không chặn công cụ, hiện cảnh báo', async () => {
    const { h } = withHooks(
      [() => toolTurn([{ name: 'read_file', input: { path: 'a.txt' } }]), () => textTurn('xong')],
      { PreToolUse: [{ hooks: [{ type: 'command', command: exits(1, 'hỏng') }] }] },
      { files: { 'a.txt': 'nội dung' } },
    );
    await h.run('đọc');
    expect(resultText(toolResults(h, 1)[0])).toContain('nội dung');
    expect(eventsOf(h.events, 'notice').some((n) => n.level === 'warn' && n.text.includes('hỏng'))).toBe(true);
  });

  it('continue:false dừng cả lần chạy và chặn các công cụ sau đó', async () => {
    const { h } = withHooks(
      [() => toolTurn([{ name: 'write_file', input: { path: 'out.txt', content: 'x' } }]), () => textTurn('đáng lẽ không tới đây')],
      { PreToolUse: [{ hooks: [{ type: 'command', command: printsJson({ continue: false, stopReason: 'hết ngân sách' }) }] }] },
    );
    const r = await h.run('ghi');
    expect(fs.existsSync(path.join(h.dir, 'out.txt'))).toBe(false);
    expect(r.stopReason).toBeDefined();
    expect(eventsOf(h.events, 'notice').some((n) => n.text.includes('hết ngân sách'))).toBe(true);
  });
});

describe('hooks — PostToolUse trong engine thật', () => {
  it('phản hồi của hook (exit 2 / additionalContext) được thêm vào kết quả công cụ cho model', async () => {
    const { h } = withHooks(
      [() => toolTurn([{ name: 'read_file', input: { path: 'a.txt' } }]), () => textTurn('xong')],
      { PostToolUse: [{ matcher: 'read_file', hooks: [{ type: 'command', command: exits(2, 'tệp này đã lỗi thời, đọc README') }] }] },
      { files: { 'a.txt': 'ABC' } },
    );
    await h.run('đọc');
    const text = resultText(toolResults(h, 1)[0]);
    expect(text).toContain('ABC');
    expect(text).toContain('[Hook PostToolUse] tệp này đã lỗi thời, đọc README');
  });

  it('stdin của PostToolUse có tool_response', async () => {
    const root = tmpRoot();
    const out = path.join(root, 'post.json');
    const { h } = withHooks(
      [() => toolTurn([{ name: 'read_file', input: { path: 'a.txt' } }]), () => textTurn('xong')],
      { PostToolUse: [{ hooks: [{ type: 'command', command: recordStdin(out) }] }] },
      { files: { 'a.txt': 'ABC' } },
    );
    await h.run('đọc');
    const got = JSON.parse(fs.readFileSync(out, 'utf8').trim().split('\n')[0]);
    expect(got.hook_event_name).toBe('PostToolUse');
    expect(got.tool_name).toBe('read_file');
    expect(got.tool_response.content).toContain('ABC');
    expect(got.session_id).toBe('s1');
  });
});

describe('hooks — Stop trong engine thật', () => {
  it('exit 2 ép model làm tiếp, kèm lý do; sau đó hook cho qua thì kết thúc', async () => {
    const root = tmpRoot();
    const marker = path.join(root, 'count.txt');
    // lần 1 chặn, lần 2 cho qua (đếm bằng tệp)
    const cmd = script(
      `const fs=require('fs');process.stdin.resume();process.stdin.on('end',()=>{const n=fs.existsSync(${JSON.stringify(marker)})?1:0;fs.writeFileSync(${JSON.stringify(marker)},'x');if(n===0){process.stderr.write('hãy chạy test trước');process.exit(2);}process.exit(0);});`,
    );
    const { h } = withHooks([() => textTurn('xong rồi'), () => textTurn('đã chạy test, xong')], { Stop: [{ hooks: [{ type: 'command', command: cmd }] }] });
    await h.run('làm việc');
    expect(h.provider.requests).toHaveLength(2);
    expect(JSON.stringify(h.provider.requests[1].messages)).toContain('[Hook Stop] hãy chạy test trước');
  });

  it('stop_hook_active = true từ lần ép tiếp theo', async () => {
    const root = tmpRoot();
    const out = path.join(root, 'stop.txt');
    const cmd = recordStdin(out, 2, `process.stderr.write('tiếp');`);
    const { h } = withHooks([() => textTurn('a'), () => textTurn('b'), () => textTurn('c')], { Stop: [{ hooks: [{ type: 'command', command: cmd }] }] });
    await h.run('x');
    const lines = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0].stop_hook_active).toBe(false);
    expect(lines[1].stop_hook_active).toBe(true);
    expect(lines[0].hook_event_name).toBe('Stop');
  }, 60_000);

  it('hook Stop luôn chặn → tối đa 8 lần ép làm tiếp rồi dừng, có thông báo', async () => {
    const steps: Step[] = Array.from({ length: 14 }, (_, i) => () => textTurn(`lượt ${i}`));
    const { h } = withHooks(steps, { Stop: [{ hooks: [{ type: 'command', command: exits(2, 'chưa đủ') }] }] });
    await h.run('x');
    // 1 lượt đầu + 8 lượt bị ép làm tiếp = 9 lần gọi model, không hơn
    expect(h.provider.requests).toHaveLength(9);
    expect(eventsOf(h.events, 'notice').some((n) => /8 lần/.test(n.text))).toBe(true);
  }, 120_000);

  it('người dùng bấm Dừng thì hook Stop không ép làm tiếp', async () => {
    const { h } = withHooks([() => textTurn('xong')], { Stop: [{ hooks: [{ type: 'command', command: exits(2, 'chưa đủ') }] }] });
    const ac = new AbortController();
    ac.abort();
    await h.run('x', ac.signal);
    expect(h.provider.requests.length).toBeLessThanOrEqual(1);
  });
});

describe('hooks — UserPromptSubmit / SessionStart / SessionEnd / PreCompact / Notification', () => {
  it('UserPromptSubmit nhận prompt; chặn thì beforeSend báo blocked', async () => {
    const root = tmpRoot();
    const out = path.join(root, 'prompt.json');
    const kit = makeKit({ root, userHooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: recordStdin(out, 2, `process.stderr.write('cấm từ này');`) }] }] } });
    const r = await kit.service.beforeSend('xin chào bí mật', new AbortController().signal);
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain('cấm từ này');
    expect(JSON.parse(fs.readFileSync(out, 'utf8').trim()).prompt).toBe('xin chào bí mật');
    expect(kit.service.takePendingContext()).toEqual([]);
  });

  it('ngữ cảnh từ SessionStart (chỉ lần đầu của phiên) và UserPromptSubmit được nối vào lịch sử gửi model', async () => {
    const root = tmpRoot();
    const sid = { v: 's1' };
    let svc!: HookService;
    const hooks: HooksConfig = {
      SessionStart: [{ hooks: [{ type: 'command', command: exits(0, '', 'đang ở nhánh main') }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: printsJson({ additionalContext: 'ngày hôm nay: thứ bảy' }) }] }],
    };
    const h = makeHarness([() => textTurn('một'), () => textTurn('hai')], {
      hostSettings: { 'terminal.shell': TEST_SHELL },
      engineDeps: { extensions: [...coreRunExtensions(), hooksRunExtension(() => svc)] },
    });
    svc = makeKit({ root: h.dir, userHooks: hooks, sessionId: () => sid.v }).service;
    await svc.beforeSend('lượt 1', new AbortController().signal);
    await h.run('lượt 1');
    const first = JSON.stringify(h.provider.requests[0].messages);
    expect(first).toContain('[Hook SessionStart] đang ở nhánh main');
    expect(first).toContain('[Hook UserPromptSubmit] ngày hôm nay: thứ bảy');

    await svc.beforeSend('lượt 2', new AbortController().signal);
    await h.run('lượt 2');
    const second = JSON.stringify(h.provider.requests[1].messages.slice(-2));
    // SessionStart chỉ chạy một lần: ngữ cảnh mới ở lượt 2 chỉ còn của UserPromptSubmit
    expect((second.match(/Hook SessionStart/g) ?? []).length).toBe(0);
    expect(second).toContain('Hook UserPromptSubmit');
  });

  it('PreCompact / Notification / SessionEnd gọi đúng sự kiện với dữ liệu đúng', async () => {
    const root = tmpRoot();
    const out = path.join(root, 'ev.txt');
    const cmd = recordStdin(out);
    const kit = makeKit({
      root,
      userHooks: {
        PreCompact: [{ hooks: [{ type: 'command', command: cmd }] }],
        Notification: [{ matcher: 'permission_prompt', hooks: [{ type: 'command', command: cmd }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: cmd }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: exits(0) }] }],
      },
    });
    const sig = new AbortController().signal;
    await kit.service.beforeSend('x', sig); // đánh dấu phiên đã bắt đầu
    await kit.service.preCompact('manual', sig);
    await kit.service.notification('Cần duyệt chạy lệnh', 'permission_prompt', sig);
    await kit.service.notification('khác', 'idle_prompt', sig); // matcher không khớp → không chạy
    await kit.service.sessionEnd('s1', 'clear');
    const evs = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(evs.map((e) => e.hook_event_name)).toEqual(['PreCompact', 'Notification', 'SessionEnd']);
    expect(evs[0].trigger).toBe('manual');
    expect(evs[1]).toMatchObject({ message: 'Cần duyệt chạy lệnh', notification_type: 'permission_prompt' });
    expect(evs[2].reason).toBe('clear');
    // SessionEnd chỉ một lần cho mỗi phiên
    await kit.service.sessionEnd('s1', 'clear');
    expect(fs.readFileSync(out, 'utf8').trim().split('\n')).toHaveLength(3);
  });
});

describe('hooks — hook DỰ ÁN trong engine thật', () => {
  function withProject(steps: Step[], opts: { trusted: boolean; approve: boolean; hooks: HooksConfig }) {
    let svc!: HookService;
    const h = makeHarness(steps, {
      hostSettings: { 'terminal.shell': TEST_SHELL },
      engineDeps: { extensions: [...coreRunExtensions(), hooksRunExtension(() => svc)] },
    });
    writeProjectHooks(h.dir, opts.hooks);
    const kit = makeKit({ root: h.dir, trusted: opts.trusted, approve: () => opts.approve });
    svc = kit.service;
    return { h, kit };
  }
  const blockWrite: HooksConfig = { PreToolUse: [{ matcher: 'write_file', hooks: [{ type: 'command', command: exits(2, 'dự án cấm ghi') }] }] };
  const steps = (): Step[] => [() => toolTurn([{ name: 'write_file', input: { path: 'out.txt', content: 'x' } }]), () => textTurn('xong')];

  it('đã tin cậy + đã xác nhận → hook dự án chạy và chặn', async () => {
    const { h, kit } = withProject(steps(), { trusted: true, approve: true, hooks: blockWrite });
    await h.run('ghi');
    expect(fs.existsSync(path.join(h.dir, 'out.txt'))).toBe(false);
    expect(kit.confirms).toHaveLength(1);
  });

  it('người dùng từ chối xác nhận → hook dự án KHÔNG chạy (công cụ chạy bình thường)', async () => {
    const { h, kit } = withProject(steps(), { trusted: true, approve: false, hooks: blockWrite });
    await h.run('ghi');
    expect(fs.readFileSync(path.join(h.dir, 'out.txt'), 'utf8')).toBe('x');
    expect(kit.confirms).toHaveLength(1);
  });

  it('workspace chưa tin cậy → hook dự án KHÔNG chạy và không hỏi', async () => {
    const { h, kit } = withProject(steps(), { trusted: false, approve: true, hooks: blockWrite });
    await h.run('ghi');
    expect(fs.readFileSync(path.join(h.dir, 'out.txt'), 'utf8')).toBe('x');
    expect(kit.confirms).toHaveLength(0);
  });
});
