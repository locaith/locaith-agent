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
  const { t, lang } = useApp();
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
          <Button variant="secondary" small icon="download" onClick={() => post({ type: 'save_artifact', artifactId: block.artifactId })}>
            {t('artifact.save')}
          </Button>
        </div>
      )}
    </div>
  );
}
