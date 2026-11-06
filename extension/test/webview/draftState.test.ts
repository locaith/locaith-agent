import { describe, expect, it } from 'vitest';
import type { AttachmentInfo } from '../../src/shared/protocol';
import { persistableAttachments } from '../../webview/src/draftState';

const img = (id: number, chars = 1000): AttachmentInfo => ({ kind: 'image', label: `Ảnh ${id}`, mediaType: 'image/png', data: 'a'.repeat(chars), imgKey: `k${id}` } as AttachmentInfo);
const doc: AttachmentInfo = { kind: 'doc', label: 'báo cáo.pdf', mediaType: 'application/pdf', sizeBytes: 1234 } as AttachmentInfo;

describe('giữ tệp đính kèm qua lần chuyển tab', () => {
  it('giữ NGUYÊN ảnh (có dữ liệu), bản thu nhỏ, tài liệu, vùng chọn — đúng thứ tự người dùng thêm', () => {
    const list = [img(1), doc, { kind: 'selection', label: 'a.ts:1–5', path: 'a.ts', range: [1, 5] } as AttachmentInfo];
    const r = persistableAttachments(list);
    expect(r.dropped).toBe(0);
    expect(r.kept).toEqual(list);
    expect((r.kept[0] as { data?: string }).data?.length).toBe(1000); // ảnh gửi đi được, không chỉ còn nhãn
  });

  it('vượt ngân sách: bỏ tệp CŨ NHẤT, giữ tệp vừa thêm và báo số tệp bị bỏ', () => {
    const list = [img(1, 900_000), img(2, 900_000), img(3, 900_000)];
    const r = persistableAttachments(list, 2_000_000);
    expect(r.dropped).toBe(1);
    expect(r.kept.map((a) => a.label)).toEqual(['Ảnh 2', 'Ảnh 3']);
  });

  it('vừa ngân sách thì giữ hết; danh sách rỗng trả rỗng', () => {
    expect(persistableAttachments([img(1)]).dropped).toBe(0);
    expect(persistableAttachments([])).toEqual({ kept: [], dropped: 0 });
  });
});
