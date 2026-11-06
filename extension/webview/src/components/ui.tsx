/** Thành phần giao diện nhỏ dùng chung. */
import type { ComponentChildren } from 'preact';
import type { IconName } from '../iconNames';
import { cx } from '../util';
import { LoMark, LoSpinner } from './Brand';
import { Icon } from './Icons';

/** Vòng xoay "đang làm việc" của toàn giao diện: chính logo Locaith chuyển động. */
export function Spinner({ size = 14 }: { size?: number }) {
  return <LoSpinner size={Math.max(size, 14)} label="…" />;
}

interface IconButtonProps {
  icon: IconName;
  label: string;
  onClick?: (e: MouseEvent) => void;
  size?: number;
  class?: string;
  disabled?: boolean;
  active?: boolean;
  title?: string;
}

export function IconButton({ icon, label, onClick, size = 16, class: cls, disabled, active, title }: IconButtonProps) {
  return (
    <button
      type="button"
      class={cx('icon-btn', active && 'is-active', cls)}
      aria-label={label}
      title={title ?? label}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}

interface ButtonProps {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
  icon?: IconName;
  onClick?: (e: MouseEvent) => void;
  disabled?: boolean;
  small?: boolean;
  class?: string;
  title?: string;
  type?: 'button' | 'submit';
  children?: ComponentChildren;
  busy?: boolean;
}

export function Button({
  variant = 'secondary',
  icon,
  onClick,
  disabled,
  small,
  class: cls,
  title,
  type = 'button',
  children,
  busy,
}: ButtonProps) {
  return (
    <button
      type={type}
      class={cx('btn', `btn-${variant}`, small && 'btn-sm', cls)}
      onClick={onClick}
      disabled={disabled || busy}
      title={title}
    >
      {busy ? <Spinner size={13} /> : icon ? <Icon name={icon} size={small ? 14 : 15} /> : null}
      {children != null && <span class="btn-label">{children}</span>}
    </button>
  );
}

/** Huy hiệu tròn chữ cái đầu của nhà cung cấp (không dùng logo hãng để tránh nhầm lẫn nhãn hiệu). */
const PROVIDER_HUES: Record<string, string> = {
  anthropic: '#c4673f',
  openai: '#0f8f6e',
  gemini: '#3b6fe0',
  deepseek: '#4e5bd8',
  xai: '#4b4f58',
  // Họ mô hình Locaith (AI Local): dải màu của logo Locaith.
  locaith: 'linear-gradient(135deg, #22bcec, #625aec)',
};

function hueFor(id: string): string {
  if (PROVIDER_HUES[id]) return PROVIDER_HUES[id];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h} 45% 42%)`;
}

export function ProviderBadge({ id, label, size = 18 }: { id: string; label: string; size?: number }) {
  // Model của chính Locaith LUÔN mang logo Locaith ở mọi nơi liệt kê/gắn nhãn model (quy ước của chủ dự án, 04/11/2026) — không bao giờ chỉ là một chữ cái.
  if (id === 'locaith') {
    return (
      <span class="prov-badge prov-badge-lo" aria-hidden="true" style={{ width: `${size}px`, height: `${size}px` }}>
        <LoMark size={size} />
      </span>
    );
  }
  const initial = (label.trim()[0] ?? id[0] ?? '?').toUpperCase();
  return (
    <span
      class="prov-badge"
      aria-hidden="true"
      style={{ width: `${size}px`, height: `${size}px`, background: hueFor(id), fontSize: `${Math.round(size * 0.58)}px` }}
    >
      {initial}
    </span>
  );
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      class={cx('switch', checked && 'is-on')}
      onClick={() => onChange(!checked)}
    >
      <span class="switch-knob" />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div class="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          class={cx('seg', o.value === value && 'is-on')}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Badge({
  tone = 'neutral',
  children,
  title,
}: {
  tone?: 'neutral' | 'ok' | 'warn' | 'accent' | 'danger';
  children: ComponentChildren;
  title?: string;
}) {
  return (
    <span class={cx('badge', `badge-${tone}`)} title={title}>
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ComponentChildren }) {
  return <kbd class="kbd">{children}</kbd>;
}
