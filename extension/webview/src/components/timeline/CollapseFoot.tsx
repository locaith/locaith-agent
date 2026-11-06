import { useApp } from '../../ctx';
import { Icon } from '../Icons';

/**
 * Nút «Thu gọn» ở CUỐI phần nội dung vừa mở.
 *
 * Vì sao: một khối gấp mở ra có thể dài hơn cả màn hình; muốn đóng lại phải cuộn ngược lên đầu khối.
 * Nút này nằm ngay dưới nội dung nên đóng được tại chỗ, và cũng là nơi bấm quen tay sau khi đọc xong.
 */
export function CollapseFoot({ onCollapse, label }: { onCollapse: () => void; label?: string }) {
  const { t } = useApp();
  return (
    <button type="button" class="collapse-foot" onClick={onCollapse}>
      <Icon name="chevron-up" size={13} />
      <span>{label ?? t('collapse.foot')}</span>
    </button>
  );
}
