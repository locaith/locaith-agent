/**
 * THIRD_PARTY_NOTICES.browser.md (được chép vào gói Chrome/Edge thành THIRD_PARTY_NOTICES.md) phải LUÔN khớp với các thư viện và phông THỰC SỰ nằm trong gói.
 *
 * Vì sao có: tệp này sinh từ source map (`npm run notices:browser`) rồi được commit. Nếu ai thêm một thư viện vào bản trình duyệt mà quên sinh lại, gói sẽ phân phối
 * thư viện đó mà không kèm thông báo bản quyền (MIT/Apache/OFL đều đòi giữ) — và không ai thấy, vì không ai mở tệp đó ra so. Test này dựng lại bản dev vào thư mục tạm
 * rồi chạy `gen-notices.mjs --browser --check` (so từng byte với tệp đã commit).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'gen-notices.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-notices-'));
const dev = path.join(tmp, 'dev');
let n = 0;

function run(mapsDir: string, ...extra: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT, '--browser', '--check', `--maps=${mapsDir}`, ...extra], { cwd: ROOT, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
/** Bản sao của bản dev + một thay đổi. */
function mutated(change: (dir: string) => void): string {
  const dir = path.join(tmp, `m${++n}`);
  fs.cpSync(dev, dir, { recursive: true });
  change(dir);
  return dir;
}

beforeAll(() => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'esbuild.browser.mjs'), `--out=${dev}`], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`Không dựng được bản dev: ${r.stdout}${r.stderr}`);
}, 120_000);
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('THIRD_PARTY_NOTICES.browser.md khớp với gói Chrome/Edge thực', () => {
  it('tệp đã commit đúng từng byte với những gì bản dựng hiện tại nhúng', () => {
    const r = run(dev);
    expect(r.out).toContain('khớp với gói thực');
    expect(r.status).toBe(0);
  });

  it('bắt được khi một thư viện bị thêm vào gói mà thông báo chưa có (giả lập: bản dựng có thêm một thư viện)', () => {
    // Giả lập "thêm thư viện" bằng chiều ngược lại: bớt source map của docparse khiến fflate/unpdf/pdf.js biến mất khỏi gói → thông báo đã commit thành LỆCH.
    const dir = mutated((d) => fs.rmSync(path.join(d, 'docparse.js.map')));
    const r = run(dir);
    expect(r.status).toBe(3);
    expect(r.out).toContain('LỆCH');
  });

  it('bắt được phông chữ có trong gói mà thông báo không ghi', () => {
    const dir = mutated((d) => {
      for (const sub of ['assets', 'fonts']) for (const f of fs.readdirSync(path.join(d, sub))) if (f.startsWith('manrope-')) fs.rmSync(path.join(d, sub, f));
    });
    const r = run(dir);
    expect(r.status).toBe(3);
  });

  it('không có source map nào → báo cách chạy, không sinh tệp rỗng', () => {
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty);
    const r = run(empty);
    expect(r.status).toBe(1);
    expect(r.out).toContain('esbuild.browser.mjs');
  });

  it('thông báo nêu logo thương hiệu nhúng trong khung bên (Simple Icons CC0, Lobe Icons MIT)', () => {
    const text = fs.readFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.browser.md'), 'utf8');
    expect(text).toContain('## Brand logos (vector data bundled in the side panel)');
    expect(text).toContain('Simple Icons');
    expect(text).toContain('Lobe Icons');
    // Câu "Market" chỉ đúng với gói VS Code — gói trình duyệt không mang thư mục market/.
    expect(text).not.toContain('market/NOTICE.md');
  });
});
