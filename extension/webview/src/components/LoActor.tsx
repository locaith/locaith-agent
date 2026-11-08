/**
 * «Nhân vật chờ» ở dòng đang chạy: logo Lo phát sáng như cũ; chờ lâu thì quét sáng biến hình thành chó robot / robot người /
 * drone / tên lửa rồi quét ngược về logo (lịch ở brand/actorPlan.ts, hình ở brand/sprites.ts).
 *
 * Ô cố định 20×20 px (đệm âm để KHÔNG đổi chiều cao dòng). Hoạt hoạ hoàn toàn bằng CSS (bật/tắt khung 6 khung / 0,9 s, chuyển cảnh
 * clip-path 0,5 s) — JS chỉ kiểm lịch 4 lần/giây và chỉ đổi state khi đổi cảnh. Giảm chuyển động → chỉ còn logo.
 * Thành phần tự đếm giờ từ lúc gắn vào (cùng gốc với đồng hồ giây của dòng chờ, vì cùng gắn một lúc).
 */
import { useEffect, useState } from 'preact/hooks';
import { actorPlan, actorTarget, WIPE_SEC, type ActorKind } from '../brand/actorPlan';
import { ACTOR_SVG } from '../brand/sprites';
import { cx } from '../util';
import { LoSpinner } from './Brand';

type Mode = 'logo' | 'in' | 'char' | 'out';
interface Stage {
  mode: Mode;
  actor: ActorKind | null;
}

const WIPE_MS = WIPE_SEC * 1000;
const KINDS = new Set<string>(['dog', 'bot', 'drone', 'rocket']);

/**
 * Chỉ dùng cho harness ảnh chụp: `window.__LO_ACTOR__ = 'dog:char'` (hoặc `:in`, `:out`) khoá cảnh, không chạy lịch.
 * Trên máy người dùng biến này không bao giờ được đặt.
 */
function debugStage(): Stage | null {
  const v = (globalThis as { __LO_ACTOR__?: unknown }).__LO_ACTOR__;
  if (typeof v !== 'string') return null;
  const [kind, mode] = v.split(':');
  if (!KINDS.has(kind) || !['in', 'char', 'out'].includes(mode)) return null;
  return { mode: mode as Mode, actor: kind as ActorKind };
}

function useReducedMotion(): boolean {
  const q = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const [reduced, setReduced] = useState(q ? q.matches : false);
  useEffect(() => {
    if (!q) return;
    const on = () => setReduced(q.matches);
    on();
    q.addEventListener?.('change', on);
    return () => q.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

export function LoActor({ seed }: { seed: number }) {
  const debug = debugStage();
  const reduced = useReducedMotion();
  const [stage, setStage] = useState<Stage>(debug ?? { mode: 'logo', actor: null });

  useEffect(() => {
    if (reduced || debug) return;
    const t0 = Date.now();
    let cur: Stage = { mode: 'logo', actor: null };
    let hold: number | undefined;
    const commit = (s: Stage) => {
      cur = s;
      setStage(s);
    };
    const tick = () => {
      if (hold !== undefined) return; // đang chạy chuyển cảnh 0,5 s
      const target = actorTarget(actorPlan((Date.now() - t0) / 1000, seed));
      if (cur.mode === 'logo' && target) {
        commit({ mode: 'in', actor: target });
        hold = window.setTimeout(() => {
          hold = undefined;
          commit({ mode: 'char', actor: target });
          tick();
        }, WIPE_MS + 20);
      } else if (cur.mode === 'char' && target !== cur.actor) {
        const was = cur.actor;
        commit({ mode: 'out', actor: was });
        hold = window.setTimeout(() => {
          hold = undefined;
          commit({ mode: 'logo', actor: null });
          tick();
        }, WIPE_MS + 20);
      }
    };
    const id = window.setInterval(tick, 250);
    tick();
    return () => {
      window.clearInterval(id);
      if (hold !== undefined) window.clearTimeout(hold);
    };
  }, [reduced, seed]);

  const { mode, actor } = reduced && !debug ? ({ mode: 'logo', actor: null } as Stage) : stage;
  return (
    <span class={cx('lo-actor', `is-${mode}`, actor && `a-${actor}`)} aria-hidden="true">
      {mode !== 'char' && (
        <span class="lo-actor-logo" key="logo">
          <LoSpinner size={18} />
        </span>
      )}
      {actor && mode !== 'logo' && <svg key="char" class="lo-actor-char" viewBox="0 0 64 64" focusable="false" dangerouslySetInnerHTML={{ __html: ACTOR_SVG[actor] }} />}
      {(mode === 'in' || mode === 'out') && <span class="lo-actor-sheen" key="sheen" />}
    </span>
  );
}
