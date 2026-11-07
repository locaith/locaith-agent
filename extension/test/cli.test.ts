import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';

/**
 * Kiểm CLI đã đóng gói: chạy đúng tệp người dùng sẽ chạy (dist-cli/locaith.cjs dựng trong thư mục tạm),
 * nên bắt cả lỗi đóng gói lẫn lỗi tham số — không cần khoá thật, không gọi mạng.
 */
const root = path.resolve(__dirname, '..');
let dir = '';
let bin = '';

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nd-cli-test-'));
  bin = path.join(dir, 'locaith.cjs');
  await build({
    entryPoints: [path.join(root, 'src/cli/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    loader: { '.md': 'text' },
    outfile: bin,
    logLevel: 'silent',
  });
}, 120_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Chạy CLI với môi trường sạch (không khoá, không tệp cấu hình của máy). */
function run(args: string[], env: Record<string, string | undefined> = {}) {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === 'LOCAITH_API_KEY' || k === 'LOCAITH_TOKEN') continue; // không để khoá của máy lọt vào bài test
    clean[k] = v;
  }
  clean.HOME = dir; // ~/.locaith/cli.json không tồn tại → kiểm đúng nhánh "chưa có khoá"
  clean.USERPROFILE = dir;
  Object.assign(clean, env);
  const r = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: clean, timeout: 60_000 });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

describe('Locaith CLI — tham số và lệnh', () => {
  it('--version in phiên bản POC', () => {
    const r = run(['--version']);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('--help nêu các lệnh và tuỳ chọn chính, kèm cảnh báo không truyền khoá qua dòng lệnh', () => {
    const r = run(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('locaith doctor');
    expect(r.out).toContain('locaith ask');
    expect(r.out).toContain('--allow');
    expect(r.out).toContain('LOCAITH_API_KEY');
    expect(r.out).toContain('Không truyền khoá qua dòng lệnh');
  });

  it('tuỳ chọn lạ bị từ chối với mã thoát 2 (không im lặng bỏ qua)', () => {
    const r = run(['ask', '--khong-co', 'x']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('Không biết tuỳ chọn --khong-co');
  });

  it('--allow chỉ nhận none | reads | all', () => {
    expect(run(['ask', 'x', '--allow', 'lung-tung']).code).toBe(2);
    expect(run(['ask', 'x', '--allow', 'all']).err).not.toContain('--allow phải là');
  });

  it('ask thiếu nội dung → mã thoát 2 kèm hướng dẫn', () => {
    const r = run(['ask']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('Thiếu nội dung');
  });

  it('doctor không có khoá → JSON có mục khoá ✘, không lộ khoá, các mục máy vẫn được kiểm', () => {
    const r = run(['doctor', '--json']);
    expect(r.code).toBe(1);
    const j = JSON.parse(r.out);
    expect(j.ok).toBe(false);
    const byName = Object.fromEntries(j.checks.map((c: { name: string; ok: boolean; detail: string }) => [c.name, c]));
    expect(byName['Khoá Locaith'].ok).toBe(false);
    expect(byName['Khoá Locaith'].detail).toContain('chưa có');
    expect(byName['Node.js'].ok).toBe(true);
    expect(byName['Đĩa trống']).toBeTruthy();
    expect(r.out).not.toMatch(/lat_[A-Za-z0-9]{6,}/); // không in khoá
  });

  it('doctor dạng người đọc có dấu ✔/✘ và câu kết luận', () => {
    const r = run(['doctor']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^✔ Node\.js/m);
    expect(r.out).toContain('Còn mục ✘');
  });
});
