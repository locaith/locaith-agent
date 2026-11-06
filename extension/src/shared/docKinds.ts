/**
 * Các loại tệp có thể tải lên để trợ lý đọc (ngoài ảnh). Tệp nhỏ gọn này không kéo theo mã đọc tệp nên giao diện (webview) dùng được trực tiếp;
 * mã đọc thật nằm ở docExtract.ts (chạy ở host / trang lazy-load, không nằm trong giao diện).
 */

export type DocKind = 'pdf' | 'docx' | 'xlsx' | 'html' | 'csv' | 'txt';

export const DOC_KINDS: readonly DocKind[] = ['pdf', 'docx', 'xlsx', 'html', 'csv', 'txt'];

/** Đuôi tệp → loại. Word/Excel đời mới (OOXML) và các tệp văn bản thuần phổ biến. */
export const DOC_EXTENSIONS: Readonly<Record<string, DocKind>> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.docm': 'docx',
  '.xlsx': 'xlsx',
  '.xlsm': 'xlsx',
  '.html': 'html',
  '.htm': 'html',
  '.xhtml': 'html',
  '.csv': 'csv',
  '.tsv': 'csv',
  '.txt': 'txt',
  '.md': 'txt',
  '.markdown': 'txt',
  '.json': 'txt',
  '.xml': 'txt',
  '.log': 'txt',
  '.yaml': 'txt',
  '.yml': 'txt',
  '.ini': 'txt',
};

/** Định dạng Office đời cũ (nhị phân): không đọc được — báo rõ để người dùng "Lưu thành" định dạng mới. */
export const LEGACY_EXTENSIONS: ReadonlySet<string> = new Set(['.doc', '.xls', '.ppt', '.rtf']);

/** Giá trị cho thuộc tính `accept` của ô chọn tệp. */
export const DOC_ACCEPT = Object.keys(DOC_EXTENSIONS).join(',');

/** Dung lượng tối đa một tệp tải lên. */
export const MAX_DOC_BYTES = 25 * 1024 * 1024;
/** Số tệp tối đa mỗi tin nhắn. */
export const MAX_DOCS_PER_MESSAGE = 5;

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase();
}

export function docKindOf(name: string): DocKind | null {
  return DOC_EXTENSIONS[extOf(name)] ?? null;
}

export function isLegacyOffice(name: string): boolean {
  return LEGACY_EXTENSIONS.has(extOf(name));
}

/** Ngân sách ký tự cho phần chữ trích từ tệp, theo cửa sổ ngữ cảnh của model (khoảng 40% cửa sổ, ~3 ký tự/token), kẹp trong [60k, 300k]. */
export function docCharBudget(contextTokens: number | undefined): number {
  const t = typeof contextTokens === 'number' && contextTokens > 0 ? contextTokens : 200_000;
  return Math.min(300_000, Math.max(60_000, Math.floor(t * 1.2)));
}
