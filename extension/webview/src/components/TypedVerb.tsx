/**
 * Từ trạng thái ở dòng đang chạy, GÕ TỪNG CHỮ RA (con trỏ nháy), giữ đủ lâu để đọc, xoá nhanh rồi gõ từ kế — như từ xoay vòng
 * «Wibbling…» của Claude Code nhưng có hiệu ứng gõ. Lịch là hàm thuần ở src/shared/typewriter.ts (dùng chung với CLI, có test bằng số).
 *
 *  - BỀ NGANG giữ chỗ bằng chính từ đầy đủ (bản ẩn) nên chữ «~token · giây» bên phải KHÔNG nhảy khi từng chữ hiện ra.
 *  - ĐỌC MÀN HÌNH: chữ đang gõ là aria-hidden; chỉ nhãn gốc (tĩnh) nằm trong `sr-only` — không ai bị đọc từng chữ một.
 *  - GIẢM CHUYỂN ĐỘNG / chế độ nhẹ / tắt hiệu ứng ở dòng chờ → nhãn tĩnh y như cũ (không timer, không con trỏ).
 *  - Một timer duy nhất, hẹn ĐÚNG lúc chữ đổi (không quét 60 lần/giây); đứng im khi giữ từ; huỷ khi gỡ khỏi màn hình.
 */
import { useEffect, useState } from 'preact/hooks';
import { TYPE_TIMING, typeFrame, type TypeFrame } from '../../../src/shared/typewriter';
import { useReducedMotion } from '../hooks';

export interface TypedVerbProps {
  /** Nhãn gốc (tĩnh): hiện khi không hiệu ứng, và là thứ duy nhất trình đọc màn hình đọc. */
  label: string;
  /** Các từ xoay vòng, từ đầu tiên là nhãn gốc. Một từ + `once` = gõ một lần rồi giữ. */
  verbs: readonly string[];
  /** Hạt giống thứ tự xoay vòng (cố định theo lượt → render lại không đổi). */
  seed: number;
  /** Bật hiệu ứng (đã tính cả chế độ nhẹ / công tắc); giảm chuyển động của hệ điều hành luôn tắt hiệu ứng. */
  animate: boolean;
  /** Chỉ gõ một lần rồi giữ nguyên (nhãn «Đang chuẩn bị»). */
  once?: boolean;
}

const same = (a: TypeFrame, b: TypeFrame): boolean => a.text === b.text && a.verb === b.verb && a.phase === b.phase;

export function TypedVerb({ label, verbs, seed, animate, once = false }: TypedVerbProps) {
  const reduced = useReducedMotion();
  const live = animate && !reduced && verbs.length > 0;
  const key = verbs.join('\u0001');
  const [frame, setFrame] = useState<TypeFrame>(() => typeFrame(verbs, 0, seed, TYPE_TIMING, once));

  useEffect(() => {
    if (!live) return;
    const t0 = performance.now();
    let timer: number | undefined;
    const step = () => {
      const f = typeFrame(verbs, performance.now() - t0, seed, TYPE_TIMING, once);
      setFrame((prev) => (same(prev, f) ? prev : f));
      if (Number.isFinite(f.nextMs)) timer = window.setTimeout(step, Math.max(20, Math.ceil(f.nextMs)));
    };
    step();
    return () => window.clearTimeout(timer);
    // `verbs` đổi nội dung (đổi ngôn ngữ, đổi giữa «chuẩn bị»/«đang xử lý») → chạy lại từ đầu; đổi danh tính mảng thì không.
  }, [live, key, seed, once]);

  if (!live) return <span class="cc-working-label">{label}</span>;
  return (
    <span class="cc-working-label tw" data-phase={frame.phase}>
      <span class="sr-only">{label}</span>
      <span class="tw-ghost" aria-hidden="true">
        {frame.verb}
      </span>
      <span class="tw-live cc-shimmer" aria-hidden="true">
        {frame.text}
        <i class="tw-caret" />
      </span>
    </span>
  );
}
