/**
 * Mô-đun 8 — luật quyền bền `permissions.allow / ask / deny` (shared/permissionRules.ts + core/engine/extensions/permissionRules.ts).
 *   • nguồn luật theo TỪNG phạm vi: `ask`/`deny` nhận từ user, project, local; `allow` chỉ từ user và local (không bị repo lạ cài sẵn) —
 *     `allow` trong `.locaith/settings.json` của dự án chỉ có hiệu lực sau khi người dùng chấp nhận đúng danh sách (`/permissions trust`);
 *     thư mục chưa tin cậy ⇒ bỏ MỌI luật allow của cài đặt (như extension). Cờ dòng lệnh `--allowedTools/--disallowedTools` (cài đặt
 *     `cli.allowedTools` / `cli.disallowedTools`) là luật của người dùng và luôn có hiệu lực;
 *   • RunExtension cho engine chính + agent con (`subAgents:true`);
 *   • «Luôn cho phép…»: `addAlwaysAllow` ghi luật `allow` vào cài đặt user/local (lõi gọi qua điểm móc tuỳ chọn `registerAlwaysAllow`);
 *   • `/permissions` — xem/thêm/xoá luật, thử một lệnh, chấp nhận allow của dự án, đổi chế độ (menu `ctx.ask` hoặc dạng chữ).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { permissionRulesExtension, type RuleSnapshot } from '../../../core/engine/extensions/permissionRules';
import { resolveUserPathReal } from '../../../core/fsutil/paths';
import { buildRules, evaluateRules, formatRule, hashRules, parseRule, type Rule, type RuleAction } from '../../../shared/permissionRules';
import type { PermissionMode } from '../../../shared/protocol';
import type { FeatureContext, FeatureModule, SlashRunContext } from '../contract';
import { asExt, askSlash, makeTr, oneLine } from './ext';
import { getPath, readJsonFile, strList, type Scope } from './settingsFile';

const tr = makeTr('perm', {
  head: ['Luật quyền đang có hiệu lực', 'Permission rules in effect'],
  none: ['Chưa có luật nào. Thêm: `/permissions allow run_command(npm test:*)` (hoặc chọn «Thêm luật» ở menu).', 'No rules yet. Add: `/permissions allow run_command(npm test:*)` (or pick “Add a rule” in the menu).'],
  pending: ['Dự án đề xuất {n} luật cho phép chưa áp dụng: {rules} — gõ `/permissions trust` để chấp nhận.', 'The project proposes {n} allow rule(s) not yet applied: {rules} — type `/permissions trust` to accept.'],
  untrusted: ['Thư mục chưa được tin cậy: mọi luật cho phép trong cài đặt bị bỏ qua.', 'Folder not trusted: all allow rules in settings are ignored.'],
  mode: ['Chế độ quyền hiện tại: **{mode}**', 'Current permission mode: **{mode}**'],
  added: ['Đã thêm luật **{action}** `{rule}` vào {where}.', 'Added **{action}** rule `{rule}` to {where}.'],
  invalid: ['Luật không hợp lệ: `{rule}`', 'Invalid rule: `{rule}`'],
  exists: ['Luật `{rule}` đã có.', 'Rule `{rule}` already exists.'],
  removed: ['Đã xoá `{rule}` khỏi {where}.', 'Removed `{rule}` from {where}.'],
  notFound: ['Không có luật `{rule}` ở {where}.', 'No rule `{rule}` in {where}.'],
  untrustedWrite: ['Thư mục chưa được tin cậy — không ghi luật vào cài đặt dự án.', 'Folder not trusted — not writing rules to project settings.'],
  testHit: ['`{cmd}` → **{action}** bởi luật `{rule}` ({source}).', '`{cmd}` → **{action}** by rule `{rule}` ({source}).'],
  testMiss: ['`{cmd}` → không khớp luật nào; chế độ quyền hiện tại quyết định.', '`{cmd}` → no rule matches; the current permission mode decides.'],
  trusted: ['Đã chấp nhận luật cho phép của dự án này.', 'Accepted this project’s allow rules.'],
  nothingPending: ['Dự án không có luật cho phép nào đang chờ.', 'This project has no pending allow rules.'],
  usage: ['Cú pháp: `/permissions` · `allow|ask|deny <luật> [--local|--project]` · `remove <luật>` · `test <lệnh>` · `trust` · `mode <default|acceptEdits|plan|bypass>`.', 'Usage: `/permissions` · `allow|ask|deny <rule> [--local|--project]` · `remove <rule>` · `test <command>` · `trust` · `mode <default|acceptEdits|plan|bypass>`.'],
  tooBroad: ['Luật `{rule}` quá rộng để lưu từ thẻ xin quyền — hãy nêu đặc tả cụ thể, hoặc dùng `/permissions allow …`.', 'Rule `{rule}` is too broad to save from the permission card — give a specific spec, or use `/permissions allow …`.'],
  saved: ['Đã lưu luật cho phép `{rule}` ({where}).', 'Saved allow rule `{rule}` ({where}).'],
  wUser: ['cài đặt người dùng', 'user settings'],
  wProject: ['cài đặt dự án', 'project settings'],
  wLocal: ['cài đặt cục bộ', 'local settings'],
  menuTitle: ['Luật quyền — chọn việc cần làm', 'Permission rules — what to do?'],
  mAdd: ['Thêm luật', 'Add a rule'],
  mRemove: ['Xoá luật', 'Remove a rule'],
  mMode: ['Đổi chế độ quyền', 'Change permission mode'],
  mTest: ['Thử một lệnh với bộ luật', 'Test a command against the rules'],
  pickAction: ['Loại luật?', 'Rule type?'],
  aAllow: ['allow — cho phép không hỏi', 'allow — run without asking'],
  aAsk: ['ask — luôn hỏi', 'ask — always ask'],
  aDeny: ['deny — luôn chặn', 'deny — always block'],
  inputRule: ['Nhập luật, ví dụ `run_command(npm test:*)`, `edit_file(src/**)`, `fetch_url(domain:example.com)`', 'Enter the rule, e.g. `run_command(npm test:*)`, `edit_file(src/**)`, `fetch_url(domain:example.com)`'],
  pickScope: ['Lưu ở đâu?', 'Save where?'],
  sUser: ['Cá nhân (mọi dự án)', 'User (all projects)'],
  sLocal: ['Dự án, cục bộ (không commit)', 'Project, local (not committed)'],
  sProject: ['Dự án (chia sẻ qua git)', 'Project (shared via git)'],
  pickRemove: ['Xoá luật nào?', 'Remove which rule?'],
  pickMode: ['Chế độ quyền?', 'Permission mode?'],
  inputCmd: ['Nhập lệnh cần thử', 'Enter a command to test'],
  bypassWarn: ['Chế độ bypass bỏ qua MỌI hỏi quyền (trừ luật deny). Chắc chắn bật?', 'Bypass mode skips ALL permission prompts (except deny rules). Really enable?'],
  yes: ['Bật', 'Enable'],
  no: ['Không', 'No'],
  modeSet: ['Đã đổi chế độ quyền sang **{mode}**.', 'Permission mode set to **{mode}**.'],
  badMode: ['Chế độ phải là default, acceptEdits, plan hoặc bypass.', 'Mode must be default, acceptEdits, plan or bypass.'],
  cancelled: ['Đã huỷ.', 'Cancelled.'],
  cliRules: ['(dòng lệnh)', '(command line)'],
});

const KEYS: Record<RuleAction, string> = { allow: 'permissions.allow', ask: 'permissions.ask', deny: 'permissions.deny' };
const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypass'];

const stateFile = (home: string): string => path.join(home, '.locaith', 'permissions-state.json');

function trustedHashes(home: string): string[] {
  return strList(readJsonFile(stateFile(home))?.trustedWorkspaceAllow);
}

function saveTrusted(home: string, hash: string): void {
  const file = stateFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ trustedWorkspaceAllow: [...new Set([...trustedHashes(home), hash])].slice(-200) }, null, 2), 'utf8');
}

const listAt = (ctx: FeatureContext, scope: Scope, action: RuleAction): string[] => strList(getPath(readJsonFile(ctx.settings.file(scope)), KEYS[action]));

/** Luật allow do DỰ ÁN đề xuất (project + local settings: tệp local cũng có thể bị repo lạ commit sẵn), đã chuẩn hoá. */
function workspaceAllow(ctx: FeatureContext): { rules: string[]; hash: string } {
  const rules = [...listAt(ctx, 'project', 'allow'), ...listAt(ctx, 'local', 'allow')]
    .map((s) => parseRule(s))
    .filter((p): p is NonNullable<typeof p> => !!p)
    .map(formatRule);
  const uniq = [...new Set(rules)];
  return { rules: uniq, hash: hashRules(uniq) };
}

export interface RuleView {
  snapshot: RuleSnapshot;
  /** Luật theo nguồn để hiển thị: [phạm vi, hành động, chữ]. */
  entries: { scope: Scope | 'cli'; action: RuleAction; text: string }[];
  pending?: { rules: string[]; hash: string };
}

/** Bộ luật có hiệu lực ngay lúc này (đọc lại tệp mỗi lần: thêm luật giữa lượt chạy có hiệu lực ngay). */
export function ruleView(ctx: FeatureContext): RuleView {
  const trusted = ctx.isTrusted();
  const ws = workspaceAllow(ctx);
  const wsOk = trusted && ws.rules.length > 0 && trustedHashes(ctx.home).includes(ws.hash);
  const cliAllow = strList(ctx.settings.get<unknown>('cli.allowedTools', []));
  const cliDeny = strList(ctx.settings.get<unknown>('cli.disallowedTools', []));
  const userAllow = listAt(ctx, 'user', 'allow');
  const snapshot: RuleSnapshot = {
    rules: buildRules([
      { action: 'deny', source: 'user', items: [...cliDeny, ...listAt(ctx, 'user', 'deny')] },
      { action: 'deny', source: 'workspace', items: [...listAt(ctx, 'project', 'deny'), ...listAt(ctx, 'local', 'deny')] },
      { action: 'ask', source: 'user', items: listAt(ctx, 'user', 'ask') },
      { action: 'ask', source: 'workspace', items: [...listAt(ctx, 'project', 'ask'), ...listAt(ctx, 'local', 'ask')] },
      { action: 'allow', source: 'user', items: [...cliAllow, ...(trusted ? userAllow : [])] },
      ...(wsOk ? [{ action: 'allow' as const, source: 'workspace' as const, items: ws.rules }] : []),
    ]),
    ...(trusted && ws.rules.length && !wsOk ? { workspaceAllowPending: ws.rules.length } : {}),
    ...(trusted ? {} : { untrusted: true }),
  };
  const entries: RuleView['entries'] = [];
  for (const action of ['deny', 'ask', 'allow'] as const) {
    for (const scope of ['user', 'project', 'local'] as const) for (const text of listAt(ctx, scope, action)) entries.push({ scope, action, text });
  }
  for (const text of cliDeny) entries.push({ scope: 'cli', action: 'deny', text });
  for (const text of cliAllow) entries.push({ scope: 'cli', action: 'allow', text });
  return { snapshot, entries, ...(snapshot.workspaceAllowPending ? { pending: ws } : {}) };
}

/** `allow` | `ask` | `deny` | null cho một lệnh shell theo luật hiện có (null = không luật nào khớp). */
export function commandVerdict(ctx: FeatureContext, command: string): RuleAction | null {
  const hit = evaluateRules(ruleView(ctx).snapshot.rules, 'run_command', { kind: 'command', command }, { caseInsensitivePaths: ctx.host.platform.os === 'windows' });
  return hit ? hit.action : null;
}

/** Luật quá rộng để lưu từ MỘT cú bấm trên thẻ xin quyền. */
function tooBroadForCard(rule: string): boolean {
  const p = parseRule(rule);
  if (!p) return true;
  if (p.spec === undefined) return !p.tool.startsWith('mcp__');
  const s = p.spec.trim();
  return s === '*' || s === '**' || s === ':*';
}

/** Thêm một luật vào cài đặt của phạm vi. Trả về chữ luật đã lưu, `'exists'` nếu đã có, hoặc null nếu không hợp lệ / không được ghi. */
export function addRule(ctx: FeatureContext, action: RuleAction, rule: string, scope: Scope): string | 'exists' | null {
  const p = parseRule(rule);
  if (!p) return null;
  if (scope !== 'user' && !ctx.isTrusted()) return null;
  const text = formatRule(p);
  const cur = listAt(ctx, scope, action);
  if (cur.includes(text)) return 'exists';
  // Người dùng tự thêm allow vào phạm vi dự án: duyệt luôn danh sách mới NẾU danh sách trước đó rỗng hoặc đã được duyệt (không duyệt hộ các mục lạ).
  const before = action === 'allow' && scope !== 'user' ? workspaceAllow(ctx) : null;
  const wasClean = !!before && (before.rules.length === 0 || trustedHashes(ctx.home).includes(before.hash));
  ctx.settings.set(KEYS[action], [...cur, text].slice(-500), scope);
  if (before && wasClean) saveTrusted(ctx.home, workspaceAllow(ctx).hash);
  return text;
}

export function removeRule(ctx: FeatureContext, action: RuleAction, rule: string, scope: Scope): boolean {
  const p = parseRule(rule);
  const text = p ? formatRule(p) : rule.trim();
  const cur = listAt(ctx, scope, action);
  if (!cur.some((r) => r === text || r === rule.trim())) return false;
  ctx.settings.set(KEYS[action], cur.filter((r) => r !== text && r !== rule.trim()), scope);
  return true;
}

/** «Luôn cho phép…» từ thẻ xin quyền: ghi luật allow (user hoặc local). Trả về luật đã lưu hoặc null. */
export function addAlwaysAllow(ctx: FeatureContext, rule: string, scope: 'user' | 'local' = 'user'): string | null {
  const r = rule.trim().slice(0, 500);
  if (tooBroadForCard(r)) {
    ctx.toast('warn', tr(ctx.lang, 'tooBroad', { rule: r }));
    return null;
  }
  const saved = addRule(ctx, 'allow', r, scope);
  if (!saved) return null;
  if (saved !== 'exists') ctx.toast('info', tr(ctx.lang, 'saved', { rule: saved, where: tr(ctx.lang, scope === 'user' ? 'wUser' : 'wLocal') }));
  return typeof saved === 'string' && saved !== 'exists' ? saved : r;
}

const whereOf = (lang: 'vi' | 'en', s: Scope): string => tr(lang, s === 'user' ? 'wUser' : s === 'project' ? 'wProject' : 'wLocal');

function summary(ctx: FeatureContext, lang: 'vi' | 'en'): string {
  const v = ruleView(ctx);
  const parts: string[] = [];
  for (const action of ['deny', 'ask', 'allow'] as const) {
    const list = v.snapshot.rules.filter((r) => r.action === action);
    if (list.length) parts.push(`**${action}** (${list.length}): ${list.map((r: Rule) => `\`${r.text}\`${r.source === 'workspace' ? ' (project)' : ''}`).join(', ')}`);
  }
  const out = [`${tr(lang, 'head')}:`, parts.length ? parts.join('\n') : tr(lang, 'none'), tr(lang, 'mode', { mode: ctx.session().mode })];
  if (v.pending) out.push(tr(lang, 'pending', { n: v.pending.rules.length, rules: v.pending.rules.map((r) => `\`${r}\``).join(', ') }));
  if (v.snapshot.untrusted) out.push(tr(lang, 'untrusted'));
  return out.join('\n');
}

function parseScopeFlag(args: string): { text: string; scope: Scope } {
  let scope: Scope = 'user';
  const text = args
    .replace(/--(local|project|user)\b/g, (_m, s: Scope) => {
      scope = s;
      return '';
    })
    .trim();
  return { text, scope };
}

async function menu(ctx: FeatureContext, c: SlashRunContext): Promise<void> {
  const lang = c.lang;
  const sel = await askSlash(c, { kind: 'pick', title: tr(lang, 'menuTitle'), allowCancel: true, items: [{ id: 'add', label: tr(lang, 'mAdd') }, { id: 'remove', label: tr(lang, 'mRemove') }, { id: 'mode', label: tr(lang, 'mMode') }, { id: 'test', label: tr(lang, 'mTest') }] });
  if (sel === 'add') {
    const action = await askSlash(c, { kind: 'pick', title: tr(lang, 'pickAction'), allowCancel: true, items: [{ id: 'allow', label: tr(lang, 'aAllow') }, { id: 'ask', label: tr(lang, 'aAsk') }, { id: 'deny', label: tr(lang, 'aDeny') }] });
    if (action !== 'allow' && action !== 'ask' && action !== 'deny') return c.output(tr(lang, 'cancelled'), 'plain');
    const rule = await askSlash(c, { kind: 'input', title: tr(lang, 'inputRule') });
    if (typeof rule !== 'string' || !rule.trim()) return c.output(tr(lang, 'cancelled'), 'plain');
    const scope = await askSlash(c, { kind: 'pick', title: tr(lang, 'pickScope'), allowCancel: true, items: [{ id: 'user', label: tr(lang, 'sUser') }, { id: 'local', label: tr(lang, 'sLocal') }, { id: 'project', label: tr(lang, 'sProject') }] });
    if (scope !== 'user' && scope !== 'local' && scope !== 'project') return c.output(tr(lang, 'cancelled'), 'plain');
    return reportAdd(ctx, c, action, rule, scope);
  }
  if (sel === 'remove') {
    const v = ruleView(ctx).entries.filter((e) => e.scope !== 'cli');
    if (!v.length) return c.output(tr(lang, 'none'));
    const id = await askSlash(c, { kind: 'pick', title: tr(lang, 'pickRemove'), searchable: true, allowCancel: true, items: v.map((e) => ({ id: `${e.scope}|${e.action}|${e.text}`, label: `${e.action}  ${e.text}`, detail: whereOf(lang, e.scope as Scope) })) });
    if (typeof id !== 'string') return c.output(tr(lang, 'cancelled'), 'plain');
    const [scope, action, ...rest] = id.split('|');
    const rule = rest.join('|');
    return c.output(removeRule(ctx, action as RuleAction, rule, scope as Scope) ? tr(lang, 'removed', { rule, where: whereOf(lang, scope as Scope) }) : tr(lang, 'notFound', { rule, where: whereOf(lang, scope as Scope) }), 'plain');
  }
  if (sel === 'mode') {
    const mode = await askSlash(c, { kind: 'pick', title: tr(lang, 'pickMode'), allowCancel: true, items: MODES.map((m) => ({ id: m, label: m, current: ctx.session().mode === m })) });
    if (typeof mode !== 'string') return c.output(tr(lang, 'cancelled'), 'plain');
    return setMode(ctx, c, mode as PermissionMode);
  }
  if (sel === 'test') {
    const cmd = await askSlash(c, { kind: 'input', title: tr(lang, 'inputCmd') });
    if (typeof cmd !== 'string' || !cmd.trim()) return c.output(tr(lang, 'cancelled'), 'plain');
    return testCommand(ctx, c, cmd.trim());
  }
}

function reportAdd(ctx: FeatureContext, c: SlashRunContext, action: RuleAction, rule: string, scope: Scope): void {
  const lang = c.lang;
  if (scope !== 'user' && !ctx.isTrusted()) return c.output(tr(lang, 'untrustedWrite'), 'error');
  const saved = addRule(ctx, action, rule, scope);
  if (saved === null) return c.output(tr(lang, 'invalid', { rule }), 'error');
  if (saved === 'exists') return c.output(tr(lang, 'exists', { rule }), 'plain');
  c.output(tr(lang, 'added', { action, rule: saved, where: whereOf(lang, scope) }), 'plain');
}

function testCommand(ctx: FeatureContext, c: SlashRunContext, cmd: string): void {
  const hit = evaluateRules(ruleView(ctx).snapshot.rules, 'run_command', { kind: 'command', command: cmd }, { caseInsensitivePaths: ctx.host.platform.os === 'windows' });
  c.output(hit ? tr(c.lang, 'testHit', { cmd: oneLine(cmd, 120), action: hit.action, rule: hit.rule, source: hit.source }) : tr(c.lang, 'testMiss', { cmd: oneLine(cmd, 120) }), 'plain');
}

async function setMode(ctx: FeatureContext, c: SlashRunContext, mode: PermissionMode): Promise<void> {
  if (!MODES.includes(mode)) return c.output(tr(c.lang, 'badMode'), 'error');
  if (mode === 'bypass') {
    const ok = await askSlash(c, { kind: 'confirm', title: tr(c.lang, 'bypassWarn'), yes: tr(c.lang, 'yes'), no: tr(c.lang, 'no'), defaultYes: false, danger: true });
    if (ok !== true) return c.output(tr(c.lang, 'cancelled'), 'plain');
  }
  ctx.session().mode = mode;
  ctx.emit({ t: 'action', action: 'redraw' });
  c.output(tr(c.lang, 'modeSet', { mode }), 'plain');
}

export const permissionsFeature: FeatureModule = {
  name: 'permissions',
  attach(ctx) {
    const ext = permissionRulesExtension({
      source: () => ruleView(ctx).snapshot,
      resolvePath: async (host, raw) => {
        const r = await resolveUserPathReal(host, raw);
        return { rel: r.rel, abs: r.abs, inWorkspace: r.zone === 'workspace' && !r.suspicious };
      },
    });
    ctx.addRunExtension(ext, { subAgents: true });
    asExt(ctx).registerAlwaysAllow?.((rule, scope) => addAlwaysAllow(ctx, rule, scope));

    ctx.slash({
      name: 'permissions',
      description: {
        vi: 'Luật quyền allow/ask/deny — /permissions [allow|ask|deny <luật> | remove <luật> | test <lệnh> | trust | mode <tên>]',
        en: 'Permission rules allow/ask/deny — /permissions [allow|ask|deny <rule> | remove <rule> | test <command> | trust | mode <name>]',
      },
      argHint: '[allow <luật>]',
      needsIdle: false,
      async run(c) {
        const lang = c.lang;
        const [verb = '', ...rest] = c.args.trim().split(/\s+/);
        const tail = c.args.trim().slice(verb.length).trim();
        const v = verb.toLowerCase();
        if (!v) {
          c.output(summary(ctx, lang));
          if (ctx.interactive) await menu(ctx, c);
          return;
        }
        if (v === 'allow' || v === 'ask' || v === 'deny') {
          const { text, scope } = parseScopeFlag(tail);
          return reportAdd(ctx, c, v, text, scope);
        }
        if (v === 'remove' || v === 'rm') {
          const { text, scope } = parseScopeFlag(tail);
          const scopes: Scope[] = tail.includes('--') ? [scope] : ['user', 'local', 'project'];
          let n = 0;
          for (const s of scopes) for (const a of ['allow', 'ask', 'deny'] as const) if (removeRule(ctx, a, text, s)) n++;
          return c.output(n ? tr(lang, 'removed', { rule: text, where: scopes.map((s) => whereOf(lang, s)).join(', ') }) : tr(lang, 'notFound', { rule: text, where: scopes.map((s) => whereOf(lang, s)).join(', ') }), 'plain');
        }
        if (v === 'test') return testCommand(ctx, c, tail);
        if (v === 'trust') {
          const pending = ruleView(ctx).pending;
          if (!pending || !ctx.isTrusted()) return c.output(tr(lang, 'nothingPending'), 'plain');
          saveTrusted(ctx.home, pending.hash);
          return c.output(tr(lang, 'trusted'), 'plain');
        }
        if (v === 'mode') return setMode(ctx, c, (rest[0] ?? '') as PermissionMode);
        c.output(tr(lang, 'usage'), 'plain');
      },
    });
  },
};

