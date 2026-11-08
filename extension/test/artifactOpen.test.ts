import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { autoOpenTarget, normalizeHtmlOpenIn, primaryArtifactTarget } from '../src/shared/artifactOpen';
import { DEFAULT_UI_SETTINGS } from '../src/shared/protocol';
import { ConfigService } from '../src/host/config';
import { t } from '../webview/src/i18n';
import { settingsStub } from './helpers/vscode-stub';

const ROOT = path.resolve(__dirname, '..');
const read = (f: string): string => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** (0.7.2) HTML mặc định mở bằng trình duyệt; `artifacts.htmlOpenIn` đổi lại thành tab VS Code. */
describe('artifacts.htmlOpenIn: hàm thuần', () => {
  it('mặc định và giá trị lạ → trình duyệt; chỉ "vscode" mới là VS Code', () => {
    expect(normalizeHtmlOpenIn(undefined)).toBe('browser');
    expect(normalizeHtmlOpenIn('xxx')).toBe('browser');
    expect(normalizeHtmlOpenIn('vscode')).toBe('vscode');
    expect(DEFAULT_UI_SETTINGS.htmlOpenIn).toBe('browser');
  });

  it('nút chính của thẻ: HTML theo cài đặt, loại khác luôn xem trước trong VS Code', () => {
    expect(primaryArtifactTarget('html', 'browser')).toBe('browser');
    expect(primaryArtifactTarget('html', 'vscode')).toBe('vscode');
    for (const ty of ['svg', 'markdown', 'dashboard']) expect(primaryArtifactTarget(ty, 'browser')).toBe('vscode');
  });

  it('autoOpen = static: SVG/Markdown tự mở trong VS Code, HTML chờ người dùng bấm', () => {
    expect(autoOpenTarget('static', 'svg', 'browser', false)).toBe('vscode');
    expect(autoOpenTarget('static', 'markdown', 'browser', false)).toBe('vscode');
    expect(autoOpenTarget('static', 'html', 'browser', false)).toBeNull();
  });

  it('autoOpen = always: HTML mở theo htmlOpenIn', () => {
    expect(autoOpenTarget('always', 'html', 'browser', false)).toBe('browser');
    expect(autoOpenTarget('always', 'html', 'vscode', false)).toBe('vscode');
    expect(autoOpenTarget('always', 'svg', 'browser', false)).toBe('vscode');
  });

  it('autoOpen = never không bao giờ mở; = browser (kiểu cũ) mở mọi loại bằng trình duyệt', () => {
    expect(autoOpenTarget('never', 'svg', 'browser', false)).toBeNull();
    expect(autoOpenTarget('never', 'html', 'browser', false)).toBeNull();
    expect(autoOpenTarget('browser', 'html', 'vscode', false)).toBe('browser');
    expect(autoOpenTarget('browser', 'svg', 'vscode', false)).toBe('browser');
  });

  it('nhà cung cấp demo: HTML xem trước ngay trong VS Code (không bật trình duyệt khi chạy thử)', () => {
    expect(autoOpenTarget('static', 'html', 'browser', true)).toBe('vscode');
    expect(autoOpenTarget('always', 'html', 'browser', true)).toBe('vscode');
  });
});

describe('artifacts.htmlOpenIn: cấu hình', () => {
  beforeEach(() => settingsStub.reset());

  it('mặc định browser; người dùng đặt vscode ở cấp toàn cục thì theo', () => {
    expect(new ConfigService().htmlOpenIn()).toBe('browser');
    settingsStub.global = { 'artifacts.htmlOpenIn': 'vscode' };
    expect(new ConfigService().htmlOpenIn()).toBe('vscode');
    expect(new ConfigService().ui().htmlOpenIn).toBe('vscode');
  });

  it('workspace không ép được (chỉ đọc từ cài đặt người dùng); giá trị lạ → browser', () => {
    settingsStub.workspace = { 'artifacts.htmlOpenIn': 'vscode' };
    expect(new ConfigService().htmlOpenIn()).toBe('browser');
    settingsStub.reset();
    settingsStub.global = { 'artifacts.htmlOpenIn': 'edge' };
    expect(new ConfigService().htmlOpenIn()).toBe('browser');
  });
});

describe('artifacts.htmlOpenIn: khai báo, chuỗi, thẻ artifact', () => {
  const pkg = JSON.parse(read('package.json')) as { contributes: { configuration: { properties: Record<string, { default?: unknown; enum?: string[]; markdownDescription?: string; scope?: string }> } } };
  const prop = pkg.contributes.configuration.properties['locaithAgent.artifacts.htmlOpenIn'];

  it('package.json: enum browser|vscode, mặc định browser, scope machine, mô tả có trong nls vi + en', () => {
    expect(prop.enum).toEqual(['browser', 'vscode']);
    expect(prop.default).toBe('browser');
    expect(prop.scope).toBe('machine');
    for (const f of ['package.nls.json', 'package.nls.en.json']) {
      const nls = JSON.parse(read(f)) as Record<string, string>;
      expect(nls['cfg.artifactsHtmlOpenIn'], f).toBeTruthy();
      expect(nls['cfg.artifactsHtmlOpenIn.browser'], f).toBeTruthy();
      expect(nls['cfg.artifactsHtmlOpenIn.vscode'], f).toBeTruthy();
    }
  });

  it('chuỗi giao diện vi/en cho nút phụ «Xem trước trong VS Code»', () => {
    expect(t('vi', 'artifact.previewVscode')).toBe('Xem trước trong VS Code');
    expect(t('en', 'artifact.previewVscode')).toBe('Preview in VS Code');
    expect(t('vi', 'artifact.browser')).toBe('Mở trong trình duyệt');
    expect(t('en', 'artifact.browser')).toBe('Open in browser');
  });

  it('thẻ artifact: nút chính là «Mở trong trình duyệt» khi primary = browser; bản trình duyệt (Chrome) không có nút này', () => {
    const card = read('webview/src/components/timeline/ArtifactCard.tsx');
    expect(card).toContain("platform === 'browser' ? 'vscode' : primaryArtifactTarget(block.artifactType, settings.htmlOpenIn)");
    expect(card).toMatch(/primary === 'browser' \? \(\s*<>\s*<Button variant="primary"[^>]*icon="globe"[\s\S]{0,200}open_artifact_browser/);
    expect(card).toMatch(/artifact\.previewVscode/);
  });

  it('mọi nơi dựng UiSettings đều có htmlOpenIn + liteMode (bản trình duyệt kiểm lại giá trị lạ)', () => {
    expect(read('src/browser/config.ts')).toContain("htmlOpenIn: oneOf(ui.htmlOpenIn, ['browser', 'vscode'] as const");
    expect(read('src/host/config.ts')).toContain("htmlOpenIn: 'artifacts.htmlOpenIn'");
  });
});
