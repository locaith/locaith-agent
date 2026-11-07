import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sanitizeEvent, sanitizeOptions, sanitizePatch, toRemoteState } from '../src/core/remote/sanitize';
import type { SuggestionOption, TItem, ViewState } from '../src/shared/protocol';
import { applyEvent, reduceView } from '../src/shared/transcript';
import { stallSetting } from '../src/host/config';

/**
 * (lane:output-timeouts) Phần hiển thị dùng chung: reducer transcript (trimTail), nút «Chạy tiếp» qua `options` (webview + Remote + Chrome),
 * dữ liệu Remote được cắt gọn, chuỗi hai ngôn ngữ, cài đặt khai báo đủ ở package.json + nls.
 */
const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const start = (): TItem[] => applyEvent([], { t: 'assistant_start', id: 'a1', provider: 'p', model: 'm', ts: 1 });

describe('transcript — sự kiện text có trimTail', () => {
  it('bỏ đúng N ký tự cuối của khối chữ cuối rồi nối delta; không có trimTail thì chỉ nối như cũ', () => {
    let items = start();
    items = applyEvent(items, { t: 'text', id: 'a1', delta: 'Câu một. Câu hai dở' });
    items = applyEvent(items, { t: 'text', id: 'a1', delta: '\n\n[tiếp phần 2]\n\n', trimTail: ' Câu hai dở'.length });
    const a = items[0] as Extract<TItem, { kind: 'assistant' }>;
    expect(a.blocks).toEqual([{ type: 'text', id: expect.any(String), text: 'Câu một.\n\n[tiếp phần 2]\n\n' }]);
    items = applyEvent(items, { t: 'text', id: 'a1', delta: 'Phần hai.' });
    expect((items[0] as Extract<TItem, { kind: 'assistant' }>).blocks[0]).toMatchObject({ text: 'Câu một.\n\n[tiếp phần 2]\n\nPhần hai.' });
  });

  it('trimTail với delta rỗng (xoá phần dở trước khi thử lại) vẫn áp; trimTail quá dài → khối rỗng, không âm', () => {
    let items = applyEvent(start(), { t: 'text', id: 'a1', delta: 'abc' });
    items = applyEvent(items, { t: 'text', id: 'a1', delta: '', trimTail: 3 });
    expect((items[0] as Extract<TItem, { kind: 'assistant' }>).blocks[0]).toMatchObject({ type: 'text', text: '' });
    items = applyEvent(items, { t: 'text', id: 'a1', delta: 'x', trimTail: 99 });
    expect((items[0] as Extract<TItem, { kind: 'assistant' }>).blocks[0]).toMatchObject({ text: 'x' });
  });

  it('khối cuối không phải chữ (công cụ) → trimTail bị bỏ qua, delta mở khối chữ mới', () => {
    let items = applyEvent(start(), { t: 'tool_start', id: 'a1', callId: 'c1', name: 'read_file', args: {} });
    items = applyEvent(items, { t: 'text', id: 'a1', delta: 'sau công cụ', trimTail: 5 });
    const a = items[0] as Extract<TItem, { kind: 'assistant' }>;
    expect(a.blocks.map((b) => b.type)).toEqual(['tool', 'text']);
    expect(a.blocks[1]).toMatchObject({ text: 'sau công cụ' });
  });

  it('sự kiện options đi vào ViewState.options (nút hiện ở mọi bề mặt dùng reducer này)', () => {
    const base = { transcript: [], options: undefined } as unknown as ViewState;
    const o: SuggestionOption = { id: 'continue-part-2', kind: 'continue', label: 'Chạy tiếp phần 2', prompt: 'Viết tiếp phần 2' };
    expect(reduceView(base, { t: 'options', options: [o] }).options).toEqual([o]);
    expect(reduceView(base, { t: 'options', options: [] }).options).toEqual([]);
  });
});

describe('Remote — nút Chạy tiếp và trimTail đi qua lớp rút gọn', () => {
  const view = (over: Partial<ViewState> = {}): ViewState =>
    ({
      version: '1', sessionId: 's', title: 't', transcript: [], todos: [], running: false, provider: 'p', model: 'm', mode: 'default', thinkingLevel: 'medium',
      providers: [], settings: {} as ViewState['settings'], sessions: [], trash: [], workspace: null, context: null, editor: null, skills: [], slashCommands: [], allowBypass: false,
      ...over,
    }) as ViewState;
  const HOST = { name: 'PC', vscode: '1.90.0', ext: '0.6.31', platform: 'win32' };

  it('sanitizeOptions: tối đa 6 nút, cắt nhãn/prompt/detail, chỉ giữ kind hợp lệ, bỏ mục hỏng', () => {
    const many: SuggestionOption[] = Array.from({ length: 9 }, (_, i) => ({ id: `o${i}`, label: 'L'.repeat(100), prompt: 'P'.repeat(5000), detail: 'D'.repeat(500), kind: (i % 2 ? 'continue' : 'weird') as 'continue' }));
    const out = sanitizeOptions([...many, { id: 1 } as unknown as SuggestionOption]);
    expect(out).toHaveLength(6);
    expect(out[0].label.length).toBeLessThanOrEqual(70);
    expect(out[0].prompt.length).toBeLessThanOrEqual(2020);
    expect(out[0].detail!.length).toBeLessThanOrEqual(180);
    expect(out[0].kind).toBeUndefined();
    expect(out[1].kind).toBe('continue');
  });

  it('snapshot + patch + sự kiện đều mang options (rỗng = thu hồi); trimTail được ép về số nguyên không âm', () => {
    const o: SuggestionOption = { id: 'continue-work', kind: 'continue', label: 'Chạy tiếp', prompt: 'Tiếp tục' };
    expect(toRemoteState(view({ options: [o] }), HOST, { canBypass: false }).options).toEqual([o]);
    expect(toRemoteState(view(), HOST, { canBypass: false })).not.toHaveProperty('options');
    expect(sanitizePatch({ options: [o] })).toEqual({ options: [o] });
    expect(sanitizePatch({ options: [] })).toEqual({ options: [] });
    expect(sanitizeEvent({ t: 'options', id: 'a1', options: [o] })).toEqual({ t: 'options', id: 'a1', options: [o] });
    expect(sanitizeEvent({ t: 'text', id: 'a1', delta: 'x', trimTail: -4.7 })).toEqual({ t: 'text', id: 'a1', delta: 'x', trimTail: 0 });
    expect(sanitizeEvent({ t: 'text', id: 'a1', delta: 'x', trimTail: 12.9 })).toEqual({ t: 'text', id: 'a1', delta: 'x', trimTail: 12 });
    expect(sanitizeEvent({ t: 'text', id: 'a1', delta: 'x' })).toEqual({ t: 'text', id: 'a1', delta: 'x' });
  });
});

describe('giao diện & cài đặt — hai ngôn ngữ, khai báo đủ', () => {
  it('OptionsBar: bộ nút toàn kind continue vẽ gọn một dòng (chấm + nhãn + nút), vẫn gửi prompt như nút thường, có nút ẩn', () => {
    const src = read('webview/src/components/OptionsBar.tsx');
    expect(src).toContain("options.every((o) => o.kind === 'continue')");
    expect(src).toContain('class="options options-continue"');
    expect(src).toContain('class="dot dot-warn"');
    expect(src).toContain("post({ type: 'send', text: o.prompt, attachments: [] })");
    const css = read('webview/src/styles/components.css');
    expect(css).toContain('.options-continue {');
    expect(css).toMatch(/\.options-continue \{[^}]*border: 0;[^}]*background: transparent;/s); // không khung kín, không tô nền
  });

  it('chuỗi webview options.continue có cả vi và en; chuỗi engine mới có đủ hai bảng', () => {
    const i18n = read('webview/src/i18n.ts');
    expect(i18n.split("'options.continue':").length - 1).toBe(2);
    const strings = read('src/core/engine/strings.ts');
    for (const k of ['partMarker', 'continuePartLabel', 'continuePartPrompt', 'maxTokensButton', 'continueWorkLabel', 'continueWorkPrompt', 'stallRetry', 'stallGiveUp', 'stopReasonMaxTurns', 'stopDone', 'stopLeft', 'stopHow', 'stopContradiction', 'wrapUpFacts']) {
      expect(strings.split(`${k}:`).length - 1, k).toBe(2);
    }
    // không có dấu «…» thừa ở nhãn nút
    expect(strings).not.toMatch(/continuePartLabel: '[^']*…/);
    expect(strings).not.toMatch(/continueWorkLabel: '[^']*…/);
  });

  it('ba cài đặt mới khai báo ngay sau agent.maxOutputTokens, mô tả qua nls ở cả hai tệp, đọc qua config.ts với mặc định an toàn', () => {
    const pkg = read('package.json');
    const i = pkg.indexOf('"locaithAgent.agent.maxOutputTokens"');
    const j = pkg.indexOf('"locaithAgent.agent.adaptiveOutputTokens"');
    const k = pkg.indexOf('"locaithAgent.agent.modelStallSeconds"');
    const l = pkg.indexOf('"locaithAgent.agent.modelCallMaxSeconds"');
    expect(i).toBeGreaterThan(0);
    expect(j).toBeGreaterThan(i);
    expect(k).toBeGreaterThan(j);
    expect(l).toBeGreaterThan(k);
    expect(pkg).toContain('"default": "auto"');
    for (const nls of ['package.nls.json', 'package.nls.en.json']) {
      const s = read(nls);
      for (const key of ['cfg.adaptiveOutputTokens', 'cfg.modelStallSeconds', 'cfg.modelCallMaxSeconds']) expect(s, `${nls} thiếu ${key}`).toContain(`"${key}":`);
    }
    const cfg = read('src/host/config.ts');
    expect(cfg).toContain("c.get<boolean>('agent.adaptiveOutputTokens', true)");
    expect(cfg).toContain("c.get<unknown>('agent.modelStallSeconds', 'auto')");
    expect(cfg).toContain("c.get<number>('agent.modelCallMaxSeconds', 600)");
  });

  it("stallSetting: 'auto' | 0 | số giây kẹp 5–600; chuỗi số cũng nhận; rác → 'auto'", () => {
    expect(stallSetting('auto')).toBe('auto');
    expect(stallSetting(undefined)).toBe('auto');
    expect(stallSetting('xyz')).toBe('auto');
    expect(stallSetting(0)).toBe(0);
    expect(stallSetting('0')).toBe(0);
    expect(stallSetting(-3)).toBe(0);
    expect(stallSetting(2)).toBe(5);
    expect(stallSetting('45')).toBe(45);
    expect(stallSetting(99_999)).toBe(600);
  });
});

describe('transcript — trimTail bỏ qua dòng trạng thái / thông báo đứng sau chữ', () => {
  it('chữ dở + dòng «Đang soạn…» + thông báo thử lại → trimTail vẫn cắt đúng chữ dở và gỡ dòng trạng thái đang chạy', () => {
    let items = applyEvent(start(), { t: 'text', id: 'a1', delta: 'Xong câu một. Câu hai dở' });
    items = applyEvent(items, { t: 'pill', id: 'a1', pillId: 'p1', text: 'Đang soạn nội dung', kind: 'writing' });
    items = applyEvent(items, { t: 'notice', id: 'a1', level: 'warn', text: 'thử lại' });
    items = applyEvent(items, { t: 'text', id: 'a1', delta: '', trimTail: 'Xong câu một. Câu hai dở'.length });
    items = applyEvent(items, { t: 'text', id: 'a1', delta: 'Lần hai.' });
    const a = items[0] as Extract<TItem, { kind: 'assistant' }>;
    expect(a.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')).toBe('Lần hai.');
    expect(a.blocks.some((b) => b.type === 'pill' && b.active)).toBe(false);
  });

  it('cắt qua nhiều khối chữ (chữ, suy luận, chữ) → bỏ khối chữ cạn, không đụng khối công cụ của lượt trước', () => {
    let items = applyEvent(start(), { t: 'tool_start', id: 'a1', callId: 'c1', name: 'read_file', args: {} });
    items = applyEvent(items, { t: 'text', id: 'a1', delta: 'AAA' });
    items = applyEvent(items, { t: 'thinking', id: 'a1', delta: 'nghĩ' });
    items = applyEvent(items, { t: 'text', id: 'a1', delta: 'BBBB' });
    items = applyEvent(items, { t: 'text', id: 'a1', delta: '', trimTail: 7 });
    const a = items[0] as Extract<TItem, { kind: 'assistant' }>;
    expect(a.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')).toBe('');
    expect(a.blocks.some((b) => b.type === 'tool')).toBe(true);
  });
});
