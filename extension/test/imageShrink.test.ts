import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  IMAGE_JPEG_QUALITY,
  IMAGE_MAX_EDGE,
  THUMB_MAX_B64,
  THUMB_MAX_EDGE,
  THUMB_MAX_EDGE_LITE,
  b64Bytes,
  fitWithin,
  planShrink,
  shrinkWorthIt,
  thumbLadder,
  thumbSpec,
} from '../src/shared/imageShrink';
import { t } from '../webview/src/i18n';
import { DEFAULT_UI_SETTINGS } from '../src/shared/protocol';
import { ConfigService } from '../src/host/config';
import { settingsStub } from './helpers/vscode-stub';

const ROOT = path.resolve(__dirname, '..');
const read = (f: string): string => fs.readFileSync(path.join(ROOT, f), 'utf8');
const KB = 1024;

describe('planShrink: thu nhỏ ảnh đính kèm', () => {
  it('ảnh chụp màn hình lớn (cạnh dài > 1568, không trong suốt) → thu về 1568 px, JPEG q0,85', () => {
    const p = planShrink({ width: 3840, height: 2160, bytes: 1_700 * KB, mime: 'image/png', hasAlpha: false });
    expect(p).toEqual({ action: 'reencode', width: 1568, height: 882, mime: 'image/jpeg', quality: IMAGE_JPEG_QUALITY });
  });

  it('ảnh lớn có alpha → thu cỡ nhưng GIỮ PNG (không làm mất trong suốt)', () => {
    const p = planShrink({ width: 4000, height: 3000, bytes: 3000 * KB, mime: 'image/png', hasAlpha: true });
    expect(p).toMatchObject({ action: 'reencode', mime: 'image/png', width: 1568, height: 1176 });
  });

  it('cạnh trong hạn, PNG nặng > 400 KB không trong suốt → nén JPEG q0,85, không đổi kích thước', () => {
    const p = planShrink({ width: 1400, height: 900, bytes: 900 * KB, mime: 'image/png', hasAlpha: false });
    expect(p).toEqual({ action: 'reencode', width: 1400, height: 900, mime: 'image/jpeg', quality: IMAGE_JPEG_QUALITY });
  });

  it('ảnh nhỏ (≤ 400 KB, trong hạn) → giữ nguyên byte gốc', () => {
    expect(planShrink({ width: 800, height: 600, bytes: 120 * KB, mime: 'image/png', hasAlpha: false }).action).toBe('keep');
    expect(planShrink({ width: 800, height: 600, bytes: 399 * KB, mime: 'image/png', hasAlpha: false }).action).toBe('keep');
  });

  it('PNG có alpha trong hạn kích thước → giữ nguyên dù nặng', () => {
    expect(planShrink({ width: 1200, height: 800, bytes: 2000 * KB, mime: 'image/png', hasAlpha: true }).action).toBe('keep');
  });

  it('JPEG sẵn: chỉ nén lại khi nặng hơn hẳn (> 800 KB), không nén đi nén lại ảnh vốn nhẹ', () => {
    expect(planShrink({ width: 1500, height: 1000, bytes: 500 * KB, mime: 'image/jpeg', hasAlpha: false }).action).toBe('keep');
    expect(planShrink({ width: 1500, height: 1000, bytes: 1200 * KB, mime: 'image/jpeg', hasAlpha: false }).action).toBe('reencode');
  });

  it('GIF (có thể động) và kích thước vô nghĩa → luôn giữ nguyên', () => {
    expect(planShrink({ width: 4000, height: 3000, bytes: 5000 * KB, mime: 'image/gif', hasAlpha: false }).action).toBe('keep');
    expect(planShrink({ width: 0, height: 0, bytes: 100, mime: 'image/png', hasAlpha: false }).action).toBe('keep');
  });

  it('ảnh dọc: cạnh dài là chiều cao; không bao giờ phóng to', () => {
    expect(fitWithin(900, 3000, IMAGE_MAX_EDGE)).toEqual({ width: 470, height: 1568 });
    expect(fitWithin(500, 400, IMAGE_MAX_EDGE)).toEqual({ width: 500, height: 400 });
  });

  it('shrinkWorthIt: chỉ nhận bản mới khi nhẹ hơn rõ rệt', () => {
    expect(shrinkWorthIt(1000, 400)).toBe(true);
    expect(shrinkWorthIt(1000, 990)).toBe(false);
    expect(shrinkWorthIt(1000, 0)).toBe(false);
  });
});

describe('bản xem trước trong transcript', () => {
  it('cỡ: ≤ 480 px / ~60 KB; chế độ nhẹ 320 px / ~30 KB', () => {
    expect(THUMB_MAX_EDGE).toBeLessThanOrEqual(480);
    expect(b64Bytes('A'.repeat(THUMB_MAX_B64))).toBeLessThanOrEqual(60 * KB);
    expect(thumbSpec(true).edge).toBe(THUMB_MAX_EDGE_LITE);
    expect(b64Bytes('A'.repeat(thumbSpec(true).maxB64))).toBeLessThanOrEqual(30 * KB);
  });

  it('thang nấc: không nấc nào vượt cạnh tối đa, nấc sau không lớn hơn nấc trước', () => {
    for (const lite of [false, true]) {
      const l = thumbLadder(lite);
      const edge = thumbSpec(lite).edge;
      for (const s of l) expect(s.edge).toBeLessThanOrEqual(edge);
      for (let i = 1; i < l.length; i++) expect(l[i].edge <= l[i - 1].edge && l[i].quality <= l[i - 1].quality).toBe(true);
    }
  });
});

describe('nối vào giao diện', () => {
  it('composer thu nhỏ ảnh trước khi đính kèm và chỉ lưu thumb nhỏ', () => {
    const src = read('webview/src/components/composer/Composer.tsx');
    expect(src).toContain('await shrinkImage(file)');
    expect(src).toContain('makeThumb(file, settings.liteMode)');
    expect(src).toContain('data: small.data');
  });

  it('chế độ nhẹ: cài đặt có trong package.json (mặc định false), ConfigService, chuỗi vi/en', () => {
    const pkg = JSON.parse(read('package.json')) as { contributes: { configuration: { properties: Record<string, { default?: unknown; type?: string; minimum?: number }> }; commands: { command: string }[] } };
    const props = pkg.contributes.configuration.properties;
    expect(props['locaithAgent.ui.liteMode']).toMatchObject({ type: 'boolean', default: false });
    expect(props['locaithAgent.history.autoCleanImagesDays']).toMatchObject({ type: 'integer', default: 0, minimum: 0 });
    expect(props['locaithAgent.agent.maxImagesInContext']).toMatchObject({ type: 'integer', default: 8 });
    expect(pkg.contributes.commands.some((c) => c.command === 'locaithAgent.cleanup')).toBe(true);
    for (const f of ['package.nls.json', 'package.nls.en.json']) {
      const nls = JSON.parse(read(f)) as Record<string, string>;
      for (const k of ['cmd.cleanup', 'cfg.liteMode', 'cfg.autoCleanImagesDays', 'cfg.maxImagesInContext']) expect(nls[k], `${f}:${k}`).toBeTruthy();
    }
    expect(DEFAULT_UI_SETTINGS.liteMode).toBe(false);
    for (const lang of ['vi', 'en'] as const) {
      for (const k of ['set.liteMode', 'cleanup.title', 'cleanup.run.images', 'cleanup.run.sessions', 'cleanup.run.trash', 'cleanup.run.checkpoints'] as const) expect(t(lang, k)).toBeTruthy();
    }
    expect(t('vi', 'cleanup.images', { n: 30 })).toBe('Xoá ảnh khỏi cuộc trò chuyện cũ hơn 30 ngày (giữ chữ)');
    expect(t('vi', 'cleanup.sessions', { n: 90 })).toBe('Chuyển cuộc trò chuyện cũ hơn 90 ngày vào Thùng rác');
    expect(t('vi', 'cleanup.trash')).toBe('Dọn Thùng rác');
    expect(t('vi', 'cleanup.checkpoints', { n: 7 })).toBe('Dọn điểm quay lại cũ hơn 7 ngày');
  });

  it('ConfigService: liteMode mặc định false và đi theo ui(); autoCleanImagesDays kẹp 0–3650, số lạ → 0', () => {
    settingsStub.reset();
    expect(new ConfigService().liteMode()).toBe(false);
    expect(new ConfigService().ui().liteMode).toBe(false);
    expect(new ConfigService().autoCleanImagesDays()).toBe(0);
    settingsStub.global = { 'ui.liteMode': true, 'history.autoCleanImagesDays': 45 };
    expect(new ConfigService().liteMode()).toBe(true);
    expect(new ConfigService().ui().liteMode).toBe(true);
    expect(new ConfigService().autoCleanImagesDays()).toBe(45);
    settingsStub.global = { 'history.autoCleanImagesDays': 99999 };
    expect(new ConfigService().autoCleanImagesDays()).toBe(3650);
    settingsStub.global = { 'history.autoCleanImagesDays': -3 };
    expect(new ConfigService().autoCleanImagesDays()).toBe(0);
    settingsStub.global = { 'history.autoCleanImagesDays': 'abc' };
    expect(new ConfigService().autoCleanImagesDays()).toBe(0);
    settingsStub.reset();
  });

  it('lệnh locaithAgent.cleanup mở thẻ trong Cài đặt; webview không có nút nào tự xoá (chỉ gửi cleanup_run)', () => {
    expect(read('src/host/commands.ts')).toMatch(/reg\('locaithAgent\.cleanup'[\s\S]{0,200}showCleanup\(\)/);
    const card = read('webview/src/components/CleanupCard.tsx');
    expect(card).toContain("post({ type: 'cleanup_run'");
    expect(card).not.toMatch(/delete_session|purge_session|empty_trash/);
    expect(read('src/host/cleanup.ts')).toContain('showWarningMessage(p.title, { modal: true, detail: p.detail }, p.yes)');
  });

  it('chế độ nhẹ tắt hiệu ứng trong CSS và cờ truyền xuống <html>', () => {
    expect(read('webview/src/fonts.ts')).toContain("root.classList.toggle('lite', s.liteMode === true)");
    const css = read('webview/src/styles/base.css');
    expect(css).toMatch(/:root\.lite \.app \*/);
    expect(css).toMatch(/:root\.lite \.app \.cc-shimmer/);
  });
});
