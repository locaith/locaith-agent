/**
 * (lane:cc-timeline-ui) Ô IN / OUT của một lệnh shell như Claude Code: nhãn «IN» nhỏ + lệnh (chữ đơn cách, xuống dòng),
 * nhãn «OUT» + đầu ra trong hộp tối. Mỗi ô giới hạn ~4 dòng, phần cắt mờ dần; bấm để bung đủ / thu lại.
 * Đầu ra lỗi: chữ đỏ, KHÔNG tô nền đỏ. Nút Sao chép hiện khi rê chuột.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { useApp } from '../../ctx';
import { countLines } from '../../timelineCc';
import { copyText, cx } from '../../util';
import { Icon } from '../Icons';

/** Số dòng tối đa trước khi cắt (khớp ảnh mẫu: 3–4 dòng). */
export const IO_CLAMP_LINES = 4;

function IoBox({ label, text, error, running, mono }: { label: string; text: string; error?: boolean; running?: boolean; mono: 'in' | 'out' }) {
  const { t } = useApp();
  const [full, setFull] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const long = countLines(text) > IO_CLAMP_LINES || text.length > 600;
  const clamped = long && !full;
  const doCopy = async (e: MouseEvent) => {
    e.stopPropagation();
    if (await copyText(text)) {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1400);
    }
  };
  return (
    <div class={cx('cc-io', `is-${mono}`, error && 'is-error', running && 'is-running')}>
      <span class="cc-io-label" aria-hidden="true">
        {label}
      </span>
      <div class="cc-io-main">
        <pre
          class={cx('cc-io-pre', clamped && 'is-clamped', long && 'is-toggle')}
          role={long ? 'button' : undefined}
          tabIndex={long ? 0 : undefined}
          aria-expanded={long ? full : undefined}
          title={long ? (full ? t('tool.showLess') : t('cc.showAll')) : undefined}
          onClick={long ? () => setFull((v) => !v) : undefined}
          onKeyDown={long ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setFull((v) => !v)) : undefined}
        >
          {text}
        </pre>
        <button type="button" class="cc-io-copy" onClick={doCopy} title={t('cc.copy')} aria-label={`${t('cc.copy')} ${label}`}>
          <Icon name={copied ? 'check' : 'copy'} size={12} />
          {copied && <span>{t('cc.copied')}</span>}
        </button>
      </div>
    </div>
  );
}

export function CmdInOut({ command, output, error, running }: { command: string; output?: string; error?: boolean; running?: boolean }) {
  const { t } = useApp();
  const hasOut = output !== undefined && (output.length > 0 || !running);
  return (
    <div class="cc-inout">
      {command && <IoBox label={t('cc.in')} text={command} mono="in" />}
      {hasOut && <IoBox label={t('cc.out')} text={output || t('tool.noOutput')} error={error} running={running} mono="out" />}
    </div>
  );
}
