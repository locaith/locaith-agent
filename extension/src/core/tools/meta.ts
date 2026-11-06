/**
 * Công cụ trạng thái & kế hoạch (4A): todo_write, scratchpad, load_skill, search_skills, exit_plan_mode.
 */

import type { TodoItem, TodoStatus } from '../../shared/protocol';
import { foldVi, type SkillRegistry } from '../skills/registry';
import type { ToolDef } from '../engine/types';

// ─────────────────────────────────────────────────────────────────────────────
// todo_write
// ─────────────────────────────────────────────────────────────────────────────

interface TodoInput {
  todos: { id?: string; title: string; status: TodoStatus }[];
}

export const todoWriteTool: ToolDef<TodoInput> = {
  name: 'todo_write',
  description:
    'Create and maintain the task list for the current request. Use it FIRST for any request that needs 3+ steps (research, multi-file changes, building a deliverable) ' +
    'to anchor the goal, then update it as you go. Send the COMPLETE list every time (it replaces the previous one). ' +
    'Keep exactly one task in_progress; mark tasks completed as soon as they are done. Titles are shown to the user: keep them short and write them in the user\'s language. ' +
    'Skip it for simple questions or one-step actions.',
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The full, ordered task list.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Stable short id (t1, t2…). Reuse ids across updates.' },
            title: { type: 'string', description: 'Short task title for the user.' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['title', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  risk: 'meta',
  concurrencySafe: false,
  async execute(input, ctx) {
    const prev = ctx.session.todos;
    const seen = new Set<string>();
    const next: TodoItem[] = input.todos
      .map((t, i) => ({ id: (t.id ?? '').trim() || `t${i + 1}`, title: t.title.trim(), status: t.status }))
      .filter((t) => t.title.length > 0)
      .map((t) => {
        let id = t.id;
        while (seen.has(id)) id += '_';
        seen.add(id);
        return { ...t, id };
      });

    const prevIds = new Set(prev.map((p) => p.id));
    const prevTitles = new Set(prev.map((p) => foldVi(p.title)));
    const added = next.filter((n) => !prevIds.has(n.id) && !prevTitles.has(foldVi(n.title))).map((n) => n.title);

    ctx.session.todos = next;
    ctx.emit({ t: 'tasks', id: ctx.assistantId, todos: next, added });

    const done = next.filter((n) => n.status === 'completed').length;
    const current = next.find((n) => n.status === 'in_progress');
    return {
      content:
        `Đã cập nhật danh sách tác vụ: ${done}/${next.length} hoàn thành.` +
        (current ? ` Đang làm: "${current.title}".` : next.length > done ? ' Chưa có tác vụ nào ở trạng thái in_progress.' : ' Tất cả đã xong.'),
      summary: `${done}/${next.length}`,
      display: next.map((n) => `${n.status === 'completed' ? '[x]' : n.status === 'in_progress' ? '[~]' : '[ ]'} ${n.title}`).join('\n'),
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// scratchpad
// ─────────────────────────────────────────────────────────────────────────────

interface ScratchInput {
  action: 'write' | 'append' | 'read' | 'list' | 'delete';
  key?: string;
  value?: string;
}

const SCRATCH_MAX_TOTAL = 120_000;

export const scratchpadTool: ToolDef<ScratchInput> = {
  name: 'scratchpad',
  description:
    'Private working notes that persist for this conversation (not shown as chat text). Store intermediate findings, extracted tables, source URLs or decisions ' +
    'so they are not lost during long tasks. Actions: write/append (key + value), read (key), list, delete (key).',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['write', 'append', 'read', 'list', 'delete'] },
      key: { type: 'string', description: 'Note name, e.g. "sources" or "scores_table".' },
      value: { type: 'string', description: 'Content for write/append.' },
    },
    required: ['action'],
  },
  risk: 'meta',
  concurrencySafe: false,
  async execute(input, ctx) {
    const pad = ctx.session.scratchpad;
    const key = (input.key ?? '').trim();
    switch (input.action) {
      case 'list': {
        const keys = Object.keys(pad);
        return { content: keys.length ? keys.map((k) => `- ${k} (${pad[k].length} ký tự)`).join('\n') : '(scratchpad trống)', summary: `${keys.length} ghi chú` };
      }
      case 'read':
        if (!key) return { content: 'Thiếu key.', isError: true };
        return key in pad ? { content: pad[key], summary: key } : { content: `Không có ghi chú "${key}".`, isError: true };
      case 'delete':
        if (!key) return { content: 'Thiếu key.', isError: true };
        delete pad[key];
        return { content: `Đã xoá "${key}".`, summary: key };
      case 'write':
      case 'append': {
        if (!key) return { content: 'Thiếu key.', isError: true };
        const value = input.value ?? '';
        const nextVal = input.action === 'append' && key in pad ? `${pad[key]}\n${value}` : value;
        const total = Object.entries(pad).reduce((n, [k, v]) => n + (k === key ? 0 : v.length), 0) + nextVal.length;
        if (total > SCRATCH_MAX_TOTAL) return { content: 'Scratchpad đã đầy. Xoá bớt ghi chú cũ.', isError: true };
        pad[key] = nextVal;
        return { content: `Đã lưu "${key}" (${nextVal.length} ký tự).`, summary: key };
      }
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// load_skill / search_skills
// ─────────────────────────────────────────────────────────────────────────────

/** Nguồn gợi ý từ Chợ kỹ năng (kỹ năng đóng gói sẵn nhưng chưa được người dùng thêm). */
export interface MarketSearch {
  search(query: string, limit: number, skip: ReadonlySet<string>): Promise<{ name: string; description: string }[]>;
}

/**
 * `currentProvider`: nhà cung cấp của phiên đang chạy — kỹ năng riêng của một họ mô hình (`providers: [locaith]`) chỉ hiện với họ đó.
 * Lúc chạy công cụ thì lấy chính xác từ `ctx.session.provider`; hàm này chỉ dùng để dựng mô tả công cụ (danh mục).
 */
export function createSkillTools(skills: SkillRegistry, market?: MarketSearch, currentProvider?: () => string | undefined): ToolDef[] {
  const loadSkill: ToolDef<{ skill_name: string }> = {
    name: 'load_skill',
    // Mô tả động: danh mục kỹ năng có thể đổi khi người dùng thêm skill vào workspace.
    get description() {
      return (
        'Load a specialised skill: its full guidelines are returned in the tool result and any extra tools it provides become available. ' +
        'Load a skill BEFORE building a complex deliverable (tables/dashboards, long documents, code work, research) instead of improvising. ' +
        'Available skills:\n' +
        skills.catalog(currentProvider?.())
      );
    },
    inputSchema: {
      type: 'object',
      properties: { skill_name: { type: 'string', description: 'Exact skill name from the list.' } },
      required: ['skill_name'],
    },
    risk: 'meta',
    concurrencySafe: false,
    async execute(input, ctx) {
      const pid = ctx.session.provider;
      const skill = skills.get(input.skill_name, pid);
      if (!skill) {
        const near = skills.search(input.skill_name, 3, pid).map((s) => s.name);
        return {
          content: `Không có kỹ năng "${input.skill_name}".` + (near.length ? ` Gần giống: ${near.join(', ')}.` : '') + `\nDanh sách:\n${skills.catalog(pid)}`,
          isError: true,
        };
      }
      if (!ctx.session.loadedSkills.includes(skill.name)) ctx.session.loadedSkills.push(skill.name);
      ctx.emit({ t: 'skill', id: ctx.assistantId, skill: skill.name, unlocked: skill.unlocks });
      const extra = skill.files?.length && skill.dir ? `\n\nTệp đi kèm (đọc bằng read_file khi cần): ${skill.files.map((f) => `${skill.dir}/${f}`).join(', ')}` : '';
      const tools = skill.unlocks.length ? `\n\n---\nCông cụ vừa được mở khoá: ${skill.unlocks.join(', ')}.` : '';
      return { content: `# Kỹ năng: ${skill.name}\n\n${skill.body}${extra}${tools}`, summary: skill.name };
    },
  };

  const searchSkills: ToolDef<{ query: string }> = {
    name: 'search_skills',
    description: 'Search the skill catalog by keywords when you are unsure which skill fits the task. Returns up to 5 matching skills with descriptions.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Keywords describing the task.' } },
      required: ['query'],
    },
    risk: 'meta',
    concurrencySafe: true,
    async execute(input, ctx) {
      const pid = ctx.session.provider;
      const found = skills.search(input.query, 5, pid);
      // Chợ có thể có kỹ năng phù hợp mà người dùng chưa thêm: báo để mô hình nhờ họ bấm "Thêm" (mô hình không tự cài).
      let extra = '';
      let extraCount = 0;
      if (market) {
        try {
          const more = await market.search(input.query, 4, new Set(skills.list(pid).map((s) => s.name)));
          extraCount = more.length;
          if (more.length) extra = `\n\nChợ kỹ năng còn có (CHƯA thêm — nếu cần, nhờ người dùng mở Chợ trên giao diện và bấm Thêm):\n${more.map((s) => `- ${s.name}: ${s.description.slice(0, 160)}`).join('\n')}`;
        } catch {
          /* Chợ lỗi không được làm hỏng tìm kiếm */
        }
      }
      if (found.length === 0) {
        if (extra) return { content: `Không có kỹ năng đã thêm nào khớp.${extra}`, summary: `${extraCount} trong Chợ` };
        return { content: 'Không có kỹ năng nào khớp. Hãy làm tiếp với công cụ sẵn có.', summary: '0 kỹ năng' };
      }
      return { content: found.map((s) => `- ${s.name}: ${s.description}`).join('\n') + extra, summary: `${found.length} kỹ năng` };
    },
  };

  return [loadSkill, searchSkills];
}

// ─────────────────────────────────────────────────────────────────────────────
// exit_plan_mode
// ─────────────────────────────────────────────────────────────────────────────

export const exitPlanModeTool: ToolDef<{ plan: string }> = {
  name: 'exit_plan_mode',
  description:
    'Plan mode only. Call this when you finished researching and have a complete plan: the plan is shown to the user for approval. ' +
    'Do not start changing anything before it is approved.',
  inputSchema: {
    type: 'object',
    properties: { plan: { type: 'string', description: 'The plan in Markdown: goal, steps, files to touch, risks, how it will be verified.' } },
    required: ['plan'],
  },
  risk: 'meta',
  concurrencySafe: false,
  hidden: true,
  onlyInMode: 'plan',
  async permission(input) {
    return { kind: 'plan', title: 'Duyệt kế hoạch này?', planMarkdown: input.plan, sessionLabel: 'Duyệt và tự nhận chỉnh sửa' };
  },
  async execute(_input, ctx) {
    return {
      content: `Kế hoạch đã được người dùng duyệt. Chế độ quyền hiện tại: ${ctx.session.mode}. Hãy bắt đầu thực hiện theo kế hoạch, cập nhật todo_write khi hoàn thành từng bước.`,
      summary: 'Đã duyệt',
    };
  },
};
