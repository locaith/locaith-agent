import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyOpenTarget, isSensitiveOpenTarget, openCandidates, type OpenProbe } from '../src/core/fsutil/openTarget';
import { parseFileRef } from '../webview/src/text';

/**
 * (0.7.2) Bấm liên kết tệp trong chat → mở được tệp thật kể cả ngoài workspace.
 * Phần phân loại là hàm THUẦN: host dò đĩa rồi đưa kết quả vào, test không đụng đĩa.
 */
const base = path.join(os.tmpdir(), 'nd-open-test');
const ws = path.join(base, 'du-an');
const ws2 = path.join(base, 'du-an-2');
const home = path.join(base, 'home');
const FILE: OpenProbe = { exists: true, isFile: true, isDirectory: false };
const classify = (abs: string, probe: OpenProbe = FILE, real?: string) => classifyOpenTarget({ abs, real, roots: [ws, ws2], probe });

describe('openCandidates', () => {
  it('tương đối → thử lần lượt từng gốc workspace rồi thư mục nhà', () => {
    expect(openCandidates('docs/bản giao.md', [ws, ws2], home)).toEqual([path.join(ws, 'docs', 'bản giao.md'), path.join(ws2, 'docs', 'bản giao.md'), path.join(home, 'docs', 'bản giao.md')]);
  });

  it('~ và ~/ mở rộng về thư mục nhà', () => {
    expect(openCandidates('~/x.md', [ws], home)).toEqual([path.join(home, 'x.md')]);
    expect(openCandidates('~\\Desktop\\ghi chú.md', [ws], home)).toEqual([path.join(home, 'Desktop', 'ghi chú.md')]);
  });

  it('file:// được đổi về đường dẫn thường (kể cả dấu cách mã hoá %20)', () => {
    const abs = path.join(base, 'ngoai', 'a b.md');
    const url = 'file:///' + abs.replace(/\\/g, '/').replace(/^\//, '').replace(/ /g, '%20');
    const got = openCandidates(url, [ws], home);
    expect(got).toHaveLength(1);
    expect(path.basename(got[0])).toBe('a b.md');
  });

  it('tuyệt đối ngoài workspace vẫn là ứng viên (người dùng chủ động bấm)', () => {
    const abs = path.join(base, 'khac', 'x.md');
    expect(openCandidates(abs, [ws], home)).toEqual([abs]);
  });

  it('từ chối: rỗng, URL http, đường dẫn mạng UNC, thiết bị, ký tự điều khiển', () => {
    expect(openCandidates('', [ws], home)).toEqual([]);
    expect(openCandidates('https://x.com/a.md', [ws], home)).toEqual([]);
    expect(openCandidates('\\\\may-la\\chia-se\\a.md', [ws], home)).toEqual([]);
    expect(openCandidates('//may-la/chia-se/a.md', [ws], home)).toEqual([]);
    expect(openCandidates('\\\\?\\C:\\a.md', [ws], home)).toEqual([]);
    expect(openCandidates('a\u0000.md', [ws], home)).toEqual([]);
  });

  it('Git Bash /c/Users/... trên Windows → C:\\Users\\...', () => {
    expect(openCandidates('/c/Users/anh/a.md', [ws], home, 'win32')).toEqual(['C:\\Users\\anh\\a.md']);
  });

  it.runIf(process.platform === 'win32')('Windows: dạng đường dẫn đáng ngờ (luồng dữ liệu thay thế) bị loại', () => {
    expect(openCandidates('C:\\x\\a.md::$DATA', [ws], home, 'win32')).toEqual([]);
  });
});

describe('classifyOpenTarget', () => {
  it('trong workspace → mở trong VS Code, không hỏi', () => {
    expect(classify(path.join(ws, 'docs', 'a.md'))).toEqual({ action: 'open', zone: 'workspace', sensitive: false, confirm: false });
  });

  it('NGOÀI workspace → vẫn mở được (lỗi bạn Huân: «Chỉ mở được tệp trong workspace»)', () => {
    const d = classify(path.join(base, 'ngoai', 'ghi chu.md'));
    expect(d.action).toBe('open');
    expect(d.zone).toBe('outside');
    expect(d.confirm).toBe(false);
  });

  it('nhạy cảm ngoài workspace (.env, khoá riêng, .ssh, credentials) → phải xác nhận', () => {
    for (const f of ['.env', '.env.production', 'id_rsa', 'server.pem', 'credentials', path.join('.ssh', 'config'), path.join('.aws', 'x.txt')]) {
      const d = classify(path.join(base, 'ngoai', f));
      expect(d.sensitive, f).toBe(true);
      expect(d.confirm, f).toBe(true);
      expect(d.action, f).toBe('open');
    }
  });

  it('nhạy cảm TRONG workspace → mở như Explorer, không hỏi thêm', () => {
    const d = classify(path.join(ws, '.env'));
    expect(d).toMatchObject({ sensitive: true, confirm: false, action: 'open', zone: 'workspace' });
  });

  it('tệp mẫu .env.example không tính nhạy cảm', () => {
    expect(classify(path.join(base, 'ngoai', '.env.example')).sensitive).toBe(false);
  });

  it('symlink trong workspace trỏ ra tệp nhạy cảm ngoài → tính theo đường dẫn THẬT', () => {
    const d = classify(path.join(ws, 'link.txt'), FILE, path.join(base, 'ngoai', '.ssh', 'id_ed25519'));
    expect(d.zone).toBe('outside');
    expect(d.confirm).toBe(true);
  });

  it('không tồn tại → missing', () => {
    expect(classify(path.join(ws, 'khong-co.md'), { exists: false, isFile: false, isDirectory: false }).action).toBe('missing');
  });

  it('là thư mục → directory (không mở như tệp)', () => {
    expect(classify(path.join(ws, 'docs'), { exists: true, isFile: false, isDirectory: true }).action).toBe('directory');
  });

  it('nhị phân: chạy được/nén chỉ hiện trong thư mục, tài liệu mở bằng ứng dụng hệ thống, ảnh mở trong VS Code', () => {
    expect(classify(path.join(ws, 'setup.exe')).action).toBe('reveal');
    expect(classify(path.join(ws, 'goi.zip')).action).toBe('reveal');
    expect(classify(path.join(ws, 'bao-cao.pdf')).action).toBe('external');
    expect(classify(path.join(ws, 'bang.xlsx')).action).toBe('external');
    expect(classify(path.join(ws, 'anh.png')).action).toBe('open');
  });

  it('đuôi lạ / không đuôi: có byte NUL ở đầu → nhị phân, không thì văn bản', () => {
    expect(classify(path.join(ws, 'blob'), { ...FILE, head: new Uint8Array([0x7f, 0x45, 0, 0]) }).action).toBe('reveal');
    expect(classify(path.join(ws, 'Makefile'), { ...FILE, head: new TextEncoder().encode('all:\n\techo hi\n') }).action).toBe('open');
  });

  it('thiết bị / socket (không phải tệp thường, không phải thư mục) → missing', () => {
    expect(classify(path.join(ws, 'sock'), { exists: true, isFile: false, isDirectory: false }).action).toBe('missing');
  });
});

describe('isSensitiveOpenTarget', () => {
  it('nhận cả thư mục khoá lẫn tên bí mật', () => {
    expect(isSensitiveOpenTarget('/home/a/.ssh/known_hosts')).toBe(true);
    expect(isSensitiveOpenTarget('C:\\Users\\a\\.aws\\credentials')).toBe(true);
    expect(isSensitiveOpenTarget('/home/a/notes.md')).toBe(false);
  });
});

describe('parseFileRef nhận đường dẫn tuyệt đối và ~', () => {
  it('Windows tuyệt đối có dấu cách + số dòng', () => {
    expect(parseFileRef('C:\\Users\\Anh Tuấn\\Documents\\bản giao.md:12')).toEqual({ path: 'C:\\Users\\Anh Tuấn\\Documents\\bản giao.md', line: 12 });
  });
  it('Windows tuyệt đối không dấu cách', () => {
    expect(parseFileRef('C:\\Users\\anh\\Desktop\\ghi-chu.md')).toEqual({ path: 'C:\\Users\\anh\\Desktop\\ghi-chu.md' });
    expect(parseFileRef('C:/Users/anh/Desktop/ghi-chu.md#L5')).toEqual({ path: 'C:/Users/anh/Desktop/ghi-chu.md', line: 5 });
  });
  it('~/x.md và ~/thư mục/bản giao.md', () => {
    expect(parseFileRef('~/x.md')).toEqual({ path: '~/x.md' });
    expect(parseFileRef('~/tài liệu/bản giao.md:3')).toEqual({ path: '~/tài liệu/bản giao.md', line: 3 });
  });
  it('câu văn không bị biến thành liên kết', () => {
    expect(parseFileRef('xem file này .md')).toBeNull();
  });
});
