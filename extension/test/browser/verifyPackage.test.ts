/**
 * Chốt chặn tổng của gói Chrome / Edge (scripts/verify-browser-package.mjs).
 *
 * 1) Dựng THẬT bản phát hành (`esbuild.browser.mjs --production --out=<tạm>`) rồi kiểm → phải đạt.
 * 2) Mỗi bài học của sự cố 0.6.27 (biểu tượng «N», mô tả có tên hãng, CDN, quyền thừa, chuỗi «kho bí mật của VS Code», thiếu thông báo đồng ý…) được đưa vào MỘT BẢN SAO của
 *    gói; bộ kiểm phải ném lỗi nêu đúng mục đó. Nếu bộ kiểm im lặng cho qua thì test này đỏ — chính là lỗi "không ai kiểm TRONG gói" lần trước.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readBundledString, verifyBrowserPackage } from '../../scripts/verify-browser-package.mjs';

const ROOT = path.resolve(__dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-verify-'));
const good = path.join(tmp, 'release');
const testBuild = path.join(tmp, 'testbuild');
let n = 0;

function build(args: string[], out: string): void {
  execFileSync(process.execPath, [path.join(ROOT, 'esbuild.browser.mjs'), ...args, `--out=${out}`], { cwd: ROOT, stdio: 'pipe' });
}
/** Bản sao của gói tốt + một thay đổi → thư mục mới. */
function mutated(change: (dir: string) => void): string {
  const dir = path.join(tmp, `m${++n}`);
  fs.cpSync(good, dir, { recursive: true });
  change(dir);
  return dir;
}
const edit = (dir: string, file: string, fn: (s: string) => string): void => {
  const p = path.join(dir, file);
  const before = fs.readFileSync(p, 'utf8');
  const after = fn(before);
  if (after === before) throw new Error(`test hỏng: thay đổi không có tác dụng trên ${file}`);
  fs.writeFileSync(p, after);
};
const editManifest = (dir: string, fn: (m: Record<string, any>) => void): void => {
  const p = path.join(dir, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  fn(m);
  fs.writeFileSync(p, JSON.stringify(m, null, 2));
};
const messages = (dir: string, loc: string, fn: (m: Record<string, any>) => void): void => {
  const p = path.join(dir, '_locales', loc, 'messages.json');
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  fn(m);
  fs.writeFileSync(p, JSON.stringify(m, null, 2));
};

beforeAll(() => {
  build(['--production'], good);
  build(['--test'], testBuild);
}, 120_000);
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('đánh giá một chạm: điểm gửi và thông báo đồng ý phải khớp nhau', () => {
  it('gói thật có máy chủ gửi đánh giá trong host_permissions và thông báo đồng ý nhắc tới việc chấm sao', () => {
    const { passed } = verifyBrowserPackage(good, { root: ROOT });
    expect(passed).toContain('host_permissions có https://studio-api.locaith.com/* (điểm gửi đánh giá một chạm)');
    expect(passed).toContain('thông báo đồng ý nói việc chấm sao được gửi tới Locaith');
  });

  it('thiếu host_permissions của máy chủ nhận đánh giá → bị chặn (nếu không mọi lần chạm sao đều lỗi CORS âm thầm)', () => {
    const dir = mutated((d) => editManifest(d, (m) => void (m.host_permissions = (m.host_permissions as string[]).filter((h) => !h.includes('studio-api.locaith.com')))));
    expect(() => verifyBrowserPackage(dir, { root: ROOT })).toThrow(/host_permissions có https:\/\/studio-api\.locaith\.com\/\*/);
  });

  it('thông báo đồng ý không còn nhắc việc gửi sao về Locaith → bị chặn', () => {
    const dir = mutated((d) => edit(d, 'store-consent.js', (s) => s.replace(/If YOU tap a star[^']*/, '').replace(/Nếu BẠN tự chạm một ngôi sao[^']*/, '')));
    expect(() => verifyBrowserPackage(dir, { root: ROOT })).toThrow(/thông báo đồng ý nói việc chấm sao/);
  });
});

describe('gói phát hành dựng thật', () => {
  it('đạt toàn bộ bộ kiểm', () => {
    const { passed } = verifyBrowserPackage(good, { root: ROOT });
    expect(passed.length).toBeGreaterThan(50);
    expect(passed).toContain('biểu tượng 128px là logo Lo');
    expect(passed).toContain('sidepanel.html nạp store-consent.js TRƯỚC panel.js');
  });

  it('CLI: thư mục đạt → mã thoát 0; thư mục hỏng → mã thoát 1 và in lý do', () => {
    const script = path.join(ROOT, 'scripts', 'verify-browser-package.mjs');
    const out = execFileSync(process.execPath, [script, good], { encoding: 'utf8' });
    expect(out).toMatch(/Gói đạt: \d+ mục kiểm/);
    const bad = mutated((d) => messages(d, 'en', (m) => (m.extDescription.message = 'Works with Claude, ChatGPT or Gemini.')));
    let code = 0;
    let err = '';
    try {
      execFileSync(process.execPath, [script, bad], { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      const x = e as { status: number; stderr: string };
      code = x.status;
      err = x.stderr;
    }
    expect(code).toBe(1);
    expect(err).toContain('KHÔNG đạt chuẩn cửa hàng');
    expect(err).toContain('mô tả ngắn (en) không chứa tên hãng');
  });

  it('manifest.version của bản dựng khớp package.json', () => {
    const m = JSON.parse(fs.readFileSync(path.join(good, 'manifest.json'), 'utf8'));
    expect(m.version).toBe(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version.replace(/-.*$/, ''));
  });

  it('chuỗi khoá API của bản trình duyệt đọc ra được từ panel.js và nói đúng sự thật', () => {
    const panel = fs.readFileSync(path.join(good, 'panel.js'), 'utf8');
    const hint = readBundledString(panel, 'set.providers.hint.browser');
    expect(hint).toMatch(/kho riêng của tiện ích trên máy này \(không mã hoá\)/);
    expect(hint).not.toMatch(/VS Code|kho bí mật/);
    // bản VS Code vẫn nằm trong cùng bundle (dùng chung giao diện) — bộ kiểm chỉ đòi bản .browser
    expect(readBundledString(panel, 'set.providers.hint')).toMatch(/VS Code/);
  });
});

describe('bộ kiểm BẮT được từng lỗi của sự cố 0.6.27', () => {
  const rejects = (dir: string, pattern: RegExp | string) => {
    expect(() => verifyBrowserPackage(dir, { root: ROOT })).toThrow(pattern);
  };

  it('biểu tượng sai (chữ «N» của dự án cũ): bất kỳ cỡ nào lệch băm logo Lo', () => {
    rejects(
      mutated((d) => {
        const p = path.join(d, 'icons', '128.png');
        const b = fs.readFileSync(p);
        b[b.length - 20] ^= 0xff; // ảnh khác
        fs.writeFileSync(p, b);
      }),
      /biểu tượng 128px là logo Lo — icons\/128\.png không phải logo Lo/,
    );
    rejects(mutated((d) => fs.rmSync(path.join(d, 'icons', '16.png'))), /biểu tượng 16px là logo Lo — thiếu icons\/16\.png/);
  });

  it('mô tả / tên có tên hãng (Yellow Argon), ở bất kỳ ngôn ngữ nào; vượt giới hạn độ dài', () => {
    rejects(mutated((d) => messages(d, 'vi', (m) => (m.extDescription.message = 'Trợ lý AI. Dùng Claude, ChatGPT, Gemini hoặc API riêng.'))), /mô tả ngắn \(vi\) không chứa tên hãng/);
    rejects(mutated((d) => messages(d, 'en', (m) => (m.extDescription.message = 'Works with OpenAI and DeepSeek.'))), /mô tả ngắn \(en\) không chứa tên hãng/);
    rejects(mutated((d) => messages(d, 'en', (m) => (m.extName.message = 'Gemini helper'))), /tên \(en\) không chứa tên hãng/);
    rejects(mutated((d) => messages(d, 'en', (m) => (m.extDescription.message = 'a'.repeat(133)))), /mô tả ngắn \(en\) ≤ 132/);
    rejects(mutated((d) => messages(d, 'vi', (m) => (m.extName.message = 'a'.repeat(76)))), /tên \(vi\) ≤ 75/);
  });

  it('CDN trong CSP sandbox, hoặc ở bất kỳ tệp mã nào của gói', () => {
    rejects(mutated((d) => editManifest(d, (m) => (m.content_security_policy.sandbox += '; script-src https://cdn.jsdelivr.net'))), /CSP sandbox không có tên miền CDN/);
    rejects(mutated((d) => editManifest(d, (m) => (m.content_security_policy.sandbox = m.content_security_policy.sandbox.replace("font-src data:", 'font-src data: https://fonts.example')))), /CSP sandbox không cho nguồn http\(s\) nào/);
    rejects(mutated((d) => edit(d, 'artifact.js', (s) => s + '\n;"https://unpkg.com/x.js";')), /không tệp nào trong gói nhắc tên miền CDN .*artifact\.js/);
    rejects(mutated((d) => edit(d, 'artifact-sandbox.html', (s) => s.replace('</body>', '<script src="https://evil.example/x.js"></script></body>'))), /HTML không tham chiếu tài nguyên http\(s\)/);
  });

  it('quyền «tabs», và quyền khai báo mà mã không dùng', () => {
    rejects(mutated((d) => editManifest(d, (m) => m.optional_permissions.push('tabs'))), /không khai báo quyền «tabs»/);
    rejects(mutated((d) => editManifest(d, (m) => m.permissions.push('history'))), /quyền «history» có chỗ dùng trong mã/);
  });

  it('chuỗi khoá API lại nói «kho bí mật của VS Code» (hoặc mất chuỗi riêng của bản trình duyệt)', () => {
    rejects(mutated((d) => edit(d, 'panel.js', (s) => s.split('"set.providers.hint.browser"').join('"set.providers.hint.removed"'))), /panel\.js có chuỗi set\.providers\.hint\.browser/);
    rejects(
      mutated((d) => edit(d, 'panel.js', (s) => s.replace(/("set\.providers\.hint\.browser":")[^"]*"/, '$1Khóa API được lưu trong kho bí mật của VS Code (không mã ho\\xE1)"'))),
      /set\.providers\.hint\.browser không nói khoá nằm trong kho bí mật của VS Code/,
    );
  });

  it('thiếu thông báo dữ liệu + đồng ý trong sản phẩm', () => {
    rejects(mutated((d) => edit(d, 'sidepanel.html', (s) => s.replace('<script src="store-consent.js"></script>\n', ''))), /sidepanel\.html nạp store-consent\.js TRƯỚC panel\.js/);
    rejects(mutated((d) => edit(d, 'sidepanel.html', (s) => s.replace('<script src="store-consent.js"></script>\n<script src="panel.js"></script>', '<script src="panel.js"></script>\n<script src="store-consent.js"></script>'))), /TRƯỚC panel\.js/);
    rejects(mutated((d) => fs.rmSync(path.join(d, 'store-consent.js'))), /có store-consent\.js/);
    rejects(mutated((d) => fs.rmSync(path.join(d, 'store-consent-sw.js'))), /có store-consent-sw\.js/);
    rejects(mutated((d) => edit(d, 'store-consent.js', (s) => s.replace(/const PRIVACY_URL = '[^']*'/, "const PRIVACY_URL = '__PRIVACY_URL__'"))), /URL chính sách quyền riêng tư thật/);
    rejects(mutated((d) => edit(d, 'background.js', (s) => s.replace('store-consent-sw.js', 'khac.js'))), /dịch vụ nền nạp store-consent-sw\.js/);
    rejects(mutated((d) => edit(d, 'store-consent-sw.js', (s) => s.replace('nd.consent.v1', 'nd.consent.v2'))), /cùng khoá đồng ý/);
  });

  it('móc kiểm thử, bản TEST, phiên bản lệch package.json', () => {
    rejects(mutated((d) => fs.writeFileSync(path.join(d, 'testHooks.js'), '')), /không có tệp móc kiểm thử/);
    rejects(mutated((d) => edit(d, 'panel.js', (s) => s + '\n;globalThis.__ndTest=1;')), /panel\.js không chứa móc kiểm thử/);
    rejects(mutated((d) => editManifest(d, (m) => (m.version = '0.0.1'))), /manifest\.version khớp package\.json/);
    rejects(testBuild, /không phải bản TEST/);
  });

  it('gói không có manifest → lỗi rõ ràng', () => {
    expect(() => verifyBrowserPackage(tmp, { root: ROOT })).toThrow(/Không thấy manifest\.json/);
  });

  it('báo MỌI mục hỏng cùng lúc, không dừng ở mục đầu', () => {
    const dir = mutated((d) => {
      messages(d, 'en', (m) => (m.extDescription.message = 'Claude'));
      editManifest(d, (m) => m.optional_permissions.push('tabs'));
      fs.rmSync(path.join(d, 'store-consent.js'));
    });
    let msg = '';
    try {
      verifyBrowserPackage(dir, { root: ROOT });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/mô tả ngắn \(en\) không chứa tên hãng/);
    expect(msg).toMatch(/quyền «tabs»/);
    expect(msg).toMatch(/có store-consent\.js/);
  });
});

describe('bản --test (e2e) tự bỏ qua cổng đồng ý', () => {
  it('không có tệp, không có thẻ nạp lớp phủ trong sidepanel.html, nên e2e không kẹt sau lớp phủ', () => {
    expect(fs.existsSync(path.join(testBuild, 'store-consent.js'))).toBe(false);
    expect(fs.existsSync(path.join(testBuild, 'store-consent-sw.js'))).toBe(false);
    expect(fs.readFileSync(path.join(testBuild, 'sidepanel.html'), 'utf8')).not.toContain('store-consent');
    expect(JSON.parse(fs.readFileSync(path.join(testBuild, 'manifest.json'), 'utf8')).name).toContain('TEST');
  });

  it('bản phát hành thì ngược lại: có đủ hai tệp và thẻ nạp', () => {
    expect(fs.existsSync(path.join(good, 'store-consent.js'))).toBe(true);
    expect(fs.existsSync(path.join(good, 'store-consent-sw.js'))).toBe(true);
    expect(fs.readFileSync(path.join(good, 'sidepanel.html'), 'utf8')).toContain('<script src="store-consent.js"></script>');
    expect(fs.readFileSync(path.join(good, 'store-consent.js'), 'utf8')).toContain('https://www.locaith.ai/chinh-sach-quyen-rieng-tu-chrome/');
  });

  it('background của bản TEST không nạp cổng (cờ __ND_TEST__ = true)', () => {
    const bg = fs.readFileSync(path.join(testBuild, 'background.js'), 'utf8');
    expect(bg).toMatch(/if \(true\) \{|if \(!true\)|if \(false\)/); // đã gập hằng số; nhánh importScripts là mã chết
    expect(bg).toContain('if (false) {');
  });
});
