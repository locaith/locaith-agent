/** Lớp phủ dùng chung: xem ảnh phóng to (ảnh chụp màn hình của trợ lý), hộp xác nhận bật "Toàn quyền" và thanh nhắc khi đang ở chế độ đó. */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ViewState } from '../../../src/shared/protocol';
import { useApp } from '../ctx';
import { post } from '../vscode';
import { Icon } from './Icons';
import { Button } from './ui';

export interface LightboxState {
  /** Khoá ảnh (imageKey): khi host gửi bản đầy đủ về thì thay `src`. */
  key?: string;
  src: string;
  label: string;
  /** (0.6.3) Ảnh kết quả là tệp trên máy (đã được host xác nhận): nút «Mở trong VS Code» / «Hiện trong thư mục» thay cho nút tải về. */
  mediaPath?: string;
}

/** Xem ảnh phóng to. Esc (xử lý ở App), bấm nền hoặc nút đóng để thoát; có nút tải ảnh về (hoặc mở tệp, với ảnh kết quả). */
export function Lightbox({ item, onClose }: { item: LightboxState; onClose: () => void }) {
  const { t } = useApp();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), []);
  const file = item.mediaPath;
  return (
    <div class="lightbox" role="dialog" aria-modal="true" aria-label={item.label} onClick={onClose}>
      <div class="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span class="lightbox-title">{item.label}</span>
        {file ? (
          <>
            <button type="button" class="lightbox-btn" onClick={() => post({ type: 'open_media', path: file, how: 'editor' })} title={t('media.open')} aria-label={t('media.open')}>
              <Icon name="external" size={16} />
            </button>
            <button type="button" class="lightbox-btn" onClick={() => post({ type: 'open_media', path: file, how: 'reveal' })} title={t('media.reveal')} aria-label={t('media.reveal')}>
              <Icon name="folder" size={16} />
            </button>
          </>
        ) : (
          <a class="lightbox-btn" href={item.src} download="anh-chup-man-hinh.jpg" title={t('lightbox.download')} aria-label={t('lightbox.download')}>
            <Icon name="download" size={16} />
          </a>
        )}
        <button ref={closeRef} type="button" class="lightbox-btn" onClick={onClose} title={t('lightbox.close')} aria-label={t('lightbox.close')}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <img class="lightbox-img" src={item.src} alt={item.label} onClick={(e) => e.stopPropagation()} />
    </div>
  );
}

/**
 * Hộp xác nhận bật "Toàn quyền" (trình duyệt) / "Bỏ qua mọi xác nhận" (VS Code): nói rõ rủi ro rồi bật và chuyển sang chế độ đó trong MỘT cú bấm —
 * không phải vào Cài đặt. Bản trình duyệt còn cho chọn ghi nhớ (mặc định có) và xin quyền mọi trang web; bản VS Code cho chọn ghi nhớ (mặc định KHÔNG, vì
 * chế độ này sửa tệp và chạy lệnh mà không hỏi).
 */
export function FullAccessDialog({ view, onClose }: { view: ViewState; onClose: () => void }) {
  const { t } = useApp();
  const browser = view.platform === 'browser';
  const k = (key: 'title' | 'body' | 'safe' | 'remember' | 'enable') => `fullAccess.${key}${browser ? '' : '.code'}` as const;
  const [remember, setRemember] = useState(browser);
  const needSite = browser && !view.browser?.siteAccess;
  const [site, setSite] = useState(needSite);
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => okRef.current?.focus(), []);
  const confirm = () => {
    post({ type: 'enable_full_access', remember, siteAccess: needSite && site });
    onClose();
  };
  return (
    <div class="lightbox" role="presentation" onClick={onClose}>
      <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="fa-title" aria-describedby="fa-body" onClick={(e) => e.stopPropagation()}>
        <div class="dialog-head" id="fa-title">
          <Icon name="alert" size={18} />
          <span>{t(k('title'))}</span>
        </div>
        <div class="dialog-body" id="fa-body">
          <p>{t(k('body'))}</p>
          <p class="dialog-note">{t(k('safe'))}</p>
          <label class="check-row">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember((e.target as HTMLInputElement).checked)} />
            <span>{t(k('remember'))}</span>
          </label>
          {needSite && (
            <label class="check-row">
              <input type="checkbox" checked={site} onChange={(e) => setSite((e.target as HTMLInputElement).checked)} />
              <span>{t('fullAccess.site')}</span>
            </label>
          )}
        </div>
        <div class="dialog-actions">
          <button ref={okRef} type="button" class="btn btn-danger" onClick={confirm}>
            <span class="btn-label">{t(k('enable'))}</span>
          </button>
          <Button variant="ghost" onClick={onClose}>
            {t('fullAccess.cancel')}
          </Button>
        </div>
      </div>
    </div>
  );
}
