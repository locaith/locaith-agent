/**
 * Mô-đun 9 — ký ức và hướng dẫn dự án.
 *   • `/memory` — xem các tệp hướng dẫn/ký ức đang dùng (LOCAITH.md của dự án và của người dùng, AGENTS.md/CLAUDE.md nếu có, chỉ mục ký ức bền
 *     `.locaith/memory/MEMORY.md` của dự án và `~/.locaith/memory/MEMORY.md`), chọn một tệp để sửa: mở bằng `$EDITOR` qua
 *     `RuntimeEvent{t:'action', action:'open_editor'}`; `/memory add <ghi chú>` thêm một dòng vào chỉ mục ký ức; `/memory show <tệp>` in nội dung.
 *   • `/init` — tạo `LOCAITH.md` bằng MỘT lượt agent quét dự án (`runPrompt`); đã có thì hỏi trước khi cải thiện.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { memoryHeader, memoryLine } from '../../../core/engine/memory';
import type { FeatureContext, FeatureModule, SlashRunContext } from '../contract';
import { askSlash, makeTr, oneLine } from './ext';

const tr = makeTr('memory', {
  head: ['**Hướng dẫn và ký ức**', '**Instructions and memory**'],
  fProject: ['LOCAITH.md (dự án)', 'LOCAITH.md (project)'],
  fUser: ['LOCAITH.md (cá nhân)', 'LOCAITH.md (user)'],
  fMemProject: ['Ký ức dự án', 'Project memory'],
  fMemUser: ['Ký ức cá nhân', 'User memory'],
  other: ['Cũng được đọc: {files}', 'Also read: {files}'],
  exists: ['{size} · {path}', '{size} · {path}'],
  missing: ['chưa có — sẽ tạo khi bạn chọn sửa · {path}', 'not created yet — created when you pick it · {path}'],
  pick: ['Sửa tệp nào?', 'Edit which file?'],
  opened: ['Đã yêu cầu mở {path} bằng $EDITOR.', 'Asked to open {path} in $EDITOR.'],
  added: ['Đã ghi nhớ vào {path}: {text}', 'Saved to {path}: {text}'],
  addUsage: ['Cú pháp: `/memory add [user] <ghi chú>`', 'Usage: `/memory add [user] <note>`'],
  unknownFile: ['Không có tệp «{name}». Dùng: project, user, mem, mem-user.', 'Unknown file “{name}”. Use: project, user, mem, mem-user.'],
  needTrust: ['Thư mục chưa được tin cậy — không tạo tệp của dự án.', 'The folder is not trusted — not creating project files.'],
  empty: ['(trống)', '(empty)'],
  tip: ['`/memory project|user|mem|mem-user` mở thẳng · `/memory add <ghi chú>` thêm ký ức · `/memory show <tệp>` xem nội dung.', '`/memory project|user|mem|mem-user` opens directly · `/memory add <note>` adds a memory · `/memory show <file>` prints it.'],
  initExists: ['Đã có LOCAITH.md ở dự án này. Cải thiện nó bằng một lượt quét lại?', 'LOCAITH.md already exists in this project. Improve it with a fresh scan?'],
  initYes: ['Cải thiện', 'Improve'],
  initNo: ['Giữ nguyên', 'Keep it'],
  initKept: ['Giữ nguyên LOCAITH.md.', 'Kept LOCAITH.md as is.'],
  initNoInteractive: ['Đã có LOCAITH.md — dùng `/memory project` để sửa tay.', 'LOCAITH.md already exists — use `/memory project` to edit it by hand.'],
  initFolder: ['Hãy chạy locaith trong thư mục dự án.', 'Run locaith inside the project folder.'],
});

type Key = 'project' | 'user' | 'mem' | 'mem-user';

const TEMPLATE_VI = '# Hướng dẫn cho Locaith\n\n<!-- Lệnh build/test, quy ước code, điều cần tránh… Locaith đọc tệp này ở đầu mỗi phiên. -->\n';
const TEMPLATE_EN = '# Instructions for Locaith\n\n<!-- Build/test commands, code conventions, things to avoid… Locaith reads this at the start of every session. -->\n';

export function memoryPaths(ctx: FeatureContext): Record<Key, string> {
  return {
    project: path.join(ctx.cwd, 'LOCAITH.md'),
    user: path.join(ctx.home, '.locaith', 'LOCAITH.md'),
    mem: path.join(ctx.cwd, '.locaith', 'memory', 'MEMORY.md'),
    'mem-user': path.join(ctx.home, '.locaith', 'memory', 'MEMORY.md'),
  };
}

const sizeOf = (file: string): number | null => {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
};

const fmtSize = (n: number): string => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

function ensureFile(ctx: FeatureContext, key: Key, file: string, lang: 'vi' | 'en'): void {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = key === 'mem' || key === 'mem-user' ? memoryHeader(lang) : lang === 'en' ? TEMPLATE_EN : TEMPLATE_VI;
  fs.writeFileSync(file, body, 'utf8');
}

/** Prompt cho `/init`: một lượt agent quét dự án rồi ghi LOCAITH.md. */
export function initPrompt(exists: boolean, others: readonly string[]): string {
  return [
    exists
      ? 'Re-scan this codebase and IMPROVE the existing LOCAITH.md at the project root: keep what is still accurate, fix what is stale, add what is missing.'
      : 'Analyze this codebase and create a LOCAITH.md file at the project root. Future Locaith sessions read it automatically at the start, so it must save them time.',
    'First explore with read-only tools: list the root, read README, package.json / pyproject.toml / Cargo.toml / go.mod / Makefile, CI config, and a few representative source files. Do not guess — only write what you verified.',
    others.length ? `Also read and fold in the useful parts of: ${others.join(', ')}.` : '',
    'Include, in this order and only where it applies: (1) the exact commands to build, lint, type-check and run tests — including how to run a SINGLE test; (2) the high-level architecture that needs several files to understand (the big picture, not a file listing); (3) code conventions and patterns that are not obvious from the code; (4) gotchas and things to never do (generated files, secrets, platform quirks).',
    'Do not pad it with generic advice ("write clean code"), do not list every file, do not repeat the README. Keep it under about 150 lines, written in the language the user is using. Start with a one-paragraph description of what the project is.',
    'Write the file with the file tools, then reply with a 3-5 line summary of what you put in it.',
  ]
    .filter(Boolean)
    .join('\n');
}

export const memoryFeature: FeatureModule = {
  name: 'memory',
  attach(ctx) {
    const paths = memoryPaths(ctx);
    const labelOf = (lang: 'vi' | 'en'): Record<Key, string> => ({ project: tr(lang, 'fProject'), user: tr(lang, 'fUser'), mem: tr(lang, 'fMemProject'), 'mem-user': tr(lang, 'fMemUser') });
    const shown = (p: string): string => p.replace(ctx.home, '~').replace(/\\/g, '/');

    const open = (c: SlashRunContext, key: Key): void => {
      if ((key === 'project' || key === 'mem') && !ctx.isTrusted()) return c.output(tr(c.lang, 'needTrust'), 'error');
      const file = paths[key];
      ensureFile(ctx, key, file, c.lang);
      ctx.emit({ t: 'action', action: 'open_editor', payload: file });
      c.output(tr(c.lang, 'opened', { path: shown(file) }), 'plain');
    };

    ctx.slash({
      name: 'memory',
      description: {
        vi: 'Xem/sửa hướng dẫn dự án (LOCAITH.md) và ký ức bền — /memory add <ghi chú>',
        en: 'View/edit project instructions (LOCAITH.md) and persistent memory — /memory add <note>',
      },
      argHint: '[project|user|mem|mem-user|add <ghi chú>|show <tệp>]',
      needsIdle: false,
      async run(c) {
        const lang = c.lang;
        const [verb = '', ...rest] = c.args.trim().split(/\s+/).filter(Boolean);
        const v = verb.toLowerCase();
        if (v === 'add' || v === 'them' || v === 'thêm') {
          const user = rest[0]?.toLowerCase() === 'user';
          const text = (user ? rest.slice(1) : rest).join(' ').trim();
          if (!text) return c.output(tr(lang, 'addUsage'), 'error');
          const key: Key = user ? 'mem-user' : 'mem';
          if (key === 'mem' && !ctx.isTrusted()) return c.output(tr(lang, 'needTrust'), 'error');
          const file = paths[key];
          ensureFile(ctx, key, file, lang);
          const date = new Date().toISOString().slice(0, 10);
          const cur = fs.readFileSync(file, 'utf8');
          fs.appendFileSync(file, `${cur.endsWith('\n') ? '' : '\n'}${memoryLine(text, { date })}\n`, 'utf8');
          return c.output(tr(lang, 'added', { path: shown(file), text: oneLine(text, 80) }), 'plain');
        }
        if (v === 'show' || v === 'xem') {
          const key = (rest[0] ?? '').toLowerCase() as Key;
          if (!paths[key]) return c.output(tr(lang, 'unknownFile', { name: rest[0] ?? '' }), 'error');
          let text = '';
          try {
            text = fs.readFileSync(paths[key], 'utf8');
          } catch {
            /* chưa có */
          }
          return c.output(`**${labelOf(lang)[key]}** — ${shown(paths[key])}\n\n${text.trim() ? text.slice(0, 6000) : tr(lang, 'empty')}`);
        }
        if (v && (v as Key) in paths) return open(c, v as Key);
        if (v) return c.output(tr(lang, 'unknownFile', { name: verb }), 'error');

        const rows: string[] = [];
        const items: { id: string; label: string; detail: string }[] = [];
        for (const key of ['project', 'user', 'mem', 'mem-user'] as const) {
          const size = sizeOf(paths[key]);
          const detail = size === null ? tr(lang, 'missing', { path: shown(paths[key]) }) : tr(lang, 'exists', { size: fmtSize(size), path: shown(paths[key]) });
          rows.push(`- **${labelOf(lang)[key]}** — ${detail}`);
          items.push({ id: key, label: labelOf(lang)[key], detail });
        }
        const others = ['AGENTS.md', 'CLAUDE.md'].filter((f) => fs.existsSync(path.join(ctx.cwd, f)));
        c.output([tr(lang, 'head'), ...rows, others.length ? tr(lang, 'other', { files: others.join(', ') }) : '', '', tr(lang, 'tip')].filter((x) => x !== '').join('\n'));
        if (ctx.interactive) {
          const pick = await askSlash(c, { kind: 'pick', title: tr(lang, 'pick'), items, allowCancel: true });
          if (typeof pick === 'string' && pick in paths) open(c, pick as Key);
        }
      },
    });

    ctx.slash({
      name: 'init',
      description: { vi: 'Tạo LOCAITH.md cho dự án bằng một lượt quét của trợ lý', en: 'Create LOCAITH.md for the project with one assistant scan' },
      needsIdle: true,
      async run(c) {
        const lang = c.lang;
        if (!fs.existsSync(ctx.cwd)) return c.output(tr(lang, 'initFolder'), 'error');
        if (!ctx.isTrusted()) return c.output(tr(lang, 'needTrust'), 'error');
        const exists = fs.existsSync(paths.project);
        if (exists) {
          if (!ctx.interactive) return c.output(tr(lang, 'initNoInteractive'), 'plain');
          const ans = await askSlash(c, { kind: 'confirm', title: tr(lang, 'initExists'), yes: tr(lang, 'initYes'), no: tr(lang, 'initNo'), defaultYes: false });
          if (ans !== true) return c.output(tr(lang, 'initKept'), 'plain');
        }
        const others = ['AGENTS.md', 'CLAUDE.md', '.cursorrules', '.github/copilot-instructions.md'].filter((f) => fs.existsSync(path.join(ctx.cwd, f)));
        await c.runPrompt(initPrompt(exists, others));
      },
    });
  },
};
