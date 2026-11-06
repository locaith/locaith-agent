/**
 * Cài Bio-Memory-Locaith (Bio-Agent OS kèm MCP) vào một môi trường Python RIÊNG (~/.locaith/bio-memory/venv): không đụng Python hệ thống,
 * không cần git (tải zip từ GitHub). Tìm Python ở những nơi người dùng Windows hay có: `py -3`, PATH, `%LOCALAPPDATA%\Programs\Python`…
 * (trên nhiều máy `python` trên PATH chỉ là lối tắt Microsoft Store nên phải thử chạy thật rồi kiểm tra phiên bản).
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';

export const BIO_ZIP_URL = 'https://github.com/locaith/bio-memory-ai-locaith/archive/refs/heads/main.zip';
export const BIO_SPEC = `bio-agent-os[mcp] @ ${BIO_ZIP_URL}`;

export interface RunResult {
  code: number | null;
  out: string;
}
export interface RunOptions {
  timeoutMs?: number;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
}
export type Runner = (cmd: string, args: string[], o?: RunOptions) => Promise<RunResult>;

export const run: Runner = (cmd, args, o = {}) =>
  new Promise((resolve) => {
    let out = '';
    let buf = '';
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = (() => {
      try {
        return spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        return null;
      }
    })();
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      o.signal?.removeEventListener('abort', kill);
      resolve({ code, out });
    };
    const kill = () => {
      try {
        child?.kill();
      } catch {
        /* đã thoát */
      }
      finish(null);
    };
    if (!child) return finish(null);
    const feed = (d: Buffer) => {
      const s = d.toString('utf8');
      out += s;
      if (!o.onLine) return;
      buf += s;
      let i: number;
      while ((i = buf.search(/\r?\n/)) >= 0) {
        o.onLine(buf.slice(0, i));
        buf = buf.slice(i + (buf[i] === '\r' ? 2 : 1));
      }
    };
    child.stdout?.on('data', feed);
    child.stderr?.on('data', feed);
    child.on('error', () => finish(null)); // không tìm thấy lệnh (ENOENT)…
    child.on('close', (c) => finish(c));
    if (o.timeoutMs) timer = setTimeout(kill, o.timeoutMs);
    o.signal?.addEventListener('abort', kill, { once: true });
  });

export interface PyCandidate {
  cmd: string;
  args: string[];
}
export interface PyFound extends PyCandidate {
  version: string;
}

/** "3.11" / "Python 3.11.9" → [3, 11]; không có số phiên bản (lối tắt Microsoft Store…) → null. */
export function parsePyVersion(out: string): [number, number] | null {
  const m = /(\d+)\.(\d+)/.exec(out);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export function pythonCandidates(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, ls: (dir: string) => string[] = (d) => safeReaddir(d)): PyCandidate[] {
  const out: PyCandidate[] = [];
  if (platform === 'win32') {
    out.push({ cmd: 'py', args: ['-3'] }, { cmd: 'python', args: [] }, { cmd: 'python3', args: [] });
    const roots = [env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'Python') : '', env.ProgramFiles ?? '', 'C:\\'].filter(Boolean);
    // Sắp theo SỐ phiên bản giảm dần (sắp theo chữ sẽ đặt Python39 trước Python311).
    const minor = (n: string): number => Number(/^Python3(\d+)$/i.exec(n)?.[1] ?? 0);
    for (const r of roots) for (const n of ls(r).filter((x) => /^Python3\d+$/i.test(x)).sort((a, b) => minor(b) - minor(a))) out.push({ cmd: path.join(r, n, 'python.exe'), args: [] });
  } else {
    for (const c of ['python3', 'python', '/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3']) out.push({ cmd: c, args: [] });
  }
  return out;
}

function safeReaddir(d: string): string[] {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
}

export async function findPython(runner: Runner = run, candidates: PyCandidate[] = pythonCandidates()): Promise<PyFound | null> {
  for (const c of candidates) {
    const r = await runner(c.cmd, [...c.args, '-c', 'import sys;print("%d.%d" % sys.version_info[:2])'], { timeoutMs: 10_000 });
    const v = r.code === 0 ? parsePyVersion(r.out) : null;
    if (v && (v[0] > 3 || (v[0] === 3 && v[1] >= 10))) return { ...c, version: `${v[0]}.${v[1]}` };
  }
  return null;
}

export function bioPaths(root: string, platform: NodeJS.Platform = process.platform): { venv: string; python: string; exe: string; data: string } {
  const venv = path.join(root, 'venv');
  const bin = platform === 'win32' ? path.join(venv, 'Scripts') : path.join(venv, 'bin');
  return { venv, python: path.join(bin, platform === 'win32' ? 'python.exe' : 'python'), exe: path.join(bin, platform === 'win32' ? 'bio-agent-os.exe' : 'bio-agent-os'), data: path.join(root, 'data') };
}

const tail = (s: string): string => s.trim().slice(-300).replace(/\s+/g, ' ');

export type InstallResult = { ok: true; exe: string } | { ok: false; message: string };

export async function installBio(o: { root: string; log(line: string): void; signal?: AbortSignal; runner?: Runner; python?: PyFound | null; platform?: NodeJS.Platform }): Promise<InstallResult> {
  const r = o.runner ?? run;
  const p = bioPaths(o.root, o.platform);
  const py = o.python === undefined ? await findPython(r) : o.python;
  if (!py) return { ok: false, message: 'Không tìm thấy Python 3.10 trở lên. Hãy cài Python từ python.org (tick "Add python.exe to PATH") rồi thử lại.' };
  o.log(`Dùng Python ${py.version} (${py.cmd})`);
  if (!existsSync(p.python)) {
    o.log('Tạo môi trường Python riêng…');
    const v = await r(py.cmd, [...py.args, '-m', 'venv', p.venv], { timeoutMs: 120_000, onLine: o.log, signal: o.signal });
    if (v.code !== 0) return { ok: false, message: `Không tạo được môi trường Python (mã ${v.code}). ${tail(v.out)}` };
  }
  o.log('Tải và cài Bio-Agent OS (khoảng 30–90 giây)…');
  const i = await r(p.python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', BIO_SPEC], { timeoutMs: 8 * 60_000, onLine: o.log, signal: o.signal });
  if (i.code !== 0) return { ok: false, message: `Cài đặt thất bại (mã ${i.code}). ${tail(i.out)}` };
  const h = await r(p.exe, ['--help'], { timeoutMs: 60_000 });
  if (h.code !== 0) return { ok: false, message: `Đã cài nhưng không chạy được bio-agent-os. ${tail(h.out)}` };
  return { ok: true, exe: p.exe };
}
