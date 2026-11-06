/**
 * Trích chữ từ PDF bằng `unpdf` (bản pdf.js đóng gói sẵn để chạy ở mọi nơi không cần Worker): dùng được trong host Node của VS Code lẫn trang
 * của tiện ích trình duyệt. Chỉ trích chữ (lớp chữ có sẵn trong PDF); PDF quét thành ảnh thì không có chữ để trích.
 * Tách riêng khỏi docExtract.ts để bản trình duyệt chỉ nạp nó khi người dùng thật sự tải PDF lên.
 */

import { getDocumentProxy } from 'unpdf';

export interface PdfPages {
  pages: string[];
  totalPages: number;
}

export class PdfError extends Error {
  constructor(
    readonly code: 'encrypted' | 'corrupt',
    message: string,
  ) {
    super(message);
  }
}

export async function pdfToPages(bytes: Uint8Array, opts: { maxPages: number; maxChars: number }): Promise<PdfPages> {
  let pdf;
  try {
    // pdf.js nhận quyền sở hữu bộ nhớ của mảng → đưa bản sao để mảng gốc của người gọi không bị rút ruột. `new Uint8Array(…)` (không phải `.slice()`): host Node
    // trả `Buffer` (lớp con của Uint8Array) mà pdf.js từ chối, bản sao này luôn là Uint8Array thuần.
    pdf = await getDocumentProxy(new Uint8Array(bytes), { isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 } as never);
  } catch (err) {
    const name = (err as { name?: string })?.name ?? '';
    if (name === 'PasswordException') throw new PdfError('encrypted', 'PDF có mật khẩu — chưa hỗ trợ.');
    throw new PdfError('corrupt', `Không đọc được PDF (${err instanceof Error ? err.message : String(err)}).`);
  }
  try {
    const pages: string[] = [];
    let chars = 0;
    const last = Math.min(pdf.numPages, opts.maxPages);
    for (let i = 1; i <= last; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if ('str' in item) text += item.str + (item.hasEOL ? '\n' : '');
      }
      pages.push(text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim());
      chars += text.length;
      page.cleanup();
      if (chars > opts.maxChars * 1.5) break; // đã đủ cho ngân sách: khỏi đọc nốt các trang sau
    }
    return { pages, totalPages: pdf.numPages };
  } catch (err) {
    const name = (err as { name?: string })?.name ?? '';
    if (name === 'PasswordException') throw new PdfError('encrypted', 'PDF có mật khẩu — chưa hỗ trợ.');
    throw new PdfError('corrupt', `Không đọc được PDF (${err instanceof Error ? err.message : String(err)}).`);
  } finally {
    await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.().catch(() => undefined);
  }
}
