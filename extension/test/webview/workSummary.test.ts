import { describe, expect, it } from 'vitest';
import type { ABlock, ToolBlock } from '../../src/shared/protocol';
import { buildSegments, splitWork, workDuration } from '../../webview/src/timeline';

/**
 * (0.6.3) Phản hồi của đồng đội: «mục làm việc không tự ẩn nên phải cuộn rất dài». Lượt ĐÃ XONG giờ gấp cả quá trình (suy nghĩ, công cụ, chữ
 * xen giữa) thành một dòng «Đã làm việc 2 phút 13 giây · 14 thao tác · sửa 3 tệp» — câu trả lời cuối, artifact và lỗi luôn hiện.
 */
const T0 = 1_750_000_000_000;
const tool = (id: string, name = 'read_file', state: ToolBlock['state'] = 'done', extra: Partial<ToolBlock> = {}): ToolBlock => ({
  type: 'tool',
  id,
  name,
  args: { path: `src/${id}.ts`, command: 'npm test' },
  state,
  startedAt: T0 + 1000,
  durationMs: 500,
  ...extra,
});
const text = (id: string, t = 'chữ'): ABlock => ({ type: 'text', id, text: t });
const thinking = (id: string): ABlock => ({ type: 'thinking', id, text: 'đang nghĩ' });
const split = (blocks: ABlock[], endedAt?: number) => splitWork(buildSegments(blocks, true, true), blocks, T0, endedAt);

describe('gấp quá trình làm việc của lượt đã xong', () => {
  it('gấp suy nghĩ + công cụ + chữ xen giữa; câu trả lời cuối nằm ngoài', () => {
    const blocks: ABlock[] = [
      thinking('k1'),
      tool('r1'),
      text('t1', 'Đọc xong, giờ sửa.'),
      tool('e1', 'edit_file', 'done', { diff: { path: 'src/a.ts', hunks: [], added: 3, removed: 1 } as unknown as ToolBlock['diff'] }),
      tool('c1', 'run_command', 'error'),
      text('t2', 'Xong rồi.'),
    ];
    const s = split(blocks)!;
    expect(s).not.toBeNull();
    expect(s.work.map((x) => x.kind)).toEqual(['activity', 'text', 'activity']);
    expect(s.tail.map((x) => (x.kind === 'text' ? x.block.text : x.kind))).toEqual(['Xong rồi.']);
    expect(s.stats).toMatchObject({ calls: 3, edits: 1, failed: 1, steps: 1 });
  });

  it('tệp đã sửa thành công vẫn bày ra dưới dòng tóm tắt (kết quả có diff); quá nhiều thì chỉ còn con số', () => {
    const diff = { diff: { path: 'x', hunks: [], added: 1, removed: 0 } as unknown as ToolBlock['diff'] };
    const s = split([tool('r1'), tool('e1', 'edit_file', 'done', diff), tool('e2', 'edit_file', 'error', diff), text('t')])!;
    expect(s.changes?.kind === 'activity' && s.changes.rows.map((r) => r.key)).toEqual(['e1']);
    const many: ABlock[] = Array.from({ length: 7 }, (_, i) => tool(`w${i}`, 'write_file'));
    const s2 = split([...many, text('t')])!;
    expect(s2.changes).toBeNull();
    expect(s2.stats.edits).toBe(7);
    expect(split([tool('a'), tool('b'), text('t')])!.changes).toBeNull();
  });

  it('artifact, thẻ xin phép và lỗi/cảnh báo giữa chừng KHÔNG bị gấp; thông báo thường thì gấp', () => {
    const blocks: ABlock[] = [
      tool('r1'),
      { type: 'notice', id: 'n1', level: 'info', text: 'Đã nén ngữ cảnh' },
      tool('r2'),
      { type: 'artifact', id: 'art', state: 'ready', artifactId: 'x', title: 'Bảng', artifactType: 'html' } as ABlock,
      { type: 'notice', id: 'n2', level: 'error', text: 'Lệnh lỗi' },
      text('t', 'Kết quả'),
    ];
    const s = split(blocks)!;
    expect(s.kept.map((x) => x.kind)).toEqual(['artifact', 'notice']);
    expect(s.work.some((x) => x.kind === 'notice')).toBe(true);
  });

  it('không gấp khi không có gì đáng gấp', () => {
    // chỉ có chữ
    expect(split([text('a')])).toBeNull();
    // một dòng hoạt động, không có chữ xen giữa
    expect(split([thinking('k'), text('a')])).toBeNull();
    // không có câu trả lời chữ (lượt dừng giữa chừng / chỉ có công cụ): giữ nguyên để thấy chuyện gì đã xảy ra
    expect(split([tool('a'), tool('b'), tool('c')])).toBeNull();
    // câu trả lời đứng đầu, công cụ chạy sau: không giấu câu trả lời
    expect(split([text('a', 'Trả lời'), tool('b'), tool('c')])).toBeNull();
    // chữ – thông báo – chữ (không có dòng hoạt động): không gấp phần đầu câu trả lời
    expect(split([text('a'), { type: 'notice', id: 'n', level: 'info', text: 'đổi model' }, text('b')])).toBeNull();
  });

  it('công cụ chạy SAU câu trả lời cuối vẫn hiện (nằm trong phần đuôi)', () => {
    const s = split([tool('a'), tool('b'), text('t', 'Trả lời'), tool('z')])!;
    expect(s.tail.map((x) => x.kind)).toEqual(['text', 'activity']);
  });

  it('thời gian làm việc: lúc xong nếu có; phiên cũ ước từ lệnh công cụ cuối; dữ liệu vô lý thì bỏ', () => {
    expect(workDuration([], T0, T0 + 133_000)).toBe(133_000);
    expect(workDuration([tool('a', 'x', 'done', { startedAt: T0 + 5000, durationMs: 40_000 })], T0)).toBe(45_000);
    // startedAt = 0 (khối cũ / kịch bản mẫu) → không đoán bừa
    expect(workDuration([tool('a', 'x', 'done', { startedAt: 0, durationMs: 10 })], T0)).toBeUndefined();
    // dưới 1 giây: không hiện
    expect(workDuration([], T0, T0 + 400)).toBeUndefined();
    expect(workDuration([], 0, 5000)).toBeUndefined();
    expect(split([tool('a'), tool('b'), text('t')], T0 + 61_000)!.stats.durationMs).toBe(61_000);
  });
});
