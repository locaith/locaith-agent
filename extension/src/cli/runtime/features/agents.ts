/**
 * Mô-đun 5b — agent con. Nạp `.locaith/agents` (dự án, chỉ khi tin cậy), `~/.locaith/agents`, tương thích `.claude/agents` và agent của plugin vào
 * `ctx.agents.loadDirs`. `/agents` liệt kê (nguồn, mô hình, công cụ, tệp), `/agents new <tên>` tạo mẫu, `/agents open <tên>` mở tệp bằng $EDITOR.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { slugifyName } from '../../../core/skills/registry';
import type { AgentDef } from '../../../core/agents/definitions';
import type { FeatureContext, FeatureModule } from '../contract';
import { agentDirs, extraReadDirs } from './dirs';
import { makeTr, oneLine } from './ext';
import { activePlugins, onPluginsChanged } from './plugins';

const tr = makeTr('agents', {
  title: ['**Agent con** ({n})', '**Sub-agents** ({n})'],
  gBuiltin: ['Dựng sẵn', 'Built-in'],
  gUser: ['Cá nhân', 'User'],
  gWorkspace: ['Dự án', 'Project'],
  gPlugin: ['Plugin', 'Plugin'],
  tip: ['`/agents new <tên>` tạo mẫu trong `.locaith/agents`, `/agents open <tên>` mở tệp định nghĩa.', '`/agents new <name>` creates a template in `.locaith/agents`, `/agents open <name>` opens its file.'],
  exists: ['Đã có tệp {file}.', '{file} already exists.'],
  created: ['Đã tạo {file} — sửa phần mô tả và vai trò rồi lưu; danh sách tự làm mới.', 'Created {file} — edit the description and role, then save; the list refreshes itself.'],
  noFile: ['Agent «{name}» là agent dựng sẵn, không có tệp.', '“{name}” is a built-in agent with no file.'],
  unknown: ['Không có agent «{name}».', 'No agent named “{name}”.'],
  needFolder: ['Hãy chạy locaith trong một thư mục dự án.', 'Run locaith inside a project folder.'],
  needTrust: ['Thư mục chưa được tin cậy: không tạo tệp.', 'The folder is not trusted: no file created.'],
  usageNew: ['Cú pháp: `/agents new <tên>`', 'Usage: `/agents new <name>`'],
  errors: ['⚠ {n} agent lỗi: {list}', '⚠ {n} agent(s) failed: {list}'],
});

export function agentTemplate(name: string, lang: 'vi' | 'en'): string {
  return lang === 'en'
    ? `---\nname: ${name}\ndescription: One sentence: when should the main assistant hand work to this agent?\ntools: readonly\nmodel: inherit\ncolor: blue\n---\nYou are ${name}. Describe the role, what to look at first, what never to do, and the exact report format to return.\n`
    : `---\nname: ${name}\ndescription: Một câu: khi nào trợ lý chính nên giao việc cho agent này?\ntools: readonly\nmodel: inherit\ncolor: blue\n---\nBạn là ${name}. Mô tả vai trò, việc cần xem trước tiên, điều không bao giờ được làm và khuôn báo cáo cần trả về.\n`;
}

export class AgentsLoader {
  private chain: Promise<unknown> = Promise.resolve();
  lastErrors: string[] = [];
  constructor(private readonly ctx: FeatureContext) {}

  reload(): Promise<{ loaded: number; errors: string[] }> {
    const run = this.chain.then(async () => {
      const plugins = await activePlugins(this.ctx);
      for (const d of extraReadDirs(this.ctx, plugins)) this.ctx.addReadRoot(d);
      const res = await this.ctx.agents.loadDirs(this.ctx.host, agentDirs(this.ctx, plugins));
      this.lastErrors = res.errors;
      for (const e of res.errors) this.ctx.log('warn', `Agent lỗi: ${e}`);
      return res;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}

export const agentsFeature: FeatureModule = {
  name: 'agents',
  async attach(ctx) {
    const loader = new AgentsLoader(ctx);
    await loader.reload();
    ctx.onSessionChange(() => void loader.reload());
    onPluginsChanged(ctx, () => void loader.reload());

    ctx.slash({
      name: 'agents',
      description: { vi: 'Danh sách agent con — /agents new <tên> tạo mẫu, /agents open <tên> mở tệp', en: 'List sub-agents — /agents new <name> creates a template, /agents open <name> opens its file' },
      argHint: '[new <tên>|open <tên>]',
      needsIdle: false,
      async run(c) {
        const lang = c.lang;
        const [verb, ...rest] = c.args.split(/\s+/).filter(Boolean);
        const v = (verb ?? '').toLowerCase();
        if (v === 'new' || v === 'tao' || v === 'create') {
          const name = slugifyName(rest.join('-'));
          if (!name) return c.output(tr(lang, 'usageNew'), 'error');
          if (!fs.existsSync(ctx.cwd)) return c.output(tr(lang, 'needFolder'), 'error');
          if (!ctx.isTrusted()) return c.output(tr(lang, 'needTrust'), 'error');
          const file = path.join(ctx.cwd, '.locaith', 'agents', `${name}.md`);
          const rel = path.relative(ctx.cwd, file).replace(/\\/g, '/');
          if (fs.existsSync(file)) return c.output(tr(lang, 'exists', { file: rel }), 'error');
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, agentTemplate(name, lang), 'utf8');
          await loader.reload();
          c.output(tr(lang, 'created', { file: rel }), 'plain');
          ctx.emit({ t: 'action', action: 'open_editor', payload: file });
          return;
        }
        if (v === 'open' || v === 'mo') {
          const ag = ctx.agents.get(rest.join(' '));
          if (!ag) return c.output(tr(lang, 'unknown', { name: rest.join(' ') }), 'error');
          if (!ag.file) return c.output(tr(lang, 'noFile', { name: ag.name }), 'plain');
          ctx.emit({ t: 'action', action: 'open_editor', payload: ag.file });
          return;
        }
        const res = await loader.reload();
        const all = ctx.agents.list();
        const label = (s: AgentDef['source']) => tr(lang, s === 'builtin' ? 'gBuiltin' : s === 'user' ? 'gUser' : s === 'workspace' ? 'gWorkspace' : 'gPlugin');
        const groups = new Map<string, string[]>();
        for (const ag of all) {
          const tools = Array.isArray(ag.tools) ? ag.tools.join(', ') : ag.tools;
          const line = `- **${ag.name}** (${ag.model ?? ag.tier}, ${tools}) — ${oneLine(ag.description, 160)}${ag.file ? ` · \`${ag.file.replace(ctx.home, '~').replace(/\\/g, '/')}\`` : ''}`;
          groups.set(label(ag.source), [...(groups.get(label(ag.source)) ?? []), line]);
        }
        const body = [...groups.entries()].map(([k, lines]) => `*${k}*\n${lines.join('\n')}`).join('\n\n');
        const errs = res.errors.length ? `\n\n${tr(lang, 'errors', { n: res.errors.length, list: oneLine(res.errors.join('; '), 200) })}` : '';
        c.output(`${tr(lang, 'title', { n: all.length })}\n\n${body}${errs}\n\n${tr(lang, 'tip')}`);
      },
    });
  },
};

