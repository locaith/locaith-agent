import { describe, expect, it } from 'vitest';
import { decodeEntities } from '../../webview/src/markdown/entities';
import { prepareStreamingMarkdown } from '../../webview/src/markdown/fence';

describe('prepareStreamingMarkdown (đóng khối mã đang stream)', () => {
  it('không đụng vào văn bản không có hàng rào', () => {
    expect(prepareStreamingMarkdown('Xin chào **thế giới**')).toBe('Xin chào **thế giới**');
  });
  it('giữ nguyên khối mã đã đóng', () => {
    const md = 'a\n```ts\nconst x = 1;\n```\nb';
    expect(prepareStreamingMarkdown(md)).toBe(md);
  });
  it('đóng khối mã còn mở', () => {
    expect(prepareStreamingMarkdown('a\n```ts\nconst x = 1;')).toBe('a\n```ts\nconst x = 1;\n```');
    expect(prepareStreamingMarkdown('a\n```ts\nconst x = 1;\n')).toBe('a\n```ts\nconst x = 1;\n```');
  });
  it('bỏ hàng rào đóng còn thiếu ký tự để không nháy chữ thô', () => {
    expect(prepareStreamingMarkdown('```js\nlet a;\n``')).toBe('```js\nlet a;\n```');
    expect(prepareStreamingMarkdown('```js\nlet a;\n`')).toBe('```js\nlet a;\n```');
  });
  it('hàng rào mở vừa gõ xong (chưa có info) → đóng tạm thành khối rỗng', () => {
    expect(prepareStreamingMarkdown('xem:\n```')).toBe('xem:\n```\n```');
  });
  it('ẩn hàng rào mở còn dở (1–2 backtick một mình trên dòng)', () => {
    expect(prepareStreamingMarkdown('xem:\n``')).toBe('xem:');
    expect(prepareStreamingMarkdown('xem:\n`')).toBe('xem:');
  });
  it('khối dùng 4 backtick chứa ``` bên trong vẫn nhận biết đúng', () => {
    const md = '````md\n```ts\nx\n```\n````';
    expect(prepareStreamingMarkdown(md)).toBe(md);
    // Dòng cuối "```" có thể là đầu của hàng rào đóng 4 backtick đang gõ dở → ẩn tạm rồi đóng khối.
    expect(prepareStreamingMarkdown('````md\n```ts\nx\n```')).toBe('````md\n```ts\nx\n````');
    // Đã xuống dòng thì "```" là nội dung thật của khối ngoài.
    expect(prepareStreamingMarkdown('````md\n```ts\nx\n```\n')).toBe('````md\n```ts\nx\n```\n````');
  });
  it('hỗ trợ hàng rào ~~~', () => {
    expect(prepareStreamingMarkdown('~~~\nabc')).toBe('~~~\nabc\n~~~');
    expect(prepareStreamingMarkdown('~~~\nabc\n~~~')).toBe('~~~\nabc\n~~~');
  });
  it('``` nằm giữa dòng văn bản (code dòng) không phải hàng rào', () => {
    const md = 'dùng ```code``` trong câu';
    expect(prepareStreamingMarkdown(md)).toBe(md);
  });
  it('hàng rào backtick có backtick trong info string không phải khối mã', () => {
    const md = '```a`b';
    expect(prepareStreamingMarkdown(md)).toBe(md);
  });
  it('thụt lề tối đa 3 dấu cách vẫn là hàng rào', () => {
    expect(prepareStreamingMarkdown('   ```\nx')).toBe('   ```\nx\n```');
  });
});

describe('decodeEntities', () => {
  it('giải mã thực thể tên và số', () => {
    expect(decodeEntities('A &amp; B &lt;tag&gt; &quot;q&quot; &copy; 2026')).toBe('A & B <tag> "q" © 2026');
    expect(decodeEntities('&#65;&#x42;&#x1F600;')).toBe('AB😀');
  });
  it('giữ nguyên thực thể lạ hoặc không hợp lệ', () => {
    expect(decodeEntities('&unknownentity; &#0; &#xD800; &')).toBe('&unknownentity; &#0; &#xD800; &');
  });
  it('không đụng vào chữ tiếng Việt', () => {
    const s = 'Nguyễn Thị Thuỷ — ướ ữ ặ ổ ệ';
    expect(decodeEntities(s)).toBe(s);
  });
});
