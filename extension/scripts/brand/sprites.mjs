// Bộ nhân vật «logo Lo biến hình» — mọi hình đều vẽ bằng nét dày bo tròn + gradient Locaith (#22bcec → #625aec),
// đầu luôn là vòng tròn «o» của logo (lỗ giữa vòng = mắt), thân là «L» được dựng lại thành nét.
// Hộp vẽ 64×64. Mỗi hàm trả về chuỗi SVG (không có thẻ <svg>) cho pha t ∈ [0,1) của vòng lặp.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const LO_PATH = readFileSync(path.join(here, 'lo-path.txt'), 'utf8');
export const LO_BOX = { x: 161.2, y: 219.7, w: 1605, h: 1494.6 };
const TAU = Math.PI * 2;
const r2 = (n) => Math.round(n * 100) / 100;
const P = (x, y) => `${r2(x)} ${r2(y)}`;
const line = (x1, y1, x2, y2, w, extra = '') => `<path d="M${P(x1, y1)}L${P(x2, y2)}" stroke-width="${w}" ${extra}/>`;
const poly = (pts, w, extra = '') => `<path d="M${pts.map(([x, y]) => P(x, y)).join('L')}" stroke-width="${w}" ${extra}/>`;
const ring = (cx, cy, r, w, extra = '') => `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r}" stroke-width="${w}" ${extra}/>`;
const dot = (cx, cy, r, extra = '') => `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r}" fill="currentColor" stroke="none" ${extra}/>`;
const rot = (deg, cx, cy, inner) => `<g transform="rotate(${r2(deg)} ${r2(cx)} ${r2(cy)})">${inner}</g>`;

/** Khai báo gradient dùng chung cho cả trang (đặt MỘT lần). */
export const DEFS = `
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <linearGradient id="loC" gradientUnits="userSpaceOnUse" x1="0" y1="5" x2="0" y2="60"><stop offset="0" stop-color="#22bcec"/><stop offset="1" stop-color="#625aec"/></linearGradient>
  <linearGradient id="loL" gradientUnits="userSpaceOnUse" x1="727.3" y1="208.3" x2="1006.7" y2="1745.3"><stop offset="0" stop-color="#22bcec"/><stop offset="1" stop-color="#625aec"/></linearGradient>
  <linearGradient id="loSheen" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".95"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
  <linearGradient id="loBeam" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#22bcec" stop-opacity=".55"/><stop offset="1" stop-color="#22bcec" stop-opacity="0"/></linearGradient>
  <clipPath id="loClip"><path d="${LO_PATH}" clip-rule="evenodd"/></clipPath>
</defs></svg>`;

const EYE = '#effcff';
const STROKE = 'fill="none" stroke="url(#loC)" stroke-linecap="round" stroke-linejoin="round"';

/** Logo thật (đường dẫn gốc), vừa khít hộp 64×64. `sheen` ∈ [0,1] đặt vệt sáng quét ngang (null = không vẽ). */
export function logo(sheen = null) {
  const k = 64 / LO_BOX.w;
  const tx = 32 - (LO_BOX.x + LO_BOX.w / 2) * k;
  const ty = 32 - (LO_BOX.y + LO_BOX.h / 2) * k;
  let s = `<g transform="translate(${r2(tx)} ${r2(ty)}) scale(${k})"><path d="${LO_PATH}" fill="url(#loL)" fill-rule="evenodd"/>`;
  if (sheen !== null) {
    const x = LO_BOX.x - LO_BOX.w * 0.5 + (LO_BOX.w * 1.6) * sheen;
    s += `<g clip-path="url(#loClip)"><rect x="${r2(x)}" y="${LO_BOX.y}" width="${LO_BOX.w * 0.5}" height="${LO_BOX.h}" fill="url(#loSheen)"/></g>`;
  }
  return s + '</g>';
}

/* ───────────────────────────── CHÓ ROBOT (nhìn ngang, quay mặt sang phải) ───────────────────────────── */
export function dog(t, o = {}) {
  const bob = -1.4 * Math.abs(Math.sin(TAU * t)); // thân nhấc lên lúc chân bay
  const by = 35 + bob;
  const hipY = by + 4.5;
  const L = 12.6;
  const leg = (hx, ph, far) => {
    const ang = 0.5 * Math.sin(TAU * t + ph);
    const c = Math.cos(TAU * t + ph);
    const lift = c > 0 ? 2.8 * c : 0;
    const ex = hx + L * Math.sin(ang);
    const ey = hipY + L * Math.cos(ang) - lift;
    return `<g ${far ? 'opacity=".5"' : ''}>${line(hx, hipY, ex, ey, far ? 4.8 : 5.6)}</g>`;
  };
  const wag = 18 * Math.sin(TAU * t * 2);
  const flop = 8 * Math.sin(TAU * t * 2 - 0.8);
  const headY = by - 8.6 + (o.tilt ? 1.2 : 0);
  const blink = o.blink ? 0.3 : 1;
  return `<g ${STROKE}>
    ${leg(33.5, Math.PI, true)}${leg(18.5, 0, true)}
    ${rot(wag, 12.5, by - 1.5, `<path d="M12.5 ${r2(by - 1.5)}Q6.5 ${r2(by - 3.5)} 5.6 ${r2(by - 12)}" stroke-width="3.6"/><circle cx="5.6" cy="${r2(by - 13.2)}" r="2.6" fill="#37b3ee" stroke="none"/>`)}
    ${line(14, by, 38, by, 13.4)}
    ${leg(36, 0, false)}${leg(17, Math.PI, false)}
    ${line(38.5, by - 2.5, 43.5, by - 6, 7)}
    ${rot(flop, 44.6, headY - 5.4, line(44.6, headY - 5.4, 41.4, headY + 2.2, 4.8))}
    ${ring(49, headY, 7.2, 5.5)}
    ${line(54.6, headY + 1.8, 60, headY + 3.4, 6.2)}
  </g>
  <g fill="${EYE}" stroke="none"><ellipse cx="50.2" cy="${r2(headY - 0.3)}" rx="1.5" ry="${r2(1.5 * blink)}"/><circle cx="61.2" cy="${r2(headY + 3.2)}" r="1.3"/></g>`;
}

/* ───────────────────────────── ROBOT NGƯỜI (nhìn ngang, chạy bộ tại chỗ) ───────────────────────────── */
export function bot(t, o = {}) {
  const A = TAU * t;
  const bob = -2 * Math.abs(Math.sin(A));
  const hx = 29;
  const hipY = 42 + bob;
  const lean = 8;
  const limb = (sx, sy, a1, a2, l1, l2) => {
    const ex = sx + l1 * Math.sin(a1), ey = sy + l1 * Math.cos(a1);
    const fx = ex + l2 * Math.sin(a2), fy = ey + l2 * Math.cos(a2);
    return { pts: [[sx, sy], [ex, ey], [fx, fy]], fx, fy };
  };
  const legOf = (ph, far) => {
    const th = 0.78 * Math.sin(A + ph);
    const c = Math.cos(A + ph);
    const k = c > 0 ? 1.35 * c : 0;
    const l = limb(hx, hipY, th, th - k, 8, 8);
    const foot = line(l.fx - 0.4, l.fy + 0.3, l.fx + 4.6, l.fy + 0.3, far ? 4.4 : 5);
    return `<g ${far ? 'opacity=".5"' : ''}>${poly(l.pts, far ? 4.8 : 5.4)}${foot}</g>`;
  };
  const armOf = (ph, far) => {
    const a = -0.95 * Math.sin(A + ph);
    const l = limb(hx, 31 + bob, a, a + 1.1, 6.5, 6);
    return `<g ${far ? 'opacity=".5"' : ''}>${poly(l.pts, far ? 4.2 : 4.8)}</g>`;
  };
  const headY = 15 + bob;
  const blink = o.blink ? 0.3 : 1;
  const pulse = 0.55 + 0.45 * Math.abs(Math.sin(A));
  const upperFar = armOf(Math.PI, true);
  const upperNear = armOf(0, false);
  return `<g ${STROKE}>
    ${legOf(Math.PI, true)}
    ${rot(lean, hx, hipY, `${upperFar}
      ${line(hx, 30 + bob, hx, hipY - 3, 12.5)}
      ${line(hx + 1, headY - 9.4, hx + 2.2, headY - 13, 2.6)}
      ${ring(hx + 1, headY, 7.2, 5.6)}`)}
    ${legOf(0, false)}
    ${rot(lean, hx, hipY, upperNear)}
  </g>
  <g transform="rotate(${lean} ${hx} ${r2(hipY)})"><g fill="${EYE}" stroke="none"><ellipse cx="${hx + 3.1}" cy="${r2(headY)}" rx="1.55" ry="${r2(1.55 * blink)}"/></g>
  <circle cx="${hx + 2.5}" cy="${r2(headY - 14.6)}" r="2.4" fill="#5fe0ff" opacity="${r2(pulse)}"/><circle cx="${hx + 1.4}" cy="${r2(35.5 + bob)}" r="1.35" fill="${EYE}" opacity="${r2(0.45 + 0.5 * pulse)}"/></g>`;
}

/* ───────────────────────────── DRONE (lơ lửng, quét) ───────────────────────────── */
export function drone(t) {
  const A = TAU * t;
  const bob = 1.3 * Math.sin(A);
  const cy = 36 + bob;
  const spin = Math.floor(t * 8) % 2; // cánh quạt: hai trạng thái mờ xen kẽ
  const sweep = 5 * Math.sin(A);
  return `<g stroke="none"><path d="M${P(28 + sweep, cy + 12)}L${P(36 + sweep, cy + 12)}L${P(46 + sweep * 1.4, 62)}L${P(18 + sweep * 1.4, 62)}Z" fill="url(#loBeam)" opacity=".5"/></g>
  <g ${STROKE}>
    ${line(32, cy - 12, 32, cy - 17.5, 3)}
    ${line(14, cy - 18.5, 50, cy - 18.5, 3)}
    <ellipse cx="14" cy="${r2(cy - 20.6)}" rx="${spin ? 9.5 : 6}" ry="1.5" stroke-width="2" opacity="${spin ? 0.55 : 0.9}"/>
    <ellipse cx="50" cy="${r2(cy - 20.6)}" rx="${spin ? 6 : 9.5}" ry="1.5" stroke-width="2" opacity="${spin ? 0.9 : 0.55}"/>
    ${line(24.5, cy + 9, 19.5, cy + 15.5, 3.2)}${line(39.5, cy + 9, 44.5, cy + 15.5, 3.2)}
    ${ring(32, cy, 9.6, 6.6)}
  </g>
  <g fill="${EYE}" stroke="none"><circle cx="${r2(32 + 1.4 * Math.sin(A * 2))}" cy="${r2(cy)}" r="2"/></g>`;
}

/* ───────────────────────────── TÊN LỬA (bay lên, lửa nhấp nháy) ───────────────────────────── */
export function rocket(t) {
  const A = TAU * t;
  const shake = 0.45 * Math.sin(A * 6);
  const fl = [0, 1, 2].map((i) => 5.5 + 3.5 * Math.abs(Math.sin(A * 3 + i * 1.7)));
  return `<g transform="translate(${r2(shake)} 0)" ${STROKE}>
    <path d="M32 5.5C39.5 11.5 41 22.5 40 38.5L24 38.5C23 22.5 24.5 11.5 32 5.5Z" stroke-width="5.4"/>
    ${poly([[24, 33], [16.5, 43], [24.5, 40.5]], 4.2)}${poly([[40, 33], [47.5, 43], [39.5, 40.5]], 4.2)}
    <g opacity=".85">${line(27.5, 45, 27.5, 45 + fl[0], 3)}${line(32, 45, 32, 45 + fl[1] + 2, 3.4)}${line(36.5, 45, 36.5, 45 + fl[2], 3)}</g>
  </g>
  <g transform="translate(${r2(shake)} 0)"><circle cx="32" cy="22" r="3.4" fill="none" stroke="${EYE}" stroke-width="2.2"/></g>`;
}

/** Bọc một mảnh SVG thành thẻ <svg> hoàn chỉnh với kích thước (px) và lớp phát sáng. */
export function svg(inner, size, { glow = 0.55, cls = '' } = {}) {
  const blur = Math.max(1.2, size / 22);
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 64 64" style="overflow:visible;filter:drop-shadow(0 0 ${r2(blur)}px rgba(34,188,236,${glow}))" aria-hidden="true">${inner}</svg>`;
}

/** Chuyển cảnh «quét sáng»: bên trái đường quét là nhân vật, bên phải là logo (p ∈ [0,1]); đường quét là một dải sáng như vệt sheen của logo. */
export function wipe(charInner, p, id = 'w') {
  const x = -4 + 72 * p;
  return `<defs>
    <clipPath id="${id}L"><rect x="-10" y="-10" width="${r2(Math.max(0, x + 10))}" height="90"/></clipPath>
    <clipPath id="${id}R"><rect x="${r2(x)}" y="-10" width="${r2(Math.max(0, 80 - x))}" height="90"/></clipPath>
  </defs>
  <g clip-path="url(#${id}R)">${logo()}</g>
  <g clip-path="url(#${id}L)">${charInner}</g>
  <rect x="${r2(x - 6)}" y="0" width="12" height="64" fill="url(#loSheen)" opacity="${p > 0.02 && p < 0.98 ? 0.9 : 0}"/>`;
}
