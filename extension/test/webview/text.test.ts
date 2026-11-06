import { describe, expect, it } from 'vitest';
import {
  basename,
  dirname,
  filterByQuery,
  fuzzyScore,
  hostOf,
  mentionAtCaret,
  normalizeVi,
  parseFileRef,
  parseSlashCommand,
  relativizeUri,
  slashAtCaret,
  truncate,
} from '../../webview/src/text';

describe('normalizeVi', () => {
  it('bỏ dấu và hạ chữ thường', () => {
    expect(normalizeVi('Tài liệu Đặng Thị Thuỷ')).toBe('tai lieu dang thi thuy');
  });
  it('xử lý chữ đ/Đ không phân rã được', () => {
    expect(normalizeVi('ĐỒNG đồng')).toBe('dong dong');
  });
  it('giống nhau với NFC và NFD', () => {
    const nfc = 'Việt Nam ướ ữ ặ ổ ệ';
    const nfd = nfc.normalize('NFD');
    expect(normalizeVi(nfc)).toBe(normalizeVi(nfd));
    expect(normalizeVi(nfc)).toBe('viet nam uo u a o e');
  });
  it('giữ nguyên chữ không dấu và ký tự đặc biệt', () => {
    expect(normalizeVi('src/App.tsx')).toBe('src/app.tsx');
  });
});

describe('fuzzyScore / filterByQuery', () => {
  it('khớp không phân biệt dấu', () => {
    expect(fuzzyScore('tai lieu', 'Tài liệu dự án')).not.toBeNull();
    expect(fuzzyScore('TÀI LIỆU', 'tai lieu du an')).not.toBeNull();
  });
  it('không khớp → null', () => {
    expect(fuzzyScore('xyz', 'Tài liệu')).toBeNull();
  });
  it('ưu tiên khớp đầu chuỗi hơn khớp giữa chuỗi', () => {
    const items = ['bản dịch model', 'model chính', 'khác'];
    const out = filterByQuery(items, 'model', (x) => x);
    expect(out[0]).toBe('model chính');
    expect(out).toHaveLength(2);
  });
  it('query rỗng → giữ nguyên thứ tự', () => {
    const items = ['b', 'a', 'c'];
    expect(filterByQuery(items, '  ', (x) => x)).toEqual(['b', 'a', 'c']);
  });
  it('nhiều từ: tất cả phải khớp', () => {
    expect(fuzzyScore('claude son', 'Claude Sonnet 5.5')).not.toBeNull();
    expect(fuzzyScore('claude haiku', 'Claude Sonnet 5.5')).toBeNull();
  });
  it('khớp dãy con khi gõ tắt', () => {
    expect(fuzzyScore('mdl', 'model')).not.toBeNull();
  });
  it('lọc theo nhiều trường', () => {
    const items = [{ label: 'Opus', id: 'claude-opus-5-5' }, { label: 'Luna', id: 'gpt-6-luna' }];
    const out = filterByQuery(items, 'gpt', (m) => [m.label, m.id]);
    expect(out.map((m) => m.label)).toEqual(['Luna']);
  });
});

describe('đường dẫn & URL', () => {
  it('basename/dirname chấp nhận cả / và \\', () => {
    expect(basename('src/utils/tệp tin.ts')).toBe('tệp tin.ts');
    expect(basename('C:\\Users\\nguye\\a.txt')).toBe('a.txt');
    expect(dirname('src/utils/a.ts')).toBe('src/utils');
    expect(dirname('a.ts')).toBe('');
  });
  it('hostOf bỏ www và đường dẫn', () => {
    expect(hostOf('https://www.artificialanalysis.ai/leaderboards/models')).toBe('artificialanalysis.ai');
    expect(hostOf('không phải url')).toBe('không phải url');
  });
  it('truncate thêm dấu …', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 4)).toBe('abc');
  });
});

describe('parseFileRef', () => {
  it('nhận đường dẫn tệp và số dòng', () => {
    expect(parseFileRef('src/app.ts')).toEqual({ path: 'src/app.ts' });
    expect(parseFileRef('src/app.ts:42')).toEqual({ path: 'src/app.ts', line: 42 });
    expect(parseFileRef('src/app.ts:42:7')).toEqual({ path: 'src/app.ts', line: 42 });
    expect(parseFileRef('README.md#L10-L20')).toEqual({ path: 'README.md', line: 10 });
    expect(parseFileRef('./webview/src/App.tsx')).toEqual({ path: './webview/src/App.tsx' });
  });
  it('nhận tên tệp có dấu tiếng Việt', () => {
    expect(parseFileRef('tài-liệu/báo-cáo.md')).toEqual({ path: 'tài-liệu/báo-cáo.md' });
  });
  it('từ chối thứ không phải đường dẫn tệp', () => {
    expect(parseFileRef('https://example.com/a.ts')).toBeNull();
    expect(parseFileRef('1.2.3')).toBeNull();
    expect(parseFileRef('npm install')).toBeNull();
    expect(parseFileRef('console.log')).toBeNull();
    expect(parseFileRef('')).toBeNull();
  });
});

describe('trigger @ và /', () => {
  it('mentionAtCaret: @ ở đầu từ', () => {
    expect(mentionAtCaret('xem @src/ap', 11)).toEqual({ start: 4, end: 11, query: 'src/ap' });
    expect(mentionAtCaret('@a', 2)).toEqual({ start: 0, end: 2, query: 'a' });
  });
  it('mentionAtCaret: kéo end tới hết từ khi con trỏ ở giữa', () => {
    expect(mentionAtCaret('xem @src/app.ts nhé', 8)).toEqual({ start: 4, end: 15, query: 'src' });
  });
  it('mentionAtCaret: @ giữa từ (email) không phải mention', () => {
    expect(mentionAtCaret('gửi a@b.com', 11)).toBeNull();
    expect(mentionAtCaret('không có', 3)).toBeNull();
  });
  it('slashAtCaret: chỉ khi còn trong từ đầu tiên', () => {
    expect(slashAtCaret('/mo', 3)).toEqual({ query: 'mo' });
    expect(slashAtCaret('  /new', 6)).toEqual({ query: 'new' });
    expect(slashAtCaret('/model gpt', 10)).toBeNull();
    expect(slashAtCaret('xin chào /new', 13)).toBeNull();
    expect(slashAtCaret('/', 1)).toEqual({ query: '' });
  });
  it('parseSlashCommand chỉ nhận lệnh đã biết', () => {
    const known = [{ name: 'new' }, { name: '/model' }];
    expect(parseSlashCommand('/new', known)).toEqual({ command: 'new', args: '' });
    expect(parseSlashCommand('/MODEL  gpt-6-astra ', known)).toEqual({ command: 'model', args: 'gpt-6-astra' });
    expect(parseSlashCommand('/usr/bin/env', known)).toBeNull();
    expect(parseSlashCommand('/khong-co', known)).toBeNull();
    expect(parseSlashCommand('xin chào', known)).toBeNull();
  });
});

describe('relativizeUri', () => {
  const folders = ['c:\\Users\\nguye\\Desktop\\Extension NamDigital'];
  it('đổi URI file:// của VS Code thành đường dẫn tương đối', () => {
    expect(relativizeUri('file:///c%3A/Users/nguye/Desktop/Extension%20NamDigital/src/a.ts', folders)).toBe('src/a.ts');
  });
  it('nhận đường dẫn tuyệt đối kiểu Windows', () => {
    expect(relativizeUri('C:\\Users\\nguye\\Desktop\\Extension NamDigital\\webview\\x.tsx', folders)).toBe('webview/x.tsx');
  });
  it('ngoài workspace → null', () => {
    expect(relativizeUri('file:///d%3A/khac/a.ts', folders)).toBeNull();
  });
});
