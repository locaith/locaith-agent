/**
 * Vòng tương tác của Locaith CLI: nối `CliRuntime` ↔ terminal.
 *
 *   phím (stdin) ──► TuiApp ──► rt.submit / rt.interrupt / …
 *   sự kiện rt ───► Conversation (dòng hoàn chỉnh → scrollback) + trạng thái → Screen (vùng sống ở đáy)
 *
 * Không import engine/host/core: chỉ biết `CliRuntime` và các kiểu chung.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PermissionRequest, SuggestionOption, TItem, TodoItem } from '../../shared/protocol';
import type { AskAnswer, AskRequest, Attachment, CliRuntime, RuntimeEvent, RuntimeStatus } from '../runtime/contract';
import { setLang, t as tr, type Lang } from '../i18n';
import { copyToClipboard, imageFromPath, readClipboardImage } from './clipboard';
import { Conversation } from './conversation';
import { PermissionDialog, makeAskDialog, type Dialog } from './dialogs';
import { Editor } from './editor';
import { History, defaultHistoryFile } from './history';
import { isPrintable, type Key, type KeyEvent } from './keys';
import { Screen, type OutStream } from './screen';
import { renderSprite } from './sprite';
import './strings';
import { Menu, applyCompletion, fileContext, filterSlash, slashContext } from './suggest';
import { TerminalSession, type InStream, type WriteStream } from './terminal';
import { detectCaps, makeTheme, type Caps, type Theme } from './theme';
import { renderWelcome } from './welcome';
import { renderFooter, renderInputBox, renderMenu, renderShortcuts, renderSpinner, renderTodos } from './widgets';
import { truncateAnsi, truncatePlain } from './width';

export interface TuiOptions {
  version: string;
  lang: Lang;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  theme?: 'auto' | 'dark' | 'light';
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Tắt màu (cờ --no-color); NO_COLOR trong môi trường luôn được tôn trọng. */
  noColor?: boolean;
  /** Ép ký hiệu ASCII. */
  ascii?: boolean;
  /** Tệp lịch sử; null = không lưu. Mặc định ~/.locaith/history. */
  historyFile?: string | null;
  home?: string;
  /** In khung chào lúc bắt đầu (mặc định true). */
  banner?: boolean;
  /** Văn bản điền sẵn vào ô nhập. */
  initialInput?: string;
  /** Câu mở đầu GỬI NGAY khi giao diện sẵn sàng (`locaith "việc cần làm"`), khác `initialInput` chỉ điền sẵn. */
  initialPrompt?: string;
  /** Thay thế đọc ảnh clipboard (kiểm thử). */
  readImage?: () => Promise<Attachment | null>;
}

interface DialogEntry {
  dlg: Dialog<unknown>;
  perm?: PermissionRequest;
  askId?: string;
}

type Toast = { level: 'info' | 'warn' | 'error'; text: string; until: number };

const SLASH_LOCAL_THEME = /^\/theme(?:\s+(\S+))?\s*$/i;

export class TuiApp {
  readonly th: Theme;
  private thRef: { th: Theme };
  readonly caps: Caps;
  private readonly stdin: InStream;
  private readonly stdout: OutStream & WriteStream & { isTTY?: boolean; getColorDepth?: () => number };
  readonly screen: Screen;
  private readonly session: TerminalSession;
  readonly conv: Conversation;
  readonly editor = new Editor();
  private readonly history: History;
  private readonly menu = new Menu();
  private shell = false;
  private status: RuntimeStatus | null = null;
  private running = false;
  private runStart = 0;
  private frame = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private dialogs: DialogEntry[] = [];
  private toast: Toast | null = null;
  private expanded = false;
  private showTodos = false;
  private helpOpen = false;
  private todos: TodoItem[] = [];
  private options: SuggestionOption[] = [];
  private attachments: Attachment[] = [];
  private echoPending: string | null = null;
  private printedNotices = new Set<string>();
  private search: { query: string; idx: number; original: string; shell: boolean } | null = null;
  private armed: { c: boolean; d: boolean; esc: boolean } = { c: false, d: false, esc: false };
  private armTimers: Partial<Record<'c' | 'd' | 'esc', ReturnType<typeof setTimeout>>> = {};
  private menuSuppressedAt: string | null = null;
  private menuSeq = 0;
  private menuTimer: ReturnType<typeof setTimeout> | null = null;
  private unsub: (() => void) | null = null;
  private exitResolve: ((code: number) => void) | null = null;
  private exiting = false;
  private spinnerSeed = Math.floor(Math.random() * 10);
  private lang: Lang;
  private busyImage = false;
  /** Đã in khung chào (đầy đủ hoặc gọn kèm hội thoại cũ) chưa. */
  private bannerPrinted = false;
  /** Đánh thức `waitForAccount` khi lõi báo có thông tin tài khoản. */
  private accountWaiter: (() => void) | null = null;

  constructor(
    private readonly rt: CliRuntime,
    private readonly o: TuiOptions,
  ) {
    this.stdin = (o.stdin ?? process.stdin) as unknown as InStream;
    this.stdout = (o.stdout ?? process.stdout) as unknown as OutStream & WriteStream & { isTTY?: boolean; getColorDepth?: () => number };
    this.lang = o.lang;
    setLang(o.lang);
    this.caps = detectCaps({
      env: o.env ?? process.env,
      colorDepth: this.stdout.getColorDepth?.(),
      theme: o.theme,
      noColor: o.noColor,
      ascii: o.ascii,
    });
    this.th = makeTheme(this.caps);
    this.thRef = { th: this.th };
    this.screen = new Screen(this.stdout, { sync: this.caps.sync });
    const self = this;
    this.conv = new Conversation({
      get theme() {
        return self.thRef.th;
      },
      width: () => this.screen.cols,
      cwd: () => this.status?.cwd ?? o.cwd ?? process.cwd(),
      expanded: () => this.expanded,
      lang: () => this.lang,
      print: (lines) => this.screen.print(lines),
    });
    this.history = new History(o.historyFile === undefined ? defaultHistoryFile(o.home) : o.historyFile);
    const real = this.stdin === (process.stdin as unknown) && this.stdout === (process.stdout as unknown);
    this.session = new TerminalSession({
      stdin: this.stdin,
      stdout: this.stdout,
      onEvent: (e) => this.onKeyEvent(e),
      processHandlers: real,
      onSignal: (sig) => this.onSignal(sig),
      onCrash: () => undefined,
    });
    if (o.initialInput) this.editor.setText(o.initialInput);
  }

  private get theme(): Theme {
    return this.thRef.th;
  }

  // ───────────────────────── vòng đời ─────────────────────────

  run(): Promise<number> {
    return new Promise<number>((resolve) => {
      this.exitResolve = resolve;
      this.status = this.safeStatus();
      this.running = !!this.status?.running;
      this.todos = this.status?.todos ?? [];
      this.session.start();
      this.screen.onResize = () => this.screen.schedule();
      this.screen.setProvider(() => this.compose());
      this.unsub = this.rt.on((e) => this.onRuntimeEvent(e));
      const begin = async (): Promise<void> => {
        if (this.exiting) return;
        if (!this.bannerPrinted && this.o.banner !== false) await this.waitForAccount(700);
        if (this.exiting) return;
        if (!this.bannerPrinted) {
          this.bannerPrinted = true;
          if (this.o.banner !== false) {
            this.screen.print(
              renderWelcome({ version: this.o.version, lang: this.lang, theme: this.theme, width: this.screen.cols, height: this.screen.rows, status: this.status, cwd: this.status?.cwd ?? this.o.cwd ?? process.cwd() }),
            );
            this.conv.markPrinted();
          }
        }
        this.printNewNotices();
        if (this.running) this.startTicker();
        this.screen.flush();
        const first = this.o.initialPrompt?.trim();
        if (first) {
          this.history.add(first);
          void this.send(first, false);
        }
      };
      // Phiên mở sẵn lúc khởi động (`-c`, `-r`) phát `replay` cho người nghe đầu tiên ở microtask kế tiếp: chờ nó (nó tự in khung chào gọn
      // kèm hội thoại cũ) rồi mới in khung chào đầy đủ nếu chưa có gì được in.
      queueMicrotask(() => queueMicrotask(() => void begin()));
    }).then(async (code) => {
      await this.shutdown();
      return code;
    });
  }

  /**
   * Lần chạy đầu bộ đệm tài khoản còn trống (lõi làm mới ở nền, vài chục ms tới vài trăm ms): chờ tối đa `ms` để khung chào có tên/gói
   * thay vì chỉ một dấu ✔. Đã có sẵn (các lần sau) hoặc không đăng nhập Locaith thì không chờ.
   */
  private waitForAccount(ms: number): Promise<void> {
    const a = this.status?.account;
    if (!a || !a.loggedIn || a.email || a.plan) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.accountWaiter = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.accountWaiter = done;
    });
  }

  /** Thoát (idempotent). */
  exit(code = 0): void {
    if (this.exiting) return;
    this.exiting = true;
    this.exitResolve?.(code);
  }

  private async shutdown(): Promise<void> {
    this.stopTicker();
    for (const k of ['c', 'd', 'esc'] as const) clearTimeout(this.armTimers[k]);
    if (this.menuTimer) clearTimeout(this.menuTimer);
    try {
      this.unsub?.();
    } catch {
      /* bỏ qua */
    }
    this.screen.close();
    const bye: string[] = [''];
    bye.push(this.theme.gradient(tr('tui.goodbye')));
    const sid = this.status?.sessionId;
    if (sid && this.conv.userMessages > 0) bye.push(this.theme.muted(tr('tui.goodbye.resume', { cmd: `locaith --resume ${sid}` })));
    try {
      this.stdout.write(bye.join('\r\n') + '\r\n');
    } catch {
      /* bỏ qua */
    }
    this.session.stop();
    try {
      await Promise.race([this.rt.dispose(), new Promise<void>((r) => setTimeout(r, 6000))]);
    } catch {
      /* dispose lỗi không chặn thoát */
    }
  }

  private onSignal(sig: NodeJS.Signals): boolean {
    if (sig === 'SIGINT') {
      if (this.running) {
        this.rt.interrupt();
        return true;
      }
      this.exit(130);
      return true;
    }
    this.exit(sig === 'SIGTERM' ? 143 : 129);
    // nếu dọn dẹp treo: ép thoát sau 8 s
    const t = setTimeout(() => {
      this.session.restore();
      process.exit(sig === 'SIGTERM' ? 143 : 129);
    }, 8000);
    t.unref?.();
    return true;
  }

  private safeStatus(): RuntimeStatus | null {
    try {
      return this.rt.status();
    } catch {
      return this.status;
    }
  }

  // ───────────────────────── sự kiện runtime ─────────────────────────

  private onRuntimeEvent(e: RuntimeEvent): void {
    try {
      this.handleRuntimeEvent(e);
    } catch (err) {
      this.safePrintError(err);
    }
    this.screen.schedule();
  }

  private safePrintError(err: unknown): void {
    try {
      this.conv.output(`${tr('tui.tool.failed')}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } catch {
      /* bỏ qua */
    }
  }

  private handleRuntimeEvent(e: RuntimeEvent): void {
    switch (e.t) {
      case 'ui':
        return this.onUi(e.ev);
      case 'status': {
        const wasRunning = this.running;
        this.status = e.status;
        this.todos = e.status.todos ?? this.todos;
        if (e.status.running !== wasRunning) this.setRunning(e.status.running);
        if (this.accountWaiter && (e.status.account?.email || e.status.account?.plan || e.status.account?.loggedIn === false)) this.accountWaiter();
        this.printNewNotices();
        return;
      }
      case 'permission':
        this.dialogs.push({ dlg: new PermissionDialog(e.request, this.theme) as Dialog<unknown>, perm: e.request });
        return;
      case 'permission_cancel':
        this.dialogs = this.dialogs.filter((d) => d.perm?.id !== e.id);
        return;
      case 'ask':
        this.dialogs.push({ dlg: makeAskDialog(e.ask, this.theme) as Dialog<unknown>, askId: e.ask.id });
        return;
      case 'output':
        this.conv.output(e.text, e.kind ?? 'markdown', e.title);
        return;
      case 'toast':
        this.setToast(e.level, e.text);
        return;
      case 'replay':
        return this.replay(e.items, e.reason);
      case 'action':
        return this.onAction(e.action, e.payload);
    }
  }

  private onUi(ev: import('../../shared/protocol').UiEvent): void {
    switch (ev.t) {
      case 'run_state':
        this.setRunning(ev.running);
        return;
      case 'user':
        this.echoPending = null;
        break;
      case 'assistant_start':
        if (this.echoPending !== null) {
          this.conv.echo(this.echoPending, true);
          this.echoPending = null;
        }
        break;
      case 'todos':
        this.todos = ev.todos;
        return;
      case 'tasks':
        this.todos = ev.todos;
        break;
      case 'options':
        this.options = ev.options;
        return;
      case 'mode':
        if (this.status) this.status = { ...this.status, mode: ev.mode };
        return;
      case 'tool_permission':
        return; // dùng sự kiện `permission`
      default:
        break;
    }
    this.conv.ui(ev);
  }

  private setRunning(r: boolean): void {
    if (r === this.running) return;
    this.running = r;
    if (r) {
      this.runStart = Date.now();
      this.conv.resetRunMeters();
      this.options = [];
      this.startTicker();
    } else {
      this.stopTicker();
    }
  }

  private startTicker(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      this.frame++;
      if (this.toast && Date.now() > this.toast.until) this.toast = null;
      this.screen.schedule();
    }, 90);
    this.ticker.unref?.();
  }

  private stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  private setToast(level: Toast['level'], text: string, ms = 4000): void {
    this.toast = { level, text, until: Date.now() + ms };
    const t = setTimeout(() => {
      if (this.toast && Date.now() >= this.toast.until) this.toast = null;
      this.screen.schedule();
    }, ms + 30);
    t.unref?.();
  }

  private printNewNotices(): void {
    for (const n of this.status?.notices ?? []) {
      if (this.printedNotices.has(n)) continue;
      this.printedNotices.add(n);
      this.conv.ui({ t: 'notice', level: 'info', text: n });
    }
  }

  private replay(items: TItem[], reason: 'resume' | 'fork' | 'rewind' | 'new' | 'clear'): void {
    // Lần đầu (phiên mở sẵn lúc khởi động) chưa in gì: KHÔNG xoá màn hình/scrollback của người dùng, chỉ in tiếp.
    if (this.bannerPrinted) this.screen.clearScreen(true);
    this.bannerPrinted = true;
    this.conv.reset();
    this.echoPending = null;
    this.options = [];
    const lines = renderWelcome({ version: this.o.version, lang: this.lang, theme: this.theme, width: this.screen.cols, height: this.screen.rows, status: this.safeStatus(), cwd: this.status?.cwd ?? this.o.cwd ?? process.cwd(), compact: true });
    this.screen.print(lines);
    this.conv.markPrinted();
    if (items.length) {
      if (reason === 'resume' || reason === 'fork' || reason === 'rewind') this.screen.print(['', this.theme.faint(`${this.theme.g.rule.repeat(2)} ${tr('tui.resume.header')} ${this.theme.g.rule.repeat(2)}`)]);
      this.screen.print(this.conv.renderItems(items));
      this.conv.markPrinted();
    }
  }

  private onAction(action: 'exit' | 'redraw' | 'clear_screen' | 'open_editor' | 'copy' | 'insert', payload?: string): void {
    switch (action) {
      case 'exit':
        this.exit(0);
        return;
      case 'redraw':
        this.screen.pushScreenToScrollback();
        return;
      case 'clear_screen':
        this.screen.clearScreen(true);
        this.conv.markPrinted();
        return;
      case 'copy': {
        const ok = copyToClipboard(payload ?? '', (s) => this.stdout.write(s));
        this.setToast(ok ? 'info' : 'warn', tr(ok ? 'tui.toast.copied' : 'tui.toast.copy.fail'));
        return;
      }
      case 'open_editor':
        void this.externalEdit(payload ?? this.editor.text);
        return;
      case 'insert': {
        // Tin đang xếp hàng bị trả về khi dừng lượt (hoặc hook chặn tin): đưa lại vào ô nhập, giữ nguyên điều người dùng đang gõ dở.
        const back = (payload ?? '').trim();
        if (!back) return;
        const cur = this.editor.text;
        this.loadText(cur ? `${back}\n${cur}` : back);
        return;
      }
    }
  }

  /** Mở trình soạn thảo ngoài ($VISUAL/$EDITOR/notepad) trên văn bản, nạp kết quả vào ô nhập. */
  private async externalEdit(initial: string): Promise<void> {
    const env = this.o.env ?? process.env;
    const editor = env.VISUAL || env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
    const file = path.join(os.tmpdir(), `locaith-edit-${process.pid}-${Date.now()}.md`);
    try {
      fs.writeFileSync(file, initial, { mode: 0o600 });
      this.screen.suspend();
      this.session.suspend();
      spawnSync(editor, [file], { stdio: 'inherit', shell: true });
      const text = fs.readFileSync(file, 'utf8').replace(/\s+$/, '');
      this.loadText(text);
    } catch (err) {
      this.setToast('error', err instanceof Error ? err.message : String(err));
    } finally {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* bỏ qua */
      }
      this.session.resume();
      this.screen.resume();
    }
  }

  // ───────────────────────── phím ─────────────────────────

  private onKeyEvent(ev: KeyEvent): void {
    try {
      if (ev.type === 'paste') this.onPaste(ev.text);
      else this.onKey(ev.key);
    } catch (err) {
      this.safePrintError(err);
    }
    this.screen.schedule();
  }

  private onPaste(text: string): void {
    const dlg = this.dialogs[0];
    if (dlg) {
      dlg.dlg.paste(text);
      return;
    }
    if (this.search) {
      this.search.query += text.replace(/\n/g, ' ');
      this.searchUpdate(this.history.entries.length - 1);
      return;
    }
    const img = imageFromPath(text, this.status?.cwd ?? this.o.cwd ?? process.cwd());
    if (img) {
      this.attachments.push(img);
      this.setToast('info', tr('tui.image.pasted', { name: img.name }));
      return;
    }
    if (this.editor.empty && text.startsWith('!') && !this.shell) {
      this.shell = true;
      text = text.slice(1);
    }
    this.editor.insert(text);
    this.afterEdit();
  }

  private disarm(): void {
    for (const k of ['c', 'd', 'esc'] as const) {
      if (this.armed[k]) {
        clearTimeout(this.armTimers[k]);
        this.armed[k] = false;
      }
    }
  }

  private arm(k: 'c' | 'd' | 'esc', ms: number): void {
    this.armed[k] = true;
    clearTimeout(this.armTimers[k]);
    this.armTimers[k] = setTimeout(() => {
      this.armed[k] = false;
      this.screen.schedule();
    }, ms);
    this.armTimers[k]?.unref?.();
  }

  private isCtrl(k: Key, ch: string): boolean {
    return k.name === 'char' && k.ctrl && !k.alt && k.text === ch;
  }

  private onKey(k: Key): void {
    // hộp thoại chiếm phím
    const top = this.dialogs[0];
    if (top) {
      this.dialogKey(top, k);
      return;
    }
    if (this.search) {
      this.searchKey(k);
      return;
    }
    const wasArmed = this.armed.c || this.armed.d || this.armed.esc;
    const keep = this.isCtrl(k, 'c') || this.isCtrl(k, 'd') || k.name === 'escape';
    if (wasArmed && !keep) this.disarm();
    if (this.helpOpen && !(k.name === 'char' && k.text === '?')) this.helpOpen = false;

    // ── phím điều khiển ──
    if (this.isCtrl(k, 'c')) return this.onCtrlC();
    if (this.isCtrl(k, 'd')) return this.onCtrlD();
    if (k.name === 'escape') return this.onEscape();
    if (this.isCtrl(k, 'l')) {
      this.screen.pushScreenToScrollback();
      return;
    }
    if (this.isCtrl(k, 'o')) return this.toggleExpanded();
    if (this.isCtrl(k, 't')) {
      this.showTodos = !this.showTodos;
      return;
    }
    if (this.isCtrl(k, 'r')) return this.startSearch();
    if (this.isCtrl(k, 'g')) {
      void this.externalEdit(this.currentText());
      return;
    }
    if (this.isCtrl(k, 'z') && process.platform !== 'win32') return this.suspendProcess();
    if ((this.isCtrl(k, 'v') || (k.alt && k.name === 'char' && k.text === 'v')) && !this.busyImage) {
      void this.pasteClipboardImage();
      return;
    }
    if (k.name === 'tab' && k.shift) {
      try {
        this.rt.cycleMode();
      } catch (err) {
        this.safePrintError(err);
      }
      return;
    }

    // ── gửi / xuống dòng ──
    if (k.name === 'enter') {
      if (k.shift || k.alt) {
        this.editor.insert('\n');
        this.afterEdit();
        return;
      }
      return this.onEnter();
    }
    if (this.isCtrl(k, 'j')) {
      this.editor.insert('\n');
      this.afterEdit();
      return;
    }

    // ── menu gợi ý ──
    if (this.menu.open) {
      if (k.name === 'up') return this.menu.move(-1);
      if (k.name === 'down') return this.menu.move(1);
      if (k.name === 'tab') return this.acceptMenu(false);
      if (k.name === 'right' && this.editor.cursor === this.editor.text.length) return this.acceptMenu(false);
    }

    // ── chỉnh sửa ──
    const ed = this.editor;
    const width = this.textWidth();
    switch (k.name) {
      case 'up':
        if (!ed.moveVertical(-1, width)) this.historyPrev();
        return this.afterMove();
      case 'down':
        if (!ed.moveVertical(1, width)) this.historyNext();
        return this.afterMove();
      case 'left':
        k.ctrl || k.alt ? ed.wordLeft() : ed.left();
        return this.afterMove();
      case 'right':
        k.ctrl || k.alt ? ed.wordRight() : ed.right();
        return this.afterMove();
      case 'home':
        ed.home();
        return this.afterMove();
      case 'end':
        ed.end();
        return this.afterMove();
      case 'backspace':
        if (ed.empty && this.shell) {
          this.shell = false;
          this.afterEdit();
          return;
        }
        if (ed.empty && this.attachments.length) {
          this.attachments.pop();
          return;
        }
        if (k.ctrl || k.alt) ed.deleteWordBack();
        else ed.backspace();
        return this.afterEdit();
      case 'delete':
        k.ctrl || k.alt ? ed.deleteWordForward() : ed.del();
        return this.afterEdit();
      case 'tab':
        return;
      case 'char':
        break;
      default:
        return;
    }

    // ── ký tự ──
    if (k.ctrl && k.text) {
      switch (k.text) {
        case 'a': ed.home(); return this.afterMove();
        case 'e': ed.end(); return this.afterMove();
        case 'b': ed.left(); return this.afterMove();
        case 'f': ed.right(); return this.afterMove();
        case 'k': ed.killToEnd(); return this.afterEdit();
        case 'u': ed.killToStart(); return this.afterEdit();
        case 'w': ed.deleteWordBack(); return this.afterEdit();
        case 'y': ed.yank(); return this.afterEdit();
        case 'p': if (!ed.moveVertical(-1, width)) this.historyPrev(); return this.afterMove();
        case 'n': if (!ed.moveVertical(1, width)) this.historyNext(); return this.afterMove();
        default: return;
      }
    }
    if (k.alt && k.text) {
      switch (k.text) {
        case 'b': ed.wordLeft(); return this.afterMove();
        case 'f': ed.wordRight(); return this.afterMove();
        case 'd': ed.deleteWordForward(); return this.afterEdit();
        case 'p': return void this.rt.cycleMode();
        default: return;
      }
    }
    if (!isPrintable(k)) return;
    const text = k.text ?? '';
    if (ed.empty) {
      if (text === '?' && !this.shell) {
        this.helpOpen = !this.helpOpen;
        return;
      }
      if (text === '!' && !this.shell) {
        this.shell = true;
        return;
      }
      if (/^[1-9]$/.test(text) && this.options.length >= Number(text) && !this.shell) {
        const opt = this.options[Number(text) - 1];
        this.options = [];
        void this.send(opt.prompt, false);
        return;
      }
    }
    // chữ dán thô nhiều ký tự (gõ nhanh) vẫn qua đây
    ed.insert(text);
    this.afterEdit();
  }

  private textWidth(): number {
    return Math.max(4, this.screen.cols - 6);
  }

  private currentText(): string {
    return (this.shell ? '!' : '') + this.editor.text;
  }

  private loadText(s: string): void {
    if (s.startsWith('!')) {
      this.shell = true;
      this.editor.setText(s.slice(1));
    } else {
      this.shell = false;
      this.editor.setText(s);
    }
    this.afterEdit();
  }

  private historyPrev(): void {
    const v = this.history.prev(this.currentText());
    if (v !== undefined) this.loadText(v);
  }

  private historyNext(): void {
    const v = this.history.next();
    if (v !== undefined) this.loadText(v);
  }

  private afterMove(): void {
    this.updateMenu();
  }

  private afterEdit(): void {
    this.menuSuppressedAt = null;
    this.updateMenu();
  }

  private toggleExpanded(): void {
    this.expanded = !this.expanded;
    if (this.expanded) this.conv.expandLast();
    this.setToast('info', this.expanded ? tr('tui.hint.expanded') : '·', 1200);
  }

  private onCtrlC(): void {
    if (!this.editor.empty || this.attachments.length || this.shell) {
      this.editor.clear();
      this.attachments = [];
      this.shell = false;
      this.menu.clear();
      this.history.resetNav();
      return;
    }
    if (this.running) {
      this.rt.interrupt();
      return;
    }
    if (this.armed.c) {
      this.exit(0);
      return;
    }
    this.arm('c', 2000);
  }

  private onCtrlD(): void {
    if (this.editor.empty) {
      if (!this.running) {
        this.exit(0);
        return;
      }
      if (this.armed.d) {
        this.exit(0);
        return;
      }
      this.arm('d', 2000);
      return;
    }
    this.editor.del();
    this.afterEdit();
  }

  private onEscape(): void {
    if (this.menu.open) {
      this.menuSuppressedAt = this.editor.text;
      this.menu.clear();
      return;
    }
    if (this.helpOpen) {
      this.helpOpen = false;
      return;
    }
    if (this.running) {
      this.rt.interrupt();
      return;
    }
    if (!this.editor.empty || this.shell || this.attachments.length) {
      this.editor.clear();
      this.shell = false;
      this.attachments = [];
      return;
    }
    if (this.armed.esc) {
      this.disarm();
      void this.send('/rewind', false);
      return;
    }
    this.arm('esc', 900);
  }

  private suspendProcess(): void {
    this.screen.suspend();
    this.session.suspend();
    const resume = (): void => {
      process.off('SIGCONT', resume);
      this.session.resume();
      this.screen.resume();
    };
    process.on('SIGCONT', resume);
    try {
      process.kill(process.pid, 'SIGTSTP');
    } catch {
      resume();
    }
  }

  private async pasteClipboardImage(): Promise<void> {
    this.busyImage = true;
    try {
      const img = await (this.o.readImage ? this.o.readImage() : readClipboardImage());
      if (img) {
        this.attachments.push(img);
        this.setToast('info', tr('tui.image.pasted', { name: img.name }));
      } else this.setToast('warn', tr('tui.image.fail'));
    } catch {
      this.setToast('warn', tr('tui.image.fail'));
    } finally {
      this.busyImage = false;
      this.screen.schedule();
    }
  }

  // ───────────────────────── gửi ─────────────────────────

  private onEnter(): void {
    if (this.menu.open && this.menu.current) {
      if (this.menu.kind === 'slash') {
        const cmd = this.menu.current.insert.trim();
        const typed = this.editor.text.trim();
        if (typed !== cmd) {
          this.editor.setText(cmd);
        }
        this.menu.clear();
        void this.submitCurrent();
        return;
      }
      this.acceptMenu(false);
      return;
    }
    // `\` + Enter: xuống dòng
    if (this.editor.text.endsWith('\\') && this.editor.cursor === this.editor.text.length) {
      this.editor.setText(this.editor.text.slice(0, -1) + '\n');
      this.afterEdit();
      return;
    }
    void this.submitCurrent();
  }

  private async submitCurrent(): Promise<void> {
    const text = this.currentText().trim();
    if (!text || text === '!') return;
    const atts = this.attachments;
    this.history.add(text);
    this.history.resetNav();
    this.editor.clear();
    this.shell = false;
    this.attachments = [];
    this.menu.clear();
    this.options = [];
    this.helpOpen = false;
    await this.send(text, true, atts);
  }

  private async send(text: string, fromEditor: boolean, atts?: Attachment[]): Promise<void> {
    void fromEditor;
    const isCmd = text.startsWith('/') || text.startsWith('!');
    // lệnh thuộc về giao diện
    const m = SLASH_LOCAL_THEME.exec(text);
    if (m) {
      this.conv.echo(text, false);
      await this.cmdTheme(m[1]);
      return;
    }
    if (isCmd) this.conv.echo(text, false);
    else if (!this.running) this.echoPending = text;
    try {
      await this.rt.submit(text, atts && atts.length ? { attachments: atts } : undefined);
    } catch (err) {
      this.echoPending = null;
      this.safePrintError(err);
    }
    this.screen.schedule();
  }

  private async cmdTheme(arg?: string): Promise<void> {
    let choice = (arg ?? '').toLowerCase();
    if (!['auto', 'dark', 'light'].includes(choice)) {
      const ans = await this.ask({
        id: 'theme',
        kind: 'pick',
        title: 'Theme',
        items: [
          { id: 'auto', label: 'auto', detail: this.lang === 'vi' ? 'theo nền terminal' : 'follow the terminal' },
          { id: 'dark', label: 'dark', detail: this.lang === 'vi' ? 'nền tối' : 'dark background' },
          { id: 'light', label: 'light', detail: this.lang === 'vi' ? 'nền sáng' : 'light background' },
        ],
      });
      if (typeof ans !== 'string') return;
      choice = ans;
    }
    const caps = detectCaps({ env: this.o.env ?? process.env, colorDepth: this.stdout.getColorDepth?.(), theme: choice as 'auto' | 'dark' | 'light', noColor: this.o.noColor, ascii: this.o.ascii });
    this.thRef.th = makeTheme(caps);
    this.setToast('info', `theme: ${choice}`);
    this.screen.schedule();
  }

  /** Hộp hỏi do giao diện tự mở (không qua runtime). */
  private ask(req: AskRequest): Promise<AskAnswer> {
    return new Promise((resolve) => {
      const dlg = makeAskDialog(req, this.theme) as Dialog<unknown>;
      this.dialogs.push({ dlg, askId: '__local:' + req.id });
      const entry = this.dialogs[this.dialogs.length - 1] as DialogEntry & { local?: (v: AskAnswer) => void };
      entry.local = resolve;
    });
  }

  private dialogKey(entry: DialogEntry & { local?: (v: AskAnswer) => void }, k: Key): void {
    if (entry.perm && this.isCtrl(k, 'c')) {
      this.finishDialog(entry, { decision: 'deny' });
      this.rt.interrupt();
      return;
    }
    const r = entry.dlg.key(k);
    if (r.done) this.finishDialog(entry, r.value);
  }

  private finishDialog(entry: DialogEntry & { local?: (v: AskAnswer) => void }, value: unknown): void {
    this.dialogs = this.dialogs.filter((d) => d !== entry);
    try {
      if (entry.perm) this.rt.respondPermission(entry.perm.id, value as Parameters<CliRuntime['respondPermission']>[1]);
      else if (entry.local) entry.local(value as AskAnswer);
      else if (entry.askId) this.rt.answer(entry.askId, value as AskAnswer);
    } catch (err) {
      this.safePrintError(err);
    }
  }

  // ───────────────────────── tìm ngược (Ctrl+R) ─────────────────────────

  private startSearch(): void {
    this.search = { query: '', idx: this.history.entries.length, original: this.currentText(), shell: this.shell };
    this.menu.clear();
  }

  private searchUpdate(from: number): void {
    const s = this.search;
    if (!s) return;
    const i = this.history.search(s.query, from);
    s.idx = i;
  }

  private searchMatch(): string | null {
    const s = this.search;
    if (!s || s.idx < 0) return null;
    return this.history.entries[s.idx] ?? null;
  }

  private searchKey(k: Key): void {
    const s = this.search!;
    if (k.name === 'escape' || this.isCtrl(k, 'c') || this.isCtrl(k, 'g')) {
      this.search = null;
      this.loadText(s.original);
      return;
    }
    if (k.name === 'enter') {
      const m = this.searchMatch();
      this.search = null;
      if (m !== null) this.loadText(m);
      else this.loadText(s.original);
      return;
    }
    if (this.isCtrl(k, 'r')) {
      this.searchUpdate(Math.max(-1, s.idx - 1));
      return;
    }
    if (k.name === 'backspace') {
      s.query = [...s.query].slice(0, -1).join('');
      this.searchUpdate(this.history.entries.length - 1);
      return;
    }
    if (isPrintable(k)) {
      s.query += k.text;
      this.searchUpdate(this.history.entries.length - 1);
      return;
    }
    // phím khác: nhận kết quả rồi xử lý phím như thường
    const m = this.searchMatch();
    this.search = null;
    if (m !== null) this.loadText(m);
    else this.loadText(s.original);
    this.onKey(k);
  }

  // ───────────────────────── menu gợi ý ─────────────────────────

  private updateMenu(): void {
    if (this.menuTimer) {
      clearTimeout(this.menuTimer);
      this.menuTimer = null;
    }
    const text = this.editor.text;
    if (this.shell || this.menuSuppressedAt === text) {
      this.menu.clear();
      return;
    }
    const sc = slashContext(text, this.editor.cursor);
    if (sc) {
      let cmds: ReturnType<CliRuntime['slashCommands']> = [];
      try {
        cmds = this.rt.slashCommands();
      } catch {
        cmds = [];
      }
      const items = filterSlash(cmds, sc.query);
      // đã gõ đủ tên một lệnh duy nhất → vẫn hiện để Enter chạy
      if (items.length) this.menu.set('slash', items, sc.range);
      else this.menu.clear();
      return;
    }
    const fc = fileContext(text, this.editor.cursor);
    if (fc) {
      const seq = ++this.menuSeq;
      this.menuTimer = setTimeout(() => {
        this.menuTimer = null;
        void this.rt
          .complete({ kind: 'file', query: fc.query, limit: 8 })
          .then((list) => {
            if (seq !== this.menuSeq) return;
            const cur = fileContext(this.editor.text, this.editor.cursor);
            if (!cur || cur.range.start !== fc.range.start) return;
            if (!list.length) this.menu.clear();
            else this.menu.set('file', list.map((c) => ({ label: c.label, insert: c.insert, detail: c.detail })), cur.range);
            this.screen.schedule();
          })
          .catch(() => undefined);
      }, 40);
      this.menuTimer.unref?.();
      return;
    }
    this.menuSeq++;
    this.menu.clear();
  }

  private acceptMenu(_run: boolean): void {
    const it = this.menu.current;
    if (!it) return;
    const r = applyCompletion(this.editor.text, this.menu.range, it.insert);
    this.editor.setText(r.text, r.cursor);
    this.menu.clear();
    this.menuSuppressedAt = this.editor.text; // không bật lại ngay (tránh vòng)
    if (this.menu.kind === 'file') this.menuSuppressedAt = null;
    this.updateMenu();
  }

  // ───────────────────────── dựng khung ─────────────────────────

  private compose(): string[] {
    const th = this.theme;
    const W = this.screen.cols;
    const H = this.screen.rows;
    const out: string[] = [];
    const dlgEntry = this.dialogs[0];
    const convLive = this.conv.live();
    out.push(...convLive);
    if (this.conv.hasPrinted || convLive.length) out.push('');

    // spinner + bảng việc
    if (this.running && !dlgEntry) {
      if (H >= 26) out.push(...renderSprite(th, Date.now() - this.runStart, W, this.o.env));
      const hint = this.conv.spinnerHint();
      out.push(
        renderSpinner({
          theme: th,
          width: W,
          lang: this.lang,
          frame: this.frame,
          elapsedMs: Date.now() - this.runStart,
          tokens: this.conv.runTokens,
          label: hint.label,
          thinking: hint.thinking,
          animate: this.caps.color !== 'none',
        }),
      );
    }
    const todosVisible = this.todos.length > 0 && (this.showTodos || (this.running && this.todos.some((x) => x.status !== 'completed')));
    if (todosVisible) out.push(...renderTodos(this.todos, th, W));

    // tác vụ nền / tệp đã đổi
    const st = this.status;
    if (st && !dlgEntry && (st.bgTasks.running > 0 || (st.changedFiles ?? 0) > 0)) {
      const parts: string[] = [];
      if (st.bgTasks.running > 0) parts.push(tr('tui.bg.tasks', { n: st.bgTasks.running }));
      if ((st.changedFiles ?? 0) > 0) parts.push(tr('tui.changed.files', { n: st.changedFiles ?? 0 }));
      out.push('  ' + th.muted(parts.join(` ${th.g.sep} `)));
    }

    // hàng đợi
    const queued = st?.queued ?? [];
    if (queued.length && !dlgEntry) {
      for (const q of queued.slice(-3)) out.push(truncateAnsi('  ' + th.muted(`${th.g.result} ${tr('tui.queued')}: `) + th.faint(truncatePlain(q.replace(/\s+/g, ' '), W - 16)), W - 1));
    }

    // gợi ý hướng đi
    if (!this.running && !dlgEntry && this.options.length && this.editor.empty) {
      out.push('  ' + th.muted(tr('tui.options.title')));
      this.options.slice(0, 4).forEach((o, i) => out.push(truncateAnsi(`  ${th.brand(String(i + 1) + '.')} ${o.label}${o.detail ? th.faint('  ' + o.detail) : ''}`, W - 1)));
    }

    // ô nhập / hộp thoại
    const extra = out.length + 4;
    if (dlgEntry) {
      out.push(...dlgEntry.dlg.render(W, Math.max(8, H - Math.min(extra, 8) - 1)));
    } else {
      const chips = this.attachments.map((a, i) => `[${this.caps.unicode ? '🖼' : 'img'}${i + 1} ${truncatePlain(a.name, 18)}]`);
      out.push(
        ...renderInputBox({
          editor: this.editor,
          width: W,
          theme: th,
          shell: this.shell,
          placeholder: tr('tui.prompt.placeholder'),
          search: this.search ? { query: this.search.query, match: this.searchMatch(), failed: this.search.query.length > 0 && this.search.idx < 0 } : undefined,
          chips: chips.length ? chips : undefined,
        }),
      );
      if (this.menu.open) out.push(...renderMenu(this.menu, th, W));
      else if (this.helpOpen) out.push(...renderShortcuts(th, W));
    }

    // dải trạng thái
    const toast = this.toast && Date.now() <= this.toast.until ? this.toast : null;
    out.push(
      renderFooter({
        width: W,
        theme: th,
        status: st,
        running: this.running,
        toast,
        ctrlCArmed: this.armed.c,
        ctrlDArmed: this.armed.d,
        esc2Armed: this.armed.esc,
        empty: this.editor.empty && !this.shell,
        expanded: this.expanded,
        dialog: !!dlgEntry,
        shell: this.shell,
      }),
    );
    return out;
  }
}

export type { Caps };
