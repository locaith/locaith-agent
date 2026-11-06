import { useEffect } from 'preact/hooks';
import { useApp } from '../ctx';
import { cx } from '../util';
import { Icon } from './Icons';

export interface ToastItem {
  id: number;
  level: 'info' | 'warn' | 'error';
  text: string;
}

function Toast({ item, onClose }: { item: ToastItem; onClose: (id: number) => void }) {
  const { t } = useApp();
  useEffect(() => {
    const timer = window.setTimeout(() => onClose(item.id), item.level === 'error' ? 8000 : 4500);
    return () => window.clearTimeout(timer);
  }, [item.id, item.level, onClose]);

  return (
    <div class={cx('toast', `toast-${item.level}`)} role={item.level === 'error' ? 'alert' : 'status'}>
      <Icon name={item.level === 'info' ? 'info' : 'alert'} size={16} />
      <span class="toast-text">{item.text}</span>
      <button type="button" class="toast-x" onClick={() => onClose(item.id)} aria-label={t('toast.dismiss')}>
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

export function Toasts({ items, onClose }: { items: ToastItem[]; onClose: (id: number) => void }) {
  if (items.length === 0) return null;
  return (
    <div class="toasts">
      {items.map((it) => (
        <Toast key={it.id} item={it} onClose={onClose} />
      ))}
    </div>
  );
}
