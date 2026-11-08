/**
 * Clipboard: đọc ảnh (Windows qua PowerShell; macOS `pngpaste`; Linux `wl-paste`/`xclip`) và ghi chữ (OSC 52 + công cụ hệ thống).
 * Mọi hàm đều bắt lỗi và có hạn giờ — clipboard hỏng không được làm treo giao diện.
 */

import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Attachment } from '../runtime/contract';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; out: Buffer }> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'buffer' }, (err, stdout) => {
        resolve({ ok: !err, out: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? '')) });
      });
    } catch {
      resolve({ ok: false, out: Buffer.alloc(0) });
    }
  });
}

const PS_IMAGE = '$ErrorActionPreference="Stop";Add-Type -AssemblyName System.Windows.Forms;Add-Type -AssemblyName System.Drawing;$i=[System.Windows.Forms.Clipboard]::GetImage();if($i -ne $null){$m=New-Object System.IO.MemoryStream;$i.Save($m,[System.Drawing.Imaging.ImageFormat]::Png);[Console]::Out.Write([Convert]::ToBase64String($m.ToArray()))}';

/** Ảnh trong clipboard → Attachment (PNG), hoặc null. */
export async function readClipboardImage(platform: NodeJS.Platform = process.platform): Promise<Attachment | null> {
  let png: Buffer | null = null;
  if (platform === 'win32') {
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', PS_IMAGE], 20_000);
    const b64 = r.out.toString('utf8').trim();
    if (r.ok && b64.length > 100) png = Buffer.from(b64, 'base64');
  } else if (platform === 'darwin') {
    const r = await run('pngpaste', ['-'], 5000);
    if (r.ok && r.out.length > 100) png = r.out;
  } else {
    let r = await run('wl-paste', ['--type', 'image/png'], 5000);
    if (!r.ok || r.out.length < 100) r = await run('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], 5000);
    if (r.ok && r.out.length > 100) png = r.out;
  }
  if (!png || png.length > MAX_IMAGE_BYTES || png.subarray(1, 4).toString('latin1') !== 'PNG') return null;
  return { kind: 'image', name: `clipboard-${Date.now().toString(36)}.png`, mediaType: 'image/png', data: png.toString('base64') };
}

const MIME: Record<string, Attachment['mediaType']> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

/** Chữ dán là đường dẫn một ảnh có thật → Attachment. */
export function imageFromPath(text: string, cwd: string): Attachment | null {
  let p = text.trim().replace(/^["']|["']$/g, '');
  if (!p || p.includes('\n')) return null;
  if (p.startsWith('file://')) p = decodeURIComponent(p.replace(/^file:\/\/\/?/, process.platform === 'win32' ? '' : '/'));
  const ext = path.extname(p).toLowerCase();
  const mt = MIME[ext];
  if (!mt) return null;
  try {
    const abs = path.resolve(cwd, p);
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_IMAGE_BYTES) return null;
    return { kind: 'image', name: path.basename(abs), mediaType: mt, data: fs.readFileSync(abs).toString('base64') };
  } catch {
    return null;
  }
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
