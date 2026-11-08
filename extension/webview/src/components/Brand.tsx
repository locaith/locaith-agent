/**
 * Thương hiệu Locaith AI trong giao diện: logo "Lo" (gradient xanh ngọc #22bcec → tím chàm #625aec) và bộ chỉ báo
 * "Locaith đang làm việc" — chính logo chuyển động: thân logo thở nhẹ, một vệt sáng quét qua, và một đốm sáng chạy dọc nét viền.
 * Toàn bộ là SVG + CSS (nét sắc ở mọi cỡ, nhẹ, theo được theme, tôn trọng "giảm chuyển động").
 */
import { LO_BOX, LO_GRAD, LO_PATH } from '../brand/lo';

const VIEWBOX = `${LO_BOX.x} ${LO_BOX.y} ${LO_BOX.w} ${LO_BOX.h}`;
const ASPECT = LO_BOX.h / LO_BOX.w;

/** Khai báo gradient / clip dùng chung — đặt MỘT lần ở gốc ứng dụng (tham chiếu bằng id nên mọi bản sao logo đều dùng lại). */
export function LoDefs() {
  return (
    <svg class="lo-defs" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="lo-g" gradientUnits="userSpaceOnUse" x1={LO_GRAD.x1} y1={LO_GRAD.y1} x2={LO_GRAD.x2} y2={LO_GRAD.y2}>
          <stop offset="0" stop-color={LO_GRAD.c1} />
          <stop offset="1" stop-color={LO_GRAD.c2} />
        </linearGradient>
        <linearGradient id="lo-sheen" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#ffffff" stop-opacity="0" />
          <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.92" />
          <stop offset="1" stop-color="#ffffff" stop-opacity="0" />
        </linearGradient>
        {/* (0.7.2) nhân vật chờ — gradient nét (hộp vẽ 64×64) và chùm sáng drone */}
        <linearGradient id="lo-cg" gradientUnits="userSpaceOnUse" x1="0" y1="5" x2="0" y2="60">
          <stop offset="0" stop-color="#22bcec" />
          <stop offset="1" stop-color="#625aec" />
        </linearGradient>
        <linearGradient id="lo-beam" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#22bcec" stop-opacity="0.55" />
          <stop offset="1" stop-color="#22bcec" stop-opacity="0" />
        </linearGradient>
        <clipPath id="lo-clip">
          <path d={LO_PATH} clip-rule="evenodd" />
        </clipPath>
      </defs>
    </svg>
  );
}

/** Logo tĩnh. */
export function LoMark({ size = 22 }: { size?: number }) {
  return (
    <svg class="lo-mark" width={size} height={Math.round(size * ASPECT)} viewBox={VIEWBOX} aria-hidden="true" focusable="false">
      <path d={LO_PATH} fill="url(#lo-g)" fill-rule="evenodd" />
    </svg>
  );
}

/**
 * Logo "Lo" có vệt sáng lướt qua đúng hình chữ (màn đăng nhập). Khác LoSpinner (chỉ báo "đang làm việc", quét dồn dập):
 * lướt MỘT lần rồi nghỉ vài giây — đủ để logo "sống" mà không làm người ta rối mắt.
 */
export function LoShine({ size = 52 }: { size?: number }) {
  return (
    <svg class="lo-shine" width={size} height={Math.round(size * ASPECT)} viewBox={VIEWBOX} aria-hidden="true" focusable="false">
      <path d={LO_PATH} fill="url(#lo-g)" fill-rule="evenodd" />
      <g clip-path="url(#lo-clip)">
        <rect class="lo-shine-band" x={LO_BOX.x} y={LO_BOX.y} width={LO_BOX.w * 0.5} height={LO_BOX.h} fill="url(#lo-sheen)" />
      </g>
    </svg>
  );
}

/** Logo chuyển động: dùng làm vòng xoay/chỉ báo "đang làm việc" ở mọi nơi (công cụ đang chạy, đang suy nghĩ, nút bận…). */
export function LoSpinner({ size = 16, label }: { size?: number; label?: string }) {
  // Nét của đốm sáng ~1,6 px màn hình bất kể cỡ logo.
  const stroke = (1.7 * LO_BOX.w) / size;
  return (
    <svg
      class="lo-spin"
      width={size}
      height={Math.round(size * ASPECT)}
      viewBox={VIEWBOX}
      role={label ? 'progressbar' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : 'true'}
      focusable="false"
    >
      <path class="lo-base" d={LO_PATH} fill="url(#lo-g)" fill-rule="evenodd" />
      <g clip-path="url(#lo-clip)">
        <rect class="lo-sheen" x={LO_BOX.x} y={LO_BOX.y} width={LO_BOX.w * 0.5} height={LO_BOX.h} fill="url(#lo-sheen)" />
      </g>
      <path class="lo-trace" d={LO_PATH} pathLength="100" fill="none" stroke="url(#lo-g)" stroke-width={stroke} stroke-linejoin="round" stroke-linecap="round" />
    </svg>
  );
}
