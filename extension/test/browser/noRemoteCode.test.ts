/**
 * Bản trình duyệt (Chrome Web Store) KHÔNG tải mã từ internet; bản VS Code giữ nguyên ba CDN.
 *
 * Chính sách «mã lưu trữ từ xa»: script/style tải từ cdn.jsdelivr.net / cdnjs / unpkg bị coi là mã từ xa. Cờ build `__ND_NO_REMOTE_CODE__` (esbuild.browser.mjs) làm
 * danh sách CDN của lõi rỗng. Ở đây ta bật/tắt cờ bằng `vi.stubGlobal` rồi nạp lại module để chứng minh CẢ HAI bản; bản build thật được kiểm ở verify-browser-package.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { artifactsSkillForBrowser } from '../../scripts/browser-skill-transform.mjs';

const ROOT = path.resolve(__dirname, '..', '..');
const CDN_RE = /cdn\.jsdelivr|cdnjs\.cloudflare|unpkg\.com/;
const HTML_WITH_CDN = '<!doctype html><html><head><script src="https://cdn.jsdelivr.net/npm/chart.js"></script><link rel="stylesheet" href="https://unpkg.com/a.css"></head><body></body></html>';

async function load(noRemote: boolean) {
  vi.resetModules();
  if (noRemote) vi.stubGlobal('__ND_NO_REMOTE_CODE__', true);
  const artifact = await import('../../src/core/tools/artifact');
  const doc = await import('../../src/shared/artifactDoc');
  return { artifact, doc };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('bản VS Code (không có cờ): vẫn cho ba CDN', () => {
  it('danh sách, đặc tả cho model, kiểm tra artifact và CSP khung xem trước', async () => {
    const { artifact, doc } = await load(false);
    expect([...artifact.CDN_ALLOWLIST]).toEqual(['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'unpkg.com']);
    const spec = (await artifact.listArtifactTypesTool.execute({}, {} as never)).content;
    expect(spec).toContain('Script/style ngoài chỉ từ cdn.jsdelivr.net, cdnjs.cloudflare.com, unpkg.com');
    expect(artifact.findBlockedResources(HTML_WITH_CDN)).toEqual([]);
    expect(artifact.findBlockedResources('<script src="https://evil.example/x.js"></script>')).toEqual(['evil.example']);
    expect(artifact.createArtifactTool.validate?.({ title: 't', type: 'html', content: HTML_WITH_CDN }, {} as never)).toBeNull();
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(doc.renderArtifactDocumentWithFonts({ type: 'html', content: HTML_WITH_CDN, title: 't' }, ''))![1];
    expect(csp).toContain("script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com;");
    expect(csp).toContain('font-src data: https://cdn.jsdelivr.net');
  });

  it('kỹ năng artifacts (tệp dùng chung) vẫn nói được tải từ ba CDN', () => {
    const md = fs.readFileSync(path.join(ROOT, 'skills/artifacts/SKILL.md'), 'utf8');
    expect(md).toContain('- Chỉ được tải script/style từ: `cdn.jsdelivr.net`, `cdnjs.cloudflare.com`, `unpkg.com`.');
  });
});

describe('bản trình duyệt (cờ __ND_NO_REMOTE_CODE__): danh sách RỖNG', () => {
  it('đặc tả cho model bảo viết nội tuyến, không nhắc CDN', async () => {
    const { artifact } = await load(true);
    expect(artifact.CDN_ALLOWLIST).toEqual([]);
    const spec = (await artifact.listArtifactTypesTool.execute({}, {} as never)).content;
    expect(spec).toContain('KHÔNG tải script/style từ internet');
    expect(spec).not.toMatch(CDN_RE);
  });

  it('kiểm tra artifact coi mọi tài nguyên ngoài là không hợp lệ (kể cả ba CDN cũ)', async () => {
    const { artifact } = await load(true);
    expect(artifact.findBlockedResources(HTML_WITH_CDN)).toEqual(['cdn.jsdelivr.net', 'unpkg.com']);
    expect(artifact.findBlockedResources('<script src="https://cdnjs.cloudflare.com/x.js"></script>')).toEqual(['cdnjs.cloudflare.com']);
    // nội tuyến vẫn hợp lệ
    expect(artifact.findBlockedResources('<style>a{}</style><script>1</script><link rel="icon" href="data:,">')).toEqual([]);
    const err = artifact.createArtifactTool.validate?.({ title: 't', type: 'html', content: HTML_WITH_CDN }, {} as never);
    expect(err).toMatch(/Không tải được tài nguyên từ: cdn\.jsdelivr\.net, unpkg\.com/);
    expect(err).toContain('viết nội tuyến');
    expect(err).not.toContain('Chỉ được dùng');
    expect(artifact.createArtifactTool.validate?.({ title: 't', type: 'html', content: '<!doctype html><html><body><script>1</script></body></html>' }, {} as never)).toBeNull();
  });

  it('CSP của khung xem trước không còn nguồn ngoài nào', async () => {
    const { doc } = await load(true);
    const out = doc.renderArtifactDocumentWithFonts({ type: 'html', content: '<!doctype html><html><body>x</body></html>', title: 't' }, '');
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(out)![1];
    expect(csp).toContain("script-src 'unsafe-inline';");
    expect(csp).toContain("style-src 'unsafe-inline';");
    expect(csp).toContain('font-src data:;');
    expect(csp).not.toMatch(/https?:/);
  });

  it('kỹ năng artifacts của bản trình duyệt: dòng CDN được thay bằng lời dặn viết nội tuyến, phần còn lại giữ nguyên', () => {
    const md = fs.readFileSync(path.join(ROOT, 'skills/artifacts/SKILL.md'), 'utf8');
    const out = artifactsSkillForBrowser(md);
    expect(out).not.toMatch(CDN_RE);
    expect(out).toContain('- KHÔNG tải script/style từ internet');
    expect(out.split('\n').length).toBe(md.split('\n').length);
    // thiếu / trùng dòng quy tắc thì ném lỗi chứ không im lặng để lọt lời hướng dẫn sai vào gói
    expect(() => artifactsSkillForBrowser('không có dòng nào')).toThrow(/đúng 1 dòng/);
  });

  it('manifest build ra không có tên miền CDN trong CSP sandbox (nguồn esbuild.browser.mjs)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'esbuild.browser.mjs'), 'utf8');
    expect(src).toContain("__ND_NO_REMOTE_CODE__: 'true'");
    const csp = /const SANDBOX_CSP =([\s\S]*?);\n/.exec(src)![1];
    expect(csp).not.toMatch(CDN_RE);
    expect(csp).not.toMatch(/https?:/);
  });
});
