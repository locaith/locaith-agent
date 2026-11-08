import { useState } from 'preact/hooks';
import type { SuggestionOption } from '../../../src/shared/protocol';
import { useApp } from '../ctx';
import { buildAllPrompt, shouldOfferAll } from '../optionsModel';
import { post } from '../vscode';
import { Icon } from './Icons';

/**
 * Lựa chọn hướng đi ở cuối lượt — NÚT bấm, không phải đoạn "bước tiếp theo" viết trong chat.
 * Bấm một nút = gửi nguyên `prompt` của lựa chọn như tin nhắn của người dùng, nên trợ lý làm trọn việc đó
 * trong cùng một lượt chạy. Chỉ hiện khi đã dừng; lượt mới bắt đầu là danh sách tự thu hồi (engine xoá).
 *
 * (0.7.2) Vẽ NGAY SAU lượt trả lời cuối ở cuối dòng hội thoại (cuộn cùng nội dung — ChatView), không còn ở chân khung. Từ 2 lựa chọn «hướng đi trở lên có thêm chip «Tất cả».
 *
 * (lane:output-timeouts) Bộ lựa chọn chỉ gồm nút `kind: 'continue'` («Chạy tiếp phần N» / «Chạy tiếp» sau khi lượt bị cắt hoặc buộc dừng)
 * vẽ GỌN một dòng kiểu Claude Code: chấm trạng thái + nhãn xám nhỏ + nút — không khung kín, không tiêu đề "hiểu theo cách nào".
 */
export function OptionsBar({ options, running }: { options?: SuggestionOption[]; running: boolean }) {
  const { t, lang } = useApp();
  /** Chữ ký của bộ lựa chọn người dùng đã ẩn — bộ mới (lượt sau) lại hiện. */
  const [hidden, setHidden] = useState('');
  if (running || !options || options.length === 0) return null;
  const sig = options.map((o) => `${o.id}:${o.label}`).join('|');
  if (hidden === sig) return null;

  const send = (o: SuggestionOption) => post({ type: 'send', text: o.prompt, attachments: [] });
  // (0.7.2) «Tất cả»: một tin duy nhất yêu cầu làm mọi hướng (chỉ kiểu «hướng đi», không áp cho «Chạy tiếp»).
  const all = shouldOfferAll(options);
  const sendAll = () => post({ type: 'send', text: buildAllPrompt(options, lang), attachments: [] });

  if (options.every((o) => o.kind === 'continue')) {
    return (
      <div class="options options-inline options-continue" role="group" aria-label={t('options.continue')}>
        <span class="dot dot-warn" aria-hidden="true" />
        <span class="options-continue-label">{t('options.continue')}</span>
        {options.map((o) => (
          <button key={o.id} type="button" class="option-chip option-continue" title={o.prompt} onClick={() => send(o)}>
            <span class="option-label">{o.label}</span>
            <Icon name="chevron-right" size={13} class="option-go" />
          </button>
        ))}
        <span class="options-spacer" />
        <button type="button" class="icon-btn" onClick={() => setHidden(sig)} title={t('options.hide')} aria-label={t('options.hide')}>
          <Icon name="x" size={13} />
        </button>
      </div>
    );
  }

  return (
    <section class="options options-inline" aria-label={t('options.title')}>
      <div class="options-head">
        <Icon name="sparkle" size={14} />
        <span class="options-title">{t('options.title')}</span>
        <span class="options-spacer" />
        <button type="button" class="icon-btn" onClick={() => setHidden(sig)} title={t('options.hide')} aria-label={t('options.hide')}>
          <Icon name="x" size={13} />
        </button>
      </div>
      <div class="options-grid">
        {options.map((o) => (
          <button key={o.id} type="button" class="option-chip" title={o.prompt} onClick={() => send(o)}>
            <span class="option-text">
              <span class="option-label">{o.label}</span>
              {o.detail && <span class="option-detail">{o.detail}</span>}
            </span>
            <Icon name="chevron-right" size={13} class="option-go" />
          </button>
        ))}
        {all && (
          <button type="button" class="option-chip option-all" title={t('options.allHint')} onClick={sendAll}>
            <Icon name="list-checks" size={13} class="option-all-icon" />
            <span class="option-label">{t('options.all')}</span>
          </button>
        )}
      </div>
    </section>
  );
}
