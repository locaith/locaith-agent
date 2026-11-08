import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsStore, buildEngineSettings, lookupKey, setDeep } from '../../../src/cli/runtime/config';
import { isDirTrusted, trustDir, untrustDir } from '../../../src/cli/runtime/trust';
import { textTurn, toolTurn } from '../../helpers/fakeProvider';
import { cleanEnv, cleanupDirs, harness, tmpDir } from './harness';

afterEach(() => cleanupDirs());

function store(o: { user?: unknown; project?: unknown; local?: unknown; env?: Record<string, string>; trusted?: boolean; cli?: Record<string, unknown> } = {}) {
  const home = tmpDir('lc-home-');
  const cwd = tmpDir('lc-cwd-');
  if (o.user !== undefined) {
    fs.mkdirSync(path.join(home, '.locaith'), { recursive: true });
    fs.writeFileSync(path.join(home, '.locaith', 'settings.json'), typeof o.user === 'string' ? o.user : JSON.stringify(o.user));
  }
  if (o.project !== undefined) {
    fs.mkdirSync(path.join(cwd, '.locaith'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.locaith', 'settings.json'), JSON.stringify(o.project));
  }
  if (o.local !== undefined) {
    fs.mkdirSync(path.join(cwd, '.locaith'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.locaith', 'settings.local.json'), JSON.stringify(o.local));
  }
  const s = new SettingsStore({ home, cwd, env: cleanEnv(o.env ?? {}), trusted: () => o.trusted !== false, cli: o.cli });
  return { s, home, cwd };
}

describe('lookupKey / setDeep', () => {
  it('đọc cả khoá chấm lẫn khoá lồng, và dựng đối tượng từ khoá chấm', () => {
    expect(lookupKey({ 'agent.compactAtPercent': 70 }, 'agent.compactAtPercent')).toEqual({ found: true, value: 70 });
    expect(lookupKey({ agent: { compactAtPercent: 60 } }, 'agent.compactAtPercent')).toEqual({ found: true, value: 60 });
    expect(lookupKey({ 'permissions.allow': ['a'], 'permissions.deny': ['b'] }, 'permissions')).toEqual({ found: true, value: { allow: ['a'], deny: ['b'] } });
    expect(lookupKey({ agent: {} }, 'agent.x').found).toBe(false);
  });

  it('setDeep giữ kiểu viết sẵn có và chặn khoá nguy hiểm', () => {
    const o: Record<string, unknown> = { 'agent.maxTurns': 5, agent2: { a: 1 } };
    setDeep(o, 'agent.maxTurns', 9);
    setDeep(o, 'agent2.b', 2);
    setDeep(o, 'ui.theme', 'dark');
    expect(o).toEqual({ 'agent.maxTurns': 9, agent2: { a: 1, b: 2 }, ui: { theme: 'dark' } });
    setDeep(o, 'agent2.a', undefined);
    expect((o.agent2 as Record<string, unknown>).a).toBeUndefined();
    expect(() => setDeep(o, '__proto__.x', 1)).toThrow();
  });
});

describe('gộp cài đặt user < project < local < env < cli', () => {
  it('tầng cao hơn thắng với giá trị đơn; mảng permissions được nối', () => {
    const { s } = store({
      user: { agent: { maxTurns: 10, compactAtPercent: 60 }, permissions: { allow: ['run_command(git status)'] } },
      project: { 'agent.maxTurns': 20, permissions: { allow: ['read_file(*)'], deny: ['run_command(rm *)'] } },
      local: { agent: { maxTurns: 30 } },
      env: { LOCAITH_SETTINGS: JSON.stringify({ 'agent.compactAtPercent': 90 }) },
    });
    expect(s.get('agent.maxTurns', 0)).toBe(30); // local thắng project thắng user
    expect(s.get('agent.compactAtPercent', 0)).toBe(90); // env thắng user
    expect(s.get<string[]>('permissions.allow', [])).toEqual(['run_command(git status)', 'read_file(*)']);
    expect(s.get<string[]>('permissions.deny', [])).toEqual(['run_command(rm *)']);
    expect(s.get('khong.co', 'mặc định')).toBe('mặc định');
    expect(s.sourceOf('agent.maxTurns')).toBe('local');
  });

  it('biến LOCAITH_MODEL / LOCAITH_PERMISSION_MODE ánh xạ vào cài đặt; cli đè tất cả', () => {
    const { s } = store({ user: { model: 'a' }, env: { LOCAITH_MODEL: 'b', LOCAITH_PERMISSION_MODE: 'plan' }, cli: { 'permissions.deny': ['web_search'] } });
    expect(s.get('model', '')).toBe('b');
    expect(s.get('agent.permissionMode', '')).toBe('plan');
    expect(s.get<string[]>('permissions.deny', [])).toEqual(['web_search']);
  });

  it('thư mục CHƯA tin cậy: tầng dự án chỉ được thêm ask/deny, không đổi gì khác', () => {
    const { s } = store({
      trusted: false,
      user: { permissions: { allow: ['read_file(*)'] }, agent: { maxTurns: 10 } },
      project: { permissions: { allow: ['run_command(*)'], ask: ['write_file(*)'], deny: ['web_search'] }, agent: { maxTurns: 99 }, hooks: { PreToolUse: [{ command: 'evil' }] }, mcpServers: { x: { command: 'evil' } } },
    });
    expect(s.get<string[]>('permissions.allow', [])).toEqual(['read_file(*)']);
    expect(s.get<string[]>('permissions.ask', [])).toEqual(['write_file(*)']);
    expect(s.get<string[]>('permissions.deny', [])).toEqual(['web_search']);
    expect(s.get('agent.maxTurns', 0)).toBe(10);
    expect(s.get('hooks', null)).toBeNull();
    expect(s.get('mcpServers', null)).toBeNull();
    expect(s.get('permissions', {})).toEqual({ allow: ['read_file(*)'], ask: ['write_file(*)'], deny: ['web_search'] });
  });

  it('agent.allowBypassPermissions chỉ đọc từ cài đặt người dùng, không từ kho mã', () => {
    const { s } = store({ user: {}, project: { agent: { allowBypassPermissions: true } }, local: { agent: { allowBypassPermissions: true } } });
    expect(s.get('agent.allowBypassPermissions', false)).toBe(false);
    expect(() => s.set('agent.allowBypassPermissions', true, 'project')).toThrow();
    s.set('agent.allowBypassPermissions', true, 'user');
    expect(s.get('agent.allowBypassPermissions', false)).toBe(true);
  });

  it('tệp cài đặt hỏng: bỏ qua, báo trong problems(), không ném', () => {
    const { s } = store({ user: '{ không phải json' });
    expect(s.get('agent.maxTurns', 7)).toBe(7);
    expect(s.problems().join('\n')).toContain('settings.json');
  });
});

describe('ghi cài đặt', () => {
  it('set() ghi nguyên tử đúng phạm vi, đọc lại thấy ngay, giữ phần còn lại của tệp', () => {
    const { s, home, cwd } = store({ user: { keep: 1 }, trusted: true });
    s.set('agent.maxTurns', 42, 'user');
    s.set('permissions.allow', ['read_file(*)'], 'project');
    s.set('ui.theme', 'dark', 'local');
    expect(s.get('agent.maxTurns', 0)).toBe(42);
    expect(JSON.parse(fs.readFileSync(path.join(home, '.locaith', 'settings.json'), 'utf8'))).toEqual({ keep: 1, agent: { maxTurns: 42 } });
    expect(JSON.parse(fs.readFileSync(path.join(cwd, '.locaith', 'settings.json'), 'utf8'))).toEqual({ permissions: { allow: ['read_file(*)'] } });
    expect(s.get('ui.theme', '')).toBe('dark');
    // không để lại tệp tạm
    expect(fs.readdirSync(path.join(home, '.locaith')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    s.set('agent.maxTurns', undefined, 'user');
    expect(s.get('agent.maxTurns', 0)).toBe(0);
  });

  it('chưa tin cậy thì từ chối ghi phạm vi dự án/cục bộ nhưng vẫn ghi được phạm vi người dùng', () => {
    const { s } = store({ trusted: false });
    expect(() => s.set('a.b', 1, 'project')).toThrow(/tin cậy/);
    expect(() => s.set('a.b', 1, 'local')).toThrow(/tin cậy/);
    s.set('a.b', 1, 'user');
    expect(s.get('a.b', 0)).toBe(1);
  });

  it('tệp hỏng được sao lưu trước khi ghi đè', () => {
    const { s, home } = store({ user: '{hỏng' });
    s.set('x', 1, 'user');
    expect(fs.readdirSync(path.join(home, '.locaith')).some((f) => f.startsWith('settings.json.corrupt-'))).toBe(true);
    expect(s.get('x', 0)).toBe(1);
  });
});

describe('tin cậy thư mục', () => {
  it('trusted.json: tin, kế thừa cho thư mục con, bỏ tin', () => {
    const home = tmpDir('lc-home-');
    const proj = tmpDir('lc-proj-');
    const child = path.join(proj, 'a', 'b');
    fs.mkdirSync(child, { recursive: true });
    expect(isDirTrusted(home, proj)).toBe(false);
    trustDir(home, proj);
    expect(isDirTrusted(home, proj)).toBe(true);
    expect(isDirTrusted(home, child)).toBe(true);
    expect(isDirTrusted(home, path.dirname(proj))).toBe(false);
    untrustDir(home, proj);
    expect(isDirTrusted(home, child)).toBe(false);
  });

  it('không bao giờ coi thư mục «nhà» là cha đã tin cậy của mọi thứ trong nó', () => {
    const home = tmpDir('lc-home-');
    trustDir(home, home);
    expect(isDirTrusted(home, home)).toBe(true);
    expect(isDirTrusted(home, path.join(home, 'du-an-la'))).toBe(false);
  });
});

describe('ánh xạ sang EngineSettings', () => {
  it('đọc compactAtPercent, clearToolResultsAtPercent, keepRecentMessages, maxTurns, language…', () => {
    const { s } = store({ user: { agent: { compactAtPercent: 90, clearToolResultsAtPercent: 30, keepRecentMessages: 10, compactAtTokens: 123456, maxTurns: 17, instructionFiles: ['MYRULES.md'] } } });
    const e = buildEngineSettings(s, { lang: 'en', contextWindow: 1_000_000, modelMaxOutputTokens: 64_000 });
    expect(e).toMatchObject({ compactAt: 0.9, clearToolResultsAtPercent: 30, keepRecentMessages: 10, compactAtTokens: 123456, maxTurns: 17, language: 'en', contextWindow: 1_000_000, modelMaxOutputTokens: 64_000, compactAtUserSet: true });
    expect(e.instructionFiles).toEqual(['MYRULES.md']);
    expect(buildEngineSettings(s, { lang: 'vi', contextWindow: 1, maxTurns: 3 }).maxTurns).toBe(3); // cờ --max-turns thắng
    const d = buildEngineSettings(store().s, { lang: 'vi', contextWindow: 200_000 });
    expect(d.compactAt).toBe(0.8);
    expect(d.compactAtUserSet).toBe(false);
    expect(d.instructionFiles).toEqual(['LOCAITH.md', 'AGENTS.md', 'CLAUDE.md']);
  });
});

describe('cài đặt trong runtime', () => {
  it('thư mục chưa tin cậy: luật allow của dự án bị bỏ, deny của dự án vẫn có hiệu lực, chế độ mặc định là plan', async () => {
    const h = await harness({
      trusted: false,
      projectSettings: { permissions: { allow: ['run_command(echo *)'], deny: ['read_file(sample.txt)'] } },
      script: [toolTurn([{ name: 'read_file', input: { path: 'sample.txt' } }]), textTurn('xong')],
    });
    expect(h.rt.status().mode).toBe('plan');
    expect(h.rt.status().notices.join(' ')).toMatch(/chưa được tin cậy/);
    await h.rt.submit('đọc');
    await h.rt.idle();
    expect(JSON.stringify(h.provider.requests[1].messages)).not.toContain('ALPHA'); // deny của dự án vẫn áp
    await h.cleanup();
  });

  it('thư mục đã tin cậy: luật allow của dự án có hiệu lực (không hỏi)', async () => {
    const h = await harness({
      interactive: false,
      projectSettings: { permissions: { allow: ['run_command(echo *)'] } },
      script: [toolTurn([{ name: 'run_command', input: { command: 'echo du-an-cho-phep' } }]), textTurn('xong')],
    });
    await h.rt.submit('chạy');
    await h.rt.idle();
    expect(JSON.stringify(h.provider.requests[1].messages)).toContain('du-an-cho-phep');
    await h.cleanup();
  });

  it('opts.trusted vắng thì tra ~/.locaith/trusted.json', async () => {
    const home = tmpDir('lc-home-');
    const cwd = tmpDir('lc-cwd-');
    const a = await harness({ home, cwd, trusted: undefined, script: [] });
    expect(a.rt.status().mode).toBe('plan');
    await a.cleanup();
    trustDir(home, cwd);
    const b = await harness({ home, cwd, trusted: undefined, script: [] });
    expect(b.rt.status().mode).toBe('default');
    await b.cleanup();
  });

  it('dùng cửa sổ ngữ cảnh theo model/cài đặt trong status', async () => {
    const h = await harness({ userSettings: { 'agent.contextWindow': 12345 }, script: [] });
    expect(h.rt.status().context.window).toBe(12345);
    await h.cleanup();
  });

  it('SettingsApi của runtime ghi vào đúng tệp (qua rt.settings)', async () => {
    const h = await harness({ script: [] });
    h.rt.settings!.set('ui.theme', 'light', 'user');
    expect(JSON.parse(fs.readFileSync(path.join(h.home, '.locaith', 'settings.json'), 'utf8')).ui.theme).toBe('light');
    expect(h.rt.settings!.get('ui.theme', '')).toBe('light');
    await h.cleanup();
  });
});
