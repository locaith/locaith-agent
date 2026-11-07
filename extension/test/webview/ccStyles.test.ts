import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * (lane:cc-timeline-ui) Dòng thời gian gọn kiểu Claude Code — kiểm bằng phân tích mã (như remoteStyles/locaithStyles): stylesheet nạp cuối,
 * giảm chuyển động, tương phản cao, quy tắc chữ tiếng Việt, không tô nền kín, đủ hai ngôn ngữ, không dấu «…» thừa, không thông báo hệ thống VS Code,
 * và các bất biến cấu trúc DOM mà trang Remote (locaith.ai) sẽ chép theo (docs/TIMELINE-SPEC.md).
 */
const W = path.resolve(__dirname, '../../webview/src');
const read = (p: string) => fs.readFileSync(path.join(W, p), 'utf8');
const css = read('styles/timeline-cc.css');
const main = read('styles/main.css');
const i18n = read('i18n.ts');
const tl = 'components/timeline/';
const sources = {
  runHead: read(`${tl}RunHead.tsx`),
  toolRow: read(`${tl}ToolRow.tsx`),
  cmd: read(`${tl}CmdInOut.tsx`),
  preview: read(`${tl}FilePreview.tsx`),
  compact: read(`${tl}CompactRow.tsx`),
  marks: read(`${tl}TimeMarks.tsx`),
  slot: read(`${tl}MessageActionSlot.tsx`),
  activity: read(`${tl}Activity.tsx`),
  turn: read(`${tl}AssistantTurn.tsx`),
  agent: read(`${tl}AgentRow.tsx`),
  summary: read(`${tl}ToolSummary.tsx`),
  user: read(`${tl}UserMessage.tsx`),
  clock: read('components/composer/RunClock.tsx'),
  chat: read('components/ChatView.tsx'),
  composer: read('components/composer/Composer.tsx'),
};
const all = Object.values(sources).join('\n');

/** Bảng chữ của một ngôn ngữ: phần vi trước `export type I18nKey`, phần en sau đó. */
const split = i18n.indexOf('export type I18nKey');
const TABLES = { vi: i18n.slice(0, split), en: i18n.slice(split) };
const str = (lang: 'vi' | 'en', key: string): string => {
  const m = new RegExp(`'${key.replace(/\./g, '\\.')}':\\s*(['"])(.*?)\\1`).exec(TABLES[lang]);
  if (!m) throw new Error(`thiếu chuỗi ${lang}:${key}`);
  return m[2]!;
};

describe('stylesheet timeline-cc.css', () => {
  it('được nạp CUỐI CÙNG trong main.css (để thắng kiểu cũ)', () => {
    const imports = [...main.matchAll(/@import '\.\/([a-z-]+)\.css'/g)].map((m) => m[1]);
    expect(imports[imports.length - 1]).toBe('timeline-cc');
  });

  it('giảm chuyển động: tắt nhấp nháy chấm và shimmer; tương phản cao: chữ phụ đậm hơn, chấm có viền, shimmer tắt', () => {
    const i = css.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(i).toBeGreaterThan(0);
    const rm = css.slice(i);
    expect(rm).toMatch(/\.cc-dot\.is-live\s*\{[^}]*animation:\s*none/);
    expect(rm).toMatch(/\.cc-shimmer\s*\{[^}]*animation:\s*none/);
    expect(css).toMatch(/body\.vscode-high-contrast \.cc-dot,\s*body\.vscode-high-contrast-light \.cc-dot\s*\{[^}]*box-shadow/);
    expect(css).toMatch(/body\.vscode-high-contrast \.cc-shimmer[\s\S]*?animation:\s*none/);
    expect(css).toMatch(/body\.vscode-high-contrast-light \.cc-line/);
  });

  it('quy tắc chữ tiếng Việt: không IN HOA bằng CSS, không letter-spacing âm, không chữ nhỏ hơn 12px', () => {
    expect(css).not.toMatch(/text-transform:\s*uppercase/);
    expect(css).not.toMatch(/letter-spacing:\s*-/);
    for (const m of css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(12);
  });

  it('tối giản: dòng nhóm/thông báo/nén KHÔNG tô nền kín, không viền trái màu khi gập; đầu ra lỗi chỉ đổi màu chữ', () => {
    const block = (sel: string) => {
      const m = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css);
      if (!m) throw new Error(`thiếu khối ${sel}`);
      return m[1]!;
    };
    expect(block('.cc-notice')).toMatch(/background:\s*transparent/);
    expect(block('.cc-notice')).toMatch(/border:\s*0/);
    expect(css).toMatch(/\.cc-group,[\s\S]*?\{[^}]*border-left:\s*0;[^}]*box-shadow:\s*none/);
    expect(block('.cc-io.is-error .cc-io-pre')).not.toMatch(/background/);
    expect(block('.cc-io.is-error .cc-io-pre')).toMatch(/color:/);
    // mở ra: thanh dọc mảnh 1px bên trái
    expect(css).toMatch(/\.cc-group > \.tool-group-body,[\s\S]*?border-left:\s*1px solid var\(--line\)/);
    // ô IN/OUT cắt ~4 dòng, phần cắt mờ dần
    expect(block('.cc-io-pre.is-clamped')).toMatch(/mask-image:\s*linear-gradient/);
    expect(block('.cc-io-pre.is-clamped')).toMatch(/1\.55em \* 4/);
  });

  it('khung hẹp: ô IN/OUT xếp dọc và ẩn thời lượng dưới 320px; đường ngăn ngày dạng sóng dùng mask (theo màu --line)', () => {
    expect(css).toMatch(/@container app \(max-width: 320px\)\s*\{[\s\S]*?\.cc-io\s*\{[^}]*grid-template-columns:\s*1fr/);
    expect(css).toMatch(/\.cc-day-line\s*\{[^}]*mask-image:\s*url\("data:image\/svg\+xml/);
  });
});

describe('thành phần: cấu trúc DOM đơn giản, tên lớp rõ (trang Remote chép theo)', () => {
  it('RunHead: <button class="tool-head cc-head"> có aria-expanded, chấm .cc-dot, dòng .cc-line, phụ .cc-sub, chevron xuống/lên', () => {
    expect(sources.runHead).toMatch(/aria-expanded=\{p\.open\}/);
    expect(sources.runHead).toMatch(/class=\{cx\('cc-dot', `is-\$\{tone\}`\)\}/);
    expect(sources.runHead).toMatch(/class="cc-line"/);
    expect(sources.runHead).toMatch(/class="cc-sub"/);
    expect(sources.runHead).toMatch(/p\.open \? 'chevron-up' : 'chevron-down'/);
    expect(sources.runHead).not.toMatch(/<Icon name=(?!\{p\.open)/); // không biểu tượng nào khác ngoài chevron
  });

  it('ToolRow: tên hành động in đậm + mô tả (ưu tiên args.description) + đường dẫn màu liên kết; nested → tự bày IN/OUT, xem trước, diff', () => {
    expect(sources.toolRow).toMatch(/toolDescription\(lang, block\)/);
    expect(sources.toolRow).toMatch(/<b class=\{cx\('cc-action', cls\)\}>\{name\}<\/b>/);
    expect(sources.toolRow).toMatch(/class="cc-desc cc-path"/);
    expect(sources.toolRow).toMatch(/nested && Boolean\(fullCommand \|\| content \|\| block\.diff\)/);
    expect(sources.toolRow).toMatch(/<CmdInOut command=\{fullCommand\}/);
    expect(sources.toolRow).toMatch(/<FilePreview content=\{content\}/);
    expect(sources.toolRow).toMatch(/<DiffView diff=\{block\.diff\} callId=\{block\.id\}/);
    expect(sources.toolRow).toMatch(/writeLineCount\(block\)/);
    // mở tệp chỉ ở VS Code (bản Chrome không có editor)
    expect(sources.toolRow).toMatch(/platform === 'vscode' \? \(\) => post\(\{ type: 'open_file'/);
  });

  it('CmdInOut: nhãn IN/OUT từ i18n, cắt 4 dòng, bấm bung/thu, sao chép khi rê chuột, lỗi chỉ đổi lớp is-error', () => {
    expect(sources.cmd).toMatch(/IO_CLAMP_LINES = 4/);
    expect(sources.cmd).toMatch(/t\('cc\.in'\)/);
    expect(sources.cmd).toMatch(/t\('cc\.out'\)/);
    expect(sources.cmd).toMatch(/role=\{long \? 'button' : undefined\}/);
    expect(sources.cmd).toMatch(/class="cc-io-copy"/);
    expect(sources.cmd).toMatch(/error && 'is-error'/);
  });

  it('FilePreview: 4 dòng đầu, tô màu bằng highlight() đã qua DOMPurify, bung tối đa 400 dòng, Thu gọn ở cuối', () => {
    expect(sources.preview).toMatch(/PREVIEW_LINES = 4/);
    expect(sources.preview).toMatch(/PREVIEW_MAX_LINES = 400/);
    expect(sources.preview).toMatch(/highlight\(code, lang\)/);
    expect(sources.preview).toMatch(/<CollapseFoot/);
  });

  it('CompactRow: chữ nghiêng (CSS), ba phần «đầu · chế độ · giải phóng», mở ra có tóm tắt + Thu gọn; dùng cho notice trong lượt lẫn độc lập', () => {
    expect(sources.compact).toMatch(/t\('cc\.compact\.head'\)/);
    expect(sources.compact).toMatch(/compact\.tokensFreed \? t\('cc\.compact\.freed'/);
    expect(sources.compact).toMatch(/<CollapseFoot/);
    expect(css).toMatch(/\.cc-compact-head\s*\{[^}]*font-style:\s*italic/);
    expect(sources.turn).toMatch(/if \(compact\) return <CompactRow compact=\{compact\} text=\{text\} \/>;/);
    expect(sources.turn).toMatch(/compact=\{item\.compact\}/); // StandaloneNotice
    expect(sources.turn).toMatch(/compact=\{b\.compact\}/); // notice trong lượt
  });

  it('giờ/ngày: <time dateTime>, đường ngăn role=separator; giờ của câu trả lời lấy từ endedAt (không bịa)', () => {
    expect(sources.marks).toMatch(/<time dateTime=/);
    expect(sources.marks).toMatch(/role="separator"/);
    expect(sources.turn).toMatch(/<Stamp ts=\{item\.endedAt\} \/>/);
    expect(sources.chat).toMatch(/timelineMarks\(view\.transcript\)/);
    expect(sources.chat).toMatch(/<DayDivider ts=\{mark\.day\} \/>/);
  });

  it('tin người dùng có MessageActionSlot (data-slot) chứa nút sửa; ô nhập có RunClock; nhãn đang chạy đậm + logo Lo', () => {
    expect(sources.slot).toMatch(/data-slot="message-actions"/);
    expect(sources.user).toMatch(/<MessageActionSlot>[\s\S]*class="user-edit"[\s\S]*<\/MessageActionSlot>/);
    expect(sources.composer).toMatch(/<RunClock view=\{view\} \/>/);
    expect(sources.clock).toMatch(/runningSince\(view\)/);
    expect(sources.turn).toMatch(/<LoSpinner size=\{15\} \/>\s*<span class="cc-working-label">/);
    expect(css).toMatch(/\.cc-working-label\s*\{[^}]*font-weight:\s*600/);
  });

  it('dòng agent luôn hiện dưới nhóm GẬP (AgentLines) ở cả lượt đang chạy lẫn lượt đã xong; bộ số in đậm nhẹ', () => {
    expect(sources.turn).toMatch(/\{!open && <AgentLines rows=\{rows\} \/>\}/);
    expect((sources.turn.match(/<AgentLines rows=/g) ?? []).length).toBe(2);
    expect(css).toMatch(/\.cc-agent \.par-agent-stats\s*\{[^}]*font-weight:\s*600/);
  });

  it('không có biểu tượng trong cột chấm của Activity; không dùng thông báo hệ thống VS Code; không dấu «…» thừa ở nhãn', () => {
    expect(sources.activity).not.toMatch(/<Icon name="(lightbulb|check|zap|list-checks)"/);
    expect(all).not.toMatch(/showInformationMessage|showWarningMessage|StatusBar|new Notification\(/);
    for (const k of ['cc.running', 'cc.background', 'cc.thought', 'cc.thoughtPlain', 'cc.thinking', 'cc.compact.head', 'cc.copy', 'cc.showAll']) {
      for (const lang of ['vi', 'en'] as const) expect(str(lang, k), `${lang}:${k}`).not.toContain('…');
    }
  });

  it('mọi khoá cc.* dùng trong mã có ở CẢ HAI ngôn ngữ, tiếng Việt có dấu đúng ở vài chuỗi chính', () => {
    const keys = new Set<string>();
    for (const m of all.matchAll(/'(cc\.[a-zA-Z.]+)'/g)) keys.add(m[1]!);
    for (const m of read('timelineCc.ts').matchAll(/`cc\.action\.\$\{k\}`/g)) void m;
    for (const k of ['bash', 'read', 'write', 'edit', 'grep', 'glob', 'list', 'web', 'fetch', 'agent', 'workflow', 'artifact', 'skill', 'notes', 'tasks', 'plan', 'tabs', 'page']) keys.add(`cc.action.${k}`);
    expect(keys.size).toBeGreaterThan(30);
    for (const k of keys) for (const lang of ['vi', 'en'] as const) expect(() => str(lang, k), `${lang}:${k}`).not.toThrow();
    expect(str('vi', 'cc.thought')).toBe('Đã suy nghĩ {d}');
    expect(str('en', 'cc.thought')).toBe('Thought for {d}');
    expect(str('vi', 'cc.background')).toBe('Chạy nền');
    expect(str('vi', 'cc.compact.freed')).toBe('giải phóng {n} token');
    expect(str('vi', 'composer.placeholderQueue')).toBe('Xếp hàng tin nhắn khác…');
    expect(str('en', 'composer.placeholderQueue')).toBe('Queue another message…');
  });
});
