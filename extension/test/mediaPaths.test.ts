import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mediaCandidates, mediaKindOf, viaLink } from '../src/core/fsutil/mediaPaths';
import { parseCommand } from '../src/core/remote/protocol';

describe('thiết bị Remote không dò được tệp trên máy', () => {
  it('resolve_media / open_media không nằm trong danh sách lệnh từ xa', () => {
    expect(parseCommand({ type: 'resolve_media', key: 'k', paths: ['C:/Users/anh/a.png'] }, { canBypass: false })).toEqual({ ok: false, error: 'unknown_command' });
    expect(parseCommand({ type: 'open_media', path: 'C:/Users/anh/a.png', how: 'external' }, { canBypass: false })).toEqual({ ok: false, error: 'unknown_command' });
  });
});

/**
 * (0.6.3) Host kiểm đường dẫn tệp xem trước TRƯỚC khi đụng đĩa. Đường dẫn do model viết là đầu vào không đáng tin: chỉ đuôi tệp xem trước
 * được, chỉ trong vùng (workspace, thư mục người dùng, thư mục tạm), không bao giờ ổ mạng (stat một đường dẫn UNC là Windows đã gửi
 * thông tin đăng nhập NTLM tới máy đó).
 */
const WIN = process.platform === 'win32';
const base = path.join(os.tmpdir(), 'nd-media-test');
const ws = path.join(base, 'du-an');
const ws2 = path.join(base, 'du-an-2');
const home = path.join(base, 'home');
const tmp = path.join(base, 'tmp');
const zones = { workspaceRoots: [ws, ws2], home, tmp };

describe('mediaCandidates', () => {
  it('đường dẫn tương đối → thử lần lượt từng thư mục workspace', () => {
    expect(mediaCandidates('out/demo.mp4', zones)).toEqual([path.join(ws, 'out', 'demo.mp4'), path.join(ws2, 'out', 'demo.mp4')]);
    expect(mediaCandidates('./out/a.png', zones)[0]).toBe(path.join(ws, 'out', 'a.png'));
  });

  it('tuyệt đối trong vùng (thư mục người dùng, thư mục tạm) được; ngoài vùng thì không đụng tới', () => {
    expect(mediaCandidates(path.join(home, 'Desktop', 'a b.png'), zones)).toEqual([path.join(home, 'Desktop', 'a b.png')]);
    expect(mediaCandidates(path.join(tmp, 'x.gif'), zones)).toEqual([path.join(tmp, 'x.gif')]);
    expect(mediaCandidates(path.join(base, 'khac', 'x.png'), zones)).toEqual([]);
    expect(mediaCandidates(WIN ? 'E:\\may-quay\\clip.mp4' : '/mnt/may-quay/clip.mp4', zones)).toEqual([]);
  });

  it('`..` thoát khỏi workspace bị chặn', () => {
    expect(mediaCandidates('../../../khac/a.png', zones)).toEqual([]);
  });

  it('ổ mạng / thiết bị / URL / ký tự điều khiển bị từ chối', () => {
    for (const bad of ['\\\\may-chu\\chia-se\\a.png', '//may-chu/chia-se/a.png', '\\\\?\\C:\\a.png', '\\\\.\\pipe\\a.png', 'https://example.com/a.png', 'data:image/png;base64,AAAA', 'vscode-resource:/a.png', 'out/a\u0000.png', 'javascript:alert(1)//a.png']) {
      expect(mediaCandidates(bad, zones), bad).toEqual([]);
    }
  });

  it('chỉ đuôi tệp xem trước được — không bao giờ mã nguồn, .env, tệp chạy', () => {
    for (const bad of ['src/app.ts', '.env', 'tools/run.exe', 'a.png.exe', 'README.md']) expect(mediaCandidates(bad, zones), bad).toEqual([]);
    expect(mediaKindOf('A.PNG')).toBe('image');
    expect(mediaKindOf('clip.MOV')).toBe('video');
    expect(mediaKindOf('nhac.flac')).toBe('audio');
    expect(mediaKindOf('bao-cao.pdf')).toBe('doc');
  });

  it('~/, file://, dấu cách bị mã hoá', () => {
    expect(mediaCandidates('~/Desktop/a.png', zones)).toEqual([path.join(home, 'Desktop', 'a.png')]);
    const fileUrl = new URL(`file:///${path.join(tmp, 'b.png').replace(/\\/g, '/').replace(/^\//, '')}`).href;
    expect(mediaCandidates(fileUrl, zones)).toEqual([path.join(tmp, 'b.png')]);
    expect(mediaCandidates('out/my%20video.mp4', zones)).toContain(path.join(ws, 'out', 'my video.mp4'));
  });

  it('viaLink: tệp thật trong thư mục thật → false; đi qua thư mục là liên kết (junction / symlink) → true; ngoài vùng → true', async () => {
    const real = path.join(ws, 'that');
    const other = path.join(base, 'ngoai-vung');
    fs.rmSync(base, { recursive: true, force: true });
    fs.mkdirSync(real, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(real, 'a.png'), 'x');
    fs.writeFileSync(path.join(other, 'b.png'), 'x');
    // junction (Windows, không cần quyền quản trị) / symlink thư mục (nơi khác)
    fs.symlinkSync(other, path.join(ws, 'lien-ket'), WIN ? 'junction' : 'dir');
    try {
      expect(await viaLink(path.join(real, 'a.png'), zones)).toBe(false);
      expect(await viaLink(path.join(ws, 'lien-ket', 'b.png'), zones)).toBe(true);
      expect(await viaLink(path.join(other, 'b.png'), zones)).toBe(true);
      expect(await viaLink(path.join(real, 'khong-co.png'), zones)).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it.runIf(WIN)('Windows: dạng Git Bash /c/… và luồng dữ liệu thay thế NTFS', () => {
    const drive = ws.slice(0, 1).toLowerCase();
    const bash = `/${drive}/${ws.slice(3).replace(/\\/g, '/')}/out/a.png`;
    expect(mediaCandidates(bash, zones, 'win32')).toEqual([path.join(ws, 'out', 'a.png')]);
    expect(mediaCandidates('out/a.png:bi-mat', zones)).toEqual([]);
    expect(mediaCandidates('out/a.png.', zones)).toEqual([]);
  });
});
