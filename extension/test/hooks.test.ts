import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileMatcher, dedupeEntries, matchesMatcher, parseHooksConfig, toolNameCandidates } from '../src/core/hooks/config';
import { buildHookEnv } from '../src/core/hooks/env';
import { runHookEvent, selectHooks } from '../src/core/hooks/runner';
import type { HookEntry } from '../src/core/hooks/types';
import { executor, exits, makeKit, printsJson, recordStdin, script, tmpRoot, writeProjectHooks } from './helpers/hookKit';

const noopSignal = new AbortController().signal;

function entriesOf(cfg: unknown, source: 'user' | 'project' | 'claude' = 'user'): HookEntry[] {
  return parseHooksConfig(cfg, source, source).entries;
}

async function run(entries: HookEntry[], event: Parameters<typeof runHookEvent>[1], payload: Record<string, unknown>, matchNames?: string[], cwd = tmpRoot()) {
  return runHookEvent(entries, event, payload, {
    executor,
    cwd,
    signal: noopSignal,
    log: () => undefined,
    matchNames,
    buildEnv: (entry) => buildHookEnv(process.env, { projectDir: cwd, entry, event }),
  });
}

describe('hooks — matcher', () => {
  it('trống và * khớp mọi thứ', () => {
    expect(matchesMatcher(undefined, ['run_command'])).toBe(true);
    expect(matchesMatcher('*', ['x'])).toBe(true);
    expect(compileMatcher('').kind).toBe('all');
  });
  it('danh sách a|b so khớp tên CHÍNH XÁC (không khớp một phần)', () => {
    expect(matchesMatcher('run_command|edit_file', ['edit_file'])).toBe(true);
    expect(matchesMatcher('run_command|edit_file', ['write_file'])).toBe(false);
    expect(matchesMatcher('run', ['run_command'])).toBe(false);
    expect(compileMatcher('a|b').kind).toBe('list');
  });
  it('regex khớp TOÀN BỘ tên; dạng /mẫu/ cũng được; regex sai → invalid, không khớp gì', () => {
    expect(matchesMatcher('mcp__.*', ['mcp__github__create_issue'])).toBe(true);
    expect(matchesMatcher('mcp__.*', ['x_mcp__a'])).toBe(false);
    expect(matchesMatcher('(read|write)_file', ['write_file'])).toBe(true);
    expect(matchesMatcher('/(read|write)_.*/', ['read_file'])).toBe(true);
    expect(compileMatcher('([').kind).toBe('invalid');
    expect(matchesMatcher('([', ['a'])).toBe(false);
  });
  it('tên Claude Code khớp công cụ Locaith tương đương (Bash→run_command, Edit→edit_file…)', () => {
    expect(matchesMatcher('Bash', toolNameCandidates('run_command'))).toBe(true);
    expect(matchesMatcher('Edit|Write', toolNameCandidates('write_file'))).toBe(true);
    expect(matchesMatcher('Read', toolNameCandidates('read_file'))).toBe(true);
    expect(matchesMatcher('Bash', toolNameCandidates('edit_file'))).toBe(false);
  });
});

describe('hooks — đọc cấu hình', () => {
  it('chuẩn hoá, kẹp timeout, bỏ mục sai nhưng giữ phần còn lại và báo cảnh báo (vi/en)', () => {
    const r = parseHooksConfig(
      {
        PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: 'echo a', timeout: 9999 }, { type: 'command' }, { type: 'http', command: 'x' }] }],
        NoSuchEvent: [],
        Stop: 'sai',
      },
      'project',
      '.locaith/settings.json',
      'en',
    );
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].timeoutSec).toBe(600);
    expect(r.entries[0].name).toBe('echo');
    expect(r.warnings.join('\n')).toMatch(/NoSuchEvent.*not supported/);
    expect(r.warnings.join('\n')).toMatch(/Stop.*must be an array/);
    expect(parseHooksConfig('x', 'user', 'u').warnings).toHaveLength(1);
  });
  it('hook trùng hệt chỉ giữ một', () => {
    const e = entriesOf({ Stop: [{ hooks: [{ command: 'a' }, { command: 'a' }] }] });
    expect(dedupeEntries([...e, ...e])).toHaveLength(1);
  });
  it('matcher sai cú pháp: bỏ nhóm đó kèm cảnh báo', () => {
    const r = parseHooksConfig({ PreToolUse: [{ matcher: '([', hooks: [{ command: 'x' }] }] }, 'user', 'u');
    expect(r.entries).toHaveLength(0);
    expect(r.warnings[0]).toMatch(/matcher/);
  });
});

describe('hooks — môi trường (danh sách cho phép)', () => {
  const base = { PATH: '/bin', HOME: '/h', OPENAI_API_KEY: 'sk-abc', ANTHROPIC_API_KEY: 'sk-ant', GITHUB_TOKEN: 'ghp_x', MY_SECRET: 's', RANDOM_VAR: 'r', LC_ALL: 'C' };
  const entry = { env: {}, dialect: 'locaith' as const };
  it('chỉ chép biến an toàn; khoá API và biến lạ KHÔNG đi qua', () => {
    const env = buildHookEnv(base, { projectDir: '/p', entry, event: 'Stop' });
    expect(env.PATH).toBe('/bin');
    expect(env.LC_ALL).toBe('C');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.RANDOM_VAR).toBeUndefined();
    expect(env.LOCAITH_PROJECT_DIR).toBe('/p');
    expect(env.LOCAITH_HOOK_EVENT).toBe('Stop');
  });
  it('biến người dùng khai báo (passEnv / env của hook) mới đi qua', () => {
    const env = buildHookEnv(base, { projectDir: '/p', passEnv: ['random_var', 'GITHUB_TOKEN'], entry: { env: { FOO: 'bar' }, dialect: 'claude' }, event: 'Stop' });
    expect(env.RANDOM_VAR).toBe('r');
    expect(env.GITHUB_TOKEN).toBe('ghp_x');
    expect(env.FOO).toBe('bar');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CLAUDE_PROJECT_DIR).toBe('/p');
  });
});

describe('hooks — thực thi bằng tiến trình thật', () => {
  it('stdin là JSON đúng định dạng; cwd là thư mục workspace; có LOCAITH_PROJECT_DIR', async () => {
    const root = tmpRoot();
    const out = path.join(root, 'stdin.txt');
    const envOut = path.join(root, 'env.json');
    const cmd = script(
      `let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const fs=require('fs');fs.writeFileSync(${JSON.stringify(out)},d);fs.writeFileSync(${JSON.stringify(envOut)},JSON.stringify({cwd:process.cwd(),dir:process.env.LOCAITH_PROJECT_DIR,ev:process.env.LOCAITH_HOOK_EVENT}));});`,
    );
    const r = await run(entriesOf({ PreToolUse: [{ matcher: 'run_command', hooks: [{ command: cmd }] }] }), 'PreToolUse', { session_id: 's9', tool_name: 'run_command', tool_input: { command: 'ls' } }, ['run_command'], root);
    expect(r.records[0].status).toBe('ok');
    const stdin = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(stdin).toMatchObject({ session_id: 's9', hook_event_name: 'PreToolUse', tool_name: 'run_command', tool_input: { command: 'ls' } });
    expect(fs.realpathSync(stdin.cwd)).toBe(fs.realpathSync(root));
    const env = JSON.parse(fs.readFileSync(envOut, 'utf8'));
    expect(fs.realpathSync(env.cwd)).toBe(fs.realpathSync(root));
    expect(env.dir).toBe(root);
    expect(env.ev).toBe('PreToolUse');
  });

  it('hook từ .claude nhận tên công cụ kiểu Claude Code (Bash, Edit + file_path)', async () => {
    const root = tmpRoot();
    const out = path.join(root, 'o.txt');
    const e = entriesOf({ PreToolUse: [{ hooks: [{ command: recordStdin(out) }] }] }, 'claude');
    await run(e, 'PreToolUse', { tool_name: 'edit_file', tool_input: { path: 'a.ts', old_string: 'x', new_string: 'y' } }, ['edit_file'], root);
    const got = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(got.tool_name).toBe('Edit');
    expect(got.tool_input.file_path).toBe('a.ts');
  });

  it('exit 0 = ok; exit 2 = CHẶN với stderr làm lý do; exit khác = cảnh báo KHÔNG chặn', async () => {
    const e = entriesOf({ Stop: [{ hooks: [{ command: exits(0) }] }] });
    expect((await run(e, 'Stop', {})).blocked).toBe(false);

    const blocked = await run(entriesOf({ Stop: [{ hooks: [{ command: exits(2, 'chạy test trước đã') }] }] }), 'Stop', {});
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toContain('chạy test trước đã');
    expect(blocked.records[0].status).toBe('block');

    const warn = await run(entriesOf({ Stop: [{ hooks: [{ command: exits(1, 'boom') }] }] }), 'Stop', {});
    expect(warn.blocked).toBe(false);
    expect(warn.warnings.join()).toMatch(/mã 1.*boom/);
    expect(warn.records[0].status).toBe('warn');
  });

  it('JSON trên stdout: decision block / approve, additionalContext, updatedInput, continue:false', async () => {
    const b = await run(entriesOf({ PreToolUse: [{ hooks: [{ command: printsJson({ decision: 'block', reason: 'cấm rm -rf' }) }] }] }), 'PreToolUse', {});
    expect(b.blocked).toBe(true);
    expect(b.reason).toBe('cấm rm -rf');

    const ok = await run(
      entriesOf({ PreToolUse: [{ hooks: [{ command: printsJson({ decision: 'approve', additionalContext: 'ghi chú', updatedInput: { command: 'echo an toan' } }) }] }] }),
      'PreToolUse',
      {},
    );
    expect(ok.blocked).toBe(false);
    expect(ok.approved).toBe(true);
    expect(ok.additionalContext).toEqual(['ghi chú']);
    expect(ok.updatedInput).toEqual({ command: 'echo an toan' });

    const stop = await run(entriesOf({ Stop: [{ hooks: [{ command: printsJson({ continue: false, stopReason: 'hết giờ' }) }] }] }), 'Stop', {});
    expect(stop.stop).toBe(true);
    expect(stop.stopReason).toBe('hết giờ');

    // định dạng hookSpecificOutput của Claude Code
    const hso = await run(
      entriesOf({ PreToolUse: [{ hooks: [{ command: printsJson({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'không được' } }) }] }] }),
      'PreToolUse',
      {},
    );
    expect(hso.blocked).toBe(true);
    expect(hso.reason).toBe('không được');
  });

  it('chữ thường trên stdout là ngữ cảnh cho UserPromptSubmit/SessionStart, nhưng KHÔNG cho PreToolUse', async () => {
    const cmd = exits(0, '', 'nhánh hiện tại: main');
    const e = entriesOf({ UserPromptSubmit: [{ hooks: [{ command: cmd }] }], PreToolUse: [{ hooks: [{ command: cmd }] }] });
    expect((await run(e, 'UserPromptSubmit', { prompt: 'x' })).additionalContext).toEqual(['nhánh hiện tại: main']);
    expect((await run(e, 'PreToolUse', {})).additionalContext).toEqual([]);
  });

  it('«chặn thắng»: một hook chặn thì approve và updatedInput của hook khác bị bỏ', async () => {
    const e = entriesOf({
      PreToolUse: [{ hooks: [{ command: printsJson({ decision: 'approve', updatedInput: { command: 'x' } }) }, { command: exits(2, 'không') }] }],
    });
    const r = await run(e, 'PreToolUse', {});
    expect(r.blocked).toBe(true);
    expect(r.approved).toBe(false);
    expect(r.updatedInput).toBeUndefined();
    expect(r.reason).toContain('không');
  });

  it('quá hạn: bỏ qua + cảnh báo, không chặn', async () => {
    const slow = script('setTimeout(()=>{},20000);process.stdin.resume();');
    const t0 = Date.now();
    const r = await run(entriesOf({ Stop: [{ hooks: [{ command: slow, timeout: 1 }] }] }), 'Stop', {});
    expect(Date.now() - t0).toBeLessThan(12_000);
    expect(r.blocked).toBe(false);
    expect(r.records[0].status).toBe('timeout');
    expect(r.warnings.join()).toMatch(/quá hạn 1 giây/);
  });

  it('các hook cùng sự kiện chạy SONG SONG (mỗi bên chờ bên kia bắt đầu mới xong)', async () => {
    const root = tmpRoot();
    const mk = (mine: string, other: string) =>
      script(
        `const fs=require('fs');fs.writeFileSync(${JSON.stringify(path.join(root, mine))},'1');const t0=Date.now();(function w(){if(fs.existsSync(${JSON.stringify(path.join(root, other))}))process.exit(0);if(Date.now()-t0>8000)process.exit(7);setTimeout(w,20);})();`,
      );
    const r = await run(entriesOf({ Stop: [{ hooks: [{ command: mk('a', 'b') }, { command: mk('b', 'a') }] }] }), 'Stop', {}, undefined, root);
    expect(r.records.map((x) => x.status)).toEqual(['ok', 'ok']);
  });

  it('môi trường hook KHÔNG chứa khoá API của máy; chỉ biến khai báo mới có', async () => {
    const root = tmpRoot();
    const out = path.join(root, 'env.json');
    const cmd = script(`process.stdin.resume();process.stdin.on('end',()=>{require('fs').writeFileSync(${JSON.stringify(out)},JSON.stringify(process.env));});`);
    const saved = { a: process.env.OPENAI_API_KEY, b: process.env.LOCAITH_TEST_SECRET_TOKEN };
    process.env.OPENAI_API_KEY = 'sk-should-not-leak-1234567890';
    process.env.LOCAITH_TEST_SECRET_TOKEN = 'tok-should-not-leak';
    try {
      const e = entriesOf({ Stop: [{ hooks: [{ command: cmd, env: { DECLARED: 'yes' } }] }] });
      await run(e, 'Stop', {}, undefined, root);
    } finally {
      if (saved.a === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved.a;
      if (saved.b === undefined) delete process.env.LOCAITH_TEST_SECRET_TOKEN;
      else process.env.LOCAITH_TEST_SECRET_TOKEN = saved.b;
    }
    const env = JSON.parse(fs.readFileSync(out, 'utf8')) as Record<string, string>;
    const dump = JSON.stringify(env);
    expect(dump).not.toContain('sk-should-not-leak');
    expect(dump).not.toContain('tok-should-not-leak');
    expect(env.DECLARED).toBe('yes');
    expect(Object.keys(env).some((k) => k.toUpperCase() === 'PATH')).toBe(true);
  });

  it('bí mật trong lệnh/đầu ra bị che trong bản ghi và log', async () => {
    const logs: string[] = [];
    const cmd = exits(2, 'lỗi với Bearer abcdefghijklmnop123456');
    const r = await runHookEvent(entriesOf({ Stop: [{ hooks: [{ command: `${cmd} --key sk-abcdefghijklmnopqrstuvwxyz123456` }] }] }), 'Stop', {}, {
      executor,
      cwd: tmpRoot(),
      signal: noopSignal,
      log: (_l, m) => logs.push(m),
      buildEnv: (entry) => buildHookEnv(process.env, { projectDir: '.', entry, event: 'Stop' }),
    });
    const all = JSON.stringify(r) + logs.join('\n');
    expect(all).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(all).not.toContain('abcdefghijklmnop123456');
  });

  it('matcher chọn đúng hook; sự kiện không dùng matcher thì chạy tất cả', async () => {
    const e = entriesOf({
      PreToolUse: [
        { matcher: 'run_command', hooks: [{ command: exits(0), name: 'A' }] },
        { matcher: 'edit_file', hooks: [{ command: exits(0), name: 'B' }] },
      ],
      Stop: [{ matcher: 'zzz', hooks: [{ command: exits(0), name: 'C' }] }],
    });
    expect(selectHooks(e, 'PreToolUse', ['run_command']).map((x) => x.name)).toEqual(['A']);
    expect(selectHooks(e, 'Stop', undefined).map((x) => x.name)).toEqual(['C']);
  });

  it('stdout rất lớn bị cắt, không làm treo', async () => {
    const big = script(`process.stdout.write('x'.repeat(2_000_000));process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`);
    const r = await run(entriesOf({ UserPromptSubmit: [{ hooks: [{ command: big }] }] }), 'UserPromptSubmit', {});
    expect(r.additionalContext[0].length).toBeLessThanOrEqual(8000);
  });
});

describe('hooks — nguồn và tin cậy', () => {
  const projectCfg = (cmd: string) => ({ PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command' as const, command: cmd }] }] });

  it('hook cấp người dùng chạy ngay cả khi workspace chưa tin cậy; hook dự án thì không, và KHÔNG hỏi', async () => {
    const root = tmpRoot();
    writeProjectHooks(root, projectCfg('echo project'));
    const kit = makeKit({ root, trusted: false, userHooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user' }] }] } });
    const res = await kit.sources.load();
    expect(res.entries.map((e) => e.source)).toEqual(['user']);
    expect(res.sources.find((s) => s.kind === 'project')?.state).toBe('untrusted');
    expect(kit.confirms).toHaveLength(0);
  });

  it('hook dự án: hỏi xác nhận với ĐẦY ĐỦ lệnh; chấp nhận thì ghi nhớ và không hỏi lại', async () => {
    const root = tmpRoot();
    writeProjectHooks(root, projectCfg('node check.js --strict'));
    const kit = makeKit({ root });
    const a = await kit.sources.load();
    expect(a.entries).toHaveLength(1);
    expect(kit.confirms).toHaveLength(1);
    expect(kit.confirms[0].lines.join('\n')).toContain('node check.js --strict');
    expect(kit.confirms[0].lines[0]).toContain('PreToolUse');
    await kit.sources.load();
    expect(kit.confirms).toHaveLength(1);
  });

  it('đổi nội dung hook → hỏi lại; đổi phần khác của tệp (thứ tự khoá, khoá không liên quan) → KHÔNG hỏi lại', async () => {
    const root = tmpRoot();
    writeProjectHooks(root, projectCfg('node a.js'));
    const kit = makeKit({ root });
    await kit.sources.load();
    expect(kit.confirms).toHaveLength(1);

    writeProjectHooks(root, projectCfg('node a.js'), '.locaith/settings.json', { permissions: { allow: ['x'] } });
    await kit.sources.load();
    expect(kit.confirms).toHaveLength(1);

    writeProjectHooks(root, projectCfg('node evil.js'));
    const res = await kit.sources.load();
    expect(kit.confirms).toHaveLength(2);
    expect(res.entries[0].command).toBe('node evil.js');
  });

  it('từ chối: hook dự án không chạy, không bị hỏi dồn dập; /hooks trust (reviewAgain) hỏi lại', async () => {
    const root = tmpRoot();
    writeProjectHooks(root, projectCfg('node a.js'));
    const kit = makeKit({ root, approve: () => false });
    expect((await kit.sources.load()).entries).toHaveLength(0);
    expect((await kit.sources.load()).entries).toHaveLength(0);
    expect(kit.confirms).toHaveLength(1);
    expect(kit.notes.join()).toMatch(/chưa được xác nhận/);
    kit.sources.reviewAgain();
    await kit.sources.load();
    expect(kit.confirms).toHaveLength(2);
  });

  it('hai lần nạp đồng thời chỉ hiện MỘT hộp xác nhận', async () => {
    const root = tmpRoot();
    writeProjectHooks(root, projectCfg('node a.js'));
    const kit = makeKit({ root });
    await Promise.all([kit.sources.load(), kit.sources.load(), kit.sources.load()]);
    expect(kit.confirms).toHaveLength(1);
  });

  it('.claude/settings.json chỉ được đọc khi bật hooksReadClaudeSettings (và cũng cần xác nhận)', async () => {
    const root = tmpRoot();
    writeProjectHooks(root, projectCfg('node c.js'), '.claude/settings.json');
    const off = makeKit({ root });
    expect((await off.sources.load()).entries).toHaveLength(0);
    expect(off.confirms).toHaveLength(0);
    const on = makeKit({ root, readClaude: true });
    const res = await on.sources.load();
    expect(res.entries.map((e) => e.dialect)).toEqual(['claude']);
    expect(on.confirms).toHaveLength(1);
  });

  it('công tắc hooksEnabled=false tắt tất cả', async () => {
    const root = tmpRoot();
    const kit = makeKit({ root, enabled: false, userHooks: { Stop: [{ hooks: [{ command: 'echo' }] }] } });
    const res = await kit.sources.load();
    expect(res.entries).toHaveLength(0);
    expect(res.sources[0].state).toBe('disabled');
  });

  it('JSON hỏng: báo lỗi, không ném, nguồn khác vẫn chạy', async () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, '.locaith'), { recursive: true });
    fs.writeFileSync(path.join(root, '.locaith/settings.json'), '{ không phải json', 'utf8');
    const kit = makeKit({ root, userHooks: { Stop: [{ hooks: [{ command: 'echo u' }] }] } });
    const res = await kit.sources.load();
    expect(res.entries).toHaveLength(1);
    expect(res.sources.find((s) => s.kind === 'project')?.state).toBe('error');
  });

  it('describe(): liệt kê theo nguồn kèm kết quả lần chạy gần nhất', async () => {
    const root = tmpRoot();
    const kit = makeKit({ root, userHooks: { Stop: [{ hooks: [{ command: exits(0), name: 'kiem-tra' }] }] } });
    await kit.service.fire('Stop', {}, { signal: noopSignal });
    const md = await kit.service.describe('vi');
    expect(md).toContain('locaithAgent.hooks');
    expect(md).toContain('kiem-tra');
    expect(md).toMatch(/lần gần nhất.*✓/);
    expect(await kit.service.describe('en')).toMatch(/last run/);
  });
});
