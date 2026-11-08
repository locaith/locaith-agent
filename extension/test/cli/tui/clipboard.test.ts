import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { WIN_CLIPBOARD_SCRIPT, imageFromPath, readClipboardImageDetailed, type RunResult, type Runner } from '../../../src/cli/tui/clipboard';
import { makePng } from './helpers/png';

const ok = (s: string | Buffer): RunResult => ({ ok: true, out: Buffer.isBuffer(s) ? s : Buffer.from(s), missing: false, detail: '' });
const missing = (): RunResult => ({ ok: false, out: Buffer.alloc(0), missing: true, detail: 'ENOENT' });
const fail = (detail = 'exit 1'): RunResult => ({ ok: false, out: Buffer.alloc(0), missing: false, detail });
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

/** Runner giả: trả kết quả theo tên lệnh, ghi lại mọi lần gọi. */
function fake(map: Record<string, RunResult>): { run: Runner; seen: Array<{ cmd: string; args: string[] }> } {
  const seen: Array<{ cmd: string; args: string[] }> = [];
  return {
    seen,
    run: async (cmd, args) => {
      seen.push({ cmd, args });
      return map[cmd] ?? missing();
    },
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ảnh-thử-')); // có dấu tiếng Việt để thử đường dẫn không phải ASCII
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('readClipboardImageDetailed — Windows (PowerShell giả)', () => {
  const png = makePng(40, 30);

  it('gọi PowerShell STA bằng -EncodedCommand với đúng script; PNG:<base64> → ảnh PNG đính kèm', async () => {
    const f = fake({ 'powershell.exe': ok('PNG:' + png.toString('base64')) });
    const r = await readClipboardImageDetailed('win32', f.run);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.attachment).toMatchObject({ kind: 'image', mediaType: 'image/png' });
    expect(r.attachment.name).toMatch(/^clipboard-[a-z0-9]+\.png$/);
    expect(Buffer.from(r.attachment.data, 'base64').equals(png)).toBe(true);
    const { cmd, args } = f.seen[0];
    expect(cmd).toBe('powershell.exe');
    expect(args).toEqual(expect.arrayContaining(['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand']));
    expect(Buffer.from(args[args.length - 1], 'base64').toString('utf16le')).toBe(WIN_CLIPBOARD_SCRIPT);
  });

  it('JPG:<base64> → ảnh JPEG', async () => {
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
    const r = await readClipboardImageDetailed('win32', fake({ 'powershell.exe': ok('JPG:' + jpg.toString('base64')) }).run);
    expect(r.ok && r.attachment.mediaType).toBe('image/jpeg');
    expect(r.ok && r.attachment.name.endsWith('.jpg')).toBe(true);
  });

  it('NONE → không có ảnh; BIG → quá lớn; ERR:<base64> → lỗi kèm thông báo (kể cả chữ có dấu)', async () => {
    expect(await readClipboardImageDetailed('win32', fake({ 'powershell.exe': ok('NONE') }).run)).toEqual({ ok: false, reason: 'none' });
    expect(await readClipboardImageDetailed('win32', fake({ 'powershell.exe': ok('BIG') }).run)).toEqual({ ok: false, reason: 'too_large' });
    expect(await readClipboardImageDetailed('win32', fake({ 'powershell.exe': ok('ERR:' + b64('Không mở được clipboard')) }).run)).toEqual({ ok: false, reason: 'error', detail: 'Không mở được clipboard' });
  });

  it('FILE:<base64 đường dẫn> (ảnh sao chép trong Explorer) → đọc tệp, kể cả đường dẫn có dấu tiếng Việt', async () => {
    const file = path.join(tmp, 'màn hình.png');
    fs.writeFileSync(file, png);
    const r = await readClipboardImageDetailed('win32', fake({ 'powershell.exe': ok('FILE:' + b64(file)) }).run);
    expect(r.ok && r.attachment.name).toBe('màn hình.png');
    expect(r.ok && Buffer.from(r.attachment.data, 'base64').equals(png)).toBe(true);
    const gone = await readClipboardImageDetailed('win32', fake({ 'powershell.exe': ok('FILE:' + b64(path.join(tmp, 'khong-co.png'))) }).run);
    expect(gone.ok).toBe(false);
    expect(!gone.ok && gone.reason).toBe('error');
  });

  it('không có PowerShell → thiếu công cụ; PowerShell thoát lỗi → lỗi kèm chi tiết; im lặng → lỗi, không phải «không có ảnh»', async () => {
    expect(await readClipboardImageDetailed('win32', fake({}).run)).toEqual({ ok: false, reason: 'no_tool', detail: 'powershell.exe' });
    expect(await readClipboardImageDetailed('win32', fake({ 'powershell.exe': fail('Add-Type bị chặn') }).run)).toEqual({ ok: false, reason: 'error', detail: 'Add-Type bị chặn' });
    const silent = await readClipboardImageDetailed('win32', fake({ 'powershell.exe': ok('') }).run);
    expect(!silent.ok && silent.reason).toBe('error');
  });

  it('dữ liệu không phải ảnh → lỗi; ảnh > 8 MB → quá lớn', async () => {
    const notPng = await readClipboardImageDetailed('win32', fake({ 'powershell.exe': ok('PNG:' + Buffer.alloc(300, 1).toString('base64')) }).run);
    expect(!notPng.ok && notPng.reason).toBe('error');
    const huge = Buffer.concat([png, Buffer.alloc(9 * 1024 * 1024)]);
    const big = await readClipboardImageDetailed('win32', fake({ 'powershell.exe': ok('PNG:' + huge.toString('base64')) }).run);
    expect(!big.ok && big.reason).toBe('too_large');
  });
});

describe('readClipboardImageDetailed — Linux và macOS', () => {
  const png = makePng(40, 30);

  it('Linux: wl-paste có ảnh → dùng luôn, không gọi xclip', async () => {
    const f = fake({ 'wl-paste': ok(png) });
    const r = await readClipboardImageDetailed('linux', f.run);
    expect(r.ok).toBe(true);
    expect(f.seen.map((s) => s.cmd)).toEqual(['wl-paste']);
  });

  it('Linux: thiếu wl-paste thì thử xclip; thiếu cả hai → nói rõ thiếu công cụ nào', async () => {
    const f = fake({ xclip: ok(png) });
    const r = await readClipboardImageDetailed('linux', f.run);
    expect(r.ok).toBe(true);
    expect(f.seen.map((s) => s.cmd)).toEqual(['wl-paste', 'xclip']);
    expect(f.seen[1].args).toEqual(['-selection', 'clipboard', '-t', 'image/png', '-o']);
    const none = await readClipboardImageDetailed('linux', fake({}).run);
    expect(none).toEqual({ ok: false, reason: 'no_tool', detail: 'wl-clipboard (wl-paste) / xclip' });
  });

  it('Linux: công cụ có mà clipboard không có ảnh → «không có ảnh» (không nhầm với thiếu công cụ)', async () => {
    expect(await readClipboardImageDetailed('linux', fake({ 'wl-paste': fail('no image'), xclip: fail('target not available') }).run)).toEqual({ ok: false, reason: 'none' });
    expect(await readClipboardImageDetailed('linux', fake({ xclip: fail('target not available') }).run)).toEqual({ ok: false, reason: 'none' });
  });

  it('macOS: pngpaste — có ảnh, không có ảnh, thiếu công cụ', async () => {
    expect((await readClipboardImageDetailed('darwin', fake({ pngpaste: ok(png) }).run)).ok).toBe(true);
    expect(await readClipboardImageDetailed('darwin', fake({ pngpaste: fail() }).run)).toEqual({ ok: false, reason: 'none' });
    const none = await readClipboardImageDetailed('darwin', fake({}).run);
    expect(!none.ok && none.reason).toBe('no_tool');
    expect(!none.ok && none.detail).toContain('pngpaste');
  });
});

describe('imageFromPath — chữ dán là đường dẫn ảnh', () => {
  const png = makePng(20, 20);
  const file = path.join(tmp, 'a b.png');
  fs.writeFileSync(file, png);
  fs.writeFileSync(path.join(tmp, 'ghi-chu.txt'), 'xin chào');

  it('nhận đường dẫn tuyệt đối, có dấu nháy, tương đối theo cwd', () => {
    expect(imageFromPath(file, 'C:\\khong\\quan\\trong')?.name).toBe('a b.png');
    expect(imageFromPath(`"${file}"`, tmp)?.mediaType).toBe('image/png');
    expect(imageFromPath('a b.png', tmp)?.name).toBe('a b.png');
  });

  it('không nhận: tệp không phải ảnh, tệp không tồn tại, nhiều dòng, chữ thường', () => {
    expect(imageFromPath(path.join(tmp, 'ghi-chu.txt'), tmp)).toBeNull();
    expect(imageFromPath(path.join(tmp, 'khong-co.png'), tmp)).toBeNull();
    expect(imageFromPath(`${file}\n${file}`, tmp)).toBeNull();
    expect(imageFromPath('xin chào', tmp)).toBeNull();
    expect(imageFromPath('', tmp)).toBeNull();
  });
});

const onWindows = process.platform === 'win32' ? it : it.skip;
describe('script PowerShell đọc clipboard', () => {
  it('chỉ gồm ký tự ASCII (đi qua -EncodedCommand nên bảng mã console không làm hỏng)', () => {
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7f]*$/.test(WIN_CLIPBOARD_SCRIPT)).toBe(true);
  });

  onWindows('không có lỗi cú pháp theo bộ phân tích của chính PowerShell (không đụng clipboard)', () => {
    const file = path.join(tmp, 'clip.ps1');
    fs.writeFileSync(file, WIN_CLIPBOARD_SCRIPT, 'utf8');
    const cmd = `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}',[ref]$t,[ref]$e);if($e.Count){$e|ForEach-Object{$_.Message};exit 1}else{'OK'}`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' });
    expect(out.trim()).toBe('OK');
  }, 30_000);
});
