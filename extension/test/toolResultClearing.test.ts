import { describe, expect, it } from 'vitest';
import { cutIndexKeepingRecent, summarizeHistoryDetailed } from '../src/core/engine/compaction';
import { estimateMessagesTokens } from '../src/core/engine/tokens';
import { clearableResults, clearOldToolResults, clearedResultText, isClearedResult, mainArgOf } from '../src/core/engine/toolResultClearing';
import { newSession } from '../src/core/engine/types';
import type { ChatMessage, ContentBlock, ToolResultBlock, ToolUseBlock } from '../src/core/types';
import { FakeProvider } from './helpers/fakeProvider';

// ── dựng lịch sử ──────────────────────────────────────────────────────────────

const BIG = 'x'.repeat(4000); // ≈ 1050 token
let seq = 0;
const use = (name: string, input: Record<string, unknown>): ToolUseBlock => ({ type: 'tool_use', id: `c${++seq}`, name, input });
const result = (u: ToolUseBlock, content = BIG, extra: Partial<ToolResultBlock> = {}): ToolResultBlock => ({ type: 'tool_result', toolUseId: u.id, name: u.name, content, ...extra });
const user = (text: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const asst = (...content: ContentBlock[]): ChatMessage => ({ role: 'assistant', content });
const results = (...rs: ToolResultBlock[]): ChatMessage => ({ role: 'user', content: rs });

/** Một vòng công cụ đọc tệp `path` với kết quả lớn. */
function round(path: string, content = BIG, extra: Partial<ToolResultBlock> = {}): ChatMessage[] {
  const u = use('read_file', { path });
  return [asst(u), results(result(u, content, extra))];
}

function session(messages: ChatMessage[]) {
  const s = newSession({ id: 's', provider: 'p', model: 'm' });
  s.messages = messages;
  return s;
}

const allResults = (msgs: readonly ChatMessage[]): ToolResultBlock[] => msgs.flatMap((m) => m.content).filter((b): b is ToolResultBlock => b.type === 'tool_result');

const OPTS = { contextWindow: 20_000, clearAtPercent: 40, targetPercent: 30, keepRecentResults: 8, lang: 'vi' as const };

describe('lược kết quả công cụ cũ (tool-result clearing)', () => {
  it('dưới ngưỡng: không đổi gì, không bật historyEdited', () => {
    seq = 0;
    const s = session([user('làm đi'), ...round('a.ts'), ...round('b.ts'), asst({ type: 'text', text: 'xong' })]);
    const r = clearOldToolResults(s, OPTS);
    expect(r.cleared).toBe(0);
    expect(s.historyEdited).toBe(false);
    expect(allResults(s.messages).every((b) => b.content === BIG)).toBe(true);
  });

  it('vượt ngưỡng: lược cũ → mới theo ĐỢT tới ≤ 30% cửa sổ, giữ 8 kết quả gần nhất và bước đang chờ', () => {
    seq = 0;
    // 14 vòng × ~1060 token ≈ 14.8k > 40% của 20k (8k). Tin cuối là kết quả đang chờ model trả lời.
    const msgs: ChatMessage[] = [user('đọc hết')];
    for (let i = 0; i < 14; i++) msgs.push(...round(`f${i}.ts`));
    const s = session(msgs);
    const before = estimateMessagesTokens(s.messages) + 3000;
    const r = clearOldToolResults(s, OPTS);
    expect(r.cleared).toBeGreaterThan(0);
    expect(r.tokensBefore).toBe(before);
    expect(r.tokensAfter).toBeLessThan(r.tokensBefore);
    const rs = allResults(s.messages);
    // 8 kết quả cuối (gồm bước đang chờ) nguyên văn; các kết quả cũ nhất bị lược trước
    expect(rs.slice(-8).every((b) => b.content === BIG)).toBe(true);
    expect(isClearedResult(rs[0])).toBe(true);
    const clearedIdx = rs.map((b, i) => (isClearedResult(b) ? i : -1)).filter((i) => i >= 0);
    expect(clearedIdx).toEqual(clearedIdx.map((_, i) => i)); // một dải liên tục từ đầu
    expect(rs[0].content).toContain('read_file f0.ts');
    expect(rs[0].content).toContain('gọi lại read_file f0.ts nếu cần');
    expect(rs[0].content).toMatch(/4k ký tự/);
    expect(s.historyEdited).toBe(true);
    expect(s.contextStats?.clearedResults).toBe(r.cleared);
    // theo đợt: về dưới mục tiêu 30% (6k) hoặc hết thứ để lược
    const after = estimateMessagesTokens(s.messages) + 3000;
    expect(after <= 6000 || r.cleared === rs.length - 8).toBe(true);
  });

  it('idempotent: gọi lại cùng tham số → 0, lịch sử y nguyên', () => {
    seq = 0;
    const msgs: ChatMessage[] = [user('đọc')];
    for (let i = 0; i < 14; i++) msgs.push(...round(`f${i}.ts`));
    const s = session(msgs);
    clearOldToolResults(s, OPTS);
    const snapshot = JSON.stringify(s.messages);
    s.historyEdited = false;
    const again = clearOldToolResults(s, { ...OPTS, force: true });
    expect(again.cleared).toBe(0);
    expect(JSON.stringify(s.messages)).toBe(snapshot);
    expect(s.historyEdited).toBe(false);
  });

  it('clearAtPercent = 0 → tắt hẳn (kể cả khi rất đầy)', () => {
    seq = 0;
    const msgs: ChatMessage[] = [user('đọc')];
    for (let i = 0; i < 20; i++) msgs.push(...round(`f${i}.ts`));
    const s = session(msgs);
    expect(clearOldToolResults(s, { ...OPTS, clearAtPercent: 0 }).cleared).toBe(0);
  });

  it('lỗi và mã thoát được GIỮ; ảnh bị bỏ nhưng được ghi số', () => {
    seq = 0;
    const cmd = use('run_command', { command: 'npm test' });
    const err = result(cmd, `Mã thoát: 1\nFAIL src/a.test.ts\n  expected 2 to be 3\n${BIG}`, { isError: true });
    const shot = use('page_screenshot', { url: 'https://x.vn' });
    const img = result(shot, 'ảnh', { images: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }] });
    const txt = clearedResultText(err, cmd, 'vi');
    expect(txt).toContain('run_command npm test');
    expect(txt).toContain('LỖI (mã thoát 1)');
    expect(txt).toContain('FAIL src/a.test.ts');
    expect(clearedResultText(img, shot, 'vi')).toContain('1 ảnh đã bỏ');
    expect(clearedResultText(result(cmd, 'Mã thoát: 0\nok'), cmd, 'en')).toContain('ok (exit code 0)');
    expect(clearedResultText(result(cmd, 'Mã thoát: 0\nok'), cmd, 'en')).toMatch(/^\[cleared — /);
    expect(mainArgOf({ pattern: 'TODO', path: 'src' })).toBe('src');
    expect(mainArgOf({ query: 'giá vàng' })).toBe('query=giá vàng');
    expect(mainArgOf(undefined)).toBe('');
  });

  it('không đụng tin đầu của người dùng, không đụng tool_use, không phá cặp', () => {
    seq = 0;
    const first = user('YÊU CẦU GỐC: ' + 'y'.repeat(5000));
    const msgs: ChatMessage[] = [first];
    for (let i = 0; i < 14; i++) msgs.push(...round(`f${i}.ts`));
    const s = session(msgs);
    const usesBefore = JSON.stringify(s.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_use'));
    clearOldToolResults(s, OPTS);
    expect((s.messages[0].content[0] as { text: string }).text).toBe('YÊU CẦU GỐC: ' + 'y'.repeat(5000));
    expect(JSON.stringify(s.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_use'))).toBe(usesBefore);
    expect(pairsIntact(s.messages)).toBe(true);
  });

  it('clearableResults: bước đang chờ (tin cuối có tool_result) không bao giờ là ứng viên', () => {
    seq = 0;
    const u1 = use('read_file', { path: 'a' });
    const u2 = use('read_file', { path: 'b' });
    const u3 = use('read_file', { path: 'c' });
    const msgs: ChatMessage[] = [user('x'), asst(u1), results(result(u1)), asst(u2, u3), results(result(u2), result(u3))];
    const c = clearableResults(msgs, 0);
    expect(c.map((x) => x.block.toolUseId)).toEqual(['c1']);
    // "N gần nhất" tính cả bước đang chờ: giữ 2 → hai kết quả đang chờ đã đủ, c1 vẫn lược được; giữ 3 → c1 cũng được giữ
    expect(clearableResults(msgs, 2).map((x) => x.block.toolUseId)).toEqual(['c1']);
    expect(clearableResults(msgs, 3)).toEqual([]);
  });
});

// ── bất biến trên lịch sử ngẫu nhiên ─────────────────────────────────────────

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Lịch sử ngẫu nhiên: nhiều lượt người dùng (có ảnh), vòng công cụ song song 1–3 lệnh, kết quả lỗi/ảnh/lớn/nhỏ, suy luận có chữ ký, tin chen (steer). */
function randomHistory(rnd: () => number): ChatMessage[] {
  seq = 0;
  const msgs: ChatMessage[] = [];
  const turns = 1 + Math.floor(rnd() * 4);
  for (let tn = 0; tn < turns; tn++) {
    const u: ContentBlock[] = [{ type: 'text', text: `yêu cầu ${tn} ${'u'.repeat(Math.floor(rnd() * 300))}` }];
    if (rnd() < 0.3) u.push({ type: 'image', mediaType: 'image/png', data: 'AAAA' });
    msgs.push({ role: 'user', content: u });
    const rounds = Math.floor(rnd() * 8);
    for (let r = 0; r < rounds; r++) {
      const n = 1 + Math.floor(rnd() * 3);
      const uses = Array.from({ length: n }, (_, i) => use(rnd() < 0.5 ? 'read_file' : 'run_command', { path: `p${r}_${i}.ts`, command: `cmd ${r}` }));
      const a: ContentBlock[] = rnd() < 0.5 ? [{ type: 'thinking', text: 'nghĩ', provider: 'anthropic', signature: 'sig' }, ...uses] : [...uses];
      msgs.push(asst(...a));
      const rs: ContentBlock[] = uses.map((x) => {
        const isError = rnd() < 0.2;
        const big = rnd() < 0.6;
        return result(x, `${isError ? 'Mã thoát: 2\n' : ''}${big ? BIG : 'ngắn'}`, { isError, images: rnd() < 0.15 ? [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }] : undefined });
      });
      if (rnd() < 0.15) rs.push({ type: 'text', text: 'tin chen giữa vòng công cụ' }); // steer
      msgs.push({ role: 'user', content: rs });
    }
    // Lượt cuối có thể kết thúc ở bước đang chờ (chưa có câu trả lời); lượt giữa luôn có câu trả lời để vai trò xen kẽ.
    if (tn < turns - 1 || rnd() < 0.7) msgs.push(asst({ type: 'text', text: `đáp ${tn}` }));
  }
  return msgs;
}

/** Mỗi tool_use có đúng một tool_result trong tin NGAY SAU; mỗi tool_result trả cho một tool_use trong tin NGAY TRƯỚC; vai trò xen kẽ. */
export function pairsIntact(msgs: readonly ChatMessage[]): boolean {
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (i > 0 && msgs[i - 1].role === m.role) return false;
    const uses = m.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
    if (uses.length) {
      const next = msgs[i + 1];
      if (!next || next.role !== 'user') return false;
      const ids = new Set(next.content.filter((b): b is ToolResultBlock => b.type === 'tool_result').map((b) => b.toolUseId));
      if (!uses.every((u) => ids.has(u.id))) return false;
    }
    const rs = m.content.filter((b): b is ToolResultBlock => b.type === 'tool_result');
    if (rs.length) {
      const prev = msgs[i - 1];
      if (!prev || prev.role !== 'assistant') return false;
      const ids = new Set(prev.content.filter((b): b is ToolUseBlock => b.type === 'tool_use').map((b) => b.id));
      if (!rs.every((r) => ids.has(r.toolUseId))) return false;
    }
  }
  return true;
}

describe('bất biến cặp tool_use ↔ tool_result trên lịch sử ngẫu nhiên (property test)', () => {
  it('lược (force, keepRecent ngẫu nhiên) rồi lược lại: cặp nguyên vẹn, idempotent, không còn suy luận, tin người dùng thật y nguyên', () => {
    const rnd = mulberry32(20261107);
    let clearedAny = 0;
    for (let i = 0; i < 150; i++) {
      const msgs = randomHistory(rnd);
      expect(pairsIntact(msgs)).toBe(true); // bộ sinh đúng
      const s = session(structuredClone(msgs));
      const keep = Math.floor(rnd() * 6);
      const o = { ...OPTS, contextWindow: 2000 + Math.floor(rnd() * 20_000), keepRecentResults: keep, force: true };
      const r = clearOldToolResults(s, o);
      clearedAny += r.cleared;
      expect(pairsIntact(s.messages)).toBe(true);
      expect(s.messages.length).toBe(msgs.length);
      // tin người dùng thật (chữ/ảnh) không đổi
      msgs.forEach((m, k) => {
        if (m.role === 'user' && m.content.some((b) => b.type === 'text' || b.type === 'image')) {
          const text = (c: ContentBlock[]) => c.filter((b) => b.type !== 'tool_result');
          expect(text(s.messages[k].content)).toEqual(text(m.content));
        }
      });
      if (r.cleared > 0) {
        expect(s.historyEdited).toBe(true);
        expect(s.messages.some((m) => m.content.some((b) => b.type === 'thinking'))).toBe(false);
        // lỗi vẫn là lỗi
        allResults(s.messages).forEach((b, k) => expect(!!b.isError).toBe(!!allResults(msgs)[k].isError));
        const snap = JSON.stringify(s.messages);
        expect(clearOldToolResults(s, o).cleared).toBe(0);
        expect(JSON.stringify(s.messages)).toBe(snap);
      }
    }
    expect(clearedAny).toBeGreaterThan(100);
  });

  it('tóm tắt giữ N tin cuối: mốc cắt hợp lệ, phần giữ lại không tách cặp, lịch sử sau nén hợp lệ', async () => {
    const rnd = mulberry32(7);
    let summarized = 0;
    for (let i = 0; i < 80; i++) {
      const msgs = randomHistory(rnd);
      const keep = 2 + Math.floor(rnd() * 12);
      const cut = cutIndexKeepingRecent(msgs, keep);
      if (cut > 0) {
        expect(pairsIntact(msgs.slice(0, cut))).toBe(true);
        expect(pairsIntact(msgs.slice(cut))).toBe(true);
        expect(msgs.length - cut).toBeGreaterThanOrEqual(Math.min(keep, msgs.length - cut));
      }
      const s = session(structuredClone(msgs));
      const provider = new FakeProvider([]);
      provider.completeImpl = async () => '## Quyết định & lý do\n- x\n## Việc còn lại\n- y';
      const r = await summarizeHistoryDetailed({ session: s, provider, model: 'm', language: 'vi', signal: new AbortController().signal, keepRecentMessages: keep });
      if (r.removed > 0) {
        summarized++;
        expect(r.removed).toBe(cut);
        expect(pairsIntact(s.messages)).toBe(true);
        expect(s.messages[0]).toMatchObject({ role: 'user', synthetic: true });
        expect(s.messages.length).toBeGreaterThanOrEqual(msgs.length - cut + 1);
      }
    }
    expect(summarized).toBeGreaterThan(20);
  });
});
