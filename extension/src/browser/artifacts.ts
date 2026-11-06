import type { ArtifactRecord } from '../core/engine/types';
import type { ArtifactHost } from './controller';
import type { BrowserLogger } from './logger';

const EXT: Record<string, { ext: string; mime: string }> = {
  html: { ext: 'html', mime: 'text/html' },
  svg: { ext: 'svg', mime: 'image/svg+xml' },
  markdown: { ext: 'md', mime: 'text/markdown' },
};

export const artifactKey = (id: string) => `nd.artifact.${id}`;

/** Mở artifact ở một tab riêng (trang xem trước bọc nội dung trong khung sandbox) và tải tệp về máy. */
export class ArtifactOpener implements ArtifactHost {
  constructor(private readonly logger: BrowserLogger) {}

  async open(rec: ArtifactRecord): Promise<void> {
    await chrome.storage.session.set({ [artifactKey(rec.id)]: { id: rec.id, title: rec.title, type: rec.type, content: rec.content, version: rec.version } });
    const base = chrome.runtime.getURL('artifact.html');
    const url = `${base}?id=${encodeURIComponent(rec.id)}`;
    const tabs = await chrome.tabs.query({ url: `${base}*` });
    const same = tabs.find((t) => t.url === url);
    if (same?.id !== undefined) {
      await chrome.tabs.update(same.id, { active: true }); // trang xem trước tự vẽ lại khi storage đổi
    } else {
      await chrome.tabs.create({ url, active: true });
    }
    this.logger.log('info', `Mở artifact "${rec.title}" (${rec.type}, ${rec.content.length} ký tự)`);
  }

  save(rec: ArtifactRecord): void {
    const spec = EXT[rec.type] ?? EXT.html;
    const safe = rec.title.normalize('NFC').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'artifact';
    this.download(`${safe}.${spec.ext}`, spec.mime, rec.content);
  }

  download(filename: string, mime: string, content: string): void {
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
