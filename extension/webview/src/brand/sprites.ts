/**
 * Bộ nhân vật «logo Lo biến hình» (bộ ảnh đã duyệt 08/11/2026), chuyển từ scripts/brand/sprites.mjs.
 * Mọi hình vẽ bằng nét dày bo tròn + gradient Locaith (#22bcec → #625aec); đầu luôn là vòng tròn «o» của logo
 * (lỗ giữa vòng = mắt). Hộp vẽ 64×64.
 *
 * KHUNG TÍNH SẴN: 6 khung của mỗi nhân vật được dựng thành chuỗi SVG tĩnh MỘT lần lúc nạp module (ACTOR_FRAMES);
 * lúc chạy không tính toán gì — hoạt hoạ chỉ là CSS bật/tắt khung (xem brand.css, `.lo-fr`).
 * Lớp CSS (lo-st, lo-eye, lo-fx, lo-lamp, lo-beamp) để chủ đề sáng / tương phản cao đổi được màu mà không đụng hình.
 */
import type { ActorKind } from './actorPlan';

export const FRAME_COUNT = 6;
/** Khung nháy mắt (chỉ số từ 0 = «khung 4» trong ảnh). */
export const BLINK_FRAME = 3;

const TAU = Math.PI * 2;
const r2 = (n: number) => Math.round(n * 100) / 100;
const P = (x: number, y: number) => `${r2(x)} ${r2(y)}`;
const line = (x1: number, y1: number, x2: number, y2: number, w: number) => `<path d="M${P(x1, y1)}L${P(x2, y2)}" stroke-width="${w}"/>`;
const poly = (pts: readonly (readonly [number, number])[], w: number) => `<path d="M${pts.map(([x, y]) => P(x, y)).join('L')}" stroke-width="${w}"/>`;
const ring = (cx: number, cy: number, r: number, w: number) => `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r}" stroke-width="${w}"/>`;
const rot = (deg: number, cx: number, cy: number, inner: string) => `<g transform="rotate(${r2(deg)} ${r2(cx)} ${r2(cy)})">${inner}</g>`;

const EYE = '#effcff';
const STROKE = 'class="lo-st" fill="none" stroke="url(#lo-cg)" stroke-linecap="round" stroke-linejoin="round"';

interface FrameOpts {
  blink?: boolean;
  spin?: boolean;
}

/** Chó robot (nhìn ngang, quay mặt sang phải), chạy tại chỗ. */
function dog(t: number, o: FrameOpts = {}): string {
  const bob = -1.4 * Math.abs(Math.sin(TAU * t)); // thân nhấc lên lúc chân bay
  const by = 35 + bob;
  const hipY = by + 4.5;
  const L = 12.6;
  const leg = (hx: number, ph: number, far: boolean) => {
    const ang = 0.5 * Math.sin(TAU * t + ph);
    const c = Math.cos(TAU * t + ph);
    const lift = c > 0 ? 2.8 * c : 0;
    const ex = hx + L * Math.sin(ang);
    const ey = hipY + L * Math.cos(ang) - lift;
    return `<g ${far ? 'opacity=".5"' : ''}>${line(hx, hipY, ex, ey, far ? 4.8 : 5.6)}</g>`;
  };
  const wag = 18 * Math.sin(TAU * t * 2);
  const flop = 8 * Math.sin(TAU * t * 2 - 0.8);
  const headY = by - 8.6;
  const blink = o.blink ? 0.3 : 1;
  return `<g ${STROKE}>
    ${leg(33.5, Math.PI, true)}${leg(18.5, 0, true)}
    ${rot(wag, 12.5, by - 1.5, `<path d="M12.5 ${r2(by - 1.5)}Q6.5 ${r2(by - 3.5)} 5.6 ${r2(by - 12)}" stroke-width="3.6"/><circle class="lo-fx" cx="5.6" cy="${r2(by - 13.2)}" r="2.6" fill="#37b3ee" stroke="none"/>`)}
    ${line(14, by, 38, by, 13.4)}
    ${leg(36, 0, false)}${leg(17, Math.PI, false)}
    ${line(38.5, by - 2.5, 43.5, by - 6, 7)}
    ${rot(flop, 44.6, headY - 5.4, line(44.6, headY - 5.4, 41.4, headY + 2.2, 4.8))}
    ${ring(49, headY, 7.2, 5.5)}
    ${line(54.6, headY + 1.8, 60, headY + 3.4, 6.2)}
  </g>
  <g class="lo-eye" fill="${EYE}" stroke="none"><ellipse cx="50.2" cy="${r2(headY - 0.3)}" rx="1.5" ry="${r2(1.5 * blink)}"/><circle cx="61.2" cy="${r2(headY + 3.2)}" r="1.3"/></g>`;
}

/** Robot người (nhìn ngang, chạy bộ tại chỗ): ăng-ten nhấp sáng, đèn ngực thở nhịp. */
function bot(t: number, o: FrameOpts = {}): string {
  const A = TAU * t;
  const bob = -2 * Math.abs(Math.sin(A));
  const hx = 29;
  const hipY = 42 + bob;
  const lean = 8;
  const limb = (sx: number, sy: number, a1: number, a2: number, l1: number, l2: number) => {
    const ex = sx + l1 * Math.sin(a1);
    const ey = sy + l1 * Math.cos(a1);
    const fx = ex + l2 * Math.sin(a2);
    const fy = ey + l2 * Math.cos(a2);
    return { pts: [[sx, sy], [ex, ey], [fx, fy]] as [number, number][], fx, fy };
  };
  const legOf = (ph: number, far: boolean) => {
    const th = 0.78 * Math.sin(A + ph);
    const c = Math.cos(A + ph);
    const k = c > 0 ? 1.35 * c : 0;
    const l = limb(hx, hipY, th, th - k, 8, 8);
    const foot = line(l.fx - 0.4, l.fy + 0.3, l.fx + 4.6, l.fy + 0.3, far ? 4.4 : 5);
    return `<g ${far ? 'opacity=".5"' : ''}>${poly(l.pts, far ? 4.8 : 5.4)}${foot}</g>`;
  };
  const armOf = (ph: number, far: boolean) => {
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
  <g transform="rotate(${lean} ${hx} ${r2(hipY)})"><g class="lo-eye" fill="${EYE}" stroke="none"><ellipse cx="${hx + 3.1}" cy="${r2(headY)}" rx="1.55" ry="${r2(1.55 * blink)}"/></g>
  <circle class="lo-fx" cx="${hx + 2.5}" cy="${r2(headY - 14.6)}" r="2.4" fill="#5fe0ff" opacity="${r2(pulse)}"/><circle class="lo-lamp" cx="${hx + 1.4}" cy="${r2(35.5 + bob)}" r="1.35" fill="${EYE}" opacity="${r2(0.45 + 0.5 * pulse)}"/></g>`;
}

/** Drone lơ lửng: cánh quạt mờ xen kẽ, chùm sáng quét qua lại bên dưới. */
function drone(t: number, o: FrameOpts = {}): string {
  const A = TAU * t;
  const bob = 1.3 * Math.sin(A);
  const cy = 36 + bob;
  const spin = o.spin ? 1 : 0;
  const sweep = 5 * Math.sin(A);
  return `<g stroke="none"><path class="lo-beamp" d="M${P(28 + sweep, cy + 12)}L${P(36 + sweep, cy + 12)}L${P(46 + sweep * 1.4, 62)}L${P(18 + sweep * 1.4, 62)}Z" fill="url(#lo-beam)" opacity=".5"/></g>
  <g ${STROKE}>
    ${line(32, cy - 12, 32, cy - 17.5, 3)}
    ${line(14, cy - 18.5, 50, cy - 18.5, 3)}
    <ellipse cx="14" cy="${r2(cy - 20.6)}" rx="${spin ? 9.5 : 6}" ry="1.5" stroke-width="2" opacity="${spin ? 0.55 : 0.9}"/>
    <ellipse cx="50" cy="${r2(cy - 20.6)}" rx="${spin ? 6 : 9.5}" ry="1.5" stroke-width="2" opacity="${spin ? 0.9 : 0.55}"/>
    ${line(24.5, cy + 9, 19.5, cy + 15.5, 3.2)}${line(39.5, cy + 9, 44.5, cy + 15.5, 3.2)}
    ${ring(32, cy, 9.6, 6.6)}
  </g>
  <g class="lo-eye" fill="${EYE}" stroke="none"><circle cx="${r2(32 + 1.4 * Math.sin(A * 2))}" cy="${r2(cy)}" r="2"/></g>`;
}

/** Tên lửa bay lên: cửa sổ tròn là «o», lửa nhấp nháy ba tia, cả thân rung nhẹ. */
function rocket(t: number): string {
  const A = TAU * t;
  // 6 khung: thân rung qua lại mỗi khung (±0,45), lửa ba tia lệch pha nhau chu kỳ 3 khung — bản mẫu cũ (sin A·6, A·3) rơi đúng nút nên 6 khung giống hệt
  const shake = 0.45 * Math.cos(A * 3);
  const fl = [0, 1, 2].map((i) => 5.5 + 3.5 * Math.abs(Math.sin(A * 2 + i * 1.7)));
  return `<g transform="translate(${r2(shake)} 0)" ${STROKE}>
    <path d="M32 5.5C39.5 11.5 41 22.5 40 38.5L24 38.5C23 22.5 24.5 11.5 32 5.5Z" stroke-width="5.4"/>
    ${poly([[24, 33], [16.5, 43], [24.5, 40.5]], 4.2)}${poly([[40, 33], [47.5, 43], [39.5, 40.5]], 4.2)}
    <g opacity=".85">${line(27.5, 45, 27.5, 45 + fl[0], 3)}${line(32, 45, 32, 45 + fl[1] + 2, 3.4)}${line(36.5, 45, 36.5, 45 + fl[2], 3)}</g>
  </g>
  <g transform="translate(${r2(shake)} 0)"><circle class="lo-eye-ring" cx="32" cy="22" r="3.4" fill="none" stroke="${EYE}" stroke-width="2.2"/></g>`;
}

const DRAW: Record<ActorKind, (t: number, o: FrameOpts) => string> = { dog, bot, drone, rocket };

/** Dựng đủ 6 khung (chuỗi `<g class="lo-fr">…</g>`), nháy mắt ở khung BLINK_FRAME; cánh quạt drone đổi trạng thái mỗi khung. */
function buildFrames(kind: ActorKind): string[] {
  const out: string[] = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const inner = DRAW[kind](i / FRAME_COUNT, { blink: i === BLINK_FRAME, spin: i % 2 === 1 });
    out.push(`<g class="lo-fr">${inner}</g>`);
  }
  return out;
}

/** Chuỗi SVG tĩnh của 6 khung mỗi nhân vật — tính MỘT lần lúc nạp module. */
export const ACTOR_FRAMES: Readonly<Record<ActorKind, readonly string[]>> = {
  dog: buildFrames('dog'),
  bot: buildFrames('bot'),
  drone: buildFrames('drone'),
  rocket: buildFrames('rocket'),
};

/** Toàn bộ nội dung `<svg>` của một nhân vật (6 khung xếp chồng; CSS chỉ cho hiện một khung mỗi lúc). */
export const ACTOR_SVG: Readonly<Record<ActorKind, string>> = {
  dog: ACTOR_FRAMES.dog.join(''),
  bot: ACTOR_FRAMES.bot.join(''),
  drone: ACTOR_FRAMES.drone.join(''),
  rocket: ACTOR_FRAMES.rocket.join(''),
};
