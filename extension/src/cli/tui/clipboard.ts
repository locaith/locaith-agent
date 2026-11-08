/**
 * Clipboard: đọc ảnh (Windows qua PowerShell; macOS `pngpaste`; Linux `wl-paste`/`xclip`) và ghi chữ (OSC 52 + công cụ hệ thống).
 * Mọi hàm đều bắt lỗi và có hạn giờ — clipboard hỏng không được làm treo giao diện.
 *
 * Windows đọc theo thứ tự: định dạng «PNG» (giữ nền trong suốt) → bitmap (ảnh chụp màn hình Win+Shift+S) → tệp ảnh đang được sao chép trong Explorer.
 * Ảnh lớn được thu nhỏ NGAY trong PowerShell: các hãng từ chối ảnh > 5 MB (chuỗi base64), mà ảnh chụp màn hình 4K thường nặng hơn.
 * Kết quả luôn kèm LÝ DO khi thất bại (không có ảnh / quá lớn / thiếu công cụ / lỗi) để giao diện nói đúng điều cần làm.
 */

import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Attachment } from '../runtime/contract';

/** Ảnh tối đa nhận được từ tệp / công cụ ngoài (Linux, macOS). */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Windows: dung lượng tối đa sau khi thu nhỏ. Hãng giới hạn 5 MB cho chuỗi base64 (≈ 3,75 MB nhị phân) — chừa dư. */
const WIN_MAX_BYTES = 3_500_000;
/** Windows: ảnh có cạnh dài hơn mức này luôn bị thu nhỏ (lõi CLI từ chối > 8000 px). */
const WIN_KEEP_EDGE = 8000;
/** Windows: cạnh dài sau khi thu nhỏ. Các hãng tự thu nhỏ ảnh > ~1568 px nên 2000 px không làm mất chi tiết model còn thấy. */
const WIN_SHRINK_EDGE = 2000;

export type ClipboardImageResult =
  | { ok: true; attachment: Attachment }
  | { ok: false; reason: 'none' | 'too_large' | 'no_tool' | 'error'; detail?: string };

export interface RunResult {
  ok: boolean;
  out: Buffer;
  /** Công cụ không tồn tại trên máy (ENOENT). */
  missing: boolean;
  detail: string;
}
export type Runner = (cmd: string, args: string[], timeoutMs: number) => Promise<RunResult>;

const run: Runner = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 48 * 1024 * 1024, windowsHide: true, encoding: 'buffer' }, (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        const errText = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '');
        resolve({
          ok: !e,
          out: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? '')),
          missing: e?.code === 'ENOENT',
          detail: e ? (e.killed ? 'quá thời gian chờ / timed out' : errText.trim().split('\n')[0] || e.message) : '',
        });
      });
    } catch (err) {
      resolve({ ok: false, out: Buffer.alloc(0), missing: false, detail: err instanceof Error ? err.message : String(err) });
    }
  });

/**
 * Script PowerShell đọc ảnh trong clipboard. Chạy bằng `-EncodedCommand` (không dính dấu nháy/thoát ký tự) và `-STA` (Clipboard của WinForms bắt buộc).
 * Xuất ra đúng MỘT dòng ASCII: `PNG:<base64>` | `JPG:<base64>` | `FILE:<base64 UTF-8 của đường dẫn>` | `ERR:<base64 UTF-8 của thông báo>` | `NONE` | `BIG`
 * (đường dẫn/thông báo qua base64 vì bảng mã của console Windows không phải UTF-8: tên tệp tiếng Việt sẽ hỏng nếu in thẳng).
 */
export const WIN_CLIPBOARD_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$MAXB = ${WIN_MAX_BYTES}
$KEEPEDGE = ${WIN_KEEP_EDGE}
$SHRINK = ${WIN_SHRINK_EDGE}
function Say([string]$kind, [byte[]]$b) { [Console]::Out.Write($kind + ':' + [Convert]::ToBase64String($b)) }
function SayText([string]$kind, [string]$s) { Say $kind ([System.Text.Encoding]::UTF8.GetBytes($s)) }
function Get-Png($img) { $m = New-Object System.IO.MemoryStream; $img.Save($m, [System.Drawing.Imaging.ImageFormat]::Png); return ,$m.ToArray() }
function Get-Jpg($img) {
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
  $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
  $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]85)
  $m = New-Object System.IO.MemoryStream
  $img.Save($m, $codec, $ep)
  return ,$m.ToArray()
}
function Get-Scaled($img, [int]$edge) {
  $long = [Math]::Max($img.Width, $img.Height)
  if ($long -le $edge) { return $img }
  $k = $edge / $long
  $w = [Math]::Max(1, [int][Math]::Round($img.Width * $k))
  $h = [Math]::Max(1, [int][Math]::Round($img.Height * $k))
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($img, 0, 0, $w, $h)
  $g.Dispose()
  return $bmp
}
function Send-Image($img, $raw) {
  $long = [Math]::Max($img.Width, $img.Height)
  if ($raw -ne $null) {
    if ($raw.Length -le $MAXB -and $long -le $KEEPEDGE) { Say 'PNG' $raw; return }
  } else {
    $png0 = Get-Png $img
    if ($png0.Length -le $MAXB -and $long -le $KEEPEDGE) { Say 'PNG' $png0; return }
  }
  $s = Get-Scaled $img $SHRINK
  $png = Get-Png $s
  if ($png.Length -le $MAXB) { Say 'PNG' $png; return }
  $jpg = Get-Jpg $s
  if ($jpg.Length -le $MAXB) { Say 'JPG' $jpg; return }
  $jpg2 = Get-Jpg (Get-Scaled $img 1280)
  if ($jpg2.Length -le $MAXB) { Say 'JPG' $jpg2; return }
  [Console]::Out.Write('BIG')
}
try {
  $d = [System.Windows.Forms.Clipboard]::GetDataObject()
  if ($d -eq $null) { [Console]::Out.Write('NONE'); exit 0 }
  if ($d.GetDataPresent('PNG')) {
    $st = $d.GetData('PNG')
    if ($st -is [System.IO.MemoryStream]) {
      $raw = $st.ToArray()
      $img = [System.Drawing.Image]::FromStream((New-Object System.IO.MemoryStream(,$raw)))
      Send-Image $img $raw
      exit 0
    }
  }
  if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
    $img = [System.Windows.Forms.Clipboard]::GetImage()
    if ($img -ne $null) { Send-Image $img $null; exit 0 }
  }
  if ($d.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop)) {
    foreach ($f in $d.GetData([System.Windows.Forms.DataFormats]::FileDrop)) {
      if ($f -match '\.(png|jpe?g|gif|bmp|webp)$') {
        $big = ((Get-Item -LiteralPath $f).Length -gt $MAXB)
        if (($f -match '\.(png|jpe?g|gif|bmp)$') -and ($big -or ($f -match '\.bmp$'))) { Send-Image ([System.Drawing.Image]::FromFile($f)) $null; exit 0 }
        SayText 'FILE' $f
        exit 0
      }
    }
  }
  [Console]::Out.Write('NONE')
} catch {
  SayText 'ERR' $_.Exception.Message
}
`;

const MIME: Record<string, Attachment['mediaType']> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

function stamp(): string {
  return Date.now().toString(36);
}

/** Byte ảnh (PNG hoặc JPEG) → Attachment, sau khi kiểm chữ ký và dung lượng. */
function asAttachment(buf: Buffer, ext: 'png' | 'jpg'): ClipboardImageResult {
  const okSig = ext === 'png' ? buf.length > 8 && buf.subarray(1, 4).toString('latin1') === 'PNG' : buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8;
  if (!okSig) return { ok: false, reason: 'error', detail: 'dữ liệu clipboard không phải ảnh PNG/JPEG hợp lệ' };
  if (buf.length > MAX_IMAGE_BYTES) return { ok: false, reason: 'too_large', detail: `${(buf.length / 1048576).toFixed(1)} MB` };
  return { ok: true, attachment: { kind: 'image', name: `clipboard-${stamp()}.${ext}`, mediaType: ext === 'png' ? 'image/png' : 'image/jpeg', data: buf.toString('base64') } };
}

/** Tệp ảnh có thật (từ clipboard Explorer hoặc chữ dán) → Attachment, với lý do thất bại rõ ràng. */
function fromFile(p: string, cwd: string): ClipboardImageResult {
  try {
    const abs = path.resolve(cwd, p);
    const mt = MIME[path.extname(abs).toLowerCase()];
    const st = fs.statSync(abs);
    if (!st.isFile() || !mt) return { ok: false, reason: 'none' };
    if (st.size > MAX_IMAGE_BYTES) return { ok: false, reason: 'too_large', detail: `${(st.size / 1048576).toFixed(1)} MB` };
    return { ok: true, attachment: { kind: 'image', name: path.basename(abs), mediaType: mt, data: fs.readFileSync(abs).toString('base64') } };
  } catch (err) {
    return { ok: false, reason: 'error', detail: err instanceof Error ? err.message : String(err) };
  }
}

function parseWindows(out: Buffer, cwd: string): ClipboardImageResult {
  const s = out.toString('utf8').replace(/^\uFEFF/, '').trim();
  const img = /^(PNG|JPG):([A-Za-z0-9+/=]+)$/.exec(s);
  if (img) return asAttachment(Buffer.from(img[2], 'base64'), img[1] === 'JPG' ? 'jpg' : 'png');
  if (s === 'NONE') return { ok: false, reason: 'none' };
  if (s === 'BIG') return { ok: false, reason: 'too_large' };
  const text = /^(FILE|ERR):([A-Za-z0-9+/=]*)$/.exec(s);
  if (text) {
    const value = Buffer.from(text[2], 'base64').toString('utf8');
    return text[1] === 'FILE' ? fromFile(value, cwd) : { ok: false, reason: 'error', detail: value.slice(0, 200) };
  }
  return { ok: false, reason: 'error', detail: s ? s.slice(0, 160) : 'PowerShell không trả về dữ liệu' };
}

/** Ảnh trong clipboard → Attachment, hoặc lý do không lấy được. `runner` để kiểm thử. */
export async function readClipboardImageDetailed(platform: NodeJS.Platform = process.platform, runner: Runner = run, cwd: string = process.cwd()): Promise<ClipboardImageResult> {
  let png: Buffer;
  if (platform === 'win32') {
    const encoded = Buffer.from(WIN_CLIPBOARD_SCRIPT, 'utf16le').toString('base64');
    const r = await runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded], 25_000);
    if (r.missing) return { ok: false, reason: 'no_tool', detail: 'powershell.exe' };
    if (!r.ok) return { ok: false, reason: 'error', detail: r.detail };
    return parseWindows(r.out, cwd);
  }
  if (platform === 'darwin') {
    const r = await runner('pngpaste', ['-'], 5000);
    if (r.missing) return { ok: false, reason: 'no_tool', detail: 'pngpaste (brew install pngpaste)' };
    if (!r.ok || r.out.length < 100) return { ok: false, reason: 'none' };
    png = r.out;
  } else {
    const a = await runner('wl-paste', ['--type', 'image/png'], 5000);
    if (a.ok && a.out.length >= 100) png = a.out;
    else {
      const b = await runner('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], 5000);
      if (b.ok && b.out.length >= 100) png = b.out;
      else if (a.missing && b.missing) return { ok: false, reason: 'no_tool', detail: 'wl-clipboard (wl-paste) / xclip' };
      else return { ok: false, reason: 'none' };
    }
  }
  return asAttachment(png, 'png');
}

/** Ảnh trong clipboard → Attachment (PNG/JPEG), hoặc null. */
export async function readClipboardImage(platform: NodeJS.Platform = process.platform): Promise<Attachment | null> {
  const r = await readClipboardImageDetailed(platform);
  return r.ok ? r.attachment : null;
}

/** Chữ dán là đường dẫn một ảnh có thật → Attachment. */
export function imageFromPath(text: string, cwd: string): Attachment | null {
  let p = text.trim().replace(/^["']|["']$/g, '');
  if (!p || p.includes('\n')) return null;
  if (p.startsWith('file://')) p = decodeURIComponent(p.replace(/^file:\/\/\/?/, process.platform === 'win32' ? '' : '/'));
  if (!MIME[path.extname(p).toLowerCase()]) return null;
  const r = fromFile(p, cwd);
  return r.ok ? r.attachment : null;
}

/** Ghi chữ vào clipboard: OSC 52 (qua terminal) + công cụ hệ thống. Trả true nếu có đường nào chạy được. */
export function copyToClipboard(text: string, write: (s: string) => void, platform: NodeJS.Platform = process.platform): boolean {
  let ok = false;
  try {
    write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`);
    ok = true;
  } catch {
    /* bỏ qua */
  }
  const cmd = platform === 'win32' ? ['clip.exe', []] : platform === 'darwin' ? ['pbcopy', []] : ['xclip', ['-selection', 'clipboard']];
  try {
    const child = spawn(cmd[0] as string, cmd[1] as string[], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    child.on('error', () => undefined);
    // clip.exe đọc UTF-16LE
    child.stdin.on('error', () => undefined);
    child.stdin.end(platform === 'win32' ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]) : text);
    ok = true;
  } catch {
    /* bỏ qua */
  }
  return ok;
}
