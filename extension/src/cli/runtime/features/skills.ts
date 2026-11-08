/**
 * Mô-đun 5a — kỹ năng. Nạp thư mục kỹ năng của người dùng (`~/.locaith/skills`, `~/.claude/skills`), của dự án (`.locaith/skills`, chỉ khi tin cậy),
 * `skills.paths` và của plugin vào `ctx.skills.loadDirs`, cho phép ĐỌC các thư mục đó (`ctx.addReadRoot`). Quét lại khi đổi phiên, khi
 * plugin đổi, và mỗi lần chạy `/skills`. `/skills` liệt kê (nguồn, mô tả, đã nạp chưa), `/skills <tên>` xem chi tiết, `/skills reload`.
 */

import type { SkillDef } from '../../../core/skills/registry';
import type { FeatureContext, FeatureModule } from '../contract';
import { extraReadDirs, skillDirs } from './dirs';
import { makeTr, oneLine } from './ext';
import { activePlugins, onPluginsChanged } from './plugins';

const tr = makeTr('skills', {
  head: ['**Kỹ năng** ({n}) — ● đã nạp trong phiên này', '**Skills** ({n}) — ● loaded in this session'],
  gBuiltin: ['Dựng sẵn', 'Built-in'],
  gUser: ['Cá nhân / plugin', 'User / plugin'],
  gWorkspace: ['Dự án', 'Project'],
  none: ['Chưa có kỹ năng nào.', 'No skills yet.'],
  unknown: ['Không có kỹ năng «{name}».', 'No skill “{name}”.'],
  errors: ['⚠ {n} kỹ năng lỗi: {list}', '⚠ {n} skill(s) failed: {list}'],
  reloaded: ['Đã nạp lại: {n} kỹ năng từ thư mục người dùng/dự án/plugin.', 'Reloaded: {n} skill(s) from user/project/plugin folders.'],
  where: ['Nguồn: {source}{dir}', 'Source: {source}{dir}'],
  files: ['Tệp kèm: {files}', 'Files: {files}'],
  tip: ['Thêm kỹ năng: tạo `~/.locaith/skills/<tên>/SKILL.md` (hoặc `.locaith/skills/` trong dự án). `/skills <tên>` xem chi tiết.', 'Add a skill: create `~/.locaith/skills/<name>/SKILL.md` (or `.locaith/skills/` in a project). `/skills <name>` shows details.'],
});

export class SkillsLoader {
  private chain: Promise<unknown> = Promise.resolve();
  lastErrors: string[] = [];

  constructor(private readonly ctx: FeatureContext) {}

  /** Nạp lại (tuần tự: `loadDirs` xoá sổ rồi nạp, hai lần chồng nhau sẽ lẫn). */
  reload(): Promise<{ loaded: number; errors: string[] }> {
    const run = this.chain.then(async () => {
      const plugins = await activePlugins(this.ctx);
      for (const d of extraReadDirs(this.ctx, plugins)) this.ctx.addReadRoot(d);
      const res = await this.ctx.skills.loadDirs(this.ctx.host, skillDirs(this.ctx, plugins));
      this.lastErrors = res.errors;
      for (const e of res.errors) this.ctx.log('warn', `Kỹ năng lỗi: ${e}`);
      return res;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}

function describeSkill(s: SkillDef, loaded: boolean, home: string): string {
  const dir = s.dir ? ` · \`${s.dir.replace(home, '~').replace(/\\/g, '/')}\`` : '';
  return `- ${loaded ? '●' : '○'} **${s.name}** — ${oneLine(s.description, 150)}${dir}`;
}

export const skillsFeature: FeatureModule = {
  name: 'skills',
  async attach(ctx) {
    const loader = new SkillsLoader(ctx);
    await loader.reload();
    ctx.onSessionChange(() => void loader.reload());
    onPluginsChanged(ctx, () => void loader.reload());

    ctx.slash({
      name: 'skills',
      description: { vi: 'Danh sách kỹ năng (dựng sẵn, cá nhân, dự án, plugin) — /skills <tên> xem chi tiết', en: 'List skills (built-in, user, project, plugin) — /skills <name> shows details' },
      argHint: '[<tên>|reload]',
      needsIdle: false,
      async run(c) {
        const arg = c.args.trim();
        const res = await loader.reload();
        if (arg.toLowerCase() === 'reload') return c.output(tr(c.lang, 'reloaded', { n: res.loaded }), 'plain');
        const loadedNames = new Set(ctx.session().loadedSkills);
        const list = ctx.skills.list(ctx.session().provider);
        if (arg) {
          const s = ctx.skills.get(arg, ctx.session().provider);
          if (!s) return c.output(tr(c.lang, 'unknown', { name: arg }), 'error');
          const body = s.body.split('\n').slice(0, 25).join('\n');
          return c.output(
            [`**${s.name}** ${loadedNames.has(s.name) ? '●' : '○'}`, s.description, tr(c.lang, 'where', { source: s.source, dir: s.dir ? ` · ${s.dir}` : '' }), s.files?.length ? tr(c.lang, 'files', { files: s.files.join(', ') }) : '', '', body].filter((x) => x !== '').join('\n'),
          );
        }
        if (!list.length) return c.output(tr(c.lang, 'none'), 'plain');
        const groups: [string, SkillDef[]][] = [
          [tr(c.lang, 'gWorkspace'), list.filter((s) => s.source === 'workspace')],
          [tr(c.lang, 'gUser'), list.filter((s) => s.source === 'user')],
          [tr(c.lang, 'gBuiltin'), list.filter((s) => s.source === 'builtin')],
        ];
        const body = groups.filter(([, l]) => l.length).map(([g, l]) => `*${g}*\n${l.map((s) => describeSkill(s, loadedNames.has(s.name), ctx.home)).join('\n')}`).join('\n\n');
        const errs = res.errors.length ? `\n\n${tr(c.lang, 'errors', { n: res.errors.length, list: oneLine(res.errors.join('; '), 200) })}` : '';
        c.output(`${tr(c.lang, 'head', { n: list.length })}\n\n${body}${errs}\n\n${tr(c.lang, 'tip')}`);
      },
    });
  },
};

