/**
 * Lệnh gạch chéo DỰNG SẴN của lõi chạy CLI (đặc tả §4): /help /clear /new /compact /context /cost /model /mode /thinking /status /login /logout
 * /whoami /resume /sessions /exit /quit /config /doctor /update /theme /export /copy. Lệnh của tính năng (hooks, rewind, mcp…) đăng ký qua FeatureContext.slash.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getPromptStats } from '../../core/engine/promptStats';
import { DEFAULT_ACCOUNT_CONFIG } from '../../core/account/config';
import { builtinOutputStyles } from '../../core/commands/outputStyles';
import { LOCAITH_GATEWAY_URL, LOCAITH_PROVIDER_ID, LocaithGatewayClient } from '../../core/providers/locaithGateway';
import { gatewayDiagnosticHeaders } from '../../core/providers/gatewayDiagnostics';
import { PERMISSION_MODES, PICKER_THINKING_LEVELS, type PermissionMode, type SessionSummary, type ThinkingLevel, type TItem } from '../../shared/protocol';
import { buildMeter, contextReport, costReport } from '../../shared/sessionMeter';
import { deviceLabel, loginWithBrowser } from '../browserLogin';
import { t as cliT } from '../i18n';
import { clearLocaithKey, cliConfigFile, locaithKeyFromEnv, readLocaithKey, writeLocaithKey } from './auth';
import type { Scope } from './config';
import type { PickItem } from './contract';
import type { FullSlashContext, Runtime } from './runtime';
import { formatAgo, matchSessions, sessionMissMessage } from './sessions';
import { isDirTrusted } from './trust';
import { addProviderFlow, keyFlow, providerMenu, removeFlow, renderList, testFlow, testLine, type WizardDeps, type WizardIO } from '../providerWizard';
import { writeFileAtomic } from './util';

type Handler = (ctx: FullSlashContext) => Promise<void> | void;

const withTimeout = <T>(p: Promise<T>, ms: number, label = 'timeout'): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(label)), ms).unref?.())]);

const fmtN = (n: number, lang: 'vi' | 'en') => Math.round(n).toLocaleString(lang === 'vi' ? 'vi-VN' : 'en-US');

const SECRET_KEY = /key|token|secret|password/i;

export function registerBuiltinSlash(rt: Runtime): void {
  const d = (key: string) => ({ vi: cliT(`runtime.cmd.${key}`, undefined, 'vi'), en: cliT(`runtime.cmd.${key}`, undefined, 'en') });
  const reg = (name: string, key: string, run: Handler, o: { argHint?: string; needsIdle?: boolean; descKey?: string } = {}) =>
    rt.slashReg.register({ name, description: d(o.descKey ?? key), ...(o.argHint ? { argHint: o.argHint } : {}), needsIdle: o.needsIdle ?? true, source: 'builtin', run: run as never });

  const tr = (k: string, v?: Record<string, string | number>) => rt.tr(k, v);

  // ── /help ──
  reg('help', 'help', (ctx) => ctx.output(rt.helpText(), 'markdown'), { needsIdle: false });

  // ── /clear /new ──
  reg('clear', 'clear', async (ctx) => {
    await rt.newSession('clear');
    ctx.toast('info', tr('newSessionStarted'));
  });
  reg('new', 'clear', async (ctx) => {
    await rt.newSession('new');
    ctx.toast('info', tr('newSessionStarted'));
  });

  // ── /compact ──
  reg(
    'compact',
    'compact',
    async (ctx) => {
      const r = await rt.compactNow(ctx.args);
      if (!r) ctx.output(tr('compactNothing'), 'plain');
    },
    { argHint: '[…]' },
  );

  // ── /context /cost ──
  const ctxInfo = () => {
    const s = rt.session;
    const limit = rt.providers.contextWindow(s.provider, s.model);
    const used = rt.status().context.tokens;
    return { usedTokens: used, limitTokens: limit, percent: limit > 0 ? Math.round((used / limit) * 100) : 0, clearedResults: s.contextStats?.clearedResults ?? 0, compactions: s.contextStats?.compactions ?? 0 };
  };
  reg('context', 'context', (ctx) => {
    const s = rt.session;
    const meter = buildMeter(s, rt.transcript, rt.providers.pricing(s.provider, s.model));
    ctx.output(contextReport({ lang: rt.lang, ctx: ctxInfo(), messages: s.messages, stats: getPromptStats(s), meter }), 'markdown');
  }, { needsIdle: false });
  reg('cost', 'cost', (ctx) => {
    const s = rt.session;
    const pricing = rt.providers.pricing(s.provider, s.model);
    ctx.output(costReport({ lang: rt.lang, meter: buildMeter(s, rt.transcript, pricing), pricing, model: s.model }), 'markdown');
  }, { needsIdle: false });

  // ── /model ──
  reg(
    'model',
    'model',
    async (ctx) => {
      const arg = ctx.args.trim();
      const s = rt.session;
      const apply = async (spec: string) => {
        try {
          await rt.setModel(spec);
          ctx.output(tr('modelSet', { model: `${rt.session.provider}:${rt.session.model}` }), 'plain');
        } catch (err) {
          ctx.output(err instanceof Error ? err.message : String(err), 'error');
        }
      };
      if (arg) return apply(arg);
      const groups = await rt.providers.listModels();
      if (!rt.interactive) {
        const lines = [tr('modelCurrent', { model: `${s.provider}:${s.model}` }), ''];
        for (const g of groups) {
          lines.push(`**${g.label}** (\`${g.providerId}\`)`);
          for (const m of g.models.slice(0, 40)) lines.push(`- \`${g.providerId}:${m.id}\`${m.label && m.label !== m.id ? ` — ${m.label}` : ''}`);
          lines.push('');
        }
        return ctx.output(lines.join('\n'), 'markdown');
      }
      const items: PickItem[] = [];
      for (const g of groups) {
        for (const m of g.models) {
          const win = m.contextWindow ?? rt.providers.contextWindow(g.providerId, m.id);
          items.push({
            id: `${g.providerId}:${m.id}`,
            label: m.label && m.label !== m.id ? m.label : m.id,
            detail: `${m.id} · ${win >= 1_000_000 ? `${+(win / 1_000_000).toFixed(1)}M` : `${Math.round(win / 1000)}k`} ctx`,
            group: g.label,
            current: g.providerId === s.provider && m.id === s.model,
          });
        }
      }
      if (!items.some((i) => i.current)) items.unshift({ id: `${s.provider}:${s.model}`, label: s.model, detail: s.provider, current: true });
      const ans = await ctx.ask({ kind: 'pick', title: tr('modelPickTitle'), items, searchable: true, allowCancel: true });
      if (typeof ans === 'string') await apply(ans);
    },
    { argHint: '[id]' },
  );

  // ── /provider ── (0.4.1) danh sách · thêm API tuỳ chỉnh · lưu khoá · gỡ · thử kết nối — cùng logic với `locaith provider`
  reg(
    'provider',
    'provider',
    async (ctx) => {
      const [sub = '', ...rest] = ctx.args.trim().split(/\s+/).filter(Boolean);
      const io: WizardIO = {
        pick: async (title, items, hint) => {
          const v = await ctx.ask({ kind: 'pick', title, items, ...(hint ? { hint } : {}), allowCancel: true });
          return typeof v === 'string' ? v : null;
        },
        input: async (title, detail, o) => {
          const v = await ctx.ask({ kind: 'input', title, detail, ...(o?.placeholder ? { placeholder: o.placeholder } : {}), ...(o?.secret ? { secret: true } : {}), ...(o?.initial ? { initial: o.initial } : {}) });
          return typeof v === 'string' ? v : null;
        },
        confirm: async (title, detail, o) => {
          const v = await ctx.ask({ kind: 'confirm', title, detail, ...(o?.yes ? { yes: o.yes } : {}), ...(o?.no ? { no: o.no } : {}), defaultYes: o?.defaultYes ?? true, ...(o?.danger ? { danger: true } : {}) });
          return typeof v === 'boolean' ? v : null;
        },
        say: (kind, text) => ctx.output(text, kind === 'error' ? 'error' : 'plain'),
      };
      const deps: WizardDeps = {
        home: rt.home,
        env: rt.env,
        lang: rt.lang,
        reload: () => {
          rt.providers.reload();
          rt.flushStatus();
        },
        test: (id) => rt.providers.test(id),
        onKey: (k) => rt.logger.registerSecret(k),
        list: () => renderList(rt.providers.rows(), rt.providers.problems(), rt.lang, 'plain'),
        testable: () => rt.providers.rows().filter((r) => r.usable && r.id !== 'locaith').map((r) => ({ id: r.id, label: r.label })),
      };
      const needUi = () => ctx.output(tr('providerNeedsTty'), 'error');
      switch (sub.toLowerCase()) {
        case '':
          if (!rt.interactive) return ctx.output(renderList(rt.providers.rows(), rt.providers.problems(), rt.lang, 'markdown'), 'markdown');
          return providerMenu(io, deps);
        case 'list':
        case 'ls':
          return ctx.output(renderList(rt.providers.rows(), rt.providers.problems(), rt.lang, 'markdown'), 'markdown');
        case 'add':
          if (!rt.interactive) return needUi();
          await addProviderFlow(io, deps);
          return;
        case 'key':
          if (!rt.interactive) return needUi();
          await keyFlow(io, deps, rest[0]);
          return;
        case 'remove':
        case 'rm':
          if (!rt.interactive) return needUi();
          await removeFlow(io, deps);
          return;
        case 'test': {
          const ids = rest[0] ? [rest[0]] : rt.providers.rows().filter((r) => r.usable && r.id !== 'locaith').map((r) => r.id);
          if (ids.length === 0) return testFlow(io, deps);
          const lines: string[] = [];
          for (const id of ids) {
            if (!rt.providers.service.has(id)) {
              lines.push(`✘ ${cliT('cli.prov.w.unknown', { id }, rt.lang)}`);
              continue;
            }
            const l = testLine(rt.lang, id, await rt.providers.test(id), rt.providers.hasPinnedModels(id));
            lines.push(`${l.ok ? '✔' : '✘'} ${l.text}`);
          }
          return ctx.output(lines.join('\n'), 'plain');
        }
        default:
          return ctx.output(tr('providerUsage'), 'error');
      }
    },
    { argHint: '[list|add|key|remove|test]', needsIdle: true },
  );

  // ── /mode ──
  reg(
    'mode',
    'mode',
    async (ctx) => {
      const arg = ctx.args.trim();
      const modeLabel = (m: PermissionMode) => tr(`mode_${m}`);
      const allowed = PERMISSION_MODES.filter((m) => m !== 'bypass' || rt.bypassAllowed());
      if (arg) {
        const hit = allowed.find((m) => m === arg || m.toLowerCase() === arg.toLowerCase());
        if (!hit) return ctx.output(tr('modeInvalid', { list: allowed.join(' | ') }), 'error');
        rt.setMode(hit);
        return ctx.output(tr('modeSet', { mode: modeLabel(hit) }), 'plain');
      }
      if (!rt.interactive) return ctx.output(tr('modeCurrent', { mode: modeLabel(rt.session.mode), list: allowed.join(' | ') }), 'plain');
      const ans = await ctx.ask({
        kind: 'pick',
        title: tr('modePickTitle'),
        items: allowed.map((m) => ({ id: m, label: modeLabel(m), detail: tr(`modeHelp_${m}`), current: m === rt.session.mode })),
        allowCancel: true,
      });
      if (typeof ans === 'string' && (PERMISSION_MODES as string[]).includes(ans)) rt.setMode(ans as PermissionMode);
    },
    { argHint: '[default|acceptEdits|plan]', needsIdle: false },
  );

  // ── /thinking ──
  reg(
    'thinking',
    'thinking',
    async (ctx) => {
      const arg = ctx.args.trim().toLowerCase();
      if (arg) {
        const hit = PICKER_THINKING_LEVELS.find((l) => l === arg);
        if (!hit) return ctx.output(tr('thinkingInvalid', { list: PICKER_THINKING_LEVELS.join(' | ') }), 'error');
        rt.setThinking(hit);
        return ctx.output(tr('thinkingSet', { level: hit }), 'plain');
      }
      if (!rt.interactive) return ctx.output(tr('thinkingCurrent', { level: rt.session.thinkingLevel, list: PICKER_THINKING_LEVELS.join(' | ') }), 'plain');
      const ans = await ctx.ask({
        kind: 'pick',
        title: tr('thinkingPickTitle'),
        items: PICKER_THINKING_LEVELS.map((l) => ({ id: l, label: l, current: l === rt.session.thinkingLevel })),
        allowCancel: true,
      });
      if (typeof ans === 'string') rt.setThinking(ans as ThinkingLevel);
    },
    { argHint: '[off|low|medium|high|max]', needsIdle: false },
  );

  // ── /status ──
  reg('status', 'status', async (ctx) => {
    const st = rt.status();
    const s = rt.session;
    const lines = [
      `**Locaith CLI ${st.version}**`,
      '',
      `- ${tr('stCwd')}: \`${st.cwd}\`${st.gitBranch ? ` · git \`${st.gitBranch}\`` : ''}`,
      `- ${tr('stSession')}: \`${st.sessionId}\` — ${st.title}`,
      `- ${tr('stModel')}: \`${st.provider}:${st.model}\` · ${tr('stThinking')} \`${st.thinking}\``,
      `- ${tr('stMode')}: ${tr(`mode_${st.mode}`)}`,
      `- ${tr('stContext')}: ${fmtN(st.context.tokens, rt.lang)} / ${fmtN(st.context.window, rt.lang)} (${st.context.percent}%)`,
      `- ${tr('stUsage')}: ${fmtN(st.usage.input, rt.lang)} ↑ · ${fmtN(st.usage.output, rt.lang)} ↓${st.costUsd !== undefined ? ` · ~$${st.costUsd.toFixed(st.costUsd < 1 ? 3 : 2)}` : ''}`,
      `- ${tr('stAccount')}: ${st.account ? (st.account.loggedIn ? `${st.account.email ?? tr('stLoggedIn')}${st.account.plan ? ` · ${st.account.plan}` : ''}` : tr('stNotLoggedIn')) : '—'}`,
      `- ${tr('stTrust')}: ${rt.isTrusted ? tr('stTrusted') : tr('stUntrusted')}`,
    ];
    if (st.notices.length) lines.push('', ...st.notices.map((n) => `> ${n}`));
    ctx.output(lines.join('\n'), 'markdown');
    void s;
  }, { needsIdle: false });

  // ── /login ──
  reg('login', 'login', async (ctx) => {
    if (!rt.interactive) return ctx.output(tr('loginNeedsTty'), 'error');
    const base = (rt.store.get<Record<string, string>>('baseUrls', {})[LOCAITH_PROVIDER_ID] || rt.opts.baseUrl || LOCAITH_GATEWAY_URL).trim();
    const client = new LocaithGatewayClient({ baseUrl: () => base, timeoutMs: 8000, headers: () => gatewayDiagnosticHeaders({ family: 'cli', version: rt.opts.version }), ...(rt.opts.fetchImpl ? { fetch: rt.opts.fetchImpl } : {}) });
    let token = '';
    const method = await ctx.ask({
      kind: 'pick',
      title: tr('loginMethodTitle'),
      items: [
        { id: 'browser', label: tr('loginBrowser'), detail: DEFAULT_ACCOUNT_CONFIG.webUrl },
        // (0.4.9) Trình duyệt ở MÁY KHÁC (SSH, máy ảo): cổng loopback không tới được CLI → mở liên kết ở đâu cũng được rồi DÁN địa chỉ trang đích về.
        { id: 'browser-other', label: tr('loginBrowserOther') },
        { id: 'token', label: tr('loginToken'), detail: 'lat_…' },
      ],
      allowCancel: true,
    });
    if (method === null) return;
    if (method === 'browser' || method === 'browser-other') {
      const other = method === 'browser-other';
      if (!other) ctx.output(tr('loginOpening'), 'plain');
      const r = await loginWithBrowser({
        webUrl: DEFAULT_ACCOUNT_CONFIG.webUrl,
        supabaseUrl: DEFAULT_ACCOUNT_CONFIG.supabaseUrl,
        anonKey: DEFAULT_ACCOUNT_CONFIG.anonKey,
        label: deviceLabel(),
        notify: (m, url) => ctx.output(url ? `${m}\n${url}` : m, 'plain'),
        ...(other
          ? {
              open: false,
              // Hộp nhập của TUI không đóng từ ngoài được: chỉ dùng ở lựa chọn «máy khác» (người dùng chủ định dán). Esc = huỷ.
              askPaste: async () => {
                for (;;) {
                  const v = await ctx.ask({ kind: 'input', title: tr('loginPasteAddrTitle'), placeholder: 'http://127.0.0.1:…/callback?code=…', secret: true });
                  if (typeof v !== 'string') return null; // Esc
                  if (v.trim()) return v; // Enter khi ô còn trống: hỏi lại (đóng hộp thì màn hình trống trơn trong lúc vẫn chờ)
                }
              },
              onPasteInvalid: () => ctx.output(tr('loginPasteInvalid'), 'error'),
            }
          : {}),
      });
      if (!r.ok) return ctx.output(tr('loginFailed', { reason: tr(`loginErr_${r.error}`) }), 'error');
      token = r.token;
    } else {
      const v = await ctx.ask({ kind: 'input', title: tr('loginPasteTitle'), placeholder: 'lat_…', secret: true });
      token = typeof v === 'string' ? v.trim() : '';
      if (!token) return;
    }
    const check = await client.getAccount(token);
    if (!check.ok && check.error !== 'unsupported') {
      const consent = await client.getConsent(token);
      if (!consent.ok) return ctx.output(tr('loginFailed', { reason: check.error === 'unauthorized' ? tr('loginErr_token') : tr('loginErr_network') }), 'error');
    }
    rt.logger.registerSecret(token);
    const file = writeLocaithKey(rt.home, token);
    rt.account.forget();
    await withTimeout(rt.account.refresh(true), 6000).catch(() => undefined);
    rt.flushStatus();
    ctx.output(tr('loginDone', { file }), 'plain');
  });

  // ── /logout ──
  reg('logout', 'logout', async (ctx) => {
    if (locaithKeyFromEnv(rt.env)) return ctx.output(tr('logoutEnv'), 'plain');
    if (!readLocaithKey(rt.home, rt.env)) return ctx.output(tr('logoutNone'), 'plain');
    if (rt.interactive) {
      const ok = await ctx.ask({ kind: 'confirm', title: tr('logoutConfirm'), defaultYes: false, danger: true });
      if (ok !== true) return;
    }
    clearLocaithKey(rt.home);
    rt.account.forget();
    rt.flushStatus();
    ctx.output(tr('logoutDone'), 'plain');
  });

  // ── /whoami ──
  reg('whoami', 'whoami', async (ctx) => {
    const key = readLocaithKey(rt.home, rt.env);
    const lines: string[] = [];
    if (!key) lines.push(tr('stNotLoggedIn'));
    else {
      await withTimeout(rt.account.refresh(true), 7000).catch(() => undefined);
      const a = rt.account.current();
      lines.push(`${tr('stAccount')}: ${a.name ? `${a.name} · ` : ''}${a.email ?? `${key.slice(0, 4)}…`}`);
      lines.push(`${tr('whoamiPlan')}: ${a.plan ?? tr('whoamiPlanUnknown')}`);
      if (a.consent !== undefined) lines.push(`${tr('whoamiConsent')}: ${a.consent ? tr('yes') : tr('whoamiConsentNo')}`);
    }
    lines.push(`${tr('stModel')}: ${rt.session.provider}:${rt.session.model}`);
    const others = rt.providers.overridden ? [] : rt.providers.usableIds().filter((i) => i !== LOCAITH_PROVIDER_ID);
    if (others.length) lines.push(`${tr('whoamiByok')}: ${others.join(', ')}`);
    ctx.output(lines.map((l) => `- ${l}`).join('\n'), 'markdown');
  }, { needsIdle: false });

  // ── /resume /sessions ──
  const fmtDate = (ts: number) => new Date(ts).toLocaleString(rt.lang === 'vi' ? 'vi-VN' : 'en-US', { dateStyle: 'short', timeStyle: 'short' });
  const mdCell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ');
  const shown = (s: SessionSummary): string => s.title || s.id;

  /**
   * Bảng Markdown cho nơi KHÔNG có hộp chọn (chế độ -p, `/sessions list`): số thứ tự, mã ĐẦY ĐỦ (sao chép được — trước đây bị cắt còn 14 ký tự) và một chân bảng
   * nói rõ cách mở lại. Trước đây bảng chỉ liệt kê mã mà không nói làm gì với chúng. `numbered`: cột # khớp với `/resume <số>` (danh sách mặc định).
   */
  const sessionsTable = (rows: SessionSummary[], numbered: boolean): string => {
    const lines = [
      `| ${numbered ? '# | ' : ''}ID | ${tr('colUpdated')} | ${tr('stModel')} | ${tr('colTitle')} |`,
      `|${numbered ? '---|' : ''}---|---|---|---|`,
      ...rows.slice(0, 30).map((s, i) => `| ${numbered ? `${i + 1} | ` : ''}\`${s.id}\` | ${fmtDate(s.updatedAt)} | ${s.model} | ${mdCell(shown(s))}${s.other ? ` _(${s.workspaceName ?? '…'})_` : ''} |`),
    ];
    if (rows.length > 30) lines.push('', tr('sessionsMore', { n: rows.length - 30 }));
    lines.push('', tr(numbered ? 'sessionsHowTo' : 'sessionsHowToAll', { id: rows[0].id }));
    return lines.join('\n');
  };

  /** Hàng của hộp chọn: tiêu đề + «2 giờ trước · model · N tin». `grouped`: phiên của thư mục này lên trước, rồi các thư mục khác (nhóm có tiêu đề). */
  const pickItems = (list: SessionSummary[], grouped: boolean) => {
    const ordered = grouped ? [...list.filter((s) => !s.other), ...list.filter((s) => s.other)] : list;
    const mixed = grouped && ordered.some((s) => s.other) && ordered.some((s) => !s.other);
    const now = Date.now();
    return ordered.slice(0, 200).map((s) => ({
      id: s.id,
      label: shown(s),
      detail: `${formatAgo(s.updatedAt, now, rt.lang, fmtDate)} · ${s.model} · ${s.messageCount} ${tr('messagesShort')}${s.other ? ` · ${s.workspaceName ?? ''}` : ''}`,
      ...(mixed ? { group: s.other ? tr('resumeGroupOther') : tr('resumeGroupHere') } : {}),
      ...(s.id === rt.session.id ? { current: true } : {}),
    }));
  };

  const openSession = async (ctx: FullSlashContext, s: SessionSummary): Promise<void> => {
    await rt.resume(s.id);
    ctx.toast('info', tr('resumed', { title: rt.session.title }));
  };

  /** Hộp chọn có ô tìm (↑↓ chọn, gõ để lọc theo tiêu đề, Enter mở, Esc huỷ) — cách chính để mở lại một phiên: không cần biết mã. */
  const chooseSession = async (ctx: FullSlashContext, list: SessionSummary[], title: string, grouped: boolean): Promise<void> => {
    const ans = await ctx.ask({ kind: 'pick', title, hint: tr('resumeHint'), searchable: true, allowCancel: true, items: pickItems(list, grouped) });
    if (typeof ans !== 'string') return;
    const s = list.find((x) => x.id === ans);
    if (s) await openSession(ctx, s);
  };

  /**
   * Dùng chung cho /resume và /sessions. Có đối số: mã, đầu mã, SỐ (`2`, `#2`) hoặc từ khoá trong tiêu đề — đúng một phiên thì mở thẳng, nhiều phiên thì
   * (tương tác) chọn trong số đó. Không đối số: hộp chọn (phiên của thư mục này; chưa có thì mọi thư mục); `all`: mọi thư mục. Không có hộp chọn (-p): bảng.
   */
  const resumeFlow = async (ctx: FullSlashContext, rawArg: string, via: 'resume' | 'sessions'): Promise<void> => {
    const arg = rawArg.trim();
    const wantAll = arg.toLowerCase() === 'all';
    const here = await rt.sessions('cwd');
    const all = await rt.sessions('all');
    if (arg && !wantAll) {
      const m = matchSessions(arg, here, all);
      if (m.kind === 'one') return openSession(ctx, m.session);
      if (m.kind === 'many' && rt.interactive) return chooseSession(ctx, m.list, tr('resumePickMany', { q: arg, n: m.list.length }), true);
      return ctx.output(sessionMissMessage(arg, m), 'error');
    }
    const everywhere = wantAll || !here.length;
    const list = everywhere ? all : here;
    if (!list.length) return ctx.output(tr('noSessions'), 'plain');
    if (!rt.interactive) return ctx.output(sessionsTable(list, !wantAll || !here.length), 'markdown');
    // /sessions chạy được cả lúc trợ lý đang trả lời (chỉ xem); nhưng mở lại một phiên thì phải đợi rảnh.
    if (via === 'sessions' && rt.busy) return ctx.output(`${tr('sessionsBusy')}\n\n${sessionsTable(list, !wantAll || !here.length)}`, 'markdown');
    await chooseSession(ctx, list, tr(everywhere ? 'resumePickTitleAll' : 'resumePickTitle'), everywhere);
  };

  reg('resume', 'resume', (ctx) => resumeFlow(ctx, ctx.args, 'resume'), { argHint: '[số | từ khoá | mã | all]' });
  // /sessions: trong giao diện tương tác mở HỘP CHỌN như /resume (trước đây chỉ in một bảng mã không chọn được); `list` in bảng; `all` gồm mọi thư mục.
  reg(
    'sessions',
    'sessions',
    async (ctx) => {
      const toks = ctx.args.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const wantAll = toks.includes('all');
      if (toks.includes('list') || toks.includes('ls') || !rt.interactive) {
        const here = await rt.sessions('cwd');
        const all = await rt.sessions('all');
        const rows = wantAll || !here.length ? all : here;
        if (!rows.length) return ctx.output(tr('noSessions'), 'plain');
        return ctx.output(sessionsTable(rows, !wantAll || !here.length), 'markdown');
      }
      return resumeFlow(ctx, wantAll ? 'all' : '', 'sessions');
    },
    { argHint: '[list] [all]', needsIdle: false },
  );

  // ── /exit /quit ──
  const exit: Handler = async () => {
    await rt.saveNow();
    rt.emit({ t: 'action', action: 'exit' });
  };
  reg('exit', 'exit', exit, { needsIdle: false });
  reg('quit', 'exit', exit, { needsIdle: false });

  // ── /config ──
  reg(
    'config',
    'config',
    async (ctx) => {
      const parts = ctx.args.trim().split(/\s+/).filter(Boolean);
      const scopeFlag = parts.findIndex((p) => /^--(user|project|local)$/.test(p));
      let scope: Scope = 'user';
      if (scopeFlag >= 0) {
        scope = parts[scopeFlag].slice(2) as Scope;
        parts.splice(scopeFlag, 1);
      }
      const showFiles = () =>
        (['user', 'project', 'local'] as const).map((sc) => `- ${sc}: \`${rt.store.file(sc)}\`${fs.existsSync(rt.store.file(sc)) ? '' : ` _(${tr('cfgMissing')})_`}`).join('\n');
      if (parts.length === 0) {
        const snap = rt.store.snapshot();
        const rows = Object.entries(snap)
          .filter(([k]) => !SECRET_KEY.test(k))
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(0, 80)
          .map(([k, v]) => `| \`${k}\` | \`${JSON.stringify(v.value).slice(0, 80).replace(/\|/g, '\\|')}\` | ${v.source} |`);
        const problems = rt.store.problems();
        return ctx.output(
          [`**${tr('cfgTitle')}**`, '', showFiles(), '', rows.length ? [`| ${tr('cfgKey')} | ${tr('cfgValue')} | ${tr('cfgSource')} |`, '|---|---|---|', ...rows].join('\n') : tr('cfgEmpty'), ...(problems.length ? ['', `**${tr('cfgProblems')}**`, ...problems.map((p) => `- ${p}`)] : []), '', tr('cfgUsage')].join('\n'),
          'markdown',
        );
      }
      if (parts[0] === 'open') {
        const sc = (parts[1] as Scope | undefined) ?? scope;
        if (!['user', 'project', 'local'].includes(sc)) return ctx.output(tr('cfgUsage'), 'error');
        const file = rt.store.file(sc);
        if (!fs.existsSync(file)) {
          if (sc !== 'user' && !rt.isTrusted) return ctx.output(tr('cfgUntrustedWrite'), 'error');
          writeFileAtomic(file, '{\n}\n', sc === 'user' ? 0o600 : undefined);
        }
        rt.emit({ t: 'action', action: 'open_editor', payload: file });
        return ctx.output(`\`${file}\``, 'markdown');
      }
      if (parts[0] === 'unset' && parts[1]) {
        rt.store.set(parts[1], undefined, scope);
        return ctx.output(tr('cfgUnset', { key: parts[1], scope }), 'plain');
      }
      const key = parts[0];
      if (parts.length === 1) {
        if (SECRET_KEY.test(key)) return ctx.output(tr('cfgSecret'), 'plain');
        const v = rt.store.getMerged(key);
        return ctx.output(v === undefined ? tr('cfgNotSet', { key }) : `\`${key}\` = \`${JSON.stringify(v)}\` (${rt.store.sourceOf(key) ?? '—'})`, 'markdown');
      }
      const raw = parts.slice(1).join(' ');
      let value: unknown = raw;
      try {
        value = JSON.parse(raw);
      } catch {
        /* chuỗi trần */
      }
      rt.store.set(key, value, scope);
      ctx.output(tr('cfgSet', { key, value: SECRET_KEY.test(key) ? '***' : JSON.stringify(value), scope, file: rt.store.file(scope) }), 'plain');
      rt.flushStatus();
    },
    { argHint: '[khoá [giá trị]]', needsIdle: false },
  );

  // ── /doctor ──
  reg('doctor', 'doctor', async (ctx) => {
    const rows: Array<[boolean | 'warn', string, string]> = [];
    const nodeOk = Number(process.versions.node.split('.')[0]) >= 20;
    rows.push([nodeOk, 'Node.js', `${process.versions.node}${nodeOk ? '' : tr('docNode20')}`]);
    const git = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
    rows.push([git.status === 0 ? true : 'warn', 'git', git.status === 0 ? git.stdout.trim() : tr('docNoGit')]);
    const ff = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
    rows.push([ff.status === 0 ? true : 'warn', 'ffmpeg', ff.status === 0 ? (ff.stdout.split('\n')[0] ?? '').slice(0, 60) : tr('docNoFfmpeg')]);
    const ids = rt.providers.usableIds();
    rows.push([ids.length > 0, tr('docKeys'), ids.length ? ids.join(', ') : tr('docNoKeys')]);
    const provProblems = rt.providers.problems();
    if (provProblems.length) rows.push(['warn', tr('docProviders'), provProblems.join('; ')]);
    const lkey = readLocaithKey(rt.home, rt.env);
    if (lkey && !rt.providers.overridden) {
      const t0 = Date.now();
      try {
        const models = await withTimeout(rt.providers.get(LOCAITH_PROVIDER_ID).fetchModels(), 8000);
        rows.push([true, tr('docGateway'), `${Date.now() - t0} ms · ${models.length} model`]);
      } catch (err) {
        rows.push([false, tr('docGateway'), err instanceof Error ? err.message : String(err)]);
      }
      await withTimeout(rt.account.refresh(true), 7000).catch(() => undefined);
      const a = rt.account.current();
      if (a.consent !== undefined) rows.push([a.consent ? true : 'warn', tr('docConsent'), a.consent ? tr('yes') : tr('docConsentNo')]);
    }
    rows.push([rt.isTrusted ? true : 'warn', tr('stTrust'), rt.isTrusted ? tr('stTrusted') : tr('stUntrusted')]);
    const problems = rt.store.problems();
    rows.push([problems.length === 0, tr('cfgTitle'), problems.length ? problems.join('; ') : tr('docSettingsOk')]);
    try {
      const dir = path.join(rt.home, '.locaith', 'sessions');
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `.probe-${process.pid}`);
      fs.writeFileSync(probe, 'x');
      fs.rmSync(probe, { force: true });
      rows.push([true, tr('docSessionsDir'), dir]);
    } catch (err) {
      rows.push([false, tr('docSessionsDir'), err instanceof Error ? err.message : String(err)]);
    }
    try {
      const sf = fs.statfsSync(rt.cwd);
      const gb = Math.round(((sf.bavail * sf.bsize) / 1e9) * 10) / 10;
      rows.push([gb >= 1 ? true : 'warn', tr('docDisk'), `${gb} GB`]);
    } catch {
      /* không đọc được thì bỏ dòng */
    }
    if (rt.featureErrors.length) for (const e of rt.featureErrors) rows.push([false, `${tr('docFeature')} ${e.name}`, e.error]);
    rows.push([true, tr('docLog'), rt.logger.path ?? '—']);
    const mark = (ok: boolean | 'warn') => (ok === true ? '✔' : ok === 'warn' ? '!' : '✘');
    ctx.output(rows.map(([ok, name, detail]) => `- ${mark(ok)} **${name}** — ${detail}`).join('\n'), 'markdown');
  }, { needsIdle: false });

  // ── /update ──
  reg('update', 'update', async (ctx) => {
    const f = rt.opts.fetchImpl ?? fetch;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 6000);
      let latest = '';
      try {
        const res = await f('https://pypi.org/pypi/locaith-cli/json', { signal: ctl.signal, headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = (await res.json()) as { info?: { version?: string } };
        latest = String(j.info?.version ?? '');
      } finally {
        clearTimeout(timer);
      }
      if (!latest) throw new Error('no version');
      const cmp = compareVersions(latest, rt.opts.version);
      ctx.output(cmp > 0 ? tr('updateAvailable', { current: rt.opts.version, latest }) : tr('updateCurrent', { current: rt.opts.version }), cmp > 0 ? 'markdown' : 'plain');
    } catch (err) {
      ctx.output(tr('updateFailed', { detail: err instanceof Error ? err.message : String(err) }), 'error');
    }
  }, { needsIdle: false });

  // ── /theme ──
  reg(
    'theme',
    'theme',
    async (ctx) => {
      const themes = ['auto', 'dark', 'light', 'mono'];
      const cur = rt.store.get<string>('ui.theme', 'auto');
      let pick = ctx.args.trim().toLowerCase();
      if (!pick) {
        if (!rt.interactive) return ctx.output(tr('themeCurrent', { theme: cur, list: themes.join(' | ') }), 'plain');
        const ans = await ctx.ask({ kind: 'pick', title: tr('themePickTitle'), items: themes.map((x) => ({ id: x, label: tr(`theme_${x}`), current: x === cur })), allowCancel: true });
        if (typeof ans !== 'string') return;
        pick = ans;
      }
      if (!themes.includes(pick)) return ctx.output(tr('themeInvalid', { list: themes.join(' | ') }), 'error');
      rt.store.set('ui.theme', pick, 'user');
      rt.emit({ t: 'action', action: 'redraw', payload: `theme:${pick}` });
      ctx.toast('info', tr('themeSet', { theme: pick }));
    },
    { argHint: '[auto|dark|light|mono]', needsIdle: false },
  );

  // ── /export ──
  reg(
    'export',
    'export',
    (ctx) => {
      if (rt.transcript.length === 0) return ctx.output(tr('exportEmpty'), 'plain');
      const md = transcriptToMarkdown(rt.session.title, rt.transcript, rt.lang);
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const arg = ctx.args.trim().replace(/^["']|["']$/g, '');
      const file = path.resolve(rt.cwd, arg || `locaith-${stamp}.md`);
      writeFileAtomic(file, md);
      ctx.output(tr('exportDone', { file }), 'plain');
    },
    { argHint: '[tệp]', needsIdle: false },
  );

  // ── /copy ──
  reg(
    'copy',
    'copy',
    (ctx) => {
      const last = [...rt.session.messages].reverse().find((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'text' && b.text.trim()));
      const text = (last?.content ?? [])
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (!text) return ctx.toast('warn', tr('copyNothing'));
      rt.emit({ t: 'action', action: 'copy', payload: text });
    },
    { needsIdle: false },
  );

  // ── /paste (/image) ── đính kèm ảnh trong clipboard. Giao diện tự xử lý dòng này trước khi tới đây; handler dành cho nơi gọi khác và để lệnh hiện trong menu / trợ giúp.
  const pasteImage: Handler = (ctx) => {
    if (!rt.interactive) return ctx.output(tr('pasteNeedsTty'), 'plain');
    rt.emit({ t: 'action', action: 'paste_image' });
  };
  reg('paste', 'paste', pasteImage, { needsIdle: false });
  reg('image', 'paste', pasteImage, { needsIdle: false });

  void builtinOutputStyles;
  void cliConfigFile;
  void isDirTrusted;
}

/** So sánh phiên bản dạng số (`0.4.1` > `0.4.0`); phần không phải số bị bỏ qua. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Xuất hội thoại ra Markdown (cho /export). */
export function transcriptToMarkdown(title: string, items: readonly TItem[], lang: 'vi' | 'en'): string {
  const out: string[] = [`# ${title}`, ''];
  const you = lang === 'vi' ? 'Bạn' : 'You';
  for (const it of items) {
    if (it.kind === 'user') {
      out.push(`## ${you}`, '', it.text || '(…)', '');
    } else if (it.kind === 'assistant') {
      out.push('## Locaith', '');
      for (const b of it.blocks) {
        if (b.type === 'text') out.push(b.text, '');
        else if (b.type === 'tool') {
          const arg = typeof b.args.command === 'string' ? b.args.command : typeof b.args.path === 'string' ? b.args.path : typeof b.args.pattern === 'string' ? b.args.pattern : '';
          out.push(`- \`${b.name}\`${arg ? ` \`${String(arg).replace(/`/g, "'").slice(0, 120)}\`` : ''}${b.summary ? ` — ${b.summary}` : ''}${b.state === 'error' || b.state === 'denied' ? ` (${b.state})` : ''}`);
        } else if (b.type === 'notice') out.push(`> ${b.text}`, '');
      }
      out.push('');
    } else if (it.kind === 'notice') {
      out.push(`> ${it.text}`, '');
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
