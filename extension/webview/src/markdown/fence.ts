/**
 * Chuẩn bị Markdown đang được stream: khối mã chưa đóng được đóng tạm để cấu trúc hiển thị ổn định,
 * và các ký tự hàng rào (```) còn dở dang không nhấp nháy thành chữ thô.
 * Thuần túy, không phụ thuộc DOM.
 */

interface OpenFence {
  char: '`' | '~';
  len: number;
}

const OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export function prepareStreamingMarkdown(text: string): string {
  if (!text.includes('`') && !text.includes('~')) return text;

  const lines = text.split('\n');
  let open: OpenFence | null = null;

  for (const line of lines) {
    if (!open) {
      const m = OPEN_RE.exec(line);
      if (m) {
        const marker = m[1];
        const info = m[2];
        // Hàng rào backtick không được có backtick trong info string (khi đó đó là code dòng, không phải khối).
        if (marker[0] === '`' && info.includes('`')) continue;
        open = { char: marker[0] as '`' | '~', len: marker.length };
      }
    } else {
      const trimmed = line.replace(/^ {0,3}/, '').replace(/[ \t]+$/, '');
      if (trimmed.length >= open.len && trimmed.split('').every((c) => c === open!.char)) open = null;
    }
  }

  const lastLine = lines[lines.length - 1];

  if (open) {
    // Dòng cuối là hàng rào đóng còn thiếu ký tự ("`" hoặc "``" khi cần ```): bỏ đi để khỏi nháy chữ thô.
    const t = lastLine.replace(/^ {0,3}/, '');
    let body = text;
    if (t.length > 0 && t.length < open.len && t.split('').every((c) => c === open!.char)) {
      body = lines.slice(0, -1).join('\n');
    }
    const fence = open.char.repeat(open.len);
    return `${body}${body.endsWith('\n') ? '' : '\n'}${fence}`;
  }

  // Ngoài khối: hàng rào mở còn dở ("`" hoặc "``" một mình trên dòng) → ẩn.
  if (/^ {0,3}(`{1,2}|~{1,2})$/.test(lastLine)) return lines.slice(0, -1).join('\n');
  return text;
}
