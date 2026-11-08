import { describe, expect, it } from 'vitest';
import type { ABlock, ToolBlock } from '../../src/shared/protocol';
import { buildSegments, needsWorkingIndicator, turnPlainText } from '../../webview/src/timeline';

const tool = (id: string, name: string, state: ToolBlock['state'] = 'done', args: Record<string, unknown> = {}): ToolBlock => ({
  type: 'tool',
  id,
  name,
  args,
  state,
  startedAt: 0,
});
const pill = (id: string, active = false): ABlock => ({ type: 'pill', id, text: id, kind: 'thinking', active });
const text = (id: string, t = 'xin chào'): ABlock => ({ type: 'text', id, text: t });

describe('buildSegments', () => {
  it('tách văn bản khỏi chuỗi hoạt động', () => {
    const blocks: ABlock[] = [
      { type: 'tasks', id: 't1', added: ['A', 'B'] },
      { type: 'skill', id: 's1', skill: 'artifacts', unlocked: [] },
      text('x1', 'Kết quả'),
      tool('c1', 'web_search'),
    ];
    const segs = buildSegments(blocks, false, true);
    expect(segs.map((s) => s.kind)).toEqual(['activity', 'text', 'activity']);
    const first = segs[0];
    expect(first.kind === 'activity' && first.rows.map((r) => r.kind)).toEqual(['tasks', 'skill']);
  });

  // 0.6.0 — hành vi ĐỔI CÓ CHỦ Ý: trước đây lúc đang chạy 5 lệnh hiện thành 5 dòng; nay mọi chuỗi ≥ 3 lệnh liền nhau (đang chạy hay đã xong) là MỘT dòng tóm tắt.
  it('lúc đang chạy: 5 lệnh tìm kiếm thành MỘT dòng tóm tắt; khi lượt xong: dòng gộp cụ thể «Đã tìm kiếm…»', () => {
    const searches = ['1', '2', '3', '4', '5'].map((i) => tool(`c${i}`, 'web_search'));
    const live = buildSegments(searches, false, true);
    expect(live[0].kind === 'activity' && live[0].rows.map((r) => r.kind)).toEqual(['toolsum']);
    const done = buildSegments(searches, true, true);
    const row = done[0].kind === 'activity' ? done[0].rows[0] : null;
    expect(row?.kind).toBe('toolgroup');
    expect(row && row.kind === 'toolgroup' && row.blocks).toHaveLength(5);
  });

  // 0.6.0 — hành vi ĐỔI CÓ CHỦ Ý: «công cụ không gộp được» (run_command…) và «có dòng chưa xong» trước đây để nguyên từng dòng; nay từ 3 lệnh trở lên
  // chúng thành dòng TÓM TẮT (kind 'toolsum', không phải 'toolgroup' cụ thể theo tên). Dưới 3 lệnh vẫn từng dòng.
  it('dưới 3 lệnh: từng dòng; từ 3 lệnh chưa xong hoặc khác tên: dòng tóm tắt; cùng tên đã xong: một dòng gộp', () => {
    const two = buildSegments([tool('a', 'web_search'), tool('b', 'web_search')], true, true);
    expect(two[0].kind === 'activity' && two[0].rows.every((r) => r.kind === 'tool')).toBe(true);
    const running = buildSegments(
      [tool('a', 'web_search'), tool('b', 'web_search'), tool('c', 'web_search', 'running')],
      true,
      true,
      true, // turnLive: một khối đang chạy chỉ có nghĩa khi lượt đang chạy (0.6.0); lượt không chạy thì khối 'running' là dữ liệu cũ
    );
    expect(running[0].kind === 'activity' && running[0].rows.some((r) => r.kind === 'toolgroup')).toBe(false);
    const sum = running[0].kind === 'activity' ? running[0].rows[0] : null;
    expect(sum?.kind === 'toolsum' && sum.info.running).toBe(true);
    // 0.6.13: 3 lệnh run_command liền nhau, lượt đã xong → gộp thành «Đã chạy 3 lệnh» (toolgroup), mở ra xem từng lệnh.
    const cmds = buildSegments([tool('a', 'run_command'), tool('b', 'run_command'), tool('c', 'run_command')], true, true);
    const row = cmds[0].kind === 'activity' ? cmds[0].rows : [];
    expect(row.map((r) => r.kind)).toEqual(['toolgroup']);
    expect(row[0].kind === 'toolgroup' && row[0].blocks).toHaveLength(3);
  });

  it('gộp các dòng trạng thái đã xong khi lượt kết thúc', () => {
    const blocks = [pill('p1'), pill('p2'), pill('p3'), pill('p4')];
    const done = buildSegments(blocks, true, true);
    expect(done[0].kind === 'activity' && done[0].rows[0].kind).toBe('pillrun');
    const live = buildSegments([pill('p1'), pill('p2'), pill('p3', true)], false, true);
    expect(live[0].kind === 'activity' && live[0].rows.map((r) => r.kind)).toEqual(['pill', 'pill', 'pill']);
  });

  it('thẻ xin quyền tách thành đoạn riêng', () => {
    const awaiting: ToolBlock = {
      ...tool('c9', 'edit_file', 'awaiting_permission', { path: 'a.ts' }),
      permission: {
        id: 'p',
        callId: 'c9',
        tool: 'edit_file',
        kind: 'edit',
        title: 'Cho phép sửa a.ts?',
        canAllowSession: true,
      },
    };
    const segs = buildSegments([tool('c1', 'read_file'), awaiting, tool('c2', 'read_file')], false, true);
    expect(segs.map((s) => s.kind)).toEqual(['activity', 'permission', 'activity']);
  });

  it('ẩn todo_write/load_skill (đã có khối riêng), hiện khi lỗi', () => {
    const segs = buildSegments([tool('a', 'todo_write'), tool('b', 'load_skill'), tool('c', 'todo_write', 'error')], false, true);
    expect(segs[0].kind === 'activity' && segs[0].rows).toHaveLength(1);
  });

  it('tôn trọng cài đặt ẩn khối suy nghĩ và bỏ khối rỗng', () => {
    const blocks: ABlock[] = [
      { type: 'thinking', id: 'k1', text: 'đang cân nhắc…' },
      { type: 'thinking', id: 'k2', text: '   ' },
    ];
    expect(buildSegments(blocks, true, false)).toHaveLength(0);
    const shown = buildSegments(blocks, true, true);
    expect(shown[0].kind === 'activity' && shown[0].rows).toHaveLength(1);
  });

  it('artifact và notice nằm ngoài chuỗi hoạt động', () => {
    const blocks: ABlock[] = [
      pill('p1'),
      { type: 'artifact', id: 'artifact:a1', artifactId: 'a1', title: 'Bảng', artifactType: 'html', state: 'ready' },
      { type: 'notice', id: 'n1', level: 'error', text: 'Lỗi' },
    ];
    expect(buildSegments(blocks, true, true).map((s) => s.kind)).toEqual(['activity', 'artifact', 'notice']);
  });
});

describe('turnPlainText', () => {
  it('nối các khối văn bản bằng dòng trống', () => {
    expect(turnPlainText({ blocks: [text('a', 'Một'), pill('p'), text('b', ' Hai ')] })).toBe('Một\n\nHai');
  });
});

describe('needsWorkingIndicator', () => {
  it('cần chỉ báo khi chưa có gì hoặc khối cuối đã xong', () => {
    expect(needsWorkingIndicator([])).toBe(true);
    expect(needsWorkingIndicator([tool('a', 'web_search', 'done')])).toBe(true);
  });
  it('luôn có suốt lượt đang chạy — kể cả khi đang nghĩ, đang chạy công cụ hay đang có chỉ báo trạng thái (như Claude Code)', () => {
    expect(needsWorkingIndicator([pill('p', true)])).toBe(true);
    expect(needsWorkingIndicator([tool('a', 'web_search', 'running')])).toBe(true);
    expect(needsWorkingIndicator([{ type: 'thinking', id: 'k', text: 'x' }])).toBe(true);
  });
  it('chỉ ẩn khi đang chờ NGƯỜI DÙNG duyệt quyền (trợ lý không làm gì)', () => {
    expect(needsWorkingIndicator([tool('a', 'edit_file', 'awaiting_permission')])).toBe(false);
  });
});
