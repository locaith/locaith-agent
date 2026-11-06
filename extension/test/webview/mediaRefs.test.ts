import { marked } from 'marked';
import { describe, expect, it } from 'vitest';
import { MAX_MEDIA_REFS, findMediaRefs, looksLikeMediaPath, mediaRefsByBlock, pathsInText } from '../../webview/src/markdown/mediaRefs';

/**
 * (0.6.3) Phản hồi của đồng đội: câu trả lời nói «đã lưu video ở out/demo.mp4 / ảnh động out/loop.gif» nhưng khung chat chỉ hiện chữ —
 * phải mở tệp bằng tay mới xem được. Nay mọi tệp ảnh / GIF / video / âm thanh / tài liệu được nhắc tới hiện xem trước ngay dưới khối nhắc tới.
 * Phía webview chỉ ĐOÁN đường dẫn (tệp này); host kiểm từng đường dẫn trước khi hiện gì (test/mediaPaths.test.ts).
 */
const paths = (md: string) => findMediaRefs(md).map((r) => r.path);

describe('tìm đường dẫn tệp kết quả trong câu trả lời', () => {
  it('đoạn mã, chữ thường, đích liên kết và ảnh Markdown', () => {
    const md = [
      'Video đã dựng xong ở `out/demo.mp4`, bản dọc: out/short.mp4.',
      'Ảnh động: [xem thử](out/loop.gif) và ![bìa](assets/cover.png)',
    ].join('\n\n');
    expect(paths(md)).toEqual(['out/demo.mp4', 'out/short.mp4', 'out/loop.gif', 'assets/cover.png']);
    expect(findMediaRefs(md).map((r) => r.kind)).toEqual(['video', 'video', 'image', 'image']);
  });

  it('đường dẫn Windows có dấu cách khi nằm trọn trong đoạn mã; đường dẫn Git Bash; file://', () => {
    expect(paths('Đã lưu: `C:\\Users\\anh\\Desktop\\Video Locaith\\ban cuoi.mp4`')).toEqual(['C:\\Users\\anh\\Desktop\\Video Locaith\\ban cuoi.mp4']);
    expect(paths('Tệp: /c/locaith/out/a.webm và file:///C:/x/y.png')).toEqual(['/c/locaith/out/a.webm', 'file:///C:/x/y.png']);
  });

  it('âm thanh và tài liệu (HTML, PDF, Word, Excel, PowerPoint) cũng được nhận', () => {
    const refs = findMediaRefs('Nhạc: `out/nhac.mp3` · báo cáo `bao-cao.pdf`, `bang.xlsx`, `slide.pptx`, `thu.docx`, trang `site/index.html`');
    expect(refs.map((r) => `${r.kind}:${r.path}`)).toEqual(['audio:out/nhac.mp3', 'doc:bao-cao.pdf', 'doc:bang.xlsx', 'doc:slide.pptx', 'doc:thu.docx', 'doc:site/index.html']);
  });

  it('KHÔNG lấy trong khối mã, URL, mẫu glob, câu lệnh, tệp mã nguồn', () => {
    const md = [
      'Lệnh:',
      '```bash',
      'ffmpeg -i in.mp4 out/final.mp4',
      '```',
      'Ảnh trên mạng https://example.com/a.png, www.example.com/b.gif, data:image/png;base64,AAAA',
      'Mẫu `*.png`, lệnh `ffmpeg -i a.mp4 b.mp4`, `cp a.png b.png`, mã `src/app.ts`, cờ `-o out.mp4`',
    ].join('\n');
    expect(paths(md)).toEqual([]);
  });

  it('nhãn liên kết không thành tệp thứ hai (chỉ lấy đích)', () => {
    expect(paths('Hình nền: [mandelbrot.jpg](out/mandelbrot.jpg)')).toEqual(['out/mandelbrot.jpg']);
  });

  it('bỏ dấu câu bám quanh, tách «Nhãn:đường-dẫn» nhưng giữ ổ đĩa C:\\', () => {
    expect(pathsInText('(out/a.png), «out/b.gif». Video:out/c.mp4 Ảnh：C:\\x\\d.png')).toEqual(['out/a.png', 'out/b.gif', 'out/c.mp4', 'C:\\x\\d.png']);
  });

  it('mỗi tệp hiện MỘT lần, ở khối nhắc tới nó đầu tiên; tối đa MAX_MEDIA_REFS tệp', () => {
    const tokens = marked.lexer('Xem `out/a.png`.\n\nLại là ./out/a.png và `out/b.mp4`\n\n- out\\a.png\n- `out/c.gif`', { gfm: true });
    const blocks = tokens.filter((t) => t.type !== 'space');
    expect(mediaRefsByBlock(blocks).map((r) => r?.map((x) => x.path) ?? null)).toEqual([['out/a.png'], ['out/b.mp4'], ['out/c.gif']]);

    const many = Array.from({ length: 20 }, (_, i) => `- \`out/anh-${i}.png\``).join('\n');
    expect(findMediaRefs(many)).toHaveLength(MAX_MEDIA_REFS);
  });

  it('bảng: đường dẫn trong từng ô', () => {
    expect(paths('| Tệp | Ghi chú |\n|--|--|\n| `docs/a.pdf` | PDF |\n| out/b.png | ảnh |')).toEqual(['docs/a.pdf', 'out/b.png']);
  });

  it('looksLikeMediaPath: dấu cách chỉ hợp lệ khi chuỗi trông như đường dẫn', () => {
    expect(looksLikeMediaPath('out/my video.mp4', true)).toBe(true);
    expect(looksLikeMediaPath('out/my video.mp4', false)).toBe(false);
    expect(looksLikeMediaPath('my video.mp4', true)).toBe(false);
    expect(looksLikeMediaPath('python make.py && open out/a.png', true)).toBe(false);
    expect(looksLikeMediaPath('.png')).toBe(false);
    expect(looksLikeMediaPath('out/.mp4')).toBe(false);
  });
});
