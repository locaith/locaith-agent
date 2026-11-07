/** (lane:sessions-ux) Văn bản có các khoảng [bắt đầu, kết thúc) được làm nổi bằng <mark>. */
import type { ComponentChildren } from 'preact';

export function Marked({ text, marks }: { text: string; marks?: ReadonlyArray<readonly [number, number]> }) {
  if (!marks || marks.length === 0) return <>{text}</>;
  const out: ComponentChildren[] = [];
  let at = 0;
  for (const [a, b] of marks) {
    const s = Math.max(at, Math.min(a, text.length));
    const e = Math.max(s, Math.min(b, text.length));
    if (e <= s) continue;
    if (s > at) out.push(text.slice(at, s));
    out.push(<mark key={s}>{text.slice(s, e)}</mark>);
    at = e;
  }
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}
