import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareVersions, fetchLatest, latestKnown, runUpdate, updateAvailable } from '../../src/cli/update';

const dirs: string[] = [];
function env(): NodeJS.ProcessEnv {
  const d = mkdtempSync(path.join(os.tmpdir(), 'locaith-upd-'));
  dirs.push(d);
  return { LOCAITH_HOME: d };
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const okFetch = (v: string): typeof fetch => (async () => new Response(JSON.stringify({ info: { version: v } }), { status: 200 })) as unknown as typeof fetch;

describe('compareVersions', () => {
  it('so sánh theo số, không theo chuỗi', () => {
    expect(compareVersions('0.4.0', '0.10.0')).toBe(-1);
    expect(compareVersions('0.4.0', '0.4.0')).toBe(0);
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1);
    expect(compareVersions('0.4', '0.4.0')).toBe(0);
  });
});

describe('kiểm tra bản mới', () => {
  it('đọc từ PyPI rồi nhớ 6 giờ', async () => {
    const e = env();
    const f = vi.fn(okFetch('0.5.0'));
    expect(await latestKnown(e, { fetchFn: f, now: 1_000 })).toBe('0.5.0');
    expect(await latestKnown(e, { fetchFn: f, now: 1_000 + 60_000 })).toBe('0.5.0');
    expect(f).toHaveBeenCalledTimes(1);
    expect(await latestKnown(e, { fetchFn: f, now: 1_000 + 7 * 3_600_000 })).toBe('0.5.0');
    expect(f).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(path.join(e.LOCAITH_HOME!, '.locaith', 'update-check.json'), 'utf8')).latest).toBe('0.5.0');
  });

  it('force bỏ qua cache; lỗi mạng im lặng', async () => {
    const e = env();
    await latestKnown(e, { fetchFn: okFetch('0.5.0'), now: 5 });
    expect(await latestKnown(e, { fetchFn: okFetch('0.6.0'), now: 6, force: true })).toBe('0.6.0');
    const boom = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await fetchLatest(boom)).toBeUndefined();
    const e2 = env();
    expect(await latestKnown(e2, { fetchFn: boom })).toBeUndefined();
  });

  it('updateAvailable chỉ báo khi bản kia cao hơn', async () => {
    const e = env();
    const u1 = await updateAvailable('0.4.0', e, { fetchFn: okFetch('0.4.1'), force: true });
    expect(u1).toEqual({ latest: '0.4.1', newer: true });
    const u2 = await updateAvailable('0.4.1', e, { fetchFn: okFetch('0.4.1'), force: true });
    expect(u2.newer).toBe(false);
  });
});

describe('locaith update', () => {
  it('gọi pip của Python đã cài gói', () => {
    const calls: unknown[][] = [];
    const spawn = ((cmd: string, args: string[]) => {
      calls.push([cmd, args]);
      return { status: 0 };
    }) as never;
    const lines: string[] = [];
    expect(runUpdate({ LOCAITH_PYTHON: 'C:\\Py\\python.exe' }, (l) => lines.push(l), spawn)).toBe(0);
    expect(calls[0]).toEqual(['C:\\Py\\python.exe', ['-m', 'pip', 'install', '-U', 'locaith-cli']]);
  });

  it('không biết Python nào → chỉ cách chạy tay, mã 1', () => {
    const lines: string[] = [];
    expect(runUpdate({}, (l) => lines.push(l))).toBe(1);
    expect(lines.join('\n')).toContain('pip install -U locaith-cli');
  });
});
