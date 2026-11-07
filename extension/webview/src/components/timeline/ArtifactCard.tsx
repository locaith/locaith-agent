import { useApp } from '../../ctx';
import { formatBytes } from '../../format';
import type { I18nKey } from '../../i18n';
import type { ArtifactBlockT } from '../../timeline';
import { cx } from '../../util';
import { post } from '../../vscode';
import { Icon } from '../Icons';
import { Button, Spinner } from '../ui';

const TYPE_KEYS: Record<string, I18nKey> = {
  html: 'artifact.type.html',
  svg: 'artifact.type.svg',
  markdown: 'artifact.type.markdown',
  dashboard: 'artifact.type.dashboard',
};

export function ArtifactCard({ block }: { block: ArtifactBlockT }) {
  const { t, lang, platform } = useApp();
  const writing = block.state === 'writing';
  const typeLabel = t(TYPE_KEYS[block.artifactType] ?? 'artifact.type.other');

  return (
    <div class={cx('artifact-card', writing && 'is-writing')}>
      <span class="artifact-icon">{writing ? <Spinner size={16} /> : <Icon name="layout" size={18} />}</span>
      <div class="artifact-info">
        <div class="artifact-title" title={block.title}>
          {block.title}
        </div>
        <div class="artifact-sub">
          <span>{typeLabel}</span>
          {writing ? (
            <span class="artifact-writing">
              · {t('artifact.writing')}
              {block.sizeChars ? ` ${formatBytes(block.sizeChars, lang)}` : ''}
            </span>
          ) : null}
        </div>
      </div>
      {!writing && (
        <div class="artifact-actions">
          <Button variant="primary" small icon="eye" onClick={() => post({ type: 'open_artifact', artifactId: block.artifactId })}>
            {t('artifact.open')}
          </Button>
          {/* Khách báo: HTML hay mở trong tab bên cạnh của VS Code, trong khi họ muốn xem bằng Chrome. Bản trình duyệt: «Mở xem trước» đã mở sẵn trong một tab Chrome/Edge và host
              không xử lý `open_artifact_browser` — nút này chỉ là nút chết (và lời chú thích của nó nhắc VS Code) nên ẩn đi. */}
          {platform !== 'browser' && (
            <Button variant="secondary" small icon="globe" onClick={() => post({ type: 'open_artifact_browser', artifactId: block.artifactId })} title={t('artifact.browserHint')}>
              {t('artifact.browser')}
            </Button>
          )}
          <Button variant="secondary" small icon="download" onClick={() => post({ type: 'save_artifact', artifactId: block.artifactId })}>
            {t('artifact.save')}
          </Button>
        </div>
      )}
    </div>
  );
}
