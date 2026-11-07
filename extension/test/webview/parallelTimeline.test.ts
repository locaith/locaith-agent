import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ABlock, AgentProgress, PermissionRequest, ToolBlock } from '../../src/shared/protocol';
import { agentStats, buildSegments, isLiveAgent, nestedRows, summarizeTools, type ActivityRow, type Segment } from '../../webview/src/timeline';
import { latestLabel } from '../../webview/src/components/timeline/latestLabel';
import { describeTool } from '../../webview/src/toolLabels';

const tool = (id: string, name: string, state: ToolBlock['state'] = 'done', args: Record<string, unknown> = {}, agent?: AgentProgress): ToolBlock => ({
  type: 'tool',
  id,
  name,
  args,
  state,
  startedAt: 0,
  ...(agent ? { agent } : {}),
});
const perm = (id: string): ToolBlock => ({
  ...tool(id, 'edit_file', 'awaiting_permission', { path: 'a.ts' }),
  permission: { id: `p_${id}`, callId: id, tool: 'edit_file', kind: 'edit', title: 'Cho phép sửa a.ts?', canAllowSession: true } as PermissionRequest,
});
const think = (id: string): ABlock => ({ type: 'thinking', id, text: 'đang cân nhắc' });
const rowsOf = (segs: Segment[], i = 0): ActivityRow[] => {
  const s = segs[i];
  return s && s.kind === 'activity' ? s.rows : [];
};
const kinds = (rows: ActivityRow[]) => rows.map((r) => r.kind);

describe('dòng tóm tắt «N lệnh gọi công cụ»', () => {
  it('ngưỡng: 2 lệnh khác tên → từng dòng; 3 lệnh khác tên → MỘT dòng tóm tắt (đã xong hay đang chạy đều vậy)', () => {
    const two = buildSegments([tool('a', 'read_file'), tool('b', 'run_command')], false, true);
    expect(kinds(rowsOf(two))).toEqual(['tool', 'tool']);
    const three = buildSegments([tool('a', 'read_file'), tool('b', 'run_command'), tool('c', 'web_search')], false, true);
    expect(kinds(rowsOf(three))).toEqual(['toolsum']);
    const doneThree = buildSegments([tool('a', 'read_file'), tool('b', 'run_command'), tool('c', 'web_search')], true, true);
    expect(kinds(rowsOf(doneThree))).toEqual(['toolsum']);
  });

  it('tổng, số lỗi, đang chạy và lệnh mới nhất', () => {
    const blocks = [tool('a', 'read_file'), tool('b', 'run_command', 'error'), tool('c', 'grep', 'running', { pattern: 'x' }), tool('d', 'web_search', 'running', { query: 'q' })];
    const row = rowsOf(buildSegments(blocks, false, true))[0];
    expect(row.kind).toBe('toolsum');
    if (row.kind !== 'toolsum') return;
    expect(row.info).toMatchObject({ total: 4, failed: 1, running: true });
    expect(row.info.latest?.id).toBe('d'); // mới nhất trong các lệnh đang chạy
    expect(row.info.blocks.map((b) => b.id)).toEqual(['a', 'b', 'c', 'd']);
    // xong hết → không còn "đang chạy"
    const settled = rowsOf(buildSegments([tool('a', 'read_file'), tool('b', 'run_command'), tool('c', 'grep')], false, true))[0];
    expect(settled.kind === 'toolsum' && settled.info.running).toBe(false);
    expect(settled.kind === 'toolsum' && settled.info.latest).toBeUndefined();
  });

  // (lane:cc-timeline-ui) ĐỔI CÓ CHỦ Ý theo ảnh Claude Code: «54 tool calls · 2 failed» chỉ đếm lệnh của lượt; «249 tools» của agent nằm trên dòng agent.
  it('lệnh BÊN TRONG agent con KHÔNG cộng vào tổng/số lỗi của dòng nhóm (agent = 1 lệnh; số của nó hiện trên dòng agent)', () => {
    const blocks = [
      tool('r1', 'read_file'),
      tool('r2', 'grep'),
      tool('ag1', 'agent', 'done', { description: 'A' }, { tokens: 1000, tools: 12, failed: 1 }),
      tool('ag2', 'agent', 'done', { description: 'B' }, { tokens: 2000, tools: 44 }),
    ];
    const row = rowsOf(buildSegments(blocks, true, true))[0];
    expect(row.kind === 'toolsum' && row.info).toMatchObject({ total: 4, failed: 0 });
  });

  it('agent đang chạy có dòng riêng bên dưới; tổng của dòng tóm tắt đếm mỗi agent là một lệnh', () => {
    const blocks = [
      tool('r1', 'read_file'),
      tool('r2', 'grep'),
      tool('r3', 'run_command'),
      tool('ag1', 'agent', 'running', { description: 'A' }, { tokens: 461_400, tools: 12 }),
      tool('ag2', 'agent', 'running', { description: 'B' }, { tokens: 591_400, tools: 44, failed: 2 }),
      tool('ag3', 'workflow_run', 'running', { description: 'C' }, { tokens: 489_700, tools: 22 }),
    ];
    const rows = rowsOf(buildSegments(blocks, false, true));
    expect(kinds(rows)).toEqual(['toolsum', 'agent', 'agent', 'agent']);
    const sum = rows[0];
    expect(sum.kind === 'toolsum' && sum.info.blocks.map((b) => b.id)).toEqual(['r1', 'r2', 'r3']); // agent đang chạy KHÔNG nằm trong danh sách mở rộng
    expect(sum.kind === 'toolsum' && sum.info.total).toBe(3 + 3); // 3 lệnh + 3 agent (lệnh bên trong agent KHÔNG cộng)
    expect(sum.kind === 'toolsum' && sum.info.failed).toBe(0);
    expect(sum.kind === 'toolsum' && sum.info.liveCalls).toBe(3); // phần thuộc agent sống (có dòng riêng) để cụm gộp không đếm hai lần
    expect(rows.slice(1).map((r) => r.kind === 'agent' && r.block.id)).toEqual(['ag1', 'ag2', 'ag3']);
  });

  it('dưới ngưỡng nhưng có agent đang chạy: giữ thứ tự, agent vẫn là dòng sống; chỉ agent thì không có dòng tóm tắt', () => {
    const mixed = rowsOf(buildSegments([tool('r1', 'read_file'), tool('ag1', 'agent', 'running'), tool('r2', 'grep')], false, true));
    expect(kinds(mixed)).toEqual(['tool', 'agent', 'tool']);
    const onlyAgents = rowsOf(buildSegments([tool('a1', 'agent', 'running'), tool('a2', 'agent', 'running'), tool('a3', 'agent', 'running')], false, true));
    expect(kinds(onlyAgents)).toEqual(['agent', 'agent', 'agent']);
  });

  it('agent đã xong nhập vào dòng tóm tắt (không còn dòng sống); bị hủy/lỗi cũng vậy', () => {
    const blocks = [tool('r1', 'read_file'), tool('r2', 'grep'), tool('ag1', 'agent', 'done'), tool('ag2', 'agent', 'cancelled'), tool('ag3', 'agent', 'error')];
    const rows = rowsOf(buildSegments(blocks, false, true));
    expect(kinds(rows)).toEqual(['toolsum']);
    expect(rows[0].kind === 'toolsum' && rows[0].info.blocks).toHaveLength(5);
    expect(rows[0].kind === 'toolsum' && rows[0].info.failed).toBe(1);
  });

  it('thẻ xin phép luôn nằm NGOÀI dòng tóm tắt và cắt chuỗi', () => {
    const blocks = [tool('a', 'read_file'), tool('b', 'read_file'), perm('p1'), tool('c', 'grep'), tool('d', 'grep'), tool('e', 'grep')];
    const segs = buildSegments(blocks, false, true);
    expect(segs.map((s) => s.kind)).toEqual(['activity', 'permission', 'activity']);
    expect(kinds(rowsOf(segs, 0))).toEqual(['tool', 'tool']); // 2 lệnh trước thẻ: chưa đủ ngưỡng
    expect(kinds(rowsOf(segs, 2))).toEqual(['toolsum']); // 3 lệnh sau thẻ
    // thẻ chờ phép nhưng thiếu thông tin quyền (không thể thành đoạn riêng): vẫn là một dòng, vẫn cắt chuỗi, không bị nuốt vào tóm tắt
    const odd: ToolBlock = tool('x', 'edit_file', 'awaiting_permission');
    const rows = rowsOf(buildSegments([tool('a', 'read_file'), tool('b', 'read_file'), tool('c', 'read_file'), odd, tool('d', 'read_file')], false, true));
    expect(kinds(rows)).toEqual(['toolsum', 'tool', 'tool']);
    expect(rows[1].kind === 'tool' && rows[1].block.id).toBe('x');
  });

  it('suy nghĩ/dòng trạng thái chen giữa tách thành các chuỗi riêng (mỗi bước một dòng tóm tắt)', () => {
    const blocks: ABlock[] = [tool('a', 'read_file'), tool('b', 'grep'), tool('c', 'glob'), think('k1'), tool('d', 'read_file'), tool('e', 'grep'), tool('f', 'glob')];
    expect(kinds(rowsOf(buildSegments(blocks, false, true)))).toEqual(['toolsum', 'thinking', 'toolsum']);
  });

  it('todo_write/load_skill đã ẩn (có khối riêng) không bị đếm', () => {
    const blocks = [tool('a', 'todo_write'), tool('b', 'load_skill'), tool('c', 'read_file'), tool('d', 'grep')];
    expect(kinds(rowsOf(buildSegments(blocks, false, true)))).toEqual(['tool', 'tool']);
  });

  it('lượt đã xong, cả chuỗi cùng một công cụ gộp được → giữ dòng cụ thể cũ «Đã đọc N tệp»; có agent đang chạy hoặc khác tên → dòng tóm tắt', () => {
    const reads = ['1', '2', '3', '4'].map((i) => tool(`r${i}`, 'read_file'));
    expect(kinds(rowsOf(buildSegments(reads, true, true)))).toEqual(['toolgroup']);
    expect(kinds(rowsOf(buildSegments(reads, false, true)))).toEqual(['toolsum']); // lượt chưa xong: tóm tắt chung
    expect(kinds(rowsOf(buildSegments([...reads, tool('x', 'grep')], true, true)))).toEqual(['toolsum']);
    // (turnLive=true cưỡng bức: một lượt đã xong mà còn agent chạy là tình huống giả định để thử nhánh «có agent sống thì không giữ dòng gộp cụ thể»)
    expect(kinds(rowsOf(buildSegments([...reads, tool('ag', 'agent', 'running')], true, true, true)))).toEqual(['toolsum', 'agent']);
  });

  it('lượt KHÔNG còn chạy (phiên lưu giữa chừng, đóng cửa sổ): khối agent còn ghi "running" là dữ liệu cũ — không dòng sống, không vòng quay', () => {
    const stale = [tool('r1', 'read_file'), tool('r2', 'grep'), tool('r3', 'glob'), tool('ag1', 'agent', 'running', { description: 'A' }, { tokens: 10, tools: 2 }), tool('r4', 'read_file', 'running')];
    // mặc định turnLive = !turnDone: lượt đã xong → không có dòng agent sống
    const done = rowsOf(buildSegments(stale, true, true));
    expect(kinds(done)).toEqual(['toolsum']);
    expect(done[0].kind === 'toolsum' && done[0].info).toMatchObject({ running: false, total: 5 });
    expect(done[0].kind === 'toolsum' && done[0].info.latest).toBeUndefined();
    // lượt chưa xong nhưng không chạy (view.running = false) → cũng vậy
    const idle = rowsOf(buildSegments(stale, false, true, false));
    expect(kinds(idle)).toEqual(['toolsum']);
    expect(idle[0].kind === 'toolsum' && idle[0].info.running).toBe(false);
    // cùng dữ liệu nhưng lượt đang chạy → dòng agent sống + vòng quay
    const live = rowsOf(buildSegments(stale, false, true, true));
    expect(kinds(live)).toEqual(['toolsum', 'agent']);
    expect(live[0].kind === 'toolsum' && live[0].info.running).toBe(true);
  });

  it('khoá của đoạn hoạt động KHÔNG đổi khi chuỗi lệnh vượt ngưỡng (không dựng lại cả đoạn, giữ trạng thái mở/đóng)', () => {
    const before = buildSegments([think('k1'), tool('a', 'read_file'), tool('b', 'grep')], false, true)[0];
    const after = buildSegments([think('k1'), tool('a', 'read_file'), tool('b', 'grep'), tool('c', 'glob')], false, true)[0];
    expect(before.key).toBe(after.key);
    // và khoá dòng tóm tắt ổn định khi chuỗi lớn thêm
    const k1 = rowsOf(buildSegments([tool('a', 'read_file'), tool('b', 'grep'), tool('c', 'glob')], false, true))[0].key;
    const k2 = rowsOf(buildSegments([tool('a', 'read_file'), tool('b', 'grep'), tool('c', 'glob'), tool('d', 'glob')], false, true))[0].key;
    expect(k1).toBe(k2);
  });
});

describe('summarizeTools / agentStats / isLiveAgent', () => {
  it('agentStats chịu được dữ liệu hỏng (tệp sao lưu, bản cũ): luôn số nguyên không âm', () => {
    const bad = { ...tool('a', 'agent'), agent: { tokens: 'x', tools: NaN, failed: -3, activity: 42 } } as unknown as ToolBlock;
    expect(agentStats(bad)).toEqual({ tokens: 0, tools: 0, failed: 0, activity: '' });
    expect(agentStats(tool('a', 'agent'))).toEqual({ tokens: 0, tools: 0, failed: 0, activity: '' });
    expect(agentStats(tool('a', 'agent', 'running', {}, { tokens: 12.9, tools: 3.2, failed: 1, activity: 'Đang đọc' }))).toEqual({ tokens: 12, tools: 3, failed: 1, activity: 'Đang đọc' });
  });

  it('summarizeTools không có agent: tổng = số khối', () => {
    expect(summarizeTools([tool('a', 'read_file'), tool('b', 'grep', 'error')])).toMatchObject({ total: 2, failed: 1, running: false });
  });

  it('isLiveAgent: chỉ agent/workflow_run đang chạy', () => {
    expect(isLiveAgent(tool('a', 'agent', 'running'))).toBe(true);
    expect(isLiveAgent(tool('a', 'workflow_run', 'running'))).toBe(true);
    expect(isLiveAgent(tool('a', 'agent', 'done'))).toBe(false);
    expect(isLiveAgent(tool('a', 'read_file', 'running'))).toBe(false);
  });

  it('phiên cũ không có trường `agent` hiển thị đúng như trước (không dòng sống, không số liệu)', () => {
    const rows = rowsOf(buildSegments([tool('a', 'agent', 'done'), tool('b', 'read_file')], true, true));
    expect(kinds(rows)).toEqual(['tool', 'tool']);
  });
});

describe('nestedRows (phần mở rộng của dòng tóm tắt)', () => {
  it('từng lệnh, và chuỗi cùng tên gộp được đã xong vẫn gộp; đang chạy thì không gộp', () => {
    const blocks = [tool('a', 'read_file'), tool('b', 'read_file'), tool('c', 'read_file'), tool('d', 'edit_file'), tool('e', 'grep'), tool('f', 'grep'), tool('g', 'grep', 'running')];
    expect(kinds(nestedRows(blocks))).toEqual(['toolgroup', 'tool', 'tool', 'tool', 'tool']);
    expect(nestedRows([])).toEqual([]);
  });
});

describe('latestLabel — việc mới nhất trên dòng tóm tắt', () => {
  it('công cụ tệp/URL: nhãn đã nêu đích, không lặp đường dẫn dài; truy vấn/lệnh thì kèm chi tiết', () => {
    expect(latestLabel('vi', tool('a', 'read_file', 'running', { path: 'src/utils/băm.ts' }))).toBe('Đang đọc băm.ts…');
    expect(latestLabel('vi', tool('a', 'web_search', 'running', { query: 'giá vàng' }))).toBe('Đang tìm kiếm trên web: giá vàng');
    expect(latestLabel('en', tool('a', 'run_command', 'running', { command: 'npm test' }))).toBe('Running command: npm test');
    expect(latestLabel('vi', tool('a', 'fetch_url', 'running', { url: 'https://www.a.io/x' }))).toBe('Đang đọc a.io…');
    expect(latestLabel('vi', undefined)).toBe('');
  });
});

describe('describeTool cho agent / workflow', () => {
  it('nhãn riêng theo mô tả, biểu tượng riêng, và KHÔNG thuộc KNOWN (vẫn hiện «Đối số» để đọc prompt)', () => {
    const d = describeTool('vi', 'agent', { description: 'Tìm hằng số' }, 'running');
    expect(d.label).toBe('Agent con: Tìm hằng số…');
    expect(d.icon).toBe('bot');
    expect(describeTool('en', 'agent', { description: 'Find constants' }, 'done').label).toBe('Sub-agent: Find constants');
    expect(describeTool('vi', 'workflow_run', { description: 'Hai việc' }, 'done')).toMatchObject({ label: 'Workflow: Hai việc', icon: 'network' });
    expect(describeTool('vi', 'agent', {}, 'done').hidden).toBe(false);
  });
});

describe('giao diện: CSS và chuỗi', () => {
  const W = path.resolve(__dirname, '../../webview/src');
  const css = fs.readFileSync(path.join(W, 'styles/parallel.css'), 'utf8');
  const main = fs.readFileSync(path.join(W, 'styles/main.css'), 'utf8');
  const summaryTsx = fs.readFileSync(path.join(W, 'components/timeline/ToolSummary.tsx'), 'utf8');
  const agentTsx = fs.readFileSync(path.join(W, 'components/timeline/AgentRow.tsx'), 'utf8');
  const i18n = fs.readFileSync(path.join(W, 'i18n.ts'), 'utf8');

  it('parallel.css được nạp, giảm chuyển động và tương phản cao được lo, hẹp thì không tràn ngang', () => {
    expect(main).toMatch(/@import '\.\/parallel\.css'/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).toMatch(/body\.vscode-high-contrast \.par-agent-activity/);
    // hẹp: bộ số «token · lệnh» dời từ dòng đầu xuống đầu dòng hai (luôn đúng hai dòng chữ, không xuống dòng, không tràn ngang)
    expect(css).toMatch(/@container app \(max-width: 520px\)\s*\{[^}]*\.par-st-counts\s*\{\s*display:\s*none/);
    expect(css).toMatch(/\.par-act-counts\s*\{\s*display:\s*none/); // mặc định ẩn (bề ngang rộng)
    expect(css).toMatch(/@container app \(max-width: 270px\)/);
    expect(css).toMatch(/text-overflow:\s*ellipsis/);
    expect(css).not.toMatch(/flex-wrap:\s*wrap/); // không xuống dòng thứ ba ở bất kỳ bề ngang nào
  });

  it('quy tắc chữ của dự án: không IN HOA, không letter-spacing âm, không chữ nhỏ hơn 12px', () => {
    expect(css).not.toMatch(/text-transform:\s*uppercase/);
    expect(css).not.toMatch(/letter-spacing:\s*-/);
    for (const m of css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(12);
  });

  it('truy cập được: danh sách/mục, không thông báo mỗi giây, nút mở rộng là <button> có aria-expanded', () => {
    expect(agentTsx).toMatch(/role="listitem"/);
    expect(agentTsx).toMatch(/aria-live="off"/);
    expect(agentTsx).not.toMatch(/aria-live="(polite|assertive)"/);
    expect(agentTsx).not.toMatch(/role="(timer|status|progressbar)"/);
    // (lane:cc-timeline-ui) nút mở rộng nằm trong RunHead dùng chung: vẫn là <button> thật có aria-expanded; ToolSummary truyền open/onToggle vào.
    const runHeadTsx = fs.readFileSync(path.join(W, 'components/timeline/RunHead.tsx'), 'utf8');
    expect(runHeadTsx).toMatch(/<button type="button" class=\{cx\('tool-head', 'cc-head'[^>]*aria-expanded=\{p\.open\}/);
    expect(summaryTsx).toMatch(/<RunHead[\s\S]*open=\{open\}[\s\S]*onToggle=/);
    expect(summaryTsx).toMatch(/if \(flat\)/); // trong nhóm đã mở: bày phẳng từng lệnh, không dòng tóm tắt trung gian
    expect(summaryTsx).toMatch(/role="listitem"/);
    // aria-label của dòng agent không chứa số giây (đọc to một đồng hồ chạy là nhiễu)
    expect(agentTsx).toMatch(/aria-label=\{t\('par\.agent\.aria', \{ title, activity, stats: `\$\{tokens\}, \$\{tools\}/);
  });

  it('mọi khoá par.* / tool.agent.* / tool.workflow_run.* dùng trong giao diện có đủ tiếng Việt và tiếng Anh', () => {
    const used = [...(summaryTsx + agentTsx).matchAll(/'(par\.[a-zA-Z.]+)'/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(6);
    for (const k of new Set([...used, 'tool.agent.run', 'tool.agent.done', 'tool.workflow_run.run', 'tool.workflow_run.done'])) {
      const n = i18n.split(`'${k}':`).length - 1;
      expect(n, `thiếu khoá ${k} ở một trong hai ngôn ngữ`).toBe(2);
    }
  });

  it('chữ tiếng Việt đúng dấu ở các chuỗi chính', () => {
    expect(i18n).toContain(`'par.calls': "{n} lệnh gọi công cụ"`);
    expect(i18n).toContain(`'par.failed': "{n} lỗi"`);
    expect(i18n).toContain(`'par.calls': "{n} tool calls"`);
    expect(i18n).toContain(`'par.failed': "{n} failed"`);
  });
});

describe('lệnh sửa tệp luôn hiện riêng, không gấp vào dòng tóm tắt', () => {
  const mk = (id: string, name: string, extra: Record<string, unknown> = {}) =>
    ({ type: 'tool', id, name, args: {}, state: 'done', startedAt: 1, ...extra }) as unknown as import('../../src/shared/protocol').ToolBlock;
  it('read×3, edit, read×3 → tóm tắt(3), dòng edit, tóm tắt(3)', async () => {
    const { buildSegments } = await import('../../webview/src/timeline');
    const blocks = [mk('r1', 'read_file'), mk('r2', 'grep'), mk('r3', 'glob'), mk('e1', 'edit_file', { diff: { added: 3, removed: 1 } }), mk('r4', 'read_file'), mk('r5', 'grep'), mk('r6', 'glob')];
    const seg = buildSegments(blocks, true, false)[0] as { rows: { kind: string; info?: { total: number }; block?: { id: string } }[] };
    expect(seg.rows.map((r) => r.kind)).toEqual(['toolsum', 'tool', 'toolsum']);
    expect(seg.rows[0].info?.total).toBe(3);
    expect(seg.rows[1].block?.id).toBe('e1');
    expect(seg.rows[2].info?.total).toBe(3);
  });
  it('các lần sửa/tạo tệp liền nhau gộp một dòng; lệnh đọc hai bên vẫn từng dòng', async () => {
    const { buildSegments } = await import('../../webview/src/timeline');
    const blocks = [mk('r1', 'read_file'), mk('r2', 'grep'), mk('w1', 'write_file'), mk('x1', 'run_command', { diff: { added: 1, removed: 0 } }), mk('r3', 'read_file')];
    const seg = buildSegments(blocks, true, false)[0] as { rows: { kind: string }[] };
    // 0.6.11: hai lần sửa/tạo tệp liền nhau (write_file và run_command có diff) gộp MỘT dòng; lệnh đọc hai bên vẫn riêng.
    expect(seg.rows.map((r) => r.kind)).toEqual(['tool', 'tool', 'editgroup', 'tool']);
  });
});
