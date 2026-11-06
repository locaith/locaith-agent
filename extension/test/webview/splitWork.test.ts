import { describe, expect, it } from 'vitest';
import { splitWork, type Segment } from '../../webview/src/timeline';

/**
 * Bài test cho lỗi thật anh gặp: câu trả lời ĐẦY ĐỦ bị gấp vào «Worked for» vì lượt kết thúc bằng
 * một câu chốt ngắn. `splitWork` cũ cắt ở «đoạn chữ cuối cùng», nên chỉ câu chốt hiện ra.
 */

const text = (id: string, t: string): Segment =>
  ({ kind: 'text', key: id, block: { type: 'text', id, text: t } }) as unknown as Segment;

const act = (id: string): Segment =>
  ({
    kind: 'activity',
    key: id,
    rows: [{ kind: 'tool', key: id, block: { type: 'tool', id, name: 'read_file', args: {}, state: 'done', startedAt: 0 } }],
  }) as unknown as Segment;

const keys = (segs: readonly Segment[]): string[] => segs.map((s) => s.key);
const textOf = (segs: readonly Segment[]): string =>
  segs.map((s) => (s.kind === 'text' ? s.block.text : '')).join('\n');

describe('splitWork — vùng câu trả lời là DÃY chữ cuối lượt', () => {
  it('câu trả lời dài + câu chốt ngắn: CẢ HAI đều hiện, không bị gấp', () => {
    const long = 'Đây là câu trả lời đầy đủ. '.repeat(20);
    const s = splitWork([act('a1'), act('a2'), text('t1', long), text('t2', 'Anh xem giúp em nhé.')]);
    expect(s).not.toBeNull();
    expect(keys(s!.tail)).toEqual(['t1', 't2']); // lỗi cũ: tail = ['t2']
    expect(textOf(s!.tail)).toContain('câu trả lời đầy đủ');
    expect(keys(s!.work)).toEqual(['a1', 'a2']); // chỉ quá trình bị gấp
    expect(s!.work.some((x) => x.kind === 'text')).toBe(false);
  });

  it('BẤT BIẾN: khi có gấp, câu trả lời dài KHÔNG BAO GIỜ nằm trong khối gấp', () => {
    const long = 'Nội dung dài cần đọc. '.repeat(30);
    for (const segs of [
      [act('a1'), text('t1', long), text('t2', 'Chốt.')],
      [act('a1'), act('a2'), text('t1', long), text('t2', 'Chốt.')],
      [act('a1'), text('i', 'đang làm'), act('a2'), text('t1', long), text('t2', 'Chốt.')],
    ]) {
      const s = splitWork(segs);
      if (s) expect(textOf(s.work)).not.toContain('Nội dung dài cần đọc');
    }
  });

  it('chữ xen giữa xen giữa hai lần hoạt động vẫn bị gấp (chỉ dãy cuối hiện)', () => {
    const s = splitWork([act('a1'), text('t1', 'Để em kiểm tra…'), act('a2'), text('t2', 'Xong rồi ạ.')]);
    expect(keys(s!.tail)).toEqual(['t2']);
    expect(keys(s!.work)).toEqual(['a1', 't1', 'a2']);
  });

  it('đoạn chữ RỖNG ở cuối không bị cắt khỏi vùng trả lời', () => {
    const s = splitWork([act('a1'), act('a2'), text('t1', 'Nội dung thật.'), text('t2', '   ')]);
    expect(keys(s!.tail)).toEqual(['t1', 't2']);
    expect(keys(s!.work)).toEqual(['a1', 'a2']);
  });

  it('lượt kết thúc bằng hoạt động (không có chữ cuối) → KHÔNG gấp gì, không giấu nội dung', () => {
    expect(splitWork([text('t1', 'Nội dung gì đó.'), act('a1')])).toBeNull();
  });

  it('lượt chỉ có một đoạn chữ → không gấp', () => {
    expect(splitWork([text('t1', 'Chỉ có câu trả lời.')])).toBeNull();
  });

  it('chỉ có hoạt động, không có chữ → không gấp', () => {
    expect(splitWork([act('a1'), act('a2')])).toBeNull();
  });

  it('nhiều đoạn chữ liền nhau đều là kết quả → tất cả nằm ngoài khối gấp', () => {
    const s = splitWork([act('a1'), act('a2'), text('t1', 'Phần 1.'), text('t2', 'Phần 2.'), text('t3', 'Phần 3.')]);
    expect(keys(s!.tail)).toEqual(['t1', 't2', 't3']);
    expect(keys(s!.work)).toEqual(['a1', 'a2']);
  });
});
