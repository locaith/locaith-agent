import { describe, expect, it } from 'vitest';
import type { TItem, ToolBlock } from '../../src/shared/protocol';
import { activityStats, buildSegments } from '../../webview/src/timeline';
import {
  actionName,
  agentRowsOf,
  backgroundOf,
  formatElapsedShort,
  countLines,
  firstLines,
  formatClock,
  formatDayLabel,
  formatDurationShort,
  formatSeconds,
  hasProcess,
  langOfPath,
  runTone,
  runningSince,
  sameLocalDay,
  thinkingDuration,
  timelineMarks,
  toolDescription,
  writeLineCount,
} from '../../webview/src/timelineCc';

/** (lane:cc-timeline-ui) Hàm thuần của dòng thời gian gọn — cũng là hợp đồng để trang Remote chép lại (docs/TIMELINE-SPEC.md). */
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime();
const tool = (name: string, args: Record<string, unknown> = {}, extra: Partial<ToolBlock> = {}): ToolBlock => ({ type: 'tool', id: 'c', name, args, state: 'done', startedAt: 1, ...extra });

describe('giờ và ngày', () => {
  it('formatClock: vi 24 giờ có số 0 đầu, en 12 giờ AM/PM; thiếu/không hợp lệ → rỗng', () => {
    expect(formatClock(at(2026, 11, 7, 17, 52), 'vi')).toBe('17:52');
    expect(formatClock(at(2026, 11, 7, 1, 27), 'vi')).toBe('01:27');
    expect(formatClock(at(2026, 11, 7, 17, 52), 'en')).toBe('5:52 PM');
    expect(formatClock(at(2026, 11, 7, 0, 5), 'en')).toBe('12:05 AM');
    expect(formatClock(at(2026, 11, 7, 12, 0), 'en')).toBe('12:00 PM');
    expect(formatClock(undefined, 'vi')).toBe('');
    expect(formatClock(0, 'en')).toBe('');
    expect(formatClock(Number.NaN, 'en')).toBe('');
  });

  it('formatDayLabel: «T7, 07/11» / «Sat, Nov 7»; khác năm thì kèm năm', () => {
    const sat = at(2026, 11, 7, 10, 0);
    expect(formatDayLabel(sat, 'vi', sat)).toBe('T7, 07/11');
    expect(formatDayLabel(sat, 'en', sat)).toBe('Sat, Nov 7');
    const sun = at(2025, 1, 5, 10, 0);
    expect(formatDayLabel(sun, 'vi', sat)).toBe('CN, 05/01/2025');
    expect(formatDayLabel(sun, 'en', sat)).toBe('Sun, Jan 5, 2025');
    expect(formatDayLabel(undefined, 'vi')).toBe('');
  });

  it('sameLocalDay so theo ngày địa phương', () => {
    expect(sameLocalDay(at(2026, 11, 7, 0, 1), at(2026, 11, 7, 23, 59))).toBe(true);
    expect(sameLocalDay(at(2026, 11, 6, 23, 59), at(2026, 11, 7, 0, 1))).toBe(false);
  });

  it('timelineMarks: giờ cho tin người dùng, giờ xong cho lượt có quá trình, đường ngăn khi sang ngày; thiếu ts thì ẩn', () => {
    const d1 = at(2026, 11, 6, 1, 27);
    const d2 = at(2026, 11, 7, 17, 52);
    const items: TItem[] = [
      { kind: 'user', id: 'u1', text: 'a', attachments: [], ts: d1 },
      { kind: 'assistant', id: 'a1', provider: 'p', model: 'm', ts: d1 + 1000, done: true, endedAt: d1 + 60_000, blocks: [{ type: 'text', id: 't', text: 'chỉ chữ' }] },
      { kind: 'notice', id: 'n1', level: 'info', text: 'x', ts: d1 + 2000 },
      { kind: 'user', id: 'u2', text: 'b', attachments: [], ts: d2 },
      { kind: 'assistant', id: 'a2', provider: 'p', model: 'm', ts: d2 + 1000, done: true, endedAt: d2 + 90_000, blocks: [tool('read_file'), { type: 'text', id: 't', text: 'xong' }] },
      { kind: 'assistant', id: 'a3', provider: 'p', model: 'm', ts: d2 + 2000, done: false, blocks: [tool('read_file')] },
      { kind: 'user', id: 'u3', text: 'c', attachments: [], ts: 0 },
    ];
    const marks = timelineMarks(items);
    expect(marks.get('u1')).toEqual({ time: d1 }); // mục đầu: không đường ngăn
    expect(marks.get('a1')).toBeUndefined(); // chỉ chữ → không giờ riêng
    expect(marks.get('n1')).toBeUndefined();
    expect(marks.get('u2')).toEqual({ day: d2, time: d2 }); // sang ngày mới
    expect(marks.get('a2')).toEqual({ time: d2 + 90_000 }); // có quá trình → giờ lúc xong
    expect(marks.get('a3')).toBeUndefined(); // đang chạy, chưa có endedAt
    expect(marks.get('u3')).toBeUndefined(); // ts = 0 → ẩn, không bịa
  });

  it('hasProcess: có công cụ hoặc suy nghĩ', () => {
    expect(hasProcess([{ type: 'text', id: 't', text: 'x' }])).toBe(false);
    expect(hasProcess([{ type: 'thinking', id: 'k', text: 'x' }])).toBe(true);
    expect(hasProcess([tool('grep')])).toBe(true);
  });
});

describe('dòng công cụ', () => {
  it('actionName: tên ngắn hai ngôn ngữ; công cụ lạ giữ nguyên tên', () => {
    expect(actionName('vi', 'run_command')).toBe('Lệnh');
    expect(actionName('en', 'run_command')).toBe('Bash');
    expect(actionName('vi', 'write_file')).toBe('Ghi');
    expect(actionName('en', 'write_file')).toBe('Write');
    expect(actionName('en', 'agent')).toBe('Task');
    expect(actionName('vi', 'grep')).toBe('Tìm');
    expect(actionName('vi', 'mcp__github__list_prs')).toBe('mcp__github__list_prs');
  });

  it('toolDescription: `description` do model đặt thắng mọi công cụ; không có thì lấy lệnh / đường dẫn / mẫu', () => {
    expect(toolDescription('vi', tool('run_command', { command: 'npm test', description: 'Chạy bộ kiểm thử\ndòng 2' }))).toEqual({ text: 'Chạy bộ kiểm thử', kind: 'description' });
    expect(toolDescription('vi', tool('run_command', { command: 'npm test' }))).toEqual({ text: 'npm test', kind: 'command' });
    expect(toolDescription('vi', tool('read_file', { path: 'src/a.ts' }))).toEqual({ text: 'src/a.ts', kind: 'path' });
    expect(toolDescription('en', tool('grep', { pattern: 'foo', path: 'src' })).text).toContain('foo');
    expect(toolDescription('en', tool('my_tool', { description: '   ' })).text).toBe('');
  });

  it('writeLineCount: ưu tiên summary «58 dòng»/«58 lines» (nguồn duy nhất ở Remote), rồi đếm content; content đã cắt → không đoán', () => {
    expect(writeLineCount(tool('write_file', { content: 'a\nb' }, { summary: '58 dòng' }))).toBe(58);
    expect(writeLineCount(tool('write_file', { content: 'a\nb' }, { summary: '1,284 lines' }))).toBe(1284);
    expect(writeLineCount(tool('write_file', { content: 'a\nb\nc' }))).toBe(3);
    expect(writeLineCount(tool('write_file', { content: 'a\nb\nc… [+900]' }, { summary: '+9 −3' }))).toBeUndefined();
    expect(writeLineCount(tool('write_file', {}))).toBeUndefined();
  });

  it('countLines / firstLines', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a\nb\n')).toBe(3);
    expect(firstLines('l1\r\nl2\nl3\nl4\nl5\n', 3)).toEqual({ lines: ['l1', 'l2', 'l3'], more: 2 });
    expect(firstLines('one', 4)).toEqual({ lines: ['one'], more: 0 });
  });

  it('langOfPath', () => {
    expect(langOfPath('src/a.tsx')).toBe('typescript');
    expect(langOfPath('C:\\x\\y.py')).toBe('python');
    expect(langOfPath('Dockerfile')).toBe('dockerfile');
    expect(langOfPath('notes')).toBeUndefined();
  });
});

describe('suy nghĩ và nhóm', () => {
  it('thinkingDuration: cộng các khối có số; không khối nào có → undefined', () => {
    expect(thinkingDuration([{ durationMs: 14_000 }, {}, { durationMs: 1000 }])).toBe(15_000);
    expect(thinkingDuration([{}, { durationMs: Number.NaN }])).toBeUndefined();
    expect(thinkingDuration([])).toBeUndefined();
  });

  it('formatSeconds: «14 giây»/«14s», phút, giờ, dưới 1 giây', () => {
    expect(formatSeconds(14_000, 'vi')).toBe('14 giây');
    expect(formatSeconds(14_000, 'en')).toBe('14s');
    expect(formatSeconds(80_000, 'vi')).toBe('1 phút 20 giây');
    expect(formatSeconds(80_000, 'en')).toBe('1m 20s');
    expect(formatSeconds(2_394_000, 'en')).toBe('39m 54s');
    expect(formatSeconds(3_600_000, 'vi')).toBe('1 giờ');
    expect(formatSeconds(300, 'vi')).toBe('<1 giây');
  });

  it('runTone: lỗi thắng đang chạy; đang chạy → live; xong sạch → ok', () => {
    expect(runTone({ failed: 2 }, true)).toBe('fail');
    expect(runTone({ failed: 0 }, true)).toBe('live');
    expect(runTone({ failed: 0 }, false)).toBe('ok');
  });

  it('formatDurationShort: giây dưới 1 phút, chỉ phút từ 1 phút, giờ + phút từ 1 giờ', () => {
    expect(formatDurationShort(48_000, 'vi')).toBe('48 giây');
    expect(formatDurationShort(23 * 60_000 + 58_000, 'vi')).toBe('23 phút');
    expect(formatDurationShort(23 * 60_000 + 58_000, 'en')).toBe('23m');
    expect(formatDurationShort(72 * 60_000, 'vi')).toBe('1 giờ 12 phút');
    expect(formatDurationShort(72 * 60_000, 'en')).toBe('1h 12m');
  });

  it('formatElapsedShort: «48s» · «59m» · «1h 12m»', () => {
    expect(formatElapsedShort(48_000)).toBe('48s');
    expect(formatElapsedShort(59 * 60_000 + 30_000)).toBe('59m');
    expect(formatElapsedShort(72 * 60_000)).toBe('1h 12m');
    expect(formatElapsedShort(3_600_000)).toBe('1h');
    expect(formatElapsedShort(-5)).toBe('0s');
  });

  it('agentRowsOf: lấy mọi agent trong cụm (trong dòng tóm tắt lẫn dòng sống), không trùng; cụm gộp KHÔNG đếm agent sống hai lần', () => {
    const ag = (id: string, state: ToolBlock['state'], tools: number): ToolBlock => tool('agent', { description: id }, { id, state, agent: { tokens: 1000, tools } });
    const blocks = [tool('read_file', {}, { id: 'r1' }), tool('grep', {}, { id: 'r2' }), tool('run_command', {}, { id: 'r3' }), ag('a1', 'done', 10), ag('a2', 'running', 5), ag('a3', 'running', 7)];
    const rows = buildSegments(blocks, false, true, true).flatMap((s) => (s.kind === 'activity' ? s.rows : []));
    expect(rows.map((r) => r.kind)).toEqual(['toolsum', 'agent', 'agent']);
    expect(agentRowsOf(rows).map((b) => b.id)).toEqual(['a1', 'a2', 'a3']);
    // 3 lệnh + 3 agent = 6 (lệnh bên trong agent hiện trên dòng agent); a2/a3 vừa nằm trong tổng của dòng tóm tắt vừa có dòng riêng nhưng không đếm hai lần
    expect(activityStats(rows).calls).toBe(6);
  });

  it('runningSince: lượt đang chạy → ts của lượt; không chạy / lượt đã xong / ts hỏng → undefined', () => {
    const user: TItem = { kind: 'user', id: 'u', text: 'x', attachments: [], ts: 5000 };
    const open: TItem = { kind: 'assistant', id: 'a', provider: 'p', model: 'm', ts: 7000, done: false, blocks: [] };
    expect(runningSince({ running: true, transcript: [user, open] })).toBe(7000);
    expect(runningSince({ running: true, transcript: [user] })).toBe(5000); // lượt chưa mở: tính từ lúc gửi
    expect(runningSince({ running: false, transcript: [user, open] })).toBeUndefined();
    expect(runningSince({ running: true, transcript: [user, { ...open, done: true }] })).toBeUndefined();
    expect(runningSince({ running: true, transcript: [user, { ...open, ts: 0 }] })).toBeUndefined();
    expect(runningSince({ running: true, transcript: [] })).toBeUndefined();
  });

  it('backgroundOf: chỉ khi model đặt run_in_background/background = true', () => {
    expect(backgroundOf(tool('run_command', { command: 'x', run_in_background: true }))).toBe(true);
    expect(backgroundOf(tool('run_command', { command: 'x', background: 'yes' }))).toBe(false);
    expect(backgroundOf(null)).toBe(false);
  });
});
