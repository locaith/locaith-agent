import { beforeAll, describe, expect, it } from 'vitest';
import type { DiffInfo, ToolBlock } from '../../../src/shared/protocol';
import { setLang } from '../../../src/cli/i18n';
import { newFileDiff, renderDiff } from '../../../src/cli/tui/diff';
import { fmtDuration, fmtTokens, middleEllipsis, relPath } from '../../../src/cli/tui/format';
import { describeCall, renderToolBlock, renderToolGroup, renderToolLive } from '../../../src/cli/tui/toolFormat';
import { detectCaps, makeTheme } from '../../../src/cli/tui/theme';
import { stringWidth, stripAnsi } from '../../../src/cli/tui/width';

const th = makeTheme(detectCaps({ env: { NO_COLOR: '1', LANG: 'en_US.UTF-8' } as NodeJS.ProcessEnv }));
const color = makeTheme(detectCaps({ env: { COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' } as NodeJS.ProcessEnv }));

beforeAll(() => setLang('vi'));

const diff: DiffInfo = {
  path: 'src/a.ts',
  added: 2,
  removed: 1,
  hunks: [
    {
      oldStart: 9,
      newStart: 9,
      lines: [
        { t: ' ', s: 'function f() {' },
        { t: '-', s: '  return 1;' },
        { t: '+', s: '  const x = 2;' },
        { t: '+', s: '  return x;' },
        { t: ' ', s: '}' },
      ],
    },
  ],
};

const tool = (over: Partial<ToolBlock>): ToolBlock => ({ type: 'tool', id: 'c1', name: 'read_file', args: {}, state: 'done', startedAt: Date.now() - 100, ...over });

describe('format', () => {
  it('token', () => {
    expect(fmtTokens(950, 'vi')).toBe('950');
    expect(fmtTokens(1234, 'vi')).toBe('1,2k');
    expect(fmtTokens(1234, 'en')).toBe('1.2k');
    expect(fmtTokens(968_000, 'en')).toBe('968k');
    expect(fmtTokens(2_500_000, 'vi')).toBe('2,5M');
  });
  it('thời lượng', () => {
    expect(fmtDuration(12_000, 'vi')).toBe('12 giây');
    expect(fmtDuration(133_000, 'vi')).toBe('2 phút 13 giây');
    expect(fmtDuration(133_000, 'en')).toBe('2m 13s');
    expect(fmtDuration(12_000, 'vi', true)).toBe('12s');
  });
  it('đường dẫn', () => {
    expect(relPath('C:\\proj\\src\\a.ts', 'C:\\proj')).toBe('src/a.ts');
    expect(relPath('/x/y.ts', '/proj')).toBe('/x/y.ts');
    expect(middleEllipsis('abcdefghijklmnop', 9)).toHaveLength(9);
  });
});

describe('diff', () => {
  it('số dòng, dấu +/-, nền', () => {
    const rows = renderDiff(diff, { width: 60, theme: color });
    const plain = rows.map(stripAnsi);
    expect(plain[0]).toBe(' 9   function f() {');
    expect(plain[1]).toContain('10 - ');
    expect(plain.find((l) => l.includes('+   const x = 2;'))).toBeTruthy();
    expect(rows[1]).toContain('\x1b[48;2;'); // nền
    expect(rows.every((l) => stringWidth(l) <= 60)).toBe(true);
  });
  it('rút gọn kèm … +N dòng', () => {
    const big: DiffInfo = { path: 'x', added: 30, removed: 0, hunks: [{ oldStart: 1, newStart: 1, lines: Array.from({ length: 30 }, (_, i) => ({ t: '+' as const, s: `l${i}` })) }] };
    const rows = renderDiff(big, { width: 50, theme: th, maxLines: 12, moreLabel: (n) => `… +${n} dòng` });
    expect(rows).toHaveLength(13);
    expect(stripAnsi(rows[12])).toBe('… +18 dòng');
    expect(renderDiff(big, { width: 50, theme: th, expanded: true })).toHaveLength(30);
  });
  it('dòng dài được bẻ, không vượt độ rộng', () => {
    const d: DiffInfo = { path: 'x', added: 1, removed: 0, hunks: [{ oldStart: 1, newStart: 1, lines: [{ t: '+', s: 'a'.repeat(120) }] }] };
    const rows = renderDiff(d, { width: 40, theme: color });
    expect(rows.length).toBeGreaterThan(2);
    expect(rows.every((l) => stringWidth(l) <= 40)).toBe(true);
  });
  it('cặp -/+ cùng số dòng làm nổi phần đổi', () => {
    const d: DiffInfo = { path: 'x', added: 1, removed: 1, hunks: [{ oldStart: 1, newStart: 1, lines: [{ t: '-', s: 'const a = 1; // cũ rất dài ở đây' }, { t: '+', s: 'const a = 2; // cũ rất dài ở đây' }] }] };
    const rows = renderDiff(d, { width: 80, theme: color });
    expect(rows[0]).toContain('\x1b[48;2;138;44;59m');
    expect(rows[1]).toContain('\x1b[48;2;29;106;58m');
  });
  it('tệp mới', () => {
    const d = newFileDiff('n.ts', 'a\nb\n');
    expect(d.added).toBe(2);
    expect(d.isNew).toBe(true);
  });
});

describe('toolFormat', () => {
  it('Read', () => {
    const v = describeCall('read_file', { path: 'C:\\p\\src\\app.ts' }, 'C:\\p');
    expect(v.title).toBe('Read');
    expect(v.arg).toBe('src/app.ts');
    const rows = renderToolBlock(tool({ name: 'read_file', args: { path: 'src/app.ts' }, output: 'a\nb\nc' }), { theme: th, width: 80 }).map(stripAnsi);
    expect(rows).toEqual(['● Read(src/app.ts)', '  ⎿ Đọc 3 dòng']);
  });
  it('Bash: 4 dòng đầu/cuối khi dài, đỏ khi lỗi', () => {
    const out = Array.from({ length: 20 }, (_, i) => `dòng ${i + 1}`).join('\n');
    const rows = renderToolBlock(tool({ name: 'run_command', args: { command: 'npm test' }, output: out }), { theme: th, width: 80 }).map(stripAnsi);
    expect(rows[0]).toBe('● Bash(npm test)');
    expect(rows[1]).toBe('  ⎿ dòng 1');
    expect(rows).toContain('    … +12 dòng (ctrl+o để mở rộng)');
    expect(rows[rows.length - 1]).toBe('    dòng 20');
    const err = renderToolBlock(tool({ name: 'run_command', args: { command: 'npm test' }, state: 'error', output: 'FAIL x\nstack' }), { theme: color, width: 80 });
    expect(err[0]).toContain('\x1b[38;2;248;113;113m');
    expect(stripAnsi(err[1])).toBe('  ⎿ Lỗi');
    expect(stripAnsi(err[2])).toBe('    FAIL x');
  });
  it('Update + diff', () => {
    const rows = renderToolBlock(tool({ name: 'edit_file', args: { path: 'src/a.ts' }, diff }), { theme: th, width: 80 }).map(stripAnsi);
    expect(rows[0]).toBe('● Update(src/a.ts)');
    expect(rows[1]).toBe('  ⎿ Thêm 2 dòng, xoá 1 dòng');
    expect(rows.length).toBe(2 + 5);
  });
  it('từ chối / dừng', () => {
    expect(stripAnsi(renderToolBlock(tool({ state: 'denied' }), { theme: th, width: 80 })[1])).toBe('  ⎿ Đã từ chối');
    expect(stripAnsi(renderToolBlock(tool({ state: 'cancelled' }), { theme: th, width: 80 })[1])).toBe('  ⎿ Đã dừng');
  });
  it('todo_write bị ẩn', () => {
    expect(renderToolBlock(tool({ name: 'todo_write' }), { theme: th, width: 80 })).toEqual([]);
  });
  it('đầu dòng không vượt độ rộng, đường dẫn dài cắt giữa', () => {
    const p = 'src/' + 'rat-dai/'.repeat(10) + 'file.ts';
    const row = renderToolBlock(tool({ args: { path: p }, output: 'x' }), { theme: th, width: 40 })[0];
    expect(stringWidth(row)).toBeLessThanOrEqual(40);
    expect(stripAnsi(row)).toContain('…');
  });
  it('MCP và công cụ lạ', () => {
    expect(describeCall('mcp__github__list_issues', { repo: 'a/b' }).title).toBe('github:list_issues');
    expect(describeCall('get_diagnostics', { path: 'x' }).title).toBe('GetDiagnostics');
  });
  it('agent con: số liệu sống', () => {
    const rows = renderToolLive(tool({ name: 'agent', args: { description: 'khảo sát' }, state: 'running', agent: { tokens: 12_300, tools: 7, activity: 'Đang đọc src/a.ts' } }), { theme: th, width: 80 }).map(stripAnsi);
    expect(rows[0]).toBe('● Agent(khảo sát)');
    expect(rows[1]).toContain('7 lệnh');
    expect(rows[1]).toContain('12,3k token');
  });
  it('lệnh đang chạy hiện 2 dòng tiến độ cuối', () => {
    const rows = renderToolLive(tool({ name: 'run_command', args: { command: 'x' }, state: 'running', output: 'a\nb\nc\nd' }), { theme: th, width: 80 }).map(stripAnsi);
    expect(rows).toEqual(['● Bash(x)', '  ⎿ c', '    d']);
  });
  it('gom ≥ 3 lệnh đọc', () => {
    const bs = ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map((p, i) => tool({ id: 'r' + i, args: { path: p } }));
    const rows = renderToolGroup(bs, { theme: th, width: 80 })!.map(stripAnsi);
    expect(rows[0]).toBe('● Đã đọc 4 tệp');
    expect(rows[1]).toContain('a.ts, b.ts, c.ts, d.ts');
    expect(renderToolGroup(bs.slice(0, 2), { theme: th, width: 80 })).toBeNull();
    expect(renderToolGroup(bs, { theme: th, width: 80, expanded: true })).toBeNull();
  });
});
