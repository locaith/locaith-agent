/**
 * Chuỗi giao diện hiện trên NỀN TẢNG TRÌNH DUYỆT phải nói đúng sự thật về chính bản trình duyệt.
 *
 * Lý do: bản 0.6.27 lên Chrome Web Store nói khoá API nằm «trong kho bí mật của VS Code» — SAI: ở Chrome khoá nằm trong chrome.storage.local của tiện ích, không mã hoá.
 * Chính sách dữ liệu người dùng buộc thông báo đúng. Bản VS Code giữ câu cũ (nó đúng ở đó).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { t, tOpt } from '../../webview/src/i18n';

const ROOT = path.resolve(__dirname, '..', '..');
const src = (f: string): string => fs.readFileSync(path.join(ROOT, f), 'utf8');
const WRONG = /VS Code|secret storage|kho bí mật/i;

describe('khoá API: nói đúng nơi lưu', () => {
  for (const lang of ['vi', 'en'] as const) {
    it(`${lang}: gợi ý trong Cài đặt và màn hình chào của bản trình duyệt`, () => {
      for (const key of ['set.providers.hint.browser', 'welcome.nokey.body.browser'] as const) {
        const s = t(lang, key);
        expect(s, key).not.toMatch(WRONG);
        expect(s, key).toMatch(lang === 'vi' ? /không mã hoá/ : /not encrypted/);
        expect(s, key).toMatch(lang === 'vi' ? /nhà cung cấp bạn chọn/ : /provider you choose/);
      }
    });

    it(`${lang}: bản VS Code giữ câu cũ`, () => {
      expect(t(lang, 'set.providers.hint')).toMatch(/VS Code/);
      expect(t(lang, 'welcome.nokey.body')).toMatch(/VS Code/);
    });
  }

  it('Cài đặt và màn hình chào chọn câu theo nền tảng', () => {
    expect(src('webview/src/components/SettingsView.tsx')).toContain("t(isBrowser ? 'set.providers.hint.browser' : 'set.providers.hint')");
    expect(src('webview/src/components/Welcome.tsx')).toContain("t(isBrowser ? 'welcome.nokey.body.browser' : 'welcome.nokey.body')");
  });
});

describe('mọi chuỗi «.browser» không nhắc VS Code như thể nó là một phần của bản trình duyệt', () => {
  const keys = [...src('webview/src/i18n.ts').matchAll(/^\s*'([\w.]+\.browser(?:\.desc)?)':/gm)].map((m) => m[1]);
  it('có các khoá .browser', () => expect(keys.length).toBeGreaterThan(10));
  for (const lang of ['vi', 'en'] as const) {
    it(`${lang}: không khoá .browser nào chứa «VS Code»`, () => {
      for (const k of new Set(keys)) {
        const v = tOpt(lang, k);
        if (v === undefined) continue;
        // «artifact.browser» / «media.browser» là NHÃN nút («Mở trong trình duyệt»), không phải câu nói về nơi lưu.
        expect(v, `${lang}:${k}`).not.toMatch(/VS Code/);
      }
    });
  }
});

describe('nút chết / câu sai trên nền tảng trình duyệt', () => {
  it('thẻ artifact ẩn nút «Mở trong trình duyệt» (host trình duyệt không xử lý open_artifact_browser; chú thích của nó nhắc VS Code)', () => {
    const card = src('webview/src/components/timeline/ArtifactCard.tsx');
    expect(card).toMatch(/platform !== 'browser' && \(\s*<Button[\s\S]{0,160}open_artifact_browser/);
    expect(src('src/browser/controller.ts')).not.toContain('open_artifact_browser');
  });
});
