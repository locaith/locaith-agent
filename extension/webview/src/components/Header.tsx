import { useApp } from '../ctx';
import { IconButton } from './ui';
import { LoSpinner } from './Brand';
import { LogoMark } from './Icons';
import { RemoteToggle } from './RemoteView';
import { MeterChip } from './MeterChip'; // (lane:sessions-ux)
import type { RemoteView, SessionMeterView, ViewState } from '../../../src/shared/protocol';

export type Screen = 'chat' | 'settings' | 'history' | 'market';

export function Header({
  title,
  screen,
  running,
  onNew,
  onHistory,
  onSettings,
  onMarket,
  onBack,
  remote,
  context,
  meter,
}: {
  title: string;
  screen: Screen;
  running: boolean;
  onNew: () => void;
  onHistory: () => void;
  onSettings: () => void;
  onMarket?: () => void;
  onBack: () => void;
  /** Trạng thái Remote: có thì hiện công tắc bật/tắt ngay trên thanh tiêu đề (màn chat). */
  remote?: RemoteView;
  /** (lane:sessions-ux) Chip «ngữ cảnh 38%» + chi phí ước tính. */
  context?: ViewState['context'];
  meter?: SessionMeterView;
}) {
  const { t, platform } = useApp();
  const inChat = screen === 'chat';
  const heading = inChat ? title || t('app.untitled') : screen === 'settings' ? t('set.title') : screen === 'market' ? t('mk.title') : t('hist.title');

  return (
    <header class="hdr">
      {inChat ? (
        <span class="hdr-logo">
          <LogoMark size={20} />
        </span>
      ) : (
        <IconButton icon="arrow-left" label={t('hdr.back')} onClick={onBack} />
      )}
      <h1 class="hdr-title" title={heading}>
        {heading}
      </h1>
      {inChat && <MeterChip context={context} meter={meter} />}
      {running && inChat && (
        <span class="hdr-busy" role="status" aria-label={t('app.assistantBusy')}>
          <LoSpinner size={18} />
        </span>
      )}
      {remote && inChat && <RemoteToggle remote={remote} />}
      <div class="hdr-actions">
        <IconButton icon="plus" label={t('hdr.new')} onClick={onNew} />
        <IconButton icon="history" label={t('hdr.history')} onClick={onHistory} active={screen === 'history'} />
        {onMarket && platform !== 'browser' && <IconButton icon="store" label={t('hdr.market')} onClick={onMarket} active={screen === 'market'} />}
        <IconButton icon="sliders" label={t('hdr.settings')} onClick={onSettings} active={screen === 'settings'} />
      </div>
    </header>
  );
}
