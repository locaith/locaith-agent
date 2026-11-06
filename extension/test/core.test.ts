import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pruneOldToolResults, summarizeHistory } from '../src/core/engine/compaction';
import { extractHint } from '../src/core/engine/interceptor';
import { sanitizePill, unescapeJsonFragment } from '../src/core/engine/summarizer';
import { ThinkTagSplitter, splitThinkTags } from '../src/core/engine/thinkTags';
import { estimateTokens } from '../src/core/engine/tokens';
import { newSession } from '../src/core/engine/types';
import { compileGlob, globToRegExp } from '../src/core/fsutil/glob';
import { GitIgnore } from '../src/core/fsutil/walk';
import { NodeToolHost } from '../src/core/host/nodeHost';
import { builtinSkills } from '../src/core/skills/builtin';
import { SkillRegistry, parseSkillMarkdown, foldVi, skillFromMarkdown } from '../src/core/skills/registry';
import type { ChatMessage } from '../src/core/types';
import { applyEvent, reduceView, trimTranscriptForStorage } from '../src/shared/transcript';
import type { TItem, UiEvent, ViewState } from '../src/shared/protocol';
import { FakeProvider } from './helpers/fakeProvider';
import { makeWorkspace } from './helpers/harness';

describe('ThinkTagSplitter', () => {
  const sample = '<think>Suy nghĩ về dữ liệu tiếng Việt: Đặng Thị Hồng</think>\nCâu trả lời ướ ữ ặ. Dùng <thinking> trong văn bản.';

  it('cho cùng kết quả dù chẻ chuỗi ở bất kỳ vị trí nào', () => {
    const expected = splitThinkTags(sample);
    expect(expected.thinking).toBe('Suy nghĩ về dữ liệu tiếng Việt: Đặng Thị Hồng');
    expect(expected.text).toBe('Câu trả lời ướ ữ ặ. Dùng <thinking> trong văn bản.');
    for (let i = 1; i < sample.length; i++) {
      const s = new ThinkTagSplitter();
      const segs = [...s.push(sample.slice(0, i)), ...s.push(sample.slice(i)), ...s.flush()];
      const thinking = segs.filter((x) => x.kind === 'thinking').map((x) => x.text).join('');
      const text = segs.filter((x) => x.kind === 'text').map((x) => x.text).join('');
      expect({ i, thinking: thinking.trim(), text }).toEqual({ i, thinking: expected.thinking, text: expected.text });
    }
  });

  it('không cắt nhầm thẻ nằm giữa câu hoặc trong mã', () => {
    const r = splitThinkTags('Ví dụ HTML: <think>x</think> không phải thẻ suy nghĩ');
    expect(r.thinking).toBe('');
    expect(r.text).toContain('<think>x</think>');
  });

  it('thẻ không đóng: phần còn lại vẫn là suy nghĩ; thẻ dở dang ở cuối luồng được trả về như chữ', () => {
    const open = splitThinkTags('<think>chưa đóng');
    expect(open.thinking).toBe('chưa đóng');
    expect(open.text).toBe('');
    const s = new ThinkTagSplitter();
    const out = [...s.push('xin chào\n<thi'), ...s.flush()];
    expect(out.map((x) => x.text).join('')).toBe('xin chào\n<thi');
  });
});

describe('summarizer helpers', () => {
  it('sanitizePill làm sạch câu trạng thái', () => {
    expect(sanitizePill('"Đang đối chiếu điểm số giữa các phiên bản."')).toBe('Đang đối chiếu điểm số giữa các phiên bản.');
    expect(sanitizePill('Output: **Reconciling conflicting scores**')).toBe('Reconciling conflicting scores');
    expect(sanitizePill('- Đang viết hàm vẽ bảng\nGiải thích thêm...')).toBe('Đang viết hàm vẽ bảng');
    expect(sanitizePill('const x = <div>function()</div>')).toBeNull();
    expect(sanitizePill('')).toBeNull();
    expect(sanitizePill('ab')).toBeNull();
    const long = sanitizePill('từ '.repeat(60))!;
    expect(long.length).toBeLessThanOrEqual(140);
  });

  it('unescapeJsonFragment và extractHint lấy tên tệp từ JSON đang chảy dở', () => {
    expect(unescapeJsonFragment('a\\nb\\"c\\"')).toBe('a\nb"c"');
    expect(extractHint('{"path": "src/bảng điểm.ts", "content": "x')).toBe('src/bảng điểm.ts');
    expect(extractHint('{"title":"Bảng thang điểm","type":"html"')).toBe('Bảng thang điểm');
    expect(extractHint('{"conte')).toBeUndefined();
  });

  it('ước lượng token nặng hơn cho chữ có dấu', () => {
    expect(estimateTokens('a'.repeat(100))).toBeLessThan(estimateTokens('ấ'.repeat(100)));
  });
});

describe('Skill registry', () => {
  it('đọc frontmatter kiểu Claude: chuỗi, mảng nội tuyến, danh sách gạch đầu dòng, khối >', () => {
    const md = `---
name: Báo Cáo Tháng
description: >
  Dựng báo cáo
  hàng tháng
unlocks: [create_artifact, update_artifact]
tags:
  - báo cáo
  - tháng
extra: "bỏ qua"
---
# Nội dung

Thân bài.`;
    const { meta, body } = parseSkillMarkdown(md);
    expect(meta.description).toBe('Dựng báo cáo hàng tháng');
    expect(meta.unlocks).toEqual(['create_artifact', 'update_artifact']);
    expect(meta.tags).toEqual(['báo cáo', 'tháng']);
    expect(body.startsWith('# Nội dung')).toBe(true);
    const def = skillFromMarkdown(md, 'x', 'workspace')!;
    expect(def.name).toBe('bao-cao-thang'); // tên được slug hoá không dấu
  });

  it('có đủ kỹ năng dựng sẵn và tìm kiếm không phân biệt dấu', () => {
    const reg = new SkillRegistry(builtinSkills());
    const names = reg.list().map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['artifacts', 'web-research', 'software-engineering', 'vietnamese-writing', 'data-analysis', 'locaith-brand']));
    expect(reg.search('dung bang bieu do')[0].name).toBe('artifacts');
    expect(reg.search('báo giá khách hàng pdf')[0].name).toBe('locaith-brand');
    expect(reg.search('nghiên cứu so sánh nguồn')[0].name).toBe('web-research');
    expect(foldVi('Đặng Thị Hồng')).toBe('dang thi hong');
    expect(reg.unlockedTools(['artifacts'])).toEqual(new Set(['list_artifact_types', 'create_artifact', 'update_artifact']));
  });

  it('nạp kỹ năng của người dùng từ thư mục workspace và cho ghi đè kỹ năng dựng sẵn', async () => {
    const dir = makeWorkspace({
      '.locaith/skills/bao-gia/SKILL.md': '---\nname: bao-gia\ndescription: Soạn báo giá theo mẫu công ty\n---\nLuôn ghi VAT 10%.',
      '.locaith/skills/bao-gia/mau.html': '<html></html>',
      '.locaith/skills/web-research/SKILL.md': '---\nname: web-research\ndescription: Bản của công ty\n---\nQuy trình riêng.',
    });
    const host = new NodeToolHost({ roots: [dir] });
    const reg = new SkillRegistry(builtinSkills());
    const r = await reg.loadDirs(host, [{ path: path.join(dir, '.locaith', 'skills'), source: 'workspace' }]);
    expect(r.loaded).toBe(2);
    expect(reg.get('bao-gia')?.files).toEqual(['mau.html']);
    expect(reg.get('web-research')?.source).toBe('workspace');
    expect(reg.get('web-research')?.body).toBe('Quy trình riêng.');
    expect(reg.catalog()).toContain('bao-gia: Soạn báo giá');
  });
});

describe('glob và .gitignore', () => {
  it('globToRegExp', () => {
    expect(globToRegExp('src/**/*.ts').test('src/a/b/c.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/c.ts')).toBe(true);
    expect(globToRegExp('*.ts').test('a/b.ts')).toBe(false);
    expect(globToRegExp('**/*.{ts,tsx}').test('x/y.tsx')).toBe(true);
    expect(globToRegExp('file?.txt').test('file1.txt')).toBe(true);
    expect(globToRegExp('[ab].txt').test('a.txt')).toBe(true);
    expect(compileGlob('*.md', true).test('docs/guide.md')).toBe(true);
    expect(compileGlob('docs/*.md', true).test('docs/guide.md')).toBe(true);
    expect(compileGlob('docs/*.md', true).test('x/docs/guide.md')).toBe(false);
  });

  it('GitIgnore: neo gốc, thư mục, phủ định', () => {
    const gi = new GitIgnore();
    gi.parse('# c\n*.log\n/build\ndist/\nsecrets/*\n!secrets/keep.txt\n');
    expect(gi.ignored('a/b.log', false)).toBe(true);
    expect(gi.ignored('build', true)).toBe(true);
    expect(gi.ignored('src/build', true)).toBe(false);
    expect(gi.ignored('dist', true)).toBe(true);
    expect(gi.ignored('dist', false)).toBe(false);
    expect(gi.ignored('secrets/x.txt', false)).toBe(true);
    expect(gi.ignored('secrets/keep.txt', false)).toBe(false);
    expect(gi.ignored('src/app.ts', false)).toBe(false);
  });
});

describe('compaction', () => {
  const big = 'x'.repeat(5000);
  const mk = (n: number): ChatMessage[] => {
    const out: ChatMessage[] = [];
    for (let i = 0; i < n; i++) {
      out.push({ role: 'user', content: [{ type: 'text', text: `câu hỏi ${i}` }] });
      out.push({ role: 'assistant', content: [{ type: 'thinking', text: 'nghĩ', provider: 'anthropic', signature: 's' }, { type: 'tool_use', id: `t${i}`, name: 'read_file', input: {} }] });
      out.push({ role: 'user', content: [{ type: 'tool_result', toolUseId: `t${i}`, name: 'read_file', content: big }] });
      out.push({ role: 'assistant', content: [{ type: 'text', text: `đáp ${i}` }] });
    }
    return out;
  };

  it('pruneOldToolResults chỉ rút gọn kết quả cũ, giữ nguyên các lượt gần đây và xoá khối suy luận', () => {
    const s = newSession({ id: 's', provider: 'p', model: 'm' });
    s.messages = mk(10);
    const saved = pruneOldToolResults(s, 6, 1500);
    expect(saved).toBeGreaterThan(5000);
    expect(s.historyEdited).toBe(true);
    const results = s.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result') as any[];
    expect(results[0].content).toContain('đã được lược bớt');
    expect(results.at(-1).content).toBe(big);
    expect(s.messages.some((m) => m.content.some((b) => b.type === 'thinking'))).toBe(false);
  });

  it('summarizeHistory cắt ở ranh giới lượt người dùng, không tách cặp tool_use/tool_result', async () => {
    const s = newSession({ id: 's', provider: 'p', model: 'm' });
    s.messages = mk(6);
    const provider = new FakeProvider([]);
    provider.completeImpl = async () => 'Tóm tắt cũ.';
    const removed = await summarizeHistory({ session: s, provider, model: 'm', language: 'vi', signal: new AbortController().signal, keepRecentUserTurns: 2 });
    expect(removed).toBe(16); // 4 lượt × 4 tin nhắn
    expect(s.messages[0].role).toBe('user');
    expect(s.messages[1].role).toBe('assistant');
    expect(s.messages[2].role).toBe('user');
    expect((s.messages[2].content[0] as any).text).toBe('câu hỏi 4');
    // mọi tool_use còn lại đều có kết quả ngay sau
    for (let i = 0; i < s.messages.length; i++) {
      const uses = s.messages[i].content.filter((b) => b.type === 'tool_use');
      if (uses.length) expect(s.messages[i + 1].content.some((b) => b.type === 'tool_result')).toBe(true);
    }
    expect(s.historyEdited).toBe(true);
  });
});

describe('reducer transcript', () => {
  const base = (): ViewState => ({ transcript: [], todos: [], running: false, mode: 'default' }) as unknown as ViewState;
  const start: UiEvent = { t: 'assistant_start', id: 'a1', provider: 'p', model: 'm', ts: 1 };
  const apply = (events: UiEvent[]) => events.reduce(reduceView, base());
  const blocks = (v: ViewState) => (v.transcript[0] as Extract<TItem, { kind: 'assistant' }>).blocks;

  it('dòng trạng thái: cùng pillId thì cập nhật tại chỗ, pill mới thì dòng cũ chuyển xám', () => {
    const v = apply([
      start,
      { t: 'pill', id: 'a1', pillId: 'p1', text: 'Đang suy nghĩ…', kind: 'thinking' },
      { t: 'pill', id: 'a1', pillId: 'p1', text: 'Đang đối chiếu điểm số', kind: 'thinking' },
      { t: 'pill', id: 'a1', pillId: 'p2', text: 'Đang chọn phiên bản', kind: 'thinking' },
    ]);
    const b = blocks(v) as any[];
    expect(b).toHaveLength(2);
    expect(b[0]).toMatchObject({ text: 'Đang đối chiếu điểm số', active: false });
    expect(b[1]).toMatchObject({ text: 'Đang chọn phiên bản', active: true });
  });

  it('chỉ báo tạm (working) bị gỡ hẳn khi nội dung thật xuất hiện', () => {
    const v = apply([
      start,
      { t: 'pill', id: 'a1', pillId: 'w1', text: 'Đang suy nghĩ…', kind: 'working' },
      { t: 'text', id: 'a1', delta: 'Xin chào' },
    ]);
    expect(blocks(v).map((x) => x.type)).toEqual(['text']);
  });

  it('chữ nối vào khối cuối; sau công cụ thì mở khối chữ mới', () => {
    const v = apply([
      start,
      { t: 'text', id: 'a1', delta: 'Xin ' },
      { t: 'text', id: 'a1', delta: 'chào' },
      { t: 'tool_start', id: 'a1', callId: 'c1', name: 'read_file', args: { path: 'a' } },
      { t: 'tool_end', id: 'a1', callId: 'c1', state: 'done', summary: '3 dòng', durationMs: 5 },
      { t: 'text', id: 'a1', delta: 'Xong' },
    ]);
    const b = blocks(v) as any[];
    expect(b.map((x) => x.type)).toEqual(['text', 'tool', 'text']);
    expect(b[0].text).toBe('Xin chào');
    expect(b[1]).toMatchObject({ state: 'done', summary: '3 dòng', durationMs: 5 });
  });

  it('xin phép rồi duyệt: dòng công cụ đi awaiting_permission → running → done', () => {
    const req = { id: 'p', callId: 'c1', tool: 'edit_file', kind: 'edit', title: 't', canAllowSession: true } as const;
    let v = apply([start, { t: 'tool_start', id: 'a1', callId: 'c1', name: 'edit_file', args: {} }, { t: 'tool_permission', id: 'a1', callId: 'c1', request: req }]);
    expect((blocks(v)[0] as any).state).toBe('awaiting_permission');
    v = reduceView(v, { t: 'tool_start', id: 'a1', callId: 'c1', name: 'edit_file', args: {} });
    expect((blocks(v)[0] as any).state).toBe('running');
    expect((blocks(v)[0] as any).permission).toBeUndefined();
    v = reduceView(v, { t: 'tool_end', id: 'a1', callId: 'c1', state: 'done', durationMs: 1 });
    expect((blocks(v)[0] as any).state).toBe('done');
  });

  it('tasks cập nhật bảng todo và chỉ tạo dòng "Đã thêm tác vụ" khi có tiêu đề mới', () => {
    const todos = [{ id: 't1', title: 'A', status: 'in_progress' as const }];
    let v = apply([start, { t: 'tasks', id: 'a1', todos, added: ['A'] }]);
    expect(v.todos).toEqual(todos);
    expect(blocks(v).map((b) => b.type)).toEqual(['tasks']);
    v = reduceView(v, { t: 'tasks', id: 'a1', todos: [{ ...todos[0], status: 'completed' }], added: [] });
    expect(blocks(v)).toHaveLength(1);
    expect(v.todos[0].status).toBe('completed');
  });

  it('usage cộng dồn, notice độc lập khi không có id, giữ nguyên tham chiếu khi không có gì đổi', () => {
    let v = apply([start, { t: 'usage', id: 'a1', usage: { inputTokens: 10, outputTokens: 5 } }, { t: 'usage', id: 'a1', usage: { inputTokens: 20, outputTokens: 7 } }]);
    expect((v.transcript[0] as any).usage).toMatchObject({ inputTokens: 30, outputTokens: 12 });
    v = reduceView(v, { t: 'notice', level: 'warn', text: 'chú ý' });
    expect(v.transcript.at(-1)).toMatchObject({ kind: 'notice', text: 'chú ý' });
    const same = reduceView(v, { t: 'text', id: 'khong-co', delta: 'x' });
    expect(same).toBe(v);
  });

  it('applyEvent bất biến và trimTranscriptForStorage cắt kết quả dài', () => {
    const items: TItem[] = [];
    const next = applyEvent(items, { t: 'user', id: 'u', text: 'hi', attachments: [], ts: 1 });
    expect(items).toHaveLength(0);
    expect(next).toHaveLength(1);
    let v = apply([start, { t: 'tool_start', id: 'a1', callId: 'c', name: 'run_command', args: {} }, { t: 'tool_end', id: 'a1', callId: 'c', state: 'done', output: 'x'.repeat(9000), durationMs: 1 }]);
    const trimmed = trimTranscriptForStorage(v.transcript, 1000);
    expect(((trimmed[0] as any).blocks[0] as any).output.length).toBeLessThanOrEqual(1000);
  });
});

describe('tiện ích khác', () => {
  it('makeWorkspace và NodeToolHost.readText giữ nguyên tiếng Việt', async () => {
    const dir = makeWorkspace({ 'vi.txt': 'Nguyễn Văn Ánh — đường Lê Lợi' });
    const host = new NodeToolHost({ roots: [dir] });
    expect(await host.readText(path.join(dir, 'vi.txt'))).toBe('Nguyễn Văn Ánh — đường Lê Lợi');
    expect(fs.existsSync(path.join(dir, 'vi.txt'))).toBe(true);
  });
});
