/**
 * Lần chạy đầu / chưa đăng nhập: chọn ngôn ngữ → đăng nhập (trình duyệt · dán token · khoá hãng khác · bỏ qua) →
 * đồng ý thông báo dữ liệu → tin cậy thư mục. Logic (`runOnboardingFlow`) tách khỏi phần vẽ (`TerminalUi`) để test được.
 * Đăng nhập dùng đúng hàm có sẵn ở `cli/account.ts` (`loginCmd`) và `cli/browserLogin.ts` (do người gọi dựng `AccountDeps`).
 */

import { loginCmd, type AccountDeps, type BrowserLoginHooks } from '../account';
import { setLang, t as tr, type Lang } from '../i18n';
import { wizardIoFromUi, type WizardIO } from '../providerWizard';
import type { PickItem } from '../runtime/contract';
import { ConfirmDialog, InputDialog, PickDialog, type Dialog } from './dialogs';
import type { Key, KeyEvent } from './keys';
import { Screen, type OutStream } from './screen';
import './strings';
import { TerminalSession, type InStream, type WriteStream } from './terminal';
import { detectCaps, makeTheme, type Theme } from './theme';
import { logoLines } from './welcome';
import { renderSpinner } from './widgets';
import { padEnd, truncateAnsi, wrapAnsi } from './width';

export interface LoginIo {
  out(line: string): void;
  err(line: string): void;
  /** Hỏi một dòng (khoá/token): không hiện ký tự. */
  ask(message: string): Promise<string>;
}

export interface OnboardingOptions {
  version: string;
  lang: Lang;
  cwd: string;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  theme?: 'auto' | 'dark' | 'light';
  env?: NodeJS.ProcessEnv;
  noColor?: boolean;
  ascii?: boolean;
  /** Bỏ qua bước chọn ngôn ngữ (đã chọn / có cờ --lang). */
  languageChosen?: boolean;
  loggedIn?: boolean;
  /** true = đã đồng ý (hoặc không áp dụng). */
  consentAccepted?: boolean;
  trusted?: boolean;
  /** Dựng `AccountDeps` cho account.ts; onboarding điền `ask/out/err`, các trường còn lại do người gọi (baseUrl, readKey, writeKey, browserLogin…). */
  accountDeps?: (io: LoginIo) => AccountDeps;
  /** Ghi nhận đồng ý thông báo dữ liệu ở cổng (gọi sau khi người dùng bấm đồng ý). */
  acceptConsent?: () => Promise<{ ok: boolean; message?: string }>;
  /** Hỏi cổng (SAU khi đăng nhập) xem tài khoản đã đồng ý ở nơi khác chưa: true (hoặc không rõ) → bỏ qua hộp thoại đồng ý. */
  checkConsent?: () => Promise<boolean>;
  /** Nội dung thông báo dữ liệu (mặc định dùng chuỗi dựng sẵn). */
  consentText?: string;
  saveLang?: (l: Lang) => void;
  /** Nhà cung cấp hãng khác ĐÃ dùng được sẵn (khoá đã lưu, API tuỳ chỉnh không cần khoá): tên để hiện. Có phần tử → bước «khoá hãng khác» chấp nhận luôn. */
  byokKnown?: () => string[];
  /** Trình hướng dẫn thêm khoá/nhà cung cấp (bước «dùng khoá hãng khác» khi chưa có gì). Trả true nếu đã thiết lập được một nhà cung cấp dùng được. */
  byokSetup?: (io: WizardIO) => Promise<boolean>;
  saveTrust?: (trusted: boolean) => void;
  /** Tiêm giao diện (kiểm thử logic). */
  ui?: OnboardingUi;
}

export interface OnboardingResult {
  lang: Lang;
  loggedIn: boolean;
  trusted: boolean;
  consented: boolean;
  cancelled: boolean;
  /** Lý do dừng sớm (nếu có): 'byok-missing' | 'untrusted' | 'cancelled'. */
  reason?: string;
}

export interface OnboardingUi {
  pick(title: string, items: PickItem[], hint?: string): Promise<string | null>;
  confirm(title: string, detail: string, o?: { yes?: string; no?: string; danger?: boolean }): Promise<boolean | null>;
  /** `signal` huỷ → hộp tự đóng và trả null (đăng nhập qua trình duyệt đã xong bằng đường khác trong lúc hộp «dán địa chỉ» còn mở). */
  input(title: string, detail: string, secret?: boolean, o?: { initial?: string; placeholder?: string; signal?: AbortSignal }): Promise<string | null>;
  say(kind: 'info' | 'ok' | 'warn' | 'error' | 'text', text: string): void;
  /**
   * In NGUYÊN một chuỗi dài không có dấu cách (liên kết) để chép: ngắt cứng đúng bề rộng terminal, KHÔNG thụt lề/ký hiệu đầu dòng, để chép nhiều dòng rồi dán vào ô địa chỉ
   * trình duyệt (xuống dòng bị bỏ) vẫn ra đúng liên kết. Thiếu = lùi về `say('text')`.
   */
  block?(text: string): void;
  /** Hiện dòng «đang chờ…» cho tới khi gọi hàm trả về; promise `cancelled` giải quyết khi người dùng nhấn Ctrl+C. */
  wait(text: string): { stop(): void; cancelled: Promise<void> };
  heading(version: string): void;
  close(): void;
}

const BYOK_VARS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'DEEPSEEK_API_KEY', 'XAI_API_KEY', 'OPENROUTER_API_KEY', 'MISTRAL_API_KEY', 'GROQ_API_KEY'];

export function detectByokKeys(env: NodeJS.ProcessEnv): string[] {
  return BYOK_VARS.filter((k) => (env[k] ?? '').trim().length > 0);
}

/** Logic trọn vẹn của onboarding; `ui` là cổng vào/ra. */
export async function runOnboardingFlow(o: OnboardingOptions, ui: OnboardingUi): Promise<OnboardingResult> {
  let lang: Lang = o.lang;
  const res: OnboardingResult = { lang, loggedIn: !!o.loggedIn, trusted: !!o.trusted, consented: o.consentAccepted === true, cancelled: false };
  const cancel = (reason: string): OnboardingResult => ({ ...res, lang, cancelled: true, reason });

  // 1. Ngôn ngữ
  if (!o.languageChosen) {
    const v = await ui.pick('Chọn ngôn ngữ / Choose language', [
      { id: 'vi', label: 'Tiếng Việt', current: lang === 'vi' },
      { id: 'en', label: 'English', current: lang === 'en' },
    ]);
    if (v === null) return cancel('cancelled');
    lang = v === 'en' ? 'en' : 'vi';
    setLang(lang);
    o.saveLang?.(lang);
  } else setLang(lang);
  ui.heading(o.version);

  // 2. Đăng nhập
  if (!res.loggedIn) {
    const items: PickItem[] = [
      { id: 'browser', label: tr('tui.ob.login.browser') },
      { id: 'token', label: tr('tui.ob.login.token') },
      { id: 'byok', label: tr('tui.ob.login.byok') },
      { id: 'skip', label: tr('tui.ob.login.skip') },
    ];
    // vòng lặp: đăng nhập lỗi → cho chọn lại
    for (;;) {
      const how = await ui.pick(tr('tui.ob.login.title'), items);
      if (how === null) return cancel('cancelled');
      if (how === 'skip') break;
      if (how === 'byok') {
        const found = [...detectByokKeys(o.env ?? process.env), ...(o.byokKnown?.() ?? [])];
        ui.say('info', tr('tui.ob.byok.title'));
        if (found.length) {
          ui.say('ok', tr('tui.ob.byok.found', { list: found.join(', ') }));
          res.loggedIn = true;
          res.consented = true; // khoá riêng: không đi qua cổng Locaith
          break;
        }
        if (o.byokSetup) {
          // Chưa có gì: dẫn người dùng chọn hãng + dán khoá ngay tại đây (lưu ở ~/.locaith, quyền 600) thay vì bắt thoát ra đặt biến môi trường.
          if (await o.byokSetup(wizardIoFromUi(ui))) {
            res.loggedIn = true;
            res.consented = true;
            break;
          }
          continue; // huỷ/chưa xong → cho chọn lại cách đăng nhập
        }
        ui.say('warn', tr('tui.ob.byok.none'));
        return cancel('byok-missing');
      }
      if (!o.accountDeps) {
        ui.say('warn', lang === 'vi' ? 'Chạy  locaith login  để đăng nhập.' : 'Run  locaith login  to sign in.');
        break;
      }
      let token: string | undefined;
      if (how === 'token') {
        const t = await ui.input(tr('tui.ob.login.token.ask'), tr('tui.ob.login.token.detail'), true);
        if (t === null) continue;
        token = t.trim();
        if (!token) continue;
      }
      const io: LoginIo = {
        out: (l) => ui.say('ok', l),
        err: (l) => ui.say('info', l),
        ask: async (m) => (await ui.input(m, '', true)) ?? '',
      };
      const deps = o.accountDeps(io);
      // Đăng nhập qua trình duyệt: liên kết hiện NGAY TRONG màn hình này (trước đây đi qua console.error nên bị giao diện terminal che mất — người ở máy khác thấy mỗi vòng quay «đang mở
      // trình duyệt» mà không có liên kết nào để mở: «cứ đơ ở đó») và có hộp «dán địa chỉ» cho trình duyệt ở máy khác (SSH, máy ảo). Hộp đóng tự động khi cổng loopback nhận được trước.
      const hooks: BrowserLoginHooks = {
        notify: (m, url) => {
          if (!url) return; // câu hướng dẫn «máy khác» đã nằm sẵn trong hộp dán bên dưới
          ui.say('info', m);
          if (ui.block) ui.block(url);
          else ui.say('text', url);
        },
        askPaste: async (signal) => {
          for (;;) {
            const v = await ui.input(tr('tui.ob.login.paste.title'), tr('tui.ob.login.paste.detail'), true, { placeholder: tr('tui.ob.login.paste.ph'), signal });
            if (v === null || signal.aborted) return null; // Esc / Ctrl+C / đã đăng nhập xong bằng đường loopback
            if (v.trim()) return v;
            // Enter khi ô còn trống: giữ hộp (nếu đóng, màn hình sẽ trống trơn trong lúc CLI vẫn chờ trình duyệt)
          }
        },
        onPasteInvalid: () => ui.say('warn', tr('tui.ob.login.paste.invalid')),
      };
      let code = 1;
      try {
        code = await loginCmd({
          ...deps,
          ...(deps.browserLogin ? { browserLogin: () => deps.browserLogin!(hooks) } : {}),
          embedded: true,
          out: (l) => ui.say('ok', l),
          err: (l) => ui.say(/^\s*✘|không|Không|fail|could not|timed out|invalid|cancel/i.test(l) ? 'warn' : 'info', l),
          json: false,
          noBrowser: how === 'token',
          token,
        });
      } catch (err) {
        ui.say('error', err instanceof Error ? err.message : String(err));
      }
      if (code === 0) {
        res.loggedIn = true;
        ui.say('ok', tr('tui.ob.login.ok'));
        break;
      }
      ui.say('warn', tr('tui.ob.login.fail'));
    }
  }

  // 3. Thông báo dữ liệu (chỉ khi đăng nhập tài khoản Locaith và cổng chưa ghi nhận)
  if (res.loggedIn && !res.consented && o.checkConsent) {
    try {
      res.consented = await o.checkConsent(); // đã đồng ý ở máy khác / lần trước → khỏi hỏi lại
    } catch {
      /* không kiểm được thì cứ hỏi */
    }
  }
  if (res.loggedIn && !res.consented && o.acceptConsent) {
    const body = o.consentText ?? tr('tui.ob.consent.body');
    const yes = await ui.confirm(tr('tui.ob.consent.title'), `${body}\n\n${tr('tui.ob.consent.q')}`, { yes: tr('tui.ob.consent.yes'), no: tr('tui.ob.consent.no') });
    if (yes === null) return cancel('cancelled');
    if (yes) {
      const r = await o.acceptConsent();
      if (r.ok) {
        res.consented = true;
        ui.say('ok', tr('tui.ob.consent.ok'));
      } else ui.say('warn', r.message ?? tr('tui.ob.login.fail'));
    }
  }

  // 4. Tin cậy thư mục
  if (!res.trusted) {
    const v = await ui.pick(
      tr('tui.ob.trust.title'),
      [
        { id: 'yes', label: '1. ' + tr('tui.ob.trust.yes') },
        { id: 'no', label: '2. ' + tr('tui.ob.trust.no') },
      ],
      `${o.cwd}\n${tr('tui.ob.trust.body')}\n${tr('tui.ob.trust.hint')}`,
    );
    if (v === null || v === 'no') {
      o.saveTrust?.(false);
      return cancel('untrusted');
    }
    res.trusted = true;
    o.saveTrust?.(true);
  }

  ui.say('text', tr('tui.ob.done'));
  return { ...res, lang };
}

// ─────────────────────────── giao diện terminal thật ───────────────────────────

export class TerminalUi implements OnboardingUi {
  private readonly stdout: OutStream & WriteStream;
  private readonly screen: Screen;
  private readonly session: TerminalSession;
  readonly theme: Theme;
  private cur: { dlg: Dialog<unknown>; resolve: (v: unknown) => void } | null = null;
  private waiting: { text: string; cancel: () => void } | null = null;
  private frame = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private t0 = Date.now();

  constructor(o: OnboardingOptions) {
    const stdin = (o.stdin ?? process.stdin) as unknown as InStream;
    this.stdout = (o.stdout ?? process.stdout) as unknown as OutStream & WriteStream;
    const caps = detectCaps({ env: o.env ?? process.env, theme: o.theme, noColor: o.noColor, ascii: o.ascii, colorDepth: (this.stdout as { getColorDepth?: () => number }).getColorDepth?.() });
    this.theme = makeTheme(caps);
    this.screen = new Screen(this.stdout, { sync: caps.sync });
    const real = stdin === (process.stdin as unknown) && this.stdout === (process.stdout as unknown);
    this.session = new TerminalSession({
      stdin,
      stdout: this.stdout,
      onEvent: (e) => this.onKey(e),
      processHandlers: real,
      onSignal: () => {
        this.cancelAll();
        return true;
      },
    });
    this.screen.setProvider(() => this.compose());
    this.screen.onResize = () => this.screen.schedule();
    this.session.start();
  }

  private cancelAll(): void {
    if (this.cur) {
      const r = this.cur.resolve;
      this.cur = null;
      r(null);
    }
    this.waiting?.cancel();
  }

  private onKey(ev: KeyEvent): void {
    if (this.waiting) {
      if (ev.type === 'key' && ev.key.ctrl && ev.key.text === 'c') this.waiting.cancel();
      return;
    }
    if (!this.cur) return;
    if (ev.type === 'paste') this.cur.dlg.paste(ev.text);
    else {
      const k: Key = ev.key;
      const r = this.cur.dlg.key(k);
      if (r.done) {
        const { resolve } = this.cur;
        this.cur = null;
        resolve(r.value);
      }
    }
    this.screen.schedule();
  }

  private compose(): string[] {
    const W = this.screen.cols;
    const out: string[] = [''];
    if (this.waiting) {
      out.push(renderSpinner({ theme: this.theme, width: W, lang: 'vi', frame: this.frame, elapsedMs: Date.now() - this.t0, tokens: 0, label: this.waiting.text.replace(/[….]+$/, ''), animate: this.theme.caps.color !== 'none', bare: true }));
      out.push('  ' + this.theme.faint('Ctrl+C'));
    } else if (this.cur) out.push(...this.cur.dlg.render(W, Math.max(8, this.screen.rows - 5)));
    // Hàng cuối của vùng sống luôn bị cắt còn cols-1 (tránh tự xuống dòng ở cột cuối): đệm một dòng trống để viền dưới của hộp không bị cắt.
    out.push('');
    return out;
  }

  private run<T>(dlg: Dialog<T>, signal?: AbortSignal): Promise<T | null> {
    return new Promise((resolve) => {
      const entry = { dlg: dlg as Dialog<unknown>, resolve: resolve as (v: unknown) => void };
      this.cur = entry;
      // Huỷ từ bên ngoài (ví dụ đăng nhập xong bằng đường khác): đóng ĐÚNG hộp này — không đụng hộp khác đã thay vào.
      if (signal) {
        const close = (): void => {
          if (this.cur !== entry) return;
          this.cur = null;
          resolve(null);
          this.screen.schedule();
        };
        if (signal.aborted) close();
        else signal.addEventListener('abort', close, { once: true });
      }
      this.screen.schedule();
    });
  }

  heading(version: string): void {
    const th = this.theme;
    const W = this.screen.cols;
    const small = W >= 40;
    const lines: string[] = [];
    if (small) {
      const logo = logoLines(th, true);
      const info = [th.bold(th.gradient('Locaith CLI')) + ' ' + th.muted('v' + version), th.muted(tr('tui.banner.tagline')), '', th.muted(tr('tui.banner.welcome'))];
      const top = Math.max(0, Math.floor((logo.lines.length - info.length) / 2));
      logo.lines.forEach((l, i) => lines.push('  ' + padEnd(l, logo.width) + '   ' + (info[i - top] ?? '')));
    } else lines.push(th.bold(th.gradient('Locaith CLI')));
    this.screen.print(['', ...lines.map((l) => truncateAnsi(l, W - 1)), '']);
  }

  pick(title: string, items: PickItem[], hint?: string): Promise<string | null> {
    // Danh sách ngắn (ngôn ngữ, cách đăng nhập) không cần ô tìm; danh sách dài (trình hướng dẫn nhà cung cấp: 13 mục) tự có ô tìm (PickDialog: > 10 mục).
    return this.run(new PickDialog({ id: 'ob', kind: 'pick', title, items, hint, ...(items.length <= 10 ? { searchable: false } : {}) }, this.theme)) as Promise<string | null>;
  }

  confirm(title: string, detail: string, o?: { yes?: string; no?: string; danger?: boolean }): Promise<boolean | null> {
    return this.run(new ConfirmDialog({ id: 'ob', kind: 'confirm', title, detail, yes: o?.yes, no: o?.no, danger: o?.danger, defaultYes: true }, this.theme)) as Promise<boolean | null>;
  }

  input(title: string, detail: string, secret = false, o?: { initial?: string; placeholder?: string; signal?: AbortSignal }): Promise<string | null> {
    return this.run(new InputDialog({ id: 'ob', kind: 'input', title, detail, secret, ...(o?.initial ? { initial: o.initial } : {}), ...(o?.placeholder ? { placeholder: o.placeholder } : {}) }, this.theme), o?.signal) as Promise<string | null>;
  }

  block(text: string): void {
    // Cắt đúng bề rộng (không thụt lề, không ký hiệu): Screen.print cắt dòng dài hơn cột bằng «…», nên tự ngắt cứng ở đây.
    const w = Math.max(10, this.screen.cols - 1);
    const lines: string[] = [];
    for (let i = 0; i < text.length; i += w) lines.push(text.slice(i, i + w));
    this.screen.print(['', ...lines, '']);
  }

  say(kind: 'info' | 'ok' | 'warn' | 'error' | 'text', text: string): void {
    const th = this.theme;
    const mark = kind === 'ok' ? th.ok(th.g.ok) : kind === 'warn' ? th.warn('!') : kind === 'error' ? th.err(th.g.fail) : kind === 'info' ? th.muted(th.g.sep) : th.brand(th.g.bullet);
    this.screen.print(wrapAnsi(text, this.screen.cols - 4, { first: `  ${mark} `, rest: '    ' }));
  }

  wait(text: string): { stop(): void; cancelled: Promise<void> } {
    let cancel!: () => void;
    const cancelled = new Promise<void>((r) => (cancel = r));
    this.waiting = { text, cancel };
    this.t0 = Date.now();
    this.ticker = setInterval(() => {
      this.frame++;
      this.screen.schedule();
    }, 90);
    this.ticker.unref?.();
    this.screen.schedule();
    return {
      cancelled,
      stop: () => {
        this.waiting = null;
        if (this.ticker) clearInterval(this.ticker);
        this.ticker = null;
        this.screen.schedule();
      },
    };
  }

  close(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.screen.close();
    this.session.stop();
  }
}

/**
 * Chạy một đoạn hội thoại (hộp chọn / ô nhập / xác nhận) trên giao diện terminal của onboarding — dùng cho `locaith provider add|key`.
 * Ném nếu không có terminal tương tác; luôn đóng giao diện (khôi phục terminal) khi xong.
 */
export async function withTerminalUi<T>(o: OnboardingOptions, fn: (ui: OnboardingUi) => Promise<T>): Promise<T> {
  const stdin = o.stdin ?? process.stdin;
  const stdout = o.stdout ?? process.stdout;
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Cần terminal tương tác (TTY).');
  const ui = new TerminalUi(o);
  try {
    return await fn(ui);
  } finally {
    ui.close();
  }
}

/** Chạy onboarding trên terminal thật. Không bao giờ ném: lỗi → { cancelled: true }. */
export async function runOnboarding(o: OnboardingOptions): Promise<OnboardingResult> {
  if (o.ui) {
    try {
      return await runOnboardingFlow(o, o.ui);
    } finally {
      o.ui.close();
    }
  }
  const stdin = o.stdin ?? process.stdin;
  const stdout = o.stdout ?? process.stdout;
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('runOnboarding cần terminal tương tác (TTY).');
  const ui = new TerminalUi(o);
  try {
    return await runOnboardingFlow(o, ui);
  } catch (err) {
    ui.say('error', err instanceof Error ? err.message : String(err));
    return { lang: o.lang, loggedIn: !!o.loggedIn, trusted: !!o.trusted, consented: false, cancelled: true, reason: 'error' };
  } finally {
    ui.close();
  }
}
