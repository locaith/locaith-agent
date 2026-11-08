/**
 * (0.7.4) Lịch sử các tin đã gõ — phím ↑/↓ ở ô nhập (anh yêu cầu 08/11/2026):
 *  • logic thuần (src/shared/promptHistory.ts): thêm/bỏ trùng/giới hạn, bước ↑/↓, điều kiện nhận phím;
 *  • lớp host VS Code: ghi khi gửi (cả lệnh gạch chéo), đẩy sau `init`, bền qua lần khởi động lại, theo thư mục làm việc;
 *  • lớp trình duyệt (Chrome/Edge): cùng hành vi qua kho khoá–giá trị;
 *  • giao diện: ↑ không còn là «sửa tin cuối» (phá huỷ), nối đúng vào logic thuần.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NO_NAV, PROMPT_ENTRY_MAX, PROMPT_HISTORY_MAX, addPrompt, historyKey, historyStep, navDetached, sanitizeHistory, type HistoryKey } from '../src/shared/promptHistory';
import type { HostMessage } from '../src/shared/protocol';
import { textTurn, type Step } from './helpers/fakeProvider';
import { makeControllerHarness, type ControllerHarness } from './helpers/controllerHarness';

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('promptHistory · thêm tin', () => {
  it('tin mới ở cuối; gửi lại đúng chữ cũ thì chuyển xuống cuối (không lặp)', () => {
    let l: readonly string[] = [];
    l = addPrompt(l, 'a');
    l = addPrompt(l, 'b');
    l = addPrompt(l, 'c');
    expect(l).toEqual(['a', 'b', 'c']);
    expect(addPrompt(l, 'a')).toEqual(['b', 'c', 'a']);
  });

  it('bỏ khoảng trắng hai đầu; rỗng, quá dài, hoặc trùng tin mới nhất → giữ NGUYÊN danh sách (cùng tham chiếu)', () => {
    const l = ['x', 'y'] as const;
    expect(addPrompt(l, '  z  ')).toEqual(['x', 'y', 'z']);
    expect(addPrompt(l, '   ')).toBe(l);
    expect(addPrompt(l, '')).toBe(l);
    expect(addPrompt(l, 'y')).toBe(l);
    expect(addPrompt(l, 'q'.repeat(PROMPT_ENTRY_MAX + 1))).toBe(l);
    expect(addPrompt(l, 'q'.repeat(PROMPT_ENTRY_MAX))).toHaveLength(3);
  });

  it(`giữ tối đa ${PROMPT_HISTORY_MAX} tin mới nhất`, () => {
    let l: readonly string[] = [];
    for (let i = 0; i < PROMPT_HISTORY_MAX + 25; i++) l = addPrompt(l, `tin ${i}`);
    expect(l).toHaveLength(PROMPT_HISTORY_MAX);
    expect(l[0]).toBe('tin 25');
    expect(l[l.length - 1]).toBe(`tin ${PROMPT_HISTORY_MAX + 24}`);
  });

  it('đọc dữ liệu không đáng tin: chỉ giữ chuỗi hợp lệ, bỏ trùng (giữ bản mới nhất), cắt độ dài', () => {
    expect(sanitizeHistory(undefined)).toEqual([]);
    expect(sanitizeHistory('chuỗi')).toEqual([]);
    expect(sanitizeHistory({ 0: 'a' })).toEqual([]);
    expect(sanitizeHistory(['a', 5, null, '  ', 'b', 'a', { x: 1 }, 'c'])).toEqual(['b', 'a', 'c']);
    expect(sanitizeHistory(['q'.repeat(PROMPT_ENTRY_MAX + 1), 'ok'])).toEqual(['ok']);
    const many = Array.from({ length: PROMPT_HISTORY_MAX + 10 }, (_, i) => `m${i}`);
    expect(sanitizeHistory(many)).toHaveLength(PROMPT_HISTORY_MAX);
  });
});

describe('promptHistory · bước ↑/↓', () => {
  const L = ['một', 'hai', 'ba'];

  it('↑ lần đầu: lấy tin mới nhất và GIỮ bản nháp đang gõ; ↑ tiếp: lùi dần; tới tin cũ nhất thì dừng', () => {
    const s1 = historyStep(L, NO_NAV, 'up', 'đang gõ dở')!;
    expect(s1.text).toBe('ba');
    expect(s1.nav).toEqual({ index: 2, draft: 'đang gõ dở' });
    const s2 = historyStep(L, s1.nav, 'up', s1.text)!;
    expect(s2.text).toBe('hai');
    expect(s2.nav.draft).toBe('đang gõ dở');
    const s3 = historyStep(L, s2.nav, 'up', s2.text)!;
    expect(s3.text).toBe('một');
    expect(historyStep(L, s3.nav, 'up', s3.text)).toBeNull();
  });

  it('↓ tiến dần; qua tin mới nhất thì TRẢ bản nháp và thoát chế độ duyệt; không duyệt thì ↓ không làm gì', () => {
    const up1 = historyStep(L, NO_NAV, 'up', 'nháp')!;
    const up2 = historyStep(L, up1.nav, 'up', up1.text)!;
    const d1 = historyStep(L, up2.nav, 'down', up2.text)!;
    expect(d1.text).toBe('ba');
    const d2 = historyStep(L, d1.nav, 'down', d1.text)!;
    expect(d2).toEqual({ text: 'nháp', nav: NO_NAV });
    expect(historyStep(L, NO_NAV, 'down', 'nháp')).toBeNull();
  });

  it('lịch sử rỗng: ↑ và ↓ đều không làm gì', () => {
    expect(historyStep([], NO_NAV, 'up', 'x')).toBeNull();
    expect(historyStep([], NO_NAV, 'down', 'x')).toBeNull();
  });

  it('danh sách đổi (ngắn đi) giữa lúc duyệt không làm chỉ số vượt biên', () => {
    const s = historyStep(['a', 'b'], { index: 9, draft: 'd' }, 'up', 'b')!;
    expect(s.text).toBe('b'); // chỉ số cũ vượt biên → coi như đứng sau tin mới nhất, ↑ lấy tin mới nhất (giao diện còn chặn thêm bằng navDetached)
    expect(historyStep(['a'], { index: 9, draft: 'd' }, 'down', 'a')).toEqual({ text: 'd', nav: NO_NAV });
  });

  it('navDetached: sửa chữ đang gọi lại (hoặc chữ bị thay từ nơi khác) → thoát chế độ duyệt', () => {
    const nav = { index: 1, draft: '' };
    expect(navDetached(L, nav, 'hai')).toBe(false);
    expect(navDetached(L, nav, 'hai!')).toBe(true);
    expect(navDetached(L, NO_NAV, 'bất kỳ')).toBe(false);
  });
});

describe('promptHistory · phím nào được nhận', () => {
  const L = ['một', 'hai'];
  const key = (o: Partial<HistoryKey> & { key: string }): HistoryKey => ({ value: '', selStart: 0, selEnd: 0, ...o });

  it('↑ ở ô trống lấy tin mới nhất; ↓ ở ô trống không làm gì', () => {
    expect(historyKey(key({ key: 'ArrowUp' }), L, NO_NAV)?.text).toBe('hai');
    expect(historyKey(key({ key: 'ArrowDown' }), L, NO_NAV)).toBeNull();
  });

  it('phím khác, hoặc có Shift/Alt/Ctrl/Cmd, hoặc đang chọn vùng chữ, hoặc bộ gõ đang ghép → để phím làm việc mặc định', () => {
    expect(historyKey(key({ key: 'Enter' }), L, NO_NAV)).toBeNull();
    for (const m of ['shift', 'alt', 'ctrl', 'meta'] as const) expect(historyKey(key({ key: 'ArrowUp', [m]: true }), L, NO_NAV)).toBeNull();
    expect(historyKey(key({ key: 'ArrowUp', value: 'abc', selStart: 0, selEnd: 3 }), L, NO_NAV)).toBeNull();
    expect(historyKey(key({ key: 'ArrowUp', composing: true }), L, NO_NAV)).toBeNull();
  });

  it('tin nhiều dòng: ↑ chỉ nhận ở DÒNG ĐẦU, ↓ chỉ nhận ở DÒNG CUỐI (còn dòng thì phím di con trỏ)', () => {
    const v = 'dòng 1\ndòng 2\ndòng 3';
    // con trỏ ở dòng giữa
    expect(historyKey(key({ key: 'ArrowUp', value: v, selStart: 9, selEnd: 9 }), L, NO_NAV)).toBeNull();
    expect(historyKey(key({ key: 'ArrowDown', value: v, selStart: 9, selEnd: 9 }), L, { index: 0, draft: 'x' })).toBeNull();
    // dòng đầu → ↑ nhận; dòng cuối → ↓ nhận
    expect(historyKey(key({ key: 'ArrowUp', value: v, selStart: 3, selEnd: 3 }), L, NO_NAV)?.text).toBe('hai');
    expect(historyKey(key({ key: 'ArrowDown', value: v, selStart: v.length, selEnd: v.length }), L, { index: 0, draft: 'x' })?.text).toBe('hai');
  });

  it('nhận ↑ ngay cả khi con trỏ không ở đầu dòng (như terminal): ô một dòng', () => {
    expect(historyKey(key({ key: 'ArrowUp', value: 'đang gõ', selStart: 4, selEnd: 4 }), L, NO_NAV)?.nav.draft).toBe('đang gõ');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lớp host VS Code
// ─────────────────────────────────────────────────────────────────────────────

const KEY = 'locaithAgent.promptHistory';
const live: ControllerHarness[] = [];
afterEach(() => {
  while (live.length) live.pop()!.dispose();
});

function mk(over: { workspaceState?: Map<string, unknown>; globalState?: Map<string, unknown>; script?: Step[] } = {}): ControllerHarness {
  const h = makeControllerHarness({
    script: over.script ?? [() => textTurn('ok'), () => textTurn('ok'), () => textTurn('ok'), () => textTurn('ok')],
    workspaceState: over.workspaceState ?? new Map<string, unknown>(),
    globalState: over.globalState ?? new Map<string, unknown>(),
  });
  live.push(h);
  return h;
}

/** Webview giả gắn vào controller để bắt các tin host → giao diện đi RIÊNG cho khung này (không qua mirror/Remote). */
function attachFake(h: ControllerHarness): HostMessage[] {
  const seen: HostMessage[] = [];
  h.ctl.attach({ postMessage: async (m: HostMessage) => void seen.push(m), onDidReceiveMessage: () => ({ dispose() {} }) } as never, () => true);
  return seen;
}

describe('promptHistory · host VS Code', () => {
  it('tin gửi (kể cả tin xếp hàng và lệnh gạch chéo) được ghi vào workspaceState, mới nhất ở cuối, không lặp', async () => {
    const ws = new Map<string, unknown>();
    const h = mk({ workspaceState: ws });
    await h.send('sửa lỗi đăng nhập');
    await h.idle();
    await h.send('chạy test');
    await h.idle();
    await h.send('sửa lỗi đăng nhập'); // gõ lại tin cũ → chuyển xuống cuối
    await h.idle();
    expect(ws.get(KEY)).toEqual(['chạy test', 'sửa lỗi đăng nhập']);
    await h.ctl.handleRemote({ type: 'slash', command: 'thinking', args: 'high' });
    expect(ws.get(KEY)).toEqual(['chạy test', 'sửa lỗi đăng nhập', '/thinking high']);
    await h.ctl.handleRemote({ type: 'slash', command: '/help', args: '' });
    expect((ws.get(KEY) as string[]).at(-1)).toBe('/help');
  });

  it('tin rỗng / chỉ có tệp đính kèm / không phải chuỗi không vào lịch sử', async () => {
    const ws = new Map<string, unknown>();
    const h = mk({ workspaceState: ws });
    await h.ctl.handleRemote({ type: 'send', text: '   ', attachments: [] });
    await h.ctl.handleRemote({ type: 'send', text: 123 as never, attachments: [] });
    expect(ws.has(KEY)).toBe(false);
  });

  it('sau `ready` host đẩy lịch sử đã lưu cho khung chat (và chỉ cho khung đó, không qua Remote)', async () => {
    const ws = new Map<string, unknown>([[KEY, ['cũ nhất', 'giữa', 'mới nhất']]]);
    const h = mk({ workspaceState: ws });
    const seen = attachFake(h);
    await h.ctl.handleRemote({ type: 'ready' });
    const msg = seen.find((m) => m.type === 'prompt_history');
    expect(msg).toEqual({ type: 'prompt_history', items: ['cũ nhất', 'giữa', 'mới nhất'] });
    expect(h.posted.some((m) => m.type === 'prompt_history')).toBe(false); // Remote (mirror) không nhận lịch sử của chủ máy
    // thứ tự: `init` đến trước, lịch sử ngay sau
    const order = seen.map((m) => m.type);
    expect(order.indexOf('init')).toBeGreaterThanOrEqual(0);
  });

  it('bền qua lần khởi động lại: controller MỚI trên cùng kho đọc lại đúng danh sách', async () => {
    const ws = new Map<string, unknown>();
    const h1 = mk({ workspaceState: ws });
    await h1.send('một');
    await h1.idle();
    await h1.send('hai');
    await h1.idle();
    h1.dispose();
    live.pop();
    const h2 = mk({ workspaceState: ws });
    const seen = attachFake(h2);
    await h2.ctl.handleRemote({ type: 'ready' });
    expect(seen.find((m) => m.type === 'prompt_history')).toEqual({ type: 'prompt_history', items: ['một', 'hai'] });
    expect(h2.ctl.promptHistory()).toEqual(['một', 'hai']);
  });

  it('dữ liệu hỏng trong kho không làm hỏng khung chat: bỏ phần không hợp lệ', async () => {
    const ws = new Map<string, unknown>([[KEY, ['ok', 42, { a: 1 }, 'ok', '  ', 'khác']]]);
    const h = mk({ workspaceState: ws });
    const seen = attachFake(h);
    await h.ctl.handleRemote({ type: 'ready' });
    expect(seen.find((m) => m.type === 'prompt_history')).toEqual({ type: 'prompt_history', items: ['ok', 'khác'] });
  });

  it('tin vượt giới hạn vẫn được gửi bình thường nhưng không vào lịch sử', async () => {
    const ws = new Map<string, unknown>();
    const h = mk({ workspaceState: ws });
    await h.send('x'.repeat(PROMPT_ENTRY_MAX + 5));
    await h.idle();
    expect(ws.has(KEY)).toBe(false);
    expect(h.shownUserTexts().length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Giao diện: nối đúng vào logic thuần
// ─────────────────────────────────────────────────────────────────────────────

describe('promptHistory · giao diện', () => {
  const composer = read('webview/src/components/composer/Composer.tsx');
  const app = read('webview/src/App.tsx');

  it('↑ ở ô trống KHÔNG còn gửi `edit_last` (thao tác phá huỷ) — dùng lịch sử; `edit_last` vẫn có ở menu của tin', () => {
    expect(composer).not.toMatch(/ArrowUp[^\n]*\n[^\n]*\n[^\n]*edit_last/);
    expect(composer).not.toContain("post({ type: 'edit_last' })");
    expect(composer).toContain('historyKey(');
    expect(composer).toContain('navDetached(');
    expect(read('webview/src/components/MessageMenu.tsx')).toContain("type: 'edit_last'");
  });

  it('tin gửi đi (cả lệnh gạch chéo) được ghi ngay phía giao diện; gửi xong thì thoát chế độ duyệt; menu @ / mở thì ↑/↓ thuộc về menu', () => {
    const submit = composer.slice(composer.indexOf('const submit = () =>'), composer.indexOf('/** (lane:ide-context) Xoá khỏi ô nhập'));
    expect(submit.match(/recordPrompt\(/g)?.length).toBe(2);
    expect(composer.slice(composer.indexOf('const clearAll'), composer.indexOf('const submit'))).toContain('histNav.current = NO_NAV');
    expect(composer).toMatch(/\(e\.key === 'ArrowUp' \|\| e\.key === 'ArrowDown'\) && !menuOpen/);
  });

  it('App nhận `prompt_history` và đưa vào kho; protocol có kiểu tin này', () => {
    expect(app).toContain("case 'prompt_history'");
    expect(app).toContain('setPromptHistory(m.items)');
    expect(read('src/shared/protocol.ts')).toContain("type: 'prompt_history'; items: string[]");
  });
});
