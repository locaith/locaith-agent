/**
 * Mô tả tĩnh các nhà cung cấp dựng sẵn và các mẫu API tương thích OpenAI cho trình hướng dẫn "Thêm API".
 *
 * Danh sách `fallbackModels` chỉ dùng khi KHÔNG hỏi được hãng (chưa có khoá, mất mạng, khoá sai): cần ĐÚNG
 * chứ không cần ĐỦ. Khi có khoá, `ModelCatalog` lấy danh sách thật từ API và dùng các mục dưới đây để bổ sung
 * nhãn/bậc/cửa sổ ngữ cảnh theo id (số liệu theo tài liệu nhà cung cấp tháng 10/2026).
 */

import type { ModelInfo, ProviderFlavor, ProviderKind } from '../types';
import { LOCAITH_CONTEXT_WINDOW, LOCAITH_GATEWAY_URL, LOCAITH_MAX_OUTPUT_TOKENS, LOCAITH_MODEL_FLASH, LOCAITH_MODEL_SI, LOCAITH_PROVIDER_ID } from './locaithGateway';

export interface ProviderPreset {
  id: string;
  label: string;
  kind: ProviderKind;
  flavor: ProviderFlavor;
  baseUrl: string;
  /** Biến môi trường được thử theo thứ tự nếu chưa lưu khoá. */
  envKeys: string[];
  /** Trang cấp khoá API. */
  keyUrl?: string;
  requiresKey: boolean;
  /**
   * 'account' = "khoá" là token đăng nhập tài khoản Locaith do nơi chạy cấp (bản VS Code), không phải khoá API người dùng nhập:
   * không có ô nhập khoá, không đọc biến môi trường; chỉ được đăng ký khi nơi chạy truyền `account` cho ProviderRegistry (bản trình duyệt thì không).
   */
  credential?: 'account';
  defaultModel: string;
  /** Biểu thức chọn model rẻ/nhanh cho bộ tóm tắt nền (ưu tiên theo thứ tự). */
  fastModelHint: RegExp[];
  fallbackModels: ModelInfo[];
}

const M = 1_000_000;

export const BUILTIN_PRESETS: ProviderPreset[] = [
  {
    id: 'anthropic',
    label: 'Claude (Anthropic)',
    kind: 'anthropic',
    flavor: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    envKeys: ['ANTHROPIC_API_KEY'],
    keyUrl: 'https://console.anthropic.com/settings/keys',
    requiresKey: true,
    defaultModel: 'claude-opus-5-5',
    fastModelHint: [/haiku/i],
    fallbackModels: [
      { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', tier: 'top', contextWindow: M, maxOutputTokens: 128_000, reasoning: true, vision: true },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', tier: 'top', contextWindow: M, maxOutputTokens: 128_000, reasoning: true, vision: true },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', tier: 'balanced', contextWindow: M, maxOutputTokens: 128_000, reasoning: true, vision: true },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', tier: 'fast', contextWindow: M, maxOutputTokens: 128_000, reasoning: true, vision: true },
    ],
  },
  {
    id: 'openai',
    label: 'ChatGPT (OpenAI)',
    kind: 'openai-responses',
    flavor: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    envKeys: ['OPENAI_API_KEY'],
    keyUrl: 'https://platform.openai.com/api-keys',
    requiresKey: true,
    // Astra là model chủ lực OpenAI khuyên dùng; Sol cho hiệu năng sát Astra với giá 1/5 nên hợp vòng lặp
    // agent gọi công cụ nhiều lần → chọn Sol làm mặc định. Người dùng đổi sang Astra khi cần.
    defaultModel: 'gpt-6.1-sol',
    fastModelHint: [/luna/i, /nano|mini/i],
    fallbackModels: [
      { id: 'gpt-6-astra', label: 'GPT-6 Astra', tier: 'top', contextWindow: 1_050_000, maxOutputTokens: 128_000, reasoning: true, vision: true },
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', tier: 'balanced', contextWindow: 1_050_000, maxOutputTokens: 128_000, reasoning: true, vision: true },
      { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', tier: 'balanced', contextWindow: 1_050_000, maxOutputTokens: 128_000, reasoning: true, vision: true },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna', tier: 'fast', contextWindow: 1_050_000, maxOutputTokens: 128_000, reasoning: true, vision: true },
    ],
  },
  {
    id: 'gemini',
    label: 'Gemini (Google)',
    kind: 'gemini',
    flavor: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    keyUrl: 'https://aistudio.google.com/apikey',
    requiresKey: true,
    // Google khuyên gemini-3.8-flash cho agent và lập trình.
    defaultModel: 'gemini-3.8-flash',
    fastModelHint: [/flash-lite/i, /flash/i],
    fallbackModels: [
      { id: 'gemini-4-argon', label: 'Gemini 4 Argon', tier: 'top', contextWindow: M, reasoning: true, vision: true },
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', tier: 'balanced', contextWindow: M, reasoning: true, vision: true },
      { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', tier: 'balanced', contextWindow: M, reasoning: true, vision: true },
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', tier: 'fast', contextWindow: M, reasoning: true, vision: true },
      { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', tier: 'fast', contextWindow: M, reasoning: true, vision: true },
      { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)', tier: 'top', contextWindow: M, reasoning: true, vision: true },
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai-chat',
    flavor: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    envKeys: ['DEEPSEEK_API_KEY'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
    requiresKey: true,
    defaultModel: 'deepseek-flash',
    fastModelHint: [/flash/i],
    // Tài liệu DeepSeek (api-docs.deepseek.com, 11/2026): cả hai model đều có cửa sổ 1M token, đầu ra tối đa 384K.
    // Thiếu `contextWindow` thì giao diện rơi về 128K mặc định (ProviderService.contextWindow) — sai cho họ model này.
    fallbackModels: [
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', tier: 'top', contextWindow: M, maxOutputTokens: 393_216, reasoning: true },
      { id: 'deepseek-flash', label: 'DeepSeek V4.1 Flash', tier: 'fast', contextWindow: M, maxOutputTokens: 393_216, reasoning: true },
    ],
  },
  {
    id: 'xai',
    label: 'Grok (xAI)',
    kind: 'openai-responses',
    flavor: 'xai',
    baseUrl: 'https://api.x.ai/v1',
    envKeys: ['XAI_API_KEY'],
    keyUrl: 'https://console.x.ai',
    requiresKey: true,
    defaultModel: 'grok-4.7',
    fastModelHint: [/non-reasoning/i, /fast|mini/i],
    fallbackModels: [
      { id: 'grok-4.7', label: 'Grok 4.7', tier: 'top', contextWindow: 500_000, reasoning: true, vision: true },
      { id: 'grok-4.6', label: 'Grok 4.6', tier: 'top', contextWindow: 500_000, reasoning: true, vision: true },
      { id: 'grok-4.5', label: 'Grok 4.5', tier: 'balanced', contextWindow: 500_000, reasoning: true, vision: true },
      { id: 'grok-4.3', label: 'Grok 4.3', tier: 'balanced', contextWindow: M, reasoning: true, vision: true },
      { id: 'grok-4.20-0309-reasoning', label: 'Grok 4.20 (suy luận)', tier: 'balanced', contextWindow: M, reasoning: true, vision: true },
      { id: 'grok-4.20-0309-non-reasoning', label: 'Grok 4.20 (không suy luận)', tier: 'fast', contextWindow: M, reasoning: false, vision: true },
    ],
  },
];

/**
 * Nhà cung cấp dùng TÀI KHOẢN Locaith thay cho khoá API: họ AI Local (Locaith-v5-flash, Locaith-v5-SI) chạy qua cổng của Locaith.
 * Tách khỏi BUILTIN_PRESETS vì chỉ có nghĩa khi nơi chạy cấp được token đăng nhập (xem ProviderRegistryOptions.account).
 * Cùng cổng với Chrome/Edge và locaith.ai: hợp đồng trong docs/LOCAITH-MODELS.md.
 */
export const ACCOUNT_PRESETS: ProviderPreset[] = [
  {
    id: LOCAITH_PROVIDER_ID,
    label: 'Locaith AI Local',
    kind: 'openai-chat',
    // Cùng giao thức và cùng cách xử lý suy luận (thinking/reasoning_content) như DeepSeek: cổng chuyển tiếp nguyên các trường đó.
    flavor: 'deepseek',
    baseUrl: LOCAITH_GATEWAY_URL,
    envKeys: [],
    // Người dùng không nhập khoá nào; "khoá" ở đây là token tài khoản → chưa đăng nhập thì coi như chưa có khoá (không gọi mạng lấy danh sách model).
    requiresKey: true,
    credential: 'account',
    defaultModel: LOCAITH_MODEL_FLASH,
    fastModelHint: [/flash/i],
    fallbackModels: [
      { id: LOCAITH_MODEL_FLASH, label: 'Locaith-v5-flash', tier: 'fast', contextWindow: LOCAITH_CONTEXT_WINDOW, maxOutputTokens: LOCAITH_MAX_OUTPUT_TOKENS, reasoning: true },
      { id: LOCAITH_MODEL_SI, label: 'Locaith-v5-SI', tier: 'top', contextWindow: LOCAITH_CONTEXT_WINDOW, maxOutputTokens: LOCAITH_MAX_OUTPUT_TOKENS, reasoning: true },
    ],
  },
];

export interface CustomPreset {
  id: string;
  label: string;
  baseUrl: string;
  requiresKey: boolean;
  keyUrl?: string;
  note?: string;
}

/** Mẫu cho trình hướng dẫn "Thêm API tương thích OpenAI…" (đều dùng Chat Completions). */
export const CUSTOM_PRESETS: CustomPreset[] = [
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', requiresKey: true, keyUrl: 'https://openrouter.ai/keys', note: 'Một khoá dùng được hàng trăm model.' },
  { id: 'ollama', label: 'Ollama (máy cục bộ)', baseUrl: 'http://localhost:11434/v1', requiresKey: false, note: 'Chạy model mã nguồn mở ngay trên máy bạn; không cần khoá.' },
  { id: 'lmstudio', label: 'LM Studio (máy cục bộ)', baseUrl: 'http://localhost:1234/v1', requiresKey: false, note: 'Bật Local Server trong LM Studio trước khi dùng.' },
  { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', requiresKey: true, keyUrl: 'https://console.groq.com/keys' },
  { id: 'together', label: 'Together AI', baseUrl: 'https://api.together.xyz/v1', requiresKey: true, keyUrl: 'https://api.together.xyz/settings/api-keys' },
  { id: 'mistral', label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', requiresKey: true, keyUrl: 'https://console.mistral.ai/api-keys' },
  { id: 'fireworks', label: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1', requiresKey: true, keyUrl: 'https://fireworks.ai/account/api-keys' },
];

export function presetById(id: string): ProviderPreset | undefined {
  return BUILTIN_PRESETS.find((p) => p.id === id) ?? ACCOUNT_PRESETS.find((p) => p.id === id);
}

/**
 * Cửa sổ ngữ cảnh đã biết theo TÊN model, cho model mà API không nói rõ (DeepSeek không trả `context_length` ở /models, id cũ như `deepseek-v4-flash`
 * vẫn dùng được nhưng không có trong danh sách dự phòng). Trả `undefined` = không biết → nơi gọi dùng mặc định 128K.
 */
export function knownContextWindow(modelId: string): number | undefined {
  const id = modelId.toLowerCase();
  if (/^locaith-v5-/.test(id)) return LOCAITH_CONTEXT_WINDOW;
  if (/^deepseek-(flash|v4|v4\.\d)/.test(id)) return M;
  return undefined;
}
