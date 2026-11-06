/** Trang kiểm tra thị giác bộ biểu tượng + logo (không thuộc bản phát hành). */
import { render } from 'preact';
import { Icon, LogoMark } from '../src/components/Icons';
import type { IconName } from '../src/iconNames';
import '../src/styles/main.css';

const NAMES: IconName[] = [
  'sparkle', 'plus', 'history', 'sliders', 'send', 'stop', 'chevron-down', 'chevron-right', 'chevron-up', 'check',
  'x', 'copy', 'search', 'globe', 'file', 'file-plus', 'file-text', 'pencil', 'terminal', 'list-checks',
  'cpu', 'shield', 'lightbulb', 'paperclip', 'image', 'folder', 'link', 'refresh', 'trash', 'alert',
  'info', 'zap', 'layout', 'eye', 'external', 'arrow-down', 'arrow-left', 'key', 'wand', 'notebook',
  'at', 'slash', 'download',
];

function Sheet() {
  return (
    <div class="app" style={{ height: 'auto', padding: '20px', gap: '20px' }}>
      <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
        <LogoMark size={64} />
        <LogoMark size={32} />
        <LogoMark size={20} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 96px)', gap: '12px' }}>
        {NAMES.map((n) => (
          <div key={n} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', padding: '10px 4px', border: '1px solid var(--line)', borderRadius: '10px' }}>
            <Icon name={n} size={28} />
            <span style={{ fontSize: '12px', color: 'var(--fg-muted)' }}>{n}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (root) render(<Sheet />, root);
(window as unknown as { __ND_READY__: boolean }).__ND_READY__ = true;
