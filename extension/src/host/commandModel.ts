/**
 * (lane:commands-agents) Chọn model cho MỘT lượt chạy của lệnh tuỳ chỉnh có `model:` trong frontmatter.
 * Khớp theo id đầy đủ, `nhàCungCấp:id`, hoặc một đoạn chữ duy nhất (ví dụ `flash`, `sonnet`). Mơ hồ/không khớp → null
 * (lượt vẫn chạy trên model của phiên, kèm một dòng cảnh báo), không bao giờ đoán bừa.
 */

export interface ModelChoice {
  provider: string;
  model: string;
}

export interface ProviderModels {
  id: string;
  models: { id: string; label: string }[];
}

const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export type ModelPick = { ok: true; pick: ModelChoice } | { ok: false; reason: 'none' | 'ambiguous' };

/** `inherit`/rỗng nghĩa là giữ model của phiên (trả về null). */
export function pickCommandModel(want: string | undefined, providers: readonly ProviderModels[]): ModelPick | null {
  const q = fold(want ?? '');
  if (!q || q === 'inherit' || q === 'default') return null;
  const all: (ModelChoice & { label: string })[] = [];
  for (const p of providers) for (const m of p.models) all.push({ provider: p.id, model: m.id, label: m.label });
  const exact = all.filter((x) => fold(x.model) === q || fold(`${x.provider}:${x.model}`) === q);
  if (exact.length === 1) return { ok: true, pick: { provider: exact[0].provider, model: exact[0].model } };
  if (exact.length > 1) return { ok: false, reason: 'ambiguous' };
  const loose = all.filter((x) => fold(x.model).includes(q) || fold(x.label).includes(q) || fold(`${x.provider}:${x.model}`).includes(q));
  if (loose.length === 1) return { ok: true, pick: { provider: loose[0].provider, model: loose[0].model } };
  return { ok: false, reason: loose.length === 0 ? 'none' : 'ambiguous' };
}
