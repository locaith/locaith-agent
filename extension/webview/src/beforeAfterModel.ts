/** Mô hình hiển thị của thẻ «Trước | Sau» (lane:customer-bugs) — thuần tuý, test được. */

export interface BeforeAfterModel {
  before: string;
  after: string;
  labelBefore?: string;
  labelAfter?: string;
  caption?: string;
}

const text = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return s || undefined;
};

/** Đọc đối số của công cụ (đã được lưu cùng phiên) thành mô hình hiển thị; thiếu đường dẫn → null. */
export function beforeAfterModel(args: Record<string, unknown> | undefined): BeforeAfterModel | null {
  const a = args ?? {};
  const before = text(a.before, 1000);
  const after = text(a.after, 1000);
  if (!before || !after) return null;
  return { before, after, labelBefore: text(a.label_before, 40), labelAfter: text(a.label_after, 40), caption: text(a.caption, 200) };
}
