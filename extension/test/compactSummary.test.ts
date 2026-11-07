import { describe, expect, it } from 'vitest';
import { compactIfNeeded, cutIndexKeepingRecent, summarizeHistoryDetailed } from '../src/core/engine/compaction';
import { assembleSummary, carriedRequests, cleanInstructions, extractFacts, narrativePrompt, SUMMARY_HEADINGS } from '../src/core/engine/compactSummary';
import { newSession } from '../src/core/engine/types';
import type { ChatMessage, ContentBlock, ToolResultBlock, ToolUseBlock } from '../src/core/types';
import { wrapUploaded } from '../src/shared/docWrap';
import { FakeProvider } from './helpers/fakeProvider';

let seq = 0;
const use = (name: string, input: Record<string, unknown>): ToolUseBlock => ({ type: 'tool_use', id: `c${++seq}`, name, input });
const result = (u: ToolUseBlock, content: string, isError = false): ToolResultBlock => ({ type: 'tool_result', toolUseId: u.id, name: u.name, content, isError });
const user = (text: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const asst = (...content: ContentBlock[]): ChatMessage => ({ role: 'assistant', content });
const round = (u: ToolUseBlock, content: string, isError = false): ChatMessage[] => [asst(u), { role: 'user', content: [result(u, content, isError)] }];

const REQUEST = 'Sửa lỗi đăng nhập: token hết hạn vẫn vào được. Giữ nguyên API /auth/login.';
const BIG = 'z'.repeat(3000);

function history(): ChatMessage[] {
  seq = 0;
  const r1 = use('read_file', { path: 'src/auth.ts' });
  const g1 = use('grep', { pattern: 'verifyToken', path: 'src' });
  const e1 = use('edit_file', { path: 'src/auth.ts', old_string: 'a', new_string: 'b' });
  const w1 = use('write_file', { path: 'test/auth.test.ts', content: 'test' });
  const c1 = use('run_command', { command: 'npm test -- auth' });
  const c2 = use('run_command', { command: 'npm run typecheck' });
  return [
    user(REQUEST),
    ...round(r1, BIG),
    ...round(g1, 'src/auth.ts:12: verifyToken(...)'),
    ...round(e1, 'Đã sửa src/auth.ts (1 chỗ, +3 −1). Vùng sau khi sửa:\n12 | ...'),
    ...round(w1, 'Đã tạo test/auth.test.ts (14 dòng).'),
    ...round(c1, 'Mã thoát: 1\nFAIL test/auth.test.ts\n  expected 401', true),
    ...round(c2, 'Mã thoát: 0\n(không có đầu ra)'),
    asst({ type: 'text', text: 'Đã sửa xong, test còn một ca đỏ.' }),
    user('Chạy lại test cho đến khi xanh'),
    asst({ type: 'text', text: 'Vâng.' }),
  ];
}

describe('dữ kiện tất định từ vết công cụ', () => {
  it('yêu cầu nguyên văn + đã đọc + đã sửa/tạo + đã chạy (kèm mã thoát), lỗi được đánh dấu', () => {
    const f = extractFacts(history(), 'vi');
    expect(f.requests).toEqual([REQUEST, 'Chạy lại test cho đến khi xanh']);
    expect(f.reads).toEqual(['read_file src/auth.ts', 'grep src']);
    expect(f.edits).toEqual(['src/auth.ts — Đã sửa src/auth.ts (1 chỗ, +3 −1). Vùng sau khi sửa:', 'test/auth.test.ts — Đã tạo test/auth.test.ts (14 dòng).']);
    expect(f.runs[0]).toBe('`npm test -- auth` → LỖI (mã thoát 1): FAIL test/auth.test.ts expected 401');
    expect(f.runs[1]).toBe('`npm run typecheck` → ok (mã thoát 0)');
  });

  it('tin chen giữa vòng công cụ (steer) vẫn là yêu cầu; tin synthetic (nhắc) không; khung ngữ cảnh IDE bị bỏ; tệp tải lên chỉ còn tên', () => {
    seq = 0;
    const u = use('read_file', { path: 'a' });
    const doc = wrapUploaded('brief.pdf', 'pdf', 'NỘI DUNG TỆP RẤT DÀI');
    const msgs: ChatMessage[] = [
      user(`<ide_context>\nđang mở a.ts\n</ide_context>\n${doc}\n\nLên kế hoạch`),
      asst(u),
      { role: 'user', content: [result(u, 'x'), { type: 'text', text: 'À, thêm cả phần báo giá' }] },
      { role: 'user', synthetic: true, content: [{ type: 'text', text: 'Bạn còn 2 việc chưa xong…' }] },
    ];
    const f = extractFacts(msgs, 'vi');
    expect(f.requests).toHaveLength(2);
    expect(f.requests[0]).not.toContain('đang mở a.ts');
    expect(f.requests[0]).not.toContain('NỘI DUNG TỆP RẤT DÀI');
    expect(f.requests[0]).toContain('[tệp tải lên "brief.pdf" — giữ riêng]');
    expect(f.requests[0]).toContain('Lên kế hoạch');
    expect(f.requests[1]).toBe('À, thêm cả phần báo giá');
  });

  it('yêu cầu quá dài bị cắt có ghi chú; dấu » trong chữ người dùng không phá định dạng', () => {
    const f = extractFacts([user('«trích» ' + 'd'.repeat(5000))], 'vi');
    expect(f.requests[0]).toContain('[… đã cắt');
    expect(f.requests[0].length).toBeLessThan(3100);
    const md = assembleSummary(f, '', 'vi', false);
    expect(carriedRequests([{ role: 'user', synthetic: true, content: [{ type: 'text', text: `<tom_tat_hoi_thoai_truoc_do>\n${md}\n</tom_tat_hoi_thoai_truoc_do>` }] }])).toEqual([f.requests[0]]);
  });

  it('bản tóm tắt theo mẫu cố định: 7 mục đúng thứ tự; phần model không có tiêu đề thì được bọc', () => {
    const f = extractFacts(history(), 'vi');
    const md = assembleSummary(f, '- quyết định dùng JWT exp\n- còn: sửa ca test 401', 'vi', true);
    const H = SUMMARY_HEADINGS.vi;
    const order = [H.requests, H.reads, H.edits, H.runs, H.decisions, H.todo].map((h) => md.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(md).toContain(`1. «${REQUEST}»`);
    expect(md).toContain('xem khối danh sách việc đang sống');
    const en = assembleSummary(extractFacts(history(), 'en'), '', 'en', false);
    expect(en).toContain('## User requests (verbatim)');
    expect(en).toContain('(no task list)');
  });

  it('lần nén SAU mang nguyên văn yêu cầu từ bản tóm tắt TRƯỚC đi tiếp (không bao giờ mất yêu cầu gốc)', () => {
    const first = assembleSummary(extractFacts(history(), 'vi'), 'x', 'vi', false);
    const prev: ChatMessage = { role: 'user', synthetic: true, content: [{ type: 'text', text: `<tom_tat_hoi_thoai_truoc_do>\n${first}\n</tom_tat_hoi_thoai_truoc_do>\n(ghi chú)` }] };
    const f2 = extractFacts([prev, asst({ type: 'text', text: 'ok' }), user('Giờ viết CHANGELOG'), asst({ type: 'text', text: 'đã viết' })], 'vi');
    expect(f2.requests).toEqual([REQUEST, 'Chạy lại test cho đến khi xanh', 'Giờ viết CHANGELOG']);
  });

  it('prompt tường thuật: chỉ hai mục, có chỉ dẫn /compact (đã làm sạch), cảnh báo dữ liệu bên thứ ba', () => {
    const p = narrativePrompt('vi', '  giữ lại   chi tiết về auth\n\nvà token ');
    expect(p).toContain('## Quyết định & lý do');
    expect(p).toContain('## Việc còn lại');
    expect(p).toContain('«giữ lại chi tiết về auth và token»');
    expect(p).toContain('[dữ liệu bên thứ ba]');
    expect(narrativePrompt('en')).not.toContain('The user asked');
    expect(cleanInstructions('a'.repeat(600)).length).toBe(500);
  });
});

describe('tóm tắt toàn bộ (summarizeHistoryDetailed)', () => {
  const rig = (messages: ChatMessage[], todos: { id: string; title: string; status: 'pending' | 'in_progress' | 'completed' }[] = []) => {
    const session = newSession({ id: 's', provider: 'p', model: 'm' });
    session.messages = messages;
    session.todos = todos;
    const provider = new FakeProvider([]);
    provider.completeImpl = async () => '## Quyết định & lý do\n- dùng JWT exp\n## Việc còn lại\n- sửa ca test 401';
    return { session, provider };
  };

  it('bản tóm tắt chứa yêu cầu gốc NGUYÊN VĂN, tệp đã sửa, lệnh đã chạy — kể cả khi model tóm tắt bỏ sót hết', async () => {
    const { session, provider } = rig(history());
    provider.completeImpl = async () => 'Người dùng muốn làm gì đó về đăng nhập.'; // model "quên" hết
    // giữ 3 tin cuối → mốc cắt là tin assistant "Đã sửa xong…" (sau tin kết quả), nên cả 6 vòng công cụ đều nằm trong phần bị nén
    const r = await summarizeHistoryDetailed({ session, provider, model: 'm', language: 'vi', signal: new AbortController().signal, keepRecentMessages: 3 });
    expect(r.removed).toBeGreaterThan(0);
    expect(r.summary).toContain(`«${REQUEST}»`);
    expect(r.summary).toContain('src/auth.ts — Đã sửa src/auth.ts');
    expect(r.summary).toContain('test/auth.test.ts — Đã tạo');
    expect(r.summary).toContain('`npm test -- auth` → LỖI (mã thoát 1)');
    expect(r.summary).toContain('`npm run typecheck` → ok (mã thoát 0)');
    expect(r.summary).toContain('## Quyết định & lý do\nNgười dùng muốn làm gì đó về đăng nhập.');
    const head = (session.messages[0].content[0] as { text: string }).text;
    expect(head).toContain(r.summary);
    // bộ tóm tắt KHÔNG được đọc nội dung tệp 3000 ký tự nguyên văn (serialize cắt 500) nhưng vẫn thấy yêu cầu
    expect(provider.completes[0].prompt).toContain(REQUEST);
    expect(provider.completes[0].prompt).not.toContain(BIG);
  });

  it('giữ đúng N tin cuối (mặc định 20) ở mốc hợp lệ; todo được gắn lại nguyên vẹn', async () => {
    seq = 0;
    const msgs: ChatMessage[] = [user('việc lớn')];
    for (let i = 0; i < 30; i++) msgs.push(...round(use('read_file', { path: `f${i}.ts` }), 'nội dung'));
    const { session, provider } = rig(msgs, [{ id: 't1', title: 'Đọc mã', status: 'completed' }, { id: 't2', title: 'Sửa lỗi', status: 'in_progress' }]);
    const cut = cutIndexKeepingRecent(msgs, 20);
    expect(cut).toBe(41); // 61 tin − 20 = 41 → tin assistant đứng sau tin kết quả: hợp lệ ngay
    const r = await summarizeHistoryDetailed({ session, provider, model: 'm', language: 'vi', signal: new AbortController().signal });
    expect(r.removed).toBe(41);
    // phần giữ lại mở đầu bằng tin assistant → KHÔNG chèn câu "đã nắm", vai trò vẫn xen kẽ
    expect(session.messages.map((m) => m.role).slice(0, 3)).toEqual(['user', 'assistant', 'user']);
    expect(session.messages.length).toBe(21);
    const headText = session.messages[0].content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(headText).toContain('<trang_thai_cong_viec>');
    expect(headText).toContain('[~] Sửa lỗi');
    expect(headText).toContain('[x] Đọc mã');
    expect(headText).toContain('## Trạng thái todo');
    // 20 tin cuối y nguyên
    expect(session.messages.slice(1)).toEqual(msgs.slice(41));
  });

  it('mốc cắt lùi về ranh giới hợp lệ, không bao giờ tách cặp; không có mốc > 1 → không nén', () => {
    seq = 0;
    const u = use('read_file', { path: 'a' });
    const msgs: ChatMessage[] = [user('x'), asst(u), { role: 'user', content: [result(u, 'r')] }, asst({ type: 'text', text: 'ok' }), user('y'), asst({ type: 'text', text: 'z' })];
    expect(cutIndexKeepingRecent(msgs, 2)).toBe(4); // tin người dùng 'y'
    expect(cutIndexKeepingRecent(msgs, 3)).toBe(3); // tin assistant 'ok' đứng sau tin kết quả
    expect(cutIndexKeepingRecent(msgs, 4)).toBe(0); // vị trí 2 là tin kết quả, 1 là assistant sau tin người dùng? 1 ≤ 1 → không
    expect(cutIndexKeepingRecent(msgs, 100)).toBe(0);
  });

  it('/compact với chỉ dẫn: chỉ dẫn vào system prompt của bộ tóm tắt; chế độ manual; lịch sử ngắn vẫn nén được (giữ ≤ nửa)', async () => {
    const { session, provider } = rig(history());
    const r = await compactIfNeeded({ session, provider, model: 'm', language: 'vi', signal: new AbortController().signal, contextWindow: 200_000, force: true, instructions: 'giữ lại chi tiết về auth' });
    expect(r.summarizedMessages).toBeGreaterThan(0);
    expect(r.mode).toBe('manual');
    expect(r.tokensFreed).toBeGreaterThan(0);
    expect(r.summary).toContain(`«${REQUEST}»`);
    expect(provider.completes[0].system).toContain('«giữ lại chi tiết về auth»');
  });

  it('nén tự động dưới ngưỡng → không gọi model, không đổi gì; vượt ngưỡng nhưng lược xong đã đủ → chỉ lược, không tóm tắt', async () => {
    seq = 0;
    const msgs: ChatMessage[] = [user('đọc hết')];
    for (let i = 0; i < 14; i++) msgs.push(...round(use('read_file', { path: `f${i}.ts` }), 'x'.repeat(4000)));
    msgs.push(asst({ type: 'text', text: 'xong' }), user('tiếp'));
    const { session, provider } = rig(msgs);
    const idle = await compactIfNeeded({ session, provider, model: 'm', language: 'vi', signal: new AbortController().signal, contextWindow: 10_000_000 });
    expect(idle).toMatchObject({ pruned: 0, summarizedMessages: 0, tokensFreed: 0 });
    expect(provider.completes).toHaveLength(0);
    // cửa sổ 20k: ước lượng ≈ 18k ≥ ngưỡng 16k → nén; lược 6 kết quả cũ đưa về ≈ 12k < 16k → không cần tóm tắt
    const r = await compactIfNeeded({ session, provider, model: 'm', language: 'vi', signal: new AbortController().signal, contextWindow: 20_000 });
    expect(r.pruned).toBe(6);
    expect(r.summarizedMessages).toBe(0);
    expect(r.tokensFreed).toBeGreaterThan(5000);
    expect(provider.completes).toHaveLength(0);
    expect(session.contextStats).toEqual({ clearedResults: 6, compactions: 0 });
  });
});
