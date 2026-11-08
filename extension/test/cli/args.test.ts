import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { UsageError, parseArgs } from '../../src/cli/args';

const CWD = path.resolve('/work/proj');
const p = (argv: string[]) => parseArgs(argv, CWD);

describe('parseArgs', () => {
  it('--cwd đánh dấu cwdExplicit (để main kiểm thư mục có thật); không truyền thì không đánh dấu — parseArgs vẫn thuần, không đụng đĩa', () => {
    expect(p(['-p', 'x']).cwdExplicit).toBeUndefined();
    const a = p(['-p', 'x', '--cwd', 'khong/co/that']);
    expect(a.cwdExplicit).toBe(true);
    expect(a.cwd).toBe(path.resolve(CWD, 'khong/co/that'));
  });


  it('không đối số → phiên tương tác', () => {
    const a = p([]);
    expect(a.command).toBe('chat');
    expect(a.prompt).toBeUndefined();
    expect(a.outputFormat).toBe('text');
  });

  it('câu mở đầu không cờ → chat có prompt', () => {
    const a = p(['sửa', 'lỗi', 'type']);
    expect(a.command).toBe('chat');
    expect(a.prompt).toBe('sửa lỗi type');
  });

  it('-p và ask đều thành print', () => {
    expect(p(['-p', 'xin chào']).command).toBe('print');
    expect(p(['--print', 'xin chào']).prompt).toBe('xin chào');
    const ask = p(['ask', 'tóm tắt repo']);
    expect(ask.command).toBe('print');
    expect(ask.prompt).toBe('tóm tắt repo');
  });

  it('lệnh con', () => {
    for (const c of ['doctor', 'login', 'logout', 'whoami', 'consent', 'update', 'sessions', 'config'] as const) expect(p([c]).command).toBe(c);
    expect(p(['help', 'permissions']).topic).toBe('permissions');
    expect(p(['--help']).command).toBe('help');
    expect(p(['-v']).command).toBe('version');
  });

  it('một từ trùng tên lệnh con nhưng nằm sau câu thì là chữ thường', () => {
    const a = p(['hãy', 'chạy', 'doctor', 'cho', 'tôi']);
    expect(a.command).toBe('chat');
    expect(a.prompt).toBe('hãy chạy doctor cho tôi');
  });

  it('định dạng đầu ra và cờ cũ', () => {
    expect(p(['-p', 'x', '--output-format', 'stream-json']).outputFormat).toBe('stream-json');
    expect(p(['-p', 'x', '--output-format=json']).outputFormat).toBe('json');
    const j = p(['ask', '--json', 'x']);
    expect(j.json).toBe(true);
    expect(j.outputFormat).toBe('json');
    expect(() => p(['-p', 'x', '--output-format', 'yaml'])).toThrow(UsageError);
  });

  it('chế độ quyền: tên mới và cờ --allow cũ', () => {
    expect(p(['--permission-mode', 'acceptEdits']).permissionMode).toBe('acceptEdits');
    expect(p(['--permission-mode', 'bypassPermissions']).permissionMode).toBe('bypass');
    expect(p(['--dangerously-skip-permissions']).permissionMode).toBe('bypass');
    expect(p(['--allow', 'all']).permissionMode).toBe('bypass');
    expect(p(['--allow', 'reads']).permissionMode).toBe('default');
    expect(p(['--allow', 'none']).permissionMode).toBe('plan');
    expect(() => p(['--permission-mode', 'yolo'])).toThrow(UsageError);
    expect(() => p(['--allow', 'maybe'])).toThrow(UsageError);
  });

  it('allowedTools tách theo dấu phẩy/khoảng trắng NGOÀI ngoặc', () => {
    const a = p(['--allowedTools', 'Bash(git log:*,git diff:*) Read', '--allowedTools', 'Edit(src/**),WebFetch(domain:github.com)', '--disallowedTools', 'Bash(rm:*)']);
    expect(a.allowedTools).toEqual(['Bash(git log:*,git diff:*)', 'Read', 'Edit(src/**)', 'WebFetch(domain:github.com)']);
    expect(a.disallowedTools).toEqual(['Bash(rm:*)']);
  });

  it('số và đường dẫn', () => {
    const a = p(['-p', 'x', '--max-turns', '12', '--timeout', '30', '--cwd', 'sub', '--add-dir', '../other', '--mcp-config', 'm.json']);
    expect(a.maxTurns).toBe(12);
    expect(a.timeoutSec).toBe(30);
    expect(a.cwd).toBe(path.resolve(CWD, 'sub'));
    expect(a.addDirs).toEqual([path.resolve(CWD, '../other')]);
    expect(a.mcpConfig).toEqual([path.resolve(CWD, 'm.json')]);
    expect(() => p(['--max-turns', '0'])).toThrow(UsageError);
    expect(() => p(['--timeout', 'abc'])).toThrow(UsageError);
  });

  it('tiếp tục / mở lại phiên', () => {
    expect(p(['-c']).continueLast).toBe(true);
    expect(p(['--continue']).continueLast).toBe(true);
    expect(p(['-r', 'abc123']).resume).toBe('abc123');
    expect(p(['--resume=abc123']).resume).toBe('abc123');
    expect(p(['-r']).resume).toBe(true);
    expect(p(['-r', '--verbose']).resume).toBe(true);
    expect(p(['-r', 'doctor']).resume).toBe(true); // `doctor` là lệnh con, không phải id
  });

  it('cờ phụ: ngôn ngữ, màu, đồng ý, trình duyệt, không lưu', () => {
    const a = p(['--lang', 'en', '--no-color', '--yes', '--no-browser', '--no-session-persistence', '--verbose', '--append-system-prompt', 'ngắn gọn']);
    expect(a.lang).toBe('en');
    expect(a.noColor).toBe(true);
    expect(a.yes).toBe(true);
    expect(a.noBrowser).toBe(true);
    expect(a.noPersist).toBe(true);
    expect(a.verbose).toBe(true);
    expect(a.appendSystemPrompt).toBe('ngắn gọn');
    expect(() => p(['--lang', 'fr'])).toThrow(UsageError);
  });

  it('cờ không biết và thiếu giá trị là lỗi dùng sai', () => {
    expect(() => p(['--khong-co'])).toThrow(UsageError);
    expect(() => p(['--model'])).toThrow(UsageError);
  });

  it('cờ phụ của lệnh con', () => {
    expect(p(['sessions', '--all']).flags.all).toBe(true);
    expect(p(['update', '--check']).flags.check).toBe(true);
  });
});
