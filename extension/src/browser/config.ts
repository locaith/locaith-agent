/**
 * Cấu hình của bản trình duyệt. Một đối tượng JSON duy nhất trong chrome.storage.local (`nd.config`), được làm sạch khi đọc
 * (dữ liệu có thể do phiên bản cũ ghi hoặc bị sửa tay): kiểu sai/ngoài khoảng → dùng mặc định.
 */

import { DEFAULT_ENGINE_SETTINGS, type EngineSettings } from '../core/engine/types';
import type { CustomProviderConfig } from '../core/providers/registry';
import { EMPTY_RATING, addComment, countRatingSend, denyRating, markRated, markSent, sanitizeRating, submitStars, type RatingKind, type RatingState } from './rating';
import { isAllowedBaseUrl } from '../shared/baseUrl';
import {
  DEFAULT_BROWSER_SETTINGS,
  DEFAULT_UI_SETTINGS,
  PERMISSION_MODES,
  type BrowserSettings,
  type CustomProviderInput,
  type PermissionMode,
  type UiSettings,
} from '../shared/protocol';
import type { KeyValueStore } from './kv';

const KEY = 'nd.config';
/** Trạng thái lời mời đánh giá — khoá riêng, xem BrowserConfig.rating(). */
const RATING_KEY = 'nd.rating';

interface Stored {
  ui: UiSettings;
  browser: BrowserSettings;
  baseUrls: Record<string, string>;
  customProviders: CustomProviderConfig[];
  lastModel?: { provider: string; model: string };
}

const clamp = (n: unknown, lo: number, hi: number, d: number): number => (typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d);
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const oneOf = <T extends string>(v: unknown, all: readonly T[], d: T): T => (typeof v === 'string' && (all as readonly string[]).includes(v) ? (v as T) : d);

const FONTS = ['be-vietnam-pro', 'manrope', 'inter', 'system'] as const;
const CODE_FONTS = ['jetbrains-mono', 'editor'] as const;
const PROVIDER_KINDS = ['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as const;

/** Id của API tuỳ chỉnh: a-z, 0-9, gạch ngang. */
export function slugifyId(label: string): string {
  const s = label
    .normalize('NFD')
    .replace(new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, 'g'), '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return s || 'custom';
}

export function sanitizeConfig(raw: unknown): Stored {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const ui = (r.ui && typeof r.ui === 'object' ? r.ui : {}) as Record<string, unknown>;
  const br = (r.browser && typeof r.browser === 'object' ? r.browser : {}) as Record<string, unknown>;
  const dU = DEFAULT_UI_SETTINGS;
  const dB = DEFAULT_BROWSER_SETTINGS;

  const baseUrls: Record<string, string> = {};
  if (r.baseUrls && typeof r.baseUrls === 'object' && !Array.isArray(r.baseUrls)) {
    for (const [id, url] of Object.entries(r.baseUrls as Record<string, unknown>)) if (typeof url === 'string' && isAllowedBaseUrl(url)) baseUrls[id] = url.trim();
  }

  const customProviders: CustomProviderConfig[] = [];
  const seen = new Set<string>();
  if (Array.isArray(r.customProviders)) {
    for (const c of r.customProviders as Record<string, unknown>[]) {
      if (!c || typeof c !== 'object' || typeof c.id !== 'string' || typeof c.baseUrl !== 'string' || !/^[a-z0-9-]{1,40}$/.test(c.id) || seen.has(c.id) || !isAllowedBaseUrl(c.baseUrl)) continue;
      seen.add(c.id);
      customProviders.push({
        id: c.id,
        label: typeof c.label === 'string' && c.label.trim() ? c.label.trim().slice(0, 60) : c.id,
        kind: oneOf(c.kind, PROVIDER_KINDS, 'openai-chat'),
        baseUrl: c.baseUrl.trim(),
        models: Array.isArray(c.models) ? (c.models as unknown[]).filter((m): m is string => typeof m === 'string' && m.trim().length > 0 && m.length < 200).map((m) => m.trim()).slice(0, 50) : [],
        requiresKey: bool(c.requiresKey, false),
        keyUrl: typeof c.keyUrl === 'string' ? c.keyUrl : undefined,
      });
    }
  }

  const lm = r.lastModel as { provider?: unknown; model?: unknown } | undefined;
  return {
    ui: {
      language: oneOf(ui.language, ['vi', 'en'] as const, dU.language),
      fontFamily: oneOf(ui.fontFamily, FONTS, dU.fontFamily),
      fontSize: clamp(ui.fontSize, 12, 20, dU.fontSize),
      lineHeight: clamp(ui.lineHeight, 1.3, 2.2, dU.lineHeight),
      codeFont: oneOf(ui.codeFont, CODE_FONTS, dU.codeFont),
      showThinking: bool(ui.showThinking, dU.showThinking),
    },
    browser: {
      defaultMode: oneOf(br.defaultMode, PERMISSION_MODES, dB.defaultMode),
      allowBypass: bool(br.allowBypass, dB.allowBypass),
      maxTurns: Math.round(clamp(br.maxTurns, 3, 100, dB.maxTurns)),
      summarizer: bool(br.summarizer, dB.summarizer),
      autoCompact: bool(br.autoCompact, dB.autoCompact),
      attachTabContext: bool(br.attachTabContext, dB.attachTabContext),
      presence: bool(br.presence, dB.presence),
      focusTabs: bool(br.focusTabs, dB.focusTabs),
      pinTab: bool(br.pinTab, dB.pinTab),
      customInstructions: typeof br.customInstructions === 'string' ? br.customInstructions.slice(0, 8000) : dB.customInstructions,
    },
    baseUrls,
    customProviders,
    lastModel: lm && typeof lm.provider === 'string' && typeof lm.model === 'string' ? { provider: lm.provider, model: lm.model } : undefined,
  };
}

export class BrowserConfig {
  private data: Stored = sanitizeConfig(undefined);
  private readonly listeners = new Set<() => void>();

  constructor(private readonly kv: KeyValueStore) {
    kv.onChanged((keys) => {
      if (keys.includes(KEY)) void this.load().then(() => this.emit());
    });
  }

  async load(): Promise<void> {
    this.data = sanitizeConfig(await this.kv.get(KEY));
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  onDidChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private async save(): Promise<void> {
    await this.kv.set(KEY, this.data);
    this.emit();
  }

  language(): 'vi' | 'en' {
    return this.data.ui.language;
  }

  ui(): UiSettings {
    return { ...this.data.ui };
  }

  /** Khoá và kiểu giá trị đến từ giao diện nên được kiểm tra lại: sanitize xử lý mọi giá trị sai. */
  async setUi<K extends keyof UiSettings>(key: K, value: UiSettings[K]): Promise<void> {
    if (!(key in DEFAULT_UI_SETTINGS) || typeof value !== typeof DEFAULT_UI_SETTINGS[key]) return;
    this.data = sanitizeConfig({ ...this.data, ui: { ...this.data.ui, [key]: value } });
    await this.save();
  }

  browser(): BrowserSettings {
    return { ...this.data.browser };
  }

  async setBrowser<K extends keyof BrowserSettings>(key: K, value: BrowserSettings[K]): Promise<void> {
    if (!(key in DEFAULT_BROWSER_SETTINGS) || typeof value !== typeof DEFAULT_BROWSER_SETTINGS[key]) return;
    this.data = sanitizeConfig({ ...this.data, browser: { ...this.data.browser, [key]: value } });
    await this.save();
  }

  engine(): EngineSettings {
    const b = this.data.browser;
    return { ...DEFAULT_ENGINE_SETTINGS, language: this.language(), maxTurns: b.maxTurns, autoCompact: b.autoCompact, instructionFiles: [] };
  }

  defaultMode(): PermissionMode {
    const b = this.data.browser;
    return b.defaultMode === 'bypass' && !b.allowBypass ? 'default' : b.defaultMode;
  }

  allowBypass(): boolean {
    return this.data.browser.allowBypass;
  }

  summarizerEnabled(): boolean {
    return this.data.browser.summarizer;
  }

  summarizerModel(): string {
    return 'auto';
  }

  eagerInput(): boolean {
    return true;
  }

  baseUrls(): Record<string, string> {
    return { ...this.data.baseUrls };
  }

  async setBaseUrl(providerId: string, url: string): Promise<void> {
    const next = { ...this.data.baseUrls };
    if (url.trim()) next[providerId] = url.trim();
    else delete next[providerId];
    this.data = sanitizeConfig({ ...this.data, baseUrls: next });
    await this.save();
  }

  customProviders(): CustomProviderConfig[] {
    return this.data.customProviders.map((c) => ({ ...c }));
  }

  async setCustomProviders(list: CustomProviderConfig[]): Promise<void> {
    this.data = sanitizeConfig({ ...this.data, customProviders: list });
    await this.save();
  }

  /** Thêm API tuỳ chỉnh từ biểu mẫu trong giao diện. Trả id, hoặc lỗi (tiếng Việt) nếu dữ liệu không hợp lệ. */
  async addCustomProvider(input: CustomProviderInput, builtinIds: ReadonlySet<string>): Promise<{ id: string } | { error: string }> {
    const label = (input.label ?? '').trim();
    const baseUrl = (input.baseUrl ?? '').trim();
    if (!label) return { error: 'Hãy đặt tên cho API.' };
    if (!isAllowedBaseUrl(baseUrl)) return { error: 'URL không hợp lệ: cần https (http chỉ cho localhost / mạng nội bộ), không kèm tên đăng nhập.' };
    const taken = new Set([...builtinIds, ...this.data.customProviders.map((c) => c.id)]);
    let id = slugifyId(label);
    for (let n = 2; taken.has(id); n++) id = `${slugifyId(label)}-${n}`.slice(0, 40);
    const models = (input.models ?? '')
      .split(/[\n,;]+/)
      .map((m) => m.trim())
      .filter(Boolean);
    await this.setCustomProviders([
      ...this.data.customProviders,
      { id, label, kind: oneOf(input.kind, PROVIDER_KINDS, 'openai-chat'), baseUrl, models, requiresKey: input.requiresKey ?? !!input.apiKey },
    ]);
    return { id };
  }

  lastModel(): { provider: string; model: string } | undefined {
    return this.data.lastModel ? { ...this.data.lastModel } : undefined;
  }

  async setLastModel(provider: string, model: string): Promise<void> {
    this.data = { ...this.data, lastModel: { provider, model } };
    await this.save();
  }

  // ── Lời mời đánh giá (Chrome Web Store) ──────────────────────────────────────
  // Khoá riêng, KHÔNG nằm trong `nd.config`: đổi cấu hình (hoặc cấu hình hỏng) không được làm mất trạng thái
  // "đã tắt lời mời", nếu không người dùng sẽ bị hỏi lại mãi.

  private ratingCache: RatingState = { ...EMPTY_RATING };
  private ratingLoaded = false;

  async rating(): Promise<RatingState> {
    if (!this.ratingLoaded) {
      this.ratingCache = sanitizeRating(await this.kv.get(RATING_KEY));
      this.ratingLoaded = true;
    }
    return { ...this.ratingCache };
  }

  private async saveRating(next: RatingState): Promise<void> {
    this.ratingCache = next;
    this.ratingLoaded = true;
    await this.kv.set(RATING_KEY, next);
  }

  /** Ghi nhận một tin người dùng gửi (chỉ tin thật). */
  async countSend(): Promise<RatingState> {
    const next = countRatingSend(await this.rating());
    await this.saveRating(next);
    return next;
  }

  async dismissRating(): Promise<RatingState> {
    const next = denyRating(await this.rating());
    await this.saveRating(next);
    return next;
  }

  async markRatingOpened(): Promise<RatingState> {
    const next = markRated(await this.rating());
    await this.saveRating(next);
    return next;
  }

  /** Người dùng chạm một ngôi sao: ghi nhận ngay (không mời lại) và xếp hàng gửi về Locaith. */
  async submitRating(stars: number): Promise<RatingState> {
    const next = submitStars(await this.rating(), stars);
    await this.saveRating(next);
    return next;
  }

  /** Nhận xét bằng chữ (tuỳ chọn) đi kèm số sao đã chấm. */
  async addRatingComment(text: string): Promise<RatingState> {
    const next = addComment(await this.rating(), text);
    await this.saveRating(next);
    return next;
  }

  /** Đã gửi xong (hoặc máy chủ từ chối hẳn) thứ đầu hàng thuộc loại `kind`. */
  async markRatingSent(kind: RatingKind): Promise<RatingState> {
    const next = markSent(await this.rating(), kind);
    await this.saveRating(next);
    return next;
  }
}
