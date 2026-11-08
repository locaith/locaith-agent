/**
 * Kiểm tra bản mới của `locaith-cli` trên PyPI (hạn giờ ngắn, nhớ kết quả 6 giờ ở `~/.locaith/update-check.json`) và `locaith update`.
 * Không bao giờ chặn khởi động: lỗi mạng = im lặng.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { homeDir } from './credentials';

const PYPI_URL = 'https://pypi.org/pypi/locaith-cli/json';
const TTL_MS = 6 * 60 * 60 * 1000;

interface Cache {
  checkedAt: number;
  latest: string;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export async function fetchLatest(fetchFn: typeof fetch = fetch, timeoutMs = 2500): Promise<string | undefined> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchFn(PYPI_URL, { signal: ctl.signal, headers: { accept: 'application/json' } });
      if (!res.ok) return undefined;
      const j = (await res.json()) as { info?: { version?: string } };
      return typeof j.info?.version === 'string' ? j.info.version : undefined;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return undefined;
  }
}

function cacheFile(env: NodeJS.ProcessEnv): string {
  return path.join(homeDir(env), '.locaith', 'update-check.json');
}

/** Bản mới nhất đã biết (từ cache, hoặc hỏi PyPI nếu cache cũ hơn 6 giờ / `force`). */
export async function latestKnown(env: NodeJS.ProcessEnv = process.env, opts: { force?: boolean; fetchFn?: typeof fetch; now?: number } = {}): Promise<string | undefined> {
  const now = opts.now ?? Date.now();
  if (!opts.force) {
    try {
      const c = JSON.parse(readFileSync(cacheFile(env), 'utf8')) as Cache;
      if (typeof c.latest === 'string' && now - c.checkedAt < TTL_MS) return c.latest;
    } catch {
      /* chưa có cache */
    }
  }
  const latest = await fetchLatest(opts.fetchFn);
  if (latest) {
    try {
      mkdirSync(path.dirname(cacheFile(env)), { recursive: true });
      writeFileSync(cacheFile(env), JSON.stringify({ checkedAt: now, latest } satisfies Cache));
    } catch {
      /* không ghi được cache thì thôi */
    }
  }
  return latest;
}

export async function updateAvailable(current: string, env: NodeJS.ProcessEnv = process.env, opts: { force?: boolean; fetchFn?: typeof fetch } = {}): Promise<{ latest?: string; newer: boolean }> {
  const latest = await latestKnown(env, opts);
  return { latest, newer: !!latest && compareVersions(current, latest) < 0 };
}

/** `locaith update`: gọi pip của CHÍNH Python đã cài gói (launcher đặt LOCAITH_PYTHON). Trả mã thoát. */
export function runUpdate(env: NodeJS.ProcessEnv, log: (l: string) => void, spawn: typeof spawnSync = spawnSync): number {
  const py = (env.LOCAITH_PYTHON ?? '').trim();
  if (!py) {
    log('Không biết Python nào đã cài gói này. Chạy tay: pip install -U locaith-cli');
    return 1;
  }
  log(`→ ${py} -m pip install -U locaith-cli`);
  const r = spawn(py, ['-m', 'pip', 'install', '-U', 'locaith-cli'], { stdio: 'inherit' });
  return r.status ?? 1;
}
