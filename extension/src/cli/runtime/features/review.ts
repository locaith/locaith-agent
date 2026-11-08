/**
 * Mô-đun 10 — rà soát và phong cách:
 *   • `/review [nhánh|đường dẫn]`, `/simplify [đường dẫn]`, `/security-review [nhánh|đường dẫn]` — mỗi lệnh một lượt agent (core/commands/builtinPrompts.ts);
 *   • `/output-style [tên] [--save]` — phong cách đầu ra `default|explanatory|learning|concise` + tuỳ chỉnh ở `.locaith/output-styles/*.md` (dự án, tin cậy)
 *     và `~/.locaith/output-styles/*.md` (core/commands/outputStyles.ts). Chọn → `session.outputStyle` (engine tự chèn vào system prompt);
 *     cài đặt `agent.outputStyle` là mặc định cho phiên chưa chọn (áp khi mở/đổi phiên);
 *   • `/fork` — rẽ nhánh phiên thành phiên mới (shared/sessionFork.ts, thuần); lõi lưu + chuyển sang phiên mới qua `adoptSession` (ext.ts).
 */

import * as path from 'node:path';
import { reviewPrompt, securityReviewPrompt, simplifyPrompt } from '../../../core/commands/builtinPrompts';
import { loadOutputStyles, type OutputStyle } from '../../../core/commands/outputStyles';
import { repairOrphanToolCalls } from '../../../core/engine/engine';
import type { SessionState } from '../../../core/engine/types';
import { forkSession } from '../../../shared/sessionFork';
import { newId } from '../../../shared/transcript';
import { rebuildTranscript } from '../../../shared/transcriptRebuild';
import type { FeatureContext, FeatureModule, SlashRunContext } from '../contract';
import { asExt, makeTr } from './ext';

const tr = makeTr('review', {
  styleSet: ['Phong cách trả lời của phiên này: **{name}**.', 'Reply style for this session: **{name}**.'],
  styleSaved: ['Đã lưu làm mặc định (cài đặt `agent.outputStyle`).', 'Saved as default (setting `agent.outputStyle`).'],
  styleUnknown: ['Không có phong cách «{name}».', 'No style named “{name}”.'],
  styleList: ['Phong cách trả lời (gõ `/output-style <tên>`; thêm `--save` để đặt làm mặc định)', 'Reply styles (type `/output-style <name>`; add `--save` to make it the default)'],
  srcProject: ['dự án', 'project'],
  srcUser: ['cá nhân', 'user'],
  forkEmpty: ['Cuộc trò chuyện còn trống — chưa có gì để rẽ nhánh.', 'The conversation is empty — nothing to fork yet.'],
  forkDone: ['Đã rẽ nhánh: **{title}**. Cuộc gốc được giữ nguyên.', 'Forked: **{title}**. The original is kept.'],
  forkApprox: ['Một phần đầu đã được nén nên nhánh mới chỉ còn bản tóm tắt phần đó.', 'An early part was compacted, so the branch keeps only a summary of it.'],
  forkUnsupported: ['Lõi chưa hỗ trợ chuyển sang phiên mới (thiếu adoptSession).', 'The runtime cannot switch to a new session yet (adoptSession missing).'],
  forkBusy: ['Hãy dừng tác vụ đang chạy trước.', 'Stop the running task first.'],
});

export const REVIEW_COMMANDS = ['review', 'simplify', 'security-review'] as const;

async function styles(ctx: FeatureContext): Promise<OutputStyle[]> {
  return loadOutputStyles(ctx.host, [
    ...(ctx.isTrusted() ? [{ path: path.join(ctx.cwd, '.locaith', 'output-styles'), source: 'project' as const }] : []),
    { path: path.join(ctx.home, '.locaith', 'output-styles'), source: 'user' as const },
  ]);
}

/** Áp phong cách mặc định (cài đặt `agent.outputStyle`) cho phiên chưa chọn phong cách nào. */
async function applyDefaultStyle(ctx: FeatureContext): Promise<void> {
  const s = ctx.session();
  if (s.outputStyle) return;
  const want = String(ctx.settings.get<string>('agent.outputStyle', 'default') || 'default').toLowerCase();
  if (want === 'default') return;
  const st = (await styles(ctx)).find((x) => x.name === want);
  if (st && st.prompt && !ctx.session().outputStyle) ctx.session().outputStyle = { name: st.name, prompt: st.prompt };
}

async function outputStyleCommand(ctx: FeatureContext, c: SlashRunContext): Promise<void> {
  const lang = c.lang;
  const words = c.args.split(/\s+/).filter(Boolean);
  const save = words.includes('--save');
  const want = words.filter((w) => w !== '--save').join('-').toLowerCase();
  const all = await styles(ctx);
  const session = ctx.session();
  const current = session.outputStyle?.name ?? 'default';
  if (!want) {
    const lines = all.map((s) => `- ${s.name === current ? '●' : '○'} **${s.name}** — ${s.description[lang]}${s.source !== 'builtin' ? ` (${tr(lang, s.source === 'project' ? 'srcProject' : 'srcUser')})` : ''}`);
    return c.output(`**${tr(lang, 'styleList')}**\n${lines.join('\n')}`);
  }
  const st = all.find((s) => s.name === want);
  if (!st) return c.output(tr(lang, 'styleUnknown', { name: want }), 'error');
  session.outputStyle = st.name === 'default' ? undefined : { name: st.name, prompt: st.prompt };
  let msg = tr(lang, 'styleSet', { name: st.name });
  if (save) {
    try {
      ctx.settings.set('agent.outputStyle', st.name, 'user');
      msg += ` ${tr(lang, 'styleSaved')}`;
    } catch {
      /* không lưu được cài đặt: vẫn áp cho phiên */
    }
  }
  c.output(msg, 'plain');
}

async function forkCommand(ctx: FeatureContext, c: SlashRunContext): Promise<void> {
  const lang = c.lang;
  if (ctx.isBusy()) return c.output(tr(lang, 'forkBusy'), 'plain');
  const parent: SessionState = ctx.session();
  if (parent.messages.length === 0) return c.output(tr(lang, 'forkEmpty'), 'plain');
  const ext = asExt(ctx);
  if (!ext.adoptSession) return c.output(tr(lang, 'forkUnsupported'), 'error');
  await ext.saveSession?.(); // phiên gốc phải được lưu đủ trước khi rời đi
  const res = forkSession(parent, rebuildTranscript(parent.messages), { newId: newId('s'), now: Date.now(), lang, repair: repairOrphanToolCalls });
  await ext.adoptSession(res.session, res.transcript, 'fork');
  c.output(tr(lang, 'forkDone', { title: res.session.title }), 'plain');
  if (res.approximate) c.toast('warn', tr(lang, 'forkApprox'));
}

export const reviewFeature: FeatureModule = {
  name: 'review',
  attach(ctx) {
    const wrap = (name: (typeof REVIEW_COMMANDS)[number], build: (args: string) => string, vi: string, en: string, argHint: string) =>
      ctx.slash({
        name,
        description: { vi, en },
        argHint,
        needsIdle: true,
        run: async (c) => {
          try {
            await c.runPrompt(build(c.args));
          } catch (err) {
            c.output(`/${name}: ${err instanceof Error ? err.message : String(err)}`, 'error');
          }
        },
      });
    wrap('review', reviewPrompt, 'Rà soát thay đổi chưa commit / nhánh hiện tại (không sửa mã)', 'Review uncommitted changes / current branch (no edits)', '[branch|path]');
    wrap('simplify', simplifyPrompt, 'Rà thay đổi vừa làm về tái sử dụng, đơn giản hoá, hiệu năng rồi sửa', 'Review recent changes for reuse, simplicity, efficiency, then fix', '[path]');
    wrap('security-review', securityReviewPrompt, 'Rà lỗ hổng bảo mật trên các thay đổi', 'Security review of the changes', '[branch|path]');

    ctx.slash({
      name: 'output-style',
      description: { vi: 'Chọn phong cách trả lời — /output-style <tên> [--save]', en: 'Choose the reply style — /output-style <name> [--save]' },
      argHint: '[tên] [--save]',
      needsIdle: false,
      run: (c) => outputStyleCommand(ctx, c),
    });

    ctx.slash({
      name: 'fork',
      description: { vi: 'Rẽ nhánh cuộc trò chuyện thành phiên mới (giữ nguyên phiên gốc)', en: 'Branch this conversation into a new session (the original is kept)' },
      needsIdle: true,
      run: (c) => forkCommand(ctx, c),
    });

    void applyDefaultStyle(ctx).catch(() => undefined);
    ctx.onSessionChange(() => void applyDefaultStyle(ctx).catch(() => undefined));
  },
};

