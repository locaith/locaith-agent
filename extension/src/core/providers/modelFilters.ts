/**
 * Lọc và xếp danh sách model thô lấy từ API của từng hãng thành danh sách dùng được cho trò chuyện.
 *
 * Nguyên tắc (từ skill gemini-model-list, áp dụng cho mọi hãng): không chép tay danh sách model;
 * hỏi chính hãng bằng khoá đang dùng, bỏ những model không viết được văn bản (ảnh, âm thanh, embedding…),
 * bỏ bản chụp có ngày, xếp mới nhất lên đầu.
 */

import type { ModelInfo } from '../types';

export interface RawModel {
  id: string;
  /** Unix ms. */
  createdAt?: number;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** (lane:sessions-ux) Giá USD / 1 triệu token nếu API danh sách model trả về (OpenRouter: `pricing.prompt/completion` theo token). */
  pricing?: { inputPerM: number; outputPerM: number };
}

/** (lane:sessions-ux) Đọc `pricing` kiểu OpenRouter (chuỗi USD mỗi token) → USD / 1 triệu token. Giá thiếu, âm, không phải số → bỏ (không đoán). */
export function parseListPricing(raw: unknown): { inputPerM: number; outputPerM: number } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
    return Number.isFinite(n) && n >= 0 && n < 1 ? n : undefined; // > 1 USD mỗi token = dữ liệu lạ (OpenRouter dùng -1 cho "giá thay đổi")
  };
  const i = num(o.prompt);
  const out = num(o.completion);
  if (i === undefined || out === undefined) return undefined;
  return { inputPerM: Math.round(i * 1e6 * 1e4) / 1e4, outputPerM: Math.round(out * 1e6 * 1e4) / 1e4 };
}

function newestFirst(a: RawModel, b: RawModel): number {
  return (b.createdAt ?? 0) - (a.createdAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function toInfo(m: RawModel): ModelInfo {
  const info: ModelInfo = { id: m.id, label: m.name?.trim() || m.id };
  if (m.createdAt) info.createdAt = m.createdAt;
  if (m.contextWindow) info.contextWindow = m.contextWindow;
  if (m.maxOutputTokens) info.maxOutputTokens = m.maxOutputTokens;
  if (m.pricing) info.pricing = m.pricing; // (lane:sessions-ux)
  return info;
}

/** Bản chụp theo ngày kiểu OpenAI: `-2024-08-06` hoặc `-20240806`. */
const DATED_SNAPSHOT = /-(?:\d{4}-\d{2}-\d{2}|\d{8})$/;

// ── OpenAI ───────────────────────────────────────────────────────────────────

const OPENAI_CHAT = /^(?:gpt-|o\d|chatgpt-)/i;
const OPENAI_NOT_CHAT =
  /(?:embedding|whisper|tts|dall-e|image|audio|realtime|transcribe|moderation|davinci|babbage|search|instruct|computer-use|sora|speech|diariz|guard|-oss)/i;

export function selectOpenAIModels(raw: readonly RawModel[]): ModelInfo[] {
  const seen = new Set<string>();
  return raw
    .filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return OPENAI_CHAT.test(m.id) && !OPENAI_NOT_CHAT.test(m.id) && !DATED_SNAPSHOT.test(m.id);
    })
    .sort(newestFirst)
    .map(toInfo);
}

// ── xAI ──────────────────────────────────────────────────────────────────────

const XAI_NOT_CHAT = /(?:image|imagine|video|embed|tts|stt|speech|voice|multi-agent)/i;

function xaiVersion(id: string): number {
  const m = /^grok-(\d+(?:\.\d+)?)/i.exec(id);
  return m ? Number(m[1]) : 0;
}

export function selectXaiModels(raw: readonly RawModel[]): ModelInfo[] {
  const seen = new Set<string>();
  return raw
    .filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return /^grok-/i.test(m.id) && !XAI_NOT_CHAT.test(m.id);
    })
    .sort((a, b) => xaiVersion(b.id) - xaiVersion(a.id) || newestFirst(a, b))
    .map(toInfo);
}

// ── DeepSeek ─────────────────────────────────────────────────────────────────

export function selectDeepseekModels(raw: readonly RawModel[]): ModelInfo[] {
  const seen = new Set<string>();
  return raw
    .filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return !/(?:embed|-exp)/i.test(m.id);
    })
    .sort(newestFirst)
    .map(toInfo);
}

// ── API tương thích OpenAI khác ──────────────────────────────────────────────

export function selectGenericModels(raw: readonly RawModel[]): ModelInfo[] {
  const seen = new Set<string>();
  return raw
    .filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return !/(?:embed|rerank|whisper|tts|stt|moderation|dall-e|image-gen)/i.test(m.id);
    })
    .sort(newestFirst)
    .map(toInfo);
}

// ── Gemini (port từ skill gemini-model-list) ─────────────────────────────────

export type GeminiModelKind = 'text' | 'image';

export interface GeminiModelOption {
  value: string;
  label: string;
  tier?: 'top' | 'balanced' | 'fast';
  version?: number;
}

/** Một phần tử của `models.list`, chỉ giữ các trường cần dùng. */
export interface GeminiApiModel {
  name: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  thinking?: boolean;
  supportedGenerationMethods?: string[];
}

/**
 * Ảnh, giọng nói, âm thanh trực tiếp, embedding, agent… đều là model Gemini nhưng không viết nổi một
 * đoạn văn — đưa vào danh sách chỉ mời người dùng chọn nhầm.
 */
const NOT_TEXT =
  /(tts|image|live|audio|embedding|robotics|computer-use|imagen|veo|aqa|learnlm|thinking-exp|-exp|omni|nano-banana|transcribe|translate|customtools)/i;
const IS_IMAGE = /(image|nano-banana)/i;
const NOT_IMAGE =
  /(tts|live|audio|embedding|robotics|computer-use|imagen|veo|aqa|learnlm|-exp|omni|transcribe|translate|customtools)/i;

/** Bản chụp có ngày ("-001", "-0827", "-05-20") là cùng model với tên không số. */
const GEMINI_SNAPSHOT = /-(\d{3,4}|\d{2}-\d{2})$/;
const GEMINI_VERSION = /^gemini-(\d+(?:\.\d+)?)-/;
const NANO_VERSION = /nano-banana-(\d+(?:\.\d+)?)/;
const MODELS_MAX = 12;

/**
 * Giữ model dùng được cho `kind`, xếp mới nhất lên đầu, rồi flash → flash-lite → pro trong cùng một đời.
 *
 * LỆCH SO VỚI SKILL: skill bỏ mọi "tên mã không thuộc họ nào" (flash/flash-lite/pro). Nhưng tài liệu Google
 * (10/2026) công bố `gemini-4-argon` là model chủ lực dạng văn bản, tên không có flash/pro. Vì vậy tên có
 * dạng `gemini-<số>-<…>` vượt qua bộ lọc NOT_TEXT mà không rõ họ được GIỮ LẠI với bậc 'top'. Tên không có
 * số phiên bản vẫn bị bỏ (đúng tinh thần "không đoán").
 */
export function selectGeminiModels(models: readonly GeminiApiModel[], kind: GeminiModelKind): GeminiModelOption[] {
  interface Candidate {
    option: GeminiModelOption;
    version: number;
    rank: number;
  }
  const picked: Candidate[] = [];
  const seen = new Set<string>();

  for (const m of models) {
    const name = m.name.replace(/^models\//, '');
    if (!name.startsWith('gemini-') || seen.has(name)) continue;
    if (!m.supportedGenerationMethods?.includes('generateContent')) continue;
    if (GEMINI_SNAPSHOT.test(name) || name.endsWith('-latest')) continue;
    if (kind === 'text' ? NOT_TEXT.test(name) : !IS_IMAGE.test(name) || NOT_IMAGE.test(name)) continue;
    seen.add(name);

    const version = Number(GEMINI_VERSION.exec(name)?.[1] ?? NANO_VERSION.exec(name)?.[1] ?? 0);

    let rank: number;
    let tier: 'top' | 'balanced' | 'fast';
    if (name.includes('flash-lite')) {
      rank = 1;
      tier = 'fast';
    } else if (name.includes('flash')) {
      rank = 0;
      tier = 'balanced';
    } else if (name.includes('pro')) {
      rank = 2;
      tier = 'top';
    } else if (kind === 'text') {
      // Tên mã có số phiên bản (ví dụ gemini-4-argon) = model chủ lực; không có số → không đoán.
      if (version === 0) continue;
      rank = -1;
      tier = 'top';
    } else {
      rank = 1;
      tier = 'balanced';
    }

    let label = m.displayName?.trim() || name;
    if (name.includes('preview') && !label.toLowerCase().includes('preview')) label += ' (preview)';
    picked.push({ option: { value: name, label, tier, version }, version, rank });
  }

  // Bản preview bị bỏ khi model nó xem trước đã ra mắt dưới tên chính thức.
  const released = picked.filter((c) => {
    const base = c.option.value.replace(/-preview$/, '');
    return base === c.option.value || !seen.has(base);
  });

  released.sort((a, b) => b.version - a.version || a.rank - b.rank || (a.option.value < b.option.value ? -1 : 1));

  const out = released.slice(0, MODELS_MAX).map((c) => c.option);
  if (out.length > 0) out[0] = { ...out[0], label: `${out[0].label} — mới nhất` };
  return out;
}
