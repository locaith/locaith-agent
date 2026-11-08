/**
 * `MockRuntime`: một `CliRuntime` GIẢ có kịch bản để phát triển và kiểm thử giao diện không cần lõi thật.
 * Kịch bản chọn theo từ khoá trong tin nhắn (xem `pickScenario`): markdown dài, chuỗi công cụ đọc/sửa/bash, xin quyền, diff, todos,
 * nén ngữ cảnh, lỗi, agent con, hàng đợi, `/resume` + replay, `ask`…
 *
 * Mọi độ trễ nhân với `speed` (0 = không chờ, dùng cho test). Sự kiện phát ĐỒNG BỘ như hợp đồng.
 */

import type { PermissionMode, PermissionRequest, SessionSummary, SlashCommandInfo, ThinkingLevel, TItem, TodoItem, UiEvent } from '../../shared/protocol';
import { newId } from '../../shared/transcript';
import type { AskAnswer, AskRequest, Attachment, CliRuntime, Completion, RuntimeEvent, RuntimeStatus } from '../runtime/contract';

type Listener = (e: RuntimeEvent) => void;

export interface MockOptions {
  /** Hệ số thời gian (1 = bình thường, 0 = tức thì). */
  speed?: number;
  lang?: 'vi' | 'en';
  cwd?: string;
  version?: string;
  loggedIn?: boolean;
  model?: string;
  mode?: PermissionMode;
  branch?: string;
}

export const MOCK_REPLY_VI = `Mình đã xem qua dự án. Đây là tóm tắt nhanh:

## Kết quả kiểm tra

- Cấu hình **TypeScript** đang bật \`strict\`, nhưng \`tsconfig.json\` thiếu \`noUncheckedIndexedAccess\`
- Hàm \`parseArgs\` trong *src/cli.ts* chưa xử lý cờ \`--no-color\`
- Có **3 tệp** import vòng nhau (xem bảng bên dưới)

| Tệp | Dòng | Vấn đề |
|---|--:|---|
| src/a.ts | 12 | import vòng với b.ts |
| src/b.ts | 40 | import vòng với c.ts |
| src/c.ts | 7 | import vòng với a.ts |

Mình đề xuất tách phần kiểu dùng chung ra một tệp riêng:

\`\`\`ts
// src/types.ts
export interface Options {
  color: boolean; // mặc định true
  retries: number;
}
export const defaults: Options = { color: true, retries: 3 };
\`\`\`

> Lưu ý: đổi này không thay đổi hành vi, chỉ gỡ vòng import.

Xem thêm tại [tài liệu](https://locaith.ai/docs). Bạn muốn mình làm luôn không?`;

export const MOCK_REPLY_EN = `I took a look at the project. Quick summary:

## Findings

- **TypeScript** has \`strict\` on, but \`tsconfig.json\` lacks \`noUncheckedIndexedAccess\`
- \`parseArgs\` in *src/cli.ts* does not handle \`--no-color\`
- **3 files** import each other in a cycle

\`\`\`ts
export const defaults = { color: true, retries: 3 };
\`\`\`

Want me to go ahead?`;

const FILES = ['src/cli.ts', 'src/app.ts', 'src/utils/format.ts', 'src/utils/path.ts', 'src/index.ts', 'package.json', 'README.md', 'tsconfig.json', 'test/app.test.ts', 'docs/ARCHITECTURE.md'];

export class MockRuntime implements CliRuntime {
  private listeners = new Set<Listener>();
  private st: RuntimeStatus;
  private speed: number;
  private lang: 'vi' | 'en';
  private abort = { aborted: false };
  private runPromise: Promise<void> = Promise.resolve();
  private permWaiters = new Map<string, (d: { decision: 'allow' | 'allow_session' | 'deny'; feedback?: string }) => void>();
  private askWaiters = new Map<string, (v: AskAnswer) => void>();
  private queue: string[] = [];
  private modes: PermissionMode[] = ['default', 'acceptEdits', 'plan'];
  /** Nhật ký để test kiểm tra: những gì giao diện đã gọi. */
  readonly calls: Array<{ fn: string; args: unknown[] }> = [];
  disposed = false;
  private turn = 0;

  constructor(private readonly o: MockOptions = {}) {
    this.speed = o.speed ?? 1;
    this.lang = o.lang ?? 'vi';
    this.st = {
      version: o.version ?? '0.4.0',
      cwd: o.cwd ?? 'C:\\Dev\\demo-app',
      gitBranch: o.branch ?? 'main',
      provider: 'locaith',
      model: o.model ?? 'locaith-v5-flash',
      mode: o.mode ?? 'default',
      thinking: 'medium',
      account: o.loggedIn === false ? { loggedIn: false } : { loggedIn: true, email: 'tu***@gmail.com', plan: 'Plus' },
      context: { tokens: 42_000, window: 1_000_000, percent: 4 },
      usage: { input: 0, output: 0 },
      running: false,
      queued: [],
      sessionId: newId('sess'),
      title: '',
      todos: [],
      bgTasks: { running: 0, total: 0 },
      notices: [],
    };
  }

  // ───────────── hợp đồng CliRuntime ─────────────

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  status(): RuntimeStatus {
    return { ...this.st, queued: [...this.st.queued], todos: [...this.st.todos] };
  }

  private emit(e: RuntimeEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        /* người nghe không được ném */
      }
    }
  }
  private ui(ev: UiEvent): void {
    this.emit({ t: 'ui', ev });
  }
  private pushStatus(patch: Partial<RuntimeStatus> = {}): void {
    this.st = { ...this.st, ...patch };
    this.emit({ t: 'status', status: this.status() });
  }

  async submit(text: string, opts?: { attachments?: Attachment[] }): Promise<void> {
    this.calls.push({ fn: 'submit', args: [text, opts] });
    const t = text.trim();
    if (!t) return;
    if (t.startsWith('/')) return this.slash(t);
    if (t.startsWith('!')) return this.shell(t.slice(1).trim());
    if (this.st.running) {
      this.queue.push(t);
      this.pushStatus({ queued: [...this.queue] });
      return;
    }
    this.start(t, opts?.attachments);
  }

  interrupt(): void {
    this.calls.push({ fn: 'interrupt', args: [] });
    if (!this.st.running) return;
    this.abort.aborted = true;
    for (const [id, w] of this.permWaiters) {
      this.emit({ t: 'permission_cancel', id });
      w({ decision: 'deny' });
    }
    this.permWaiters.clear();
  }

  idle(): Promise<void> {
    return this.runPromise;
  }

  respondPermission(id: string, d: { decision: 'allow' | 'allow_session' | 'deny'; feedback?: string }): void {
    this.calls.push({ fn: 'respondPermission', args: [id, d] });
    const w = this.permWaiters.get(id);
    this.permWaiters.delete(id);
    w?.(d);
  }

  answer(id: string, value: AskAnswer): void {
    this.calls.push({ fn: 'answer', args: [id, value] });
    const w = this.askWaiters.get(id);
    this.askWaiters.delete(id);
    w?.(value);
  }

  setMode(mode: PermissionMode): void {
    this.calls.push({ fn: 'setMode', args: [mode] });
    this.pushStatus({ mode });
    this.ui({ t: 'mode', mode });
  }
  cycleMode(): PermissionMode {
    const i = this.modes.indexOf(this.st.mode);
    const next = this.modes[(i + 1) % this.modes.length];
    this.calls.push({ fn: 'cycleMode', args: [] });
    this.setMode(next);
    return next;
  }
  async setModel(id: string): Promise<void> {
    this.calls.push({ fn: 'setModel', args: [id] });
    this.pushStatus({ model: id });
  }
  setThinking(level: ThinkingLevel): void {
    this.calls.push({ fn: 'setThinking', args: [level] });
    this.pushStatus({ thinking: level });
  }

  slashCommands(): SlashCommandInfo[] {
    const vi = this.lang === 'vi';
    const d = (a: string, b: string): string => (vi ? a : b);
    return [
      { name: 'help', description: d('Xem trợ giúp và phím tắt', 'Show help and shortcuts') },
      { name: 'clear', description: d('Xoá hội thoại, bắt đầu phiên mới', 'Clear the conversation and start fresh') },
      { name: 'compact', description: d('Nén ngữ cảnh (có thể kèm điều cần giữ)', 'Compact the context') },
      { name: 'context', description: d('Xem mức dùng ngữ cảnh', 'Show context usage') },
      { name: 'cost', description: d('Token và chi phí của phiên', 'Session tokens and cost') },
      { name: 'model', description: d('Chọn model', 'Pick a model') },
      { name: 'mode', description: d('Đổi chế độ quyền', 'Change permission mode') },
      { name: 'resume', description: d('Mở lại một phiên cũ', 'Resume an earlier session') },
      { name: 'rewind', description: d('Quay lại một điểm trước đó', 'Rewind to an earlier point') },
      { name: 'theme', description: d('Đổi giao diện sáng/tối', 'Switch light/dark theme') },
      { name: 'login', description: d('Đăng nhập tài khoản Locaith', 'Sign in to Locaith') },
      { name: 'doctor', description: d('Chẩn đoán cài đặt', 'Diagnose the setup') },
      { name: 'tasks', description: d('Tác vụ nền', 'Background tasks') },
      { name: 'mcp', description: d('Máy chủ MCP', 'MCP servers') },
      { name: 'memory', description: d('Ký ức dự án (LOCAITH.md)', 'Project memory (LOCAITH.md)') },
      { name: 'exit', description: d('Thoát Locaith', 'Quit Locaith') },
    ];
  }

  async complete(req: { kind: 'file' | 'slash'; query: string; limit?: number }): Promise<Completion[]> {
    this.calls.push({ fn: 'complete', args: [req] });
    if (req.kind === 'slash') return [];
    const q = req.query.toLowerCase();
    return FILES.filter((f) => f.toLowerCase().includes(q))
      .slice(0, req.limit ?? 8)
      .map((f) => ({ label: f, insert: '@' + f + ' ', detail: f.endsWith('.ts') ? 'TypeScript' : undefined }));
  }

  async sessions(): Promise<SessionSummary[]> {
    const now = Date.now();
    const mk = (i: number, title: string, mins: number, n: number): SessionSummary => ({ id: `sess_${i}abcdef`, title, updatedAt: now - mins * 60_000, provider: 'locaith', model: 'locaith-v5-flash', messageCount: n });
    return [
      mk(1, 'Sửa lỗi đăng nhập trên trang quản trị', 12, 18),
      mk(2, 'Viết test cho module thanh toán', 190, 42),
      mk(3, 'Refactor parseArgs và thêm cờ --no-color', 60 * 26, 9),
      mk(4, 'Dựng workflow GitHub Actions để phát hành', 60 * 24 * 3, 31),
      mk(5, 'Khảo sát vì sao build chậm', 60 * 24 * 9, 12),
    ];
  }

  async resume(idOrPrefix: string): Promise<void> {
    this.calls.push({ fn: 'resume', args: [idOrPrefix] });
    this.pushStatus({ sessionId: idOrPrefix, title: 'Sửa lỗi đăng nhập trên trang quản trị' });
    this.emit({ t: 'replay', items: this.sampleItems(), reason: 'resume' });
  }

  async newSession(): Promise<void> {
    this.calls.push({ fn: 'newSession', args: [] });
    this.pushStatus({ sessionId: newId('sess'), title: '', todos: [] });
    this.emit({ t: 'replay', items: [], reason: 'new' });
  }

  helpText(): string {
    return this.lang === 'vi' ? 'Gõ /help để xem trợ giúp.' : 'Type /help for help.';
  }

  async dispose(): Promise<void> {
    this.calls.push({ fn: 'dispose', args: [] });
    this.disposed = true;
    this.interrupt();
    await this.runPromise.catch(() => undefined);
  }

  // ───────────── lệnh gạch chéo ─────────────

  private async slash(line: string): Promise<void> {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd) {
      case 'help':
        this.emit({ t: 'output', kind: 'markdown', title: 'Locaith — trợ giúp', text: this.slashCommands().map((c) => `- \`/${c.name}\` — ${c.description}`).join('\n') + '\n\n**Phím tắt:** `Shift+Tab` đổi chế độ, `Esc` dừng, `Ctrl+O` mở rộng kết quả.' });
        return;
      case 'clear':
      case 'new':
        return this.newSession();
      case 'exit':
      case 'quit':
        this.emit({ t: 'action', action: 'exit' });
        return;
      case 'resume': {
        const list = await this.sessions();
        const ans = await this.askUser({
          id: newId('ask'),
          kind: 'pick',
          title: this.lang === 'vi' ? 'Mở lại phiên' : 'Resume session',
          searchable: true,
          items: list.map((s, i) => ({ id: s.id, label: s.title, detail: `${s.messageCount} tin · ${i === 0 ? '12 phút trước' : i === 1 ? '3 giờ trước' : i === 2 ? 'hôm qua' : `${i + 1} ngày trước`}`, group: i < 2 ? (this.lang === 'vi' ? 'Hôm nay' : 'Today') : this.lang === 'vi' ? 'Trước đó' : 'Earlier' })),
        });
        if (typeof ans === 'string') await this.resume(ans);
        return;
      }
      case 'model': {
        const ans = await this.askUser({
          id: newId('ask'),
          kind: 'pick',
          title: 'Model',
          items: [
            { id: 'locaith-v5-flash', label: 'locaith-v5-flash', detail: 'nhanh, giá rẻ', current: this.st.model === 'locaith-v5-flash' },
            { id: 'locaith-v5-si', label: 'locaith-v5-si', detail: 'Siêu Trí tuệ', current: this.st.model === 'locaith-v5-si' },
            { id: 'gemini-3.8-flash', label: 'gemini-3.8-flash', detail: 'Google', current: this.st.model === 'gemini-3.8-flash' },
          ],
        });
        if (typeof ans === 'string') await this.setModel(ans);
        return;
      }
      case 'compact':
        this.ui({ t: 'notice', level: 'info', text: 'Đã nén', compact: { mode: 'manual', tokensFreed: 968_000, clearedResults: 14 } });
        this.pushStatus({ context: { tokens: 31_000, window: 1_000_000, percent: 3 } });
        return;
      case 'mode':
        if (arg && (this.modes as string[]).includes(arg)) this.setMode(arg as PermissionMode);
        else this.cycleMode();
        return;
      case 'login': {
        const ok = await this.askUser({ id: newId('ask'), kind: 'confirm', title: 'Đăng xuất và đăng nhập lại?', detail: 'Tài khoản hiện tại: tu***@gmail.com', danger: true });
        this.emit({ t: 'toast', level: ok ? 'info' : 'warn', text: ok ? 'Đã mở trình duyệt để đăng nhập' : 'Đã huỷ' });
        return;
      }
      case 'rewind': {
        const ans = await this.askUser({
          id: newId('ask'),
          kind: 'pick',
          title: 'Quay lại điểm nào?',
          items: [
            { id: 'p3', label: 'Sau khi sửa src/cli.ts', detail: '2 phút trước · 1 tệp' },
            { id: 'p2', label: 'Sau khi đọc cấu hình', detail: '9 phút trước' },
            { id: 'p1', label: 'Bắt đầu phiên', detail: '20 phút trước' },
          ],
        });
        if (ans) this.emit({ t: 'toast', level: 'info', text: 'Đã quay lại ' + String(ans) });
        return;
      }
      case 'name': {
        const v = await this.askUser({ id: newId('ask'), kind: 'input', title: 'Đặt tên phiên', placeholder: 'ví dụ: sửa lỗi đăng nhập' });
        if (typeof v === 'string' && v) this.pushStatus({ title: v });
        return;
      }
      default:
        this.emit({ t: 'output', kind: 'error', text: `Không có lệnh /${cmd}. Gõ /help để xem danh sách.` });
    }
  }

  private async shell(cmd: string): Promise<void> {
    this.emit({ t: 'output', kind: 'plain', title: '$ ' + cmd, text: cmd.startsWith('git') ? 'On branch main\nnothing to commit, working tree clean' : `(giả lập) đã chạy: ${cmd}` });
  }

  // ───────────── kịch bản ─────────────

  private sleep(ms: number): Promise<void> {
    const t = ms * this.speed;
    return t <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, t));
  }

  private askUser(ask: AskRequest): Promise<AskAnswer> {
    return new Promise((res) => {
      this.askWaiters.set(ask.id, res);
      this.emit({ t: 'ask', ask });
    });
  }

  private askPermission(req: PermissionRequest): Promise<{ decision: 'allow' | 'allow_session' | 'deny'; feedback?: string }> {
    return new Promise((res) => {
      this.permWaiters.set(req.id, res);
      this.emit({ t: 'permission', request: req });
    });
  }

  private start(text: string, atts?: Attachment[]): void {
    this.abort = { aborted: false };
    // đặt cờ chạy NGAY (đồng bộ) để tin gõ tiếp theo được xếp hàng
    this.st = { ...this.st, running: true };
    const run = async (): Promise<void> => {
      let cur: string | undefined = text;
      let curAtts = atts;
      while (cur !== undefined) {
        this.pushStatus({ running: true, title: this.st.title || cur.slice(0, 50) });
        this.ui({ t: 'run_state', running: true });
        try {
          this.ui({ t: 'user', id: newId('u'), text: cur, attachments: (curAtts ?? []).map((a) => ({ kind: 'image' as const, label: a.name, mediaType: a.mediaType })), ts: Date.now() });
          await this.scenario(cur);
        } catch (e) {
          this.ui({ t: 'notice', level: 'error', text: 'Lỗi trong mock: ' + (e instanceof Error ? e.message : String(e)) });
        } finally {
          this.ui({ t: 'run_state', running: false });
          this.pushStatus({ running: false });
        }
        curAtts = undefined;
        if (this.abort.aborted || this.disposed) this.queue = [];
        cur = this.queue.shift();
        this.pushStatus({ queued: [...this.queue] });
        if (cur !== undefined) this.abort = { aborted: false };
      }
    };
    this.runPromise = run();
  }

  private async scenario(text: string): Promise<void> {
    const t = text.toLowerCase();
    this.turn++;
    if (/(quyền|permission|sửa|edit|diff|update)/.test(t)) return this.scEdit();
    if (/(bash|test|chạy|build|npm)/.test(t)) return this.scBash();
    if (/(lỗi|error|fail|crash)/.test(t)) return this.scError();
    if (/(todo|việc|kế hoạch|plan)/.test(t)) return this.scTodos();
    if (/(agent|song song)/.test(t)) return this.scAgent();
    if (/(nhiều tệp|many|read)/.test(t)) return this.scReads();
    if (/(nén|compact)/.test(t)) return this.scCompact();
    if (/(dài|long|stream)/.test(t)) return this.scLong();
    return this.scDefault();
  }

  private async streamText(id: string, text: string, chunk = 4, delay = 12): Promise<void> {
    for (let i = 0; i < text.length; i += chunk) {
      if (this.abort.aborted) return;
      this.ui({ t: 'text', id, delta: text.slice(i, i + chunk) });
      await this.sleep(delay);
    }
  }

  private begin(): string {
    const id = newId('a');
    this.ui({ t: 'assistant_start', id, provider: 'locaith', model: this.st.model, ts: Date.now() });
    return id;
  }

  private end(id: string, stop = 'end_turn', out = 480): void {
    if (this.abort.aborted) stop = 'aborted';
    this.ui({ t: 'usage', id, usage: { inputTokens: 3200, outputTokens: out } });
    this.ui({ t: 'assistant_end', id, stopReason: stop });
    this.pushStatus({ usage: { input: this.st.usage.input + 3200, output: this.st.usage.output + out }, context: { tokens: this.st.context.tokens + 3200 + out, window: 1_000_000, percent: Math.min(99, Math.round(((this.st.context.tokens + 3700) / 1_000_000) * 100)) } });
  }

  private async think(id: string, ms = 900): Promise<void> {
    const t0 = Date.now();
    this.ui({ t: 'thinking', id, delta: 'Cần xem cấu trúc dự án trước. ', ts: t0 });
    await this.sleep(ms / 2);
    this.ui({ t: 'thinking', id, delta: 'Sau đó đọc tệp cấu hình để xác định chuẩn mã.', ts: t0 + ms });
    await this.sleep(ms / 2);
  }

  private async tool(id: string, name: string, args: Record<string, unknown>, o: { ms?: number; output?: string; summary?: string; state?: 'done' | 'error'; progress?: string[]; diff?: import('../../shared/protocol').DiffInfo } = {}): Promise<void> {
    const callId = newId('c');
    this.ui({ t: 'tool_start', id, callId, name, args });
    for (const p of o.progress ?? []) {
      await this.sleep(250);
      if (this.abort.aborted) break;
      this.ui({ t: 'tool_progress', id, callId, output: p + '\n' });
    }
    await this.sleep(o.ms ?? 350);
    if (this.abort.aborted) {
      this.ui({ t: 'tool_end', id, callId, state: 'cancelled', durationMs: 100 });
      return;
    }
    this.ui({ t: 'tool_end', id, callId, state: o.state ?? 'done', summary: o.summary, output: o.output, diff: o.diff, durationMs: o.ms ?? 350 });
  }

  private reply(): string {
    return this.lang === 'vi' ? MOCK_REPLY_VI : MOCK_REPLY_EN;
  }

  private async scDefault(): Promise<void> {
    const id = this.begin();
    await this.think(id);
    await this.streamText(id, this.lang === 'vi' ? 'Để mình xem cấu trúc dự án trước.\n' : 'Let me look at the project structure first.\n');
    await this.tool(id, 'list_dir', { path: '.' }, { output: 'src\ntest\npackage.json\ntsconfig.json', summary: '4 mục' });
    await this.tool(id, 'read_file', { path: 'tsconfig.json' }, { output: '{\n  "compilerOptions": {\n    "strict": true\n  }\n}\n', summary: 'Đọc 5 dòng' });
    await this.streamText(id, '\n' + this.reply());
    this.end(id);
  }

  private async scLong(): Promise<void> {
    const id = this.begin();
    await this.streamText(id, (this.reply() + '\n\n').repeat(3), 6, 6);
    this.end(id, 'end_turn', 2400);
  }

  private async scReads(): Promise<void> {
    const id = this.begin();
    await this.streamText(id, 'Mình đọc lần lượt các tệp liên quan.\n');
    for (const f of ['src/cli.ts', 'src/app.ts', 'src/utils/format.ts', 'src/utils/path.ts', 'src/index.ts']) await this.tool(id, 'read_file', { path: f }, { ms: 120, output: 'x\n'.repeat(40) });
    await this.tool(id, 'grep', { pattern: 'parseArgs', path: 'src' }, { ms: 200, output: 'src/cli.ts:12\nsrc/app.ts:44', summary: '2 kết quả' });
    await this.streamText(id, '\nXong phần đọc: `parseArgs` được dùng ở hai nơi.');
    this.end(id);
  }

  private async scBash(): Promise<void> {
    const id = this.begin();
    await this.streamText(id, 'Chạy bộ test để xem hiện trạng.\n');
    const req: PermissionRequest = { id: newId('perm'), callId: 'x', tool: 'run_command', kind: 'command', title: 'Cho phép chạy lệnh?', command: 'npm test -- --reporter=dot', canAllowSession: true, suggest: ['run_command(npm test:*)'] };
    this.ui({ t: 'tool_start', id, callId: 'bash1', name: 'run_command', args: { command: 'npm test -- --reporter=dot' } });
    const d = await this.askPermission({ ...req, callId: 'bash1' });
    if (d.decision === 'deny' || this.abort.aborted) {
      this.ui({ t: 'tool_end', id, callId: 'bash1', state: 'denied', durationMs: 0 });
      await this.streamText(id, d.feedback ? `\nĐã hiểu, mình sẽ ${d.feedback}.` : '\nOK, mình không chạy.');
      return this.end(id);
    }
    for (const p of ['> demo-app@1.0.0 test', '> vitest run', ' RUN  v5.0.5']) {
      await this.sleep(300);
      this.ui({ t: 'tool_progress', id, callId: 'bash1', output: p + '\n' });
    }
    await this.sleep(500);
    const out = Array.from({ length: 22 }, (_, i) => (i === 10 ? ' ✗ app.test.ts > parse flags' : i === 11 ? '   AssertionError: expected 3 to be 4' : ` ✓ case ${i + 1}`)).join('\n');
    this.ui({ t: 'tool_end', id, callId: 'bash1', state: 'error', output: out + '\n\n Test Files  1 failed | 3 passed (4)\n      Tests  1 failed | 19 passed (20)', durationMs: 4200 });
    await this.streamText(id, '\nCó **1 test lỗi** trong `app.test.ts`. Mình xem lại `parseArgs`.');
    this.end(id);
  }

  private async scEdit(): Promise<void> {
    const id = this.begin();
    await this.think(id, 600);
    await this.streamText(id, 'Mình sửa `parseArgs` để nhận cờ `--no-color`.\n');
    await this.tool(id, 'read_file', { path: 'src/cli.ts' }, { output: 'a\n'.repeat(120), summary: 'Đọc 120 dòng' });
    const diff = {
      path: 'src/cli.ts',
      added: 4,
      removed: 1,
      hunks: [
        {
          oldStart: 10,
          newStart: 10,
          lines: [
            { t: ' ' as const, s: 'export function parseArgs(argv: string[]) {' },
            { t: ' ' as const, s: '  const opts = { color: true };' },
            { t: '-' as const, s: '  for (const a of argv) {' },
            { t: '+' as const, s: '  for (const a of argv.slice(2)) {' },
            { t: '+' as const, s: "    if (a === '--no-color') opts.color = false;" },
            { t: '+' as const, s: "    else if (a === '--color') opts.color = true;" },
            { t: '+' as const, s: '    // cờ không nhận ra: bỏ qua' },
            { t: ' ' as const, s: '  }' },
            { t: ' ' as const, s: '  return opts;' },
            { t: ' ' as const, s: '}' },
          ],
        },
      ],
    };
    const callId = 'edit1';
    this.ui({ t: 'tool_start', id, callId, name: 'edit_file', args: { path: 'src/cli.ts' } });
    const d = await this.askPermission({ id: newId('perm'), callId, tool: 'edit_file', kind: 'edit', title: 'Cho phép sửa src/cli.ts?', diff, canAllowSession: true, suggest: ['edit_file(src/**)'] });
    if (d.decision === 'deny' || this.abort.aborted) {
      this.ui({ t: 'tool_end', id, callId, state: 'denied', durationMs: 0 });
      await this.streamText(id, '\nĐã bỏ qua thay đổi.');
      return this.end(id);
    }
    await this.sleep(300);
    this.ui({ t: 'tool_end', id, callId, state: 'done', diff, summary: '+4 −1', durationMs: 300 });
    await this.streamText(id, '\nĐã cập nhật. Chạy lại test nhé?');
    this.end(id);
  }

  private async scError(): Promise<void> {
    const id = this.begin();
    await this.streamText(id, 'Thử tải trang tài liệu.\n');
    await this.tool(id, 'fetch_url', { url: 'https://example.invalid/docs' }, { state: 'error', output: 'getaddrinfo ENOTFOUND example.invalid\n    at GetAddrInfoReqWrap.onlookup' });
    this.ui({ t: 'notice', id, level: 'error', text: 'Không kết nối được tới cổng locaith.ai (ECONNRESET). Đang thử lại sau 4 giây…' });
    this.end(id, 'error');
  }

  private async scTodos(): Promise<void> {
    const id = this.begin();
    const mk = (n: number): TodoItem[] =>
      ['Đọc cấu hình TypeScript', 'Sửa parseArgs', 'Thêm test cho --no-color', 'Chạy lại toàn bộ test', 'Cập nhật tài liệu'].map((title, i) => ({ id: 't' + i, title, status: i < n ? 'completed' : i === n ? 'in_progress' : 'pending' }));
    for (let n = 0; n <= 3; n++) {
      if (this.abort.aborted) break;
      const todos = mk(n);
      this.ui({ t: 'tasks', id, todos, added: n === 0 ? todos.map((x) => x.title) : [] });
      this.ui({ t: 'todos', todos });
      this.pushStatus({ todos });
      await this.tool(id, 'read_file', { path: `src/step${n}.ts` }, { ms: 700, output: 'ok\n', summary: 'Đọc 1 dòng' });
    }
    await this.streamText(id, '\nXong ba bước đầu, còn chạy test và cập nhật tài liệu.');
    this.pushStatus({ todos: mk(5) });
    this.ui({ t: 'todos', todos: mk(5) });
    this.end(id);
  }

  private async scAgent(): Promise<void> {
    const id = this.begin();
    await this.streamText(id, 'Giao việc khảo sát cho một agent con.\n');
    const callId = 'ag1';
    this.ui({ t: 'tool_start', id, callId, name: 'agent', args: { description: 'khảo sát vòng import', agent_type: 'explorer' } });
    for (let i = 1; i <= 4; i++) {
      await this.sleep(500);
      if (this.abort.aborted) break;
      this.ui({ t: 'agent_progress', id, callId, tokens: 8000 * i, tools: i * 3, activity: i < 3 ? 'Đang đọc src/a.ts' : 'Đang tổng hợp' });
    }
    this.ui({ t: 'tool_end', id, callId, state: this.abort.aborted ? 'cancelled' : 'done', summary: 'Tìm thấy 3 vòng import', durationMs: 5200 });
    await this.streamText(id, '\nAgent con báo có 3 vòng import.');
    this.end(id);
  }

  private async scCompact(): Promise<void> {
    const id = this.begin();
    await this.streamText(id, 'Ngữ cảnh đã khá đầy, mình nén lại trước khi làm tiếp.\n');
    this.ui({ t: 'notice', id, level: 'info', text: 'compact', compact: { mode: 'auto', tokensFreed: 968_000, clearedResults: 31 } });
    this.ui({ t: 'notice', id, level: 'info', text: 'verify', verify: { key: 'v1', state: 'pass', round: 1, maxRounds: 3, durationMs: 8200 } });
    await this.streamText(id, '\nTiếp tục công việc.');
    this.end(id);
  }

  // ───────────── dữ liệu mẫu cho /resume ─────────────

  sampleItems(): TItem[] {
    const now = Date.now();
    const a = newId('a');
    return [
      { kind: 'user', id: newId('u'), text: 'Trang quản trị không đăng nhập được, báo lỗi 401 dù mật khẩu đúng', attachments: [], ts: now - 600_000 },
      {
        kind: 'assistant',
        id: a,
        provider: 'locaith',
        model: 'locaith-v5-flash',
        ts: now - 590_000,
        done: true,
        endedAt: now - 540_000,
        usage: { inputTokens: 5000, outputTokens: 900 },
        blocks: [
          { type: 'text', id: a + ':t0', text: 'Mình kiểm tra luồng xác thực trước.' },
          { type: 'tool', id: 'h1', name: 'read_file', args: { path: 'src/auth/login.ts' }, state: 'done', summary: 'Đọc 86 dòng', startedAt: now - 580_000 },
          { type: 'tool', id: 'h2', name: 'grep', args: { pattern: 'verifyToken', path: 'src' }, state: 'done', output: 'src/auth/token.ts:21\nsrc/middleware.ts:9', summary: '2 kết quả', startedAt: now - 575_000 },
          { type: 'text', id: a + ':t1', text: 'Nguyên nhân: `verifyToken` so sánh hạn bằng **giây** nhưng token lưu **mili-giây**. Đã sửa ở `src/auth/token.ts`.' },
        ],
      },
      { kind: 'notice', id: newId('n'), level: 'info', text: 'compact', ts: now - 500_000, compact: { mode: 'auto', tokensFreed: 120_000 } },
    ];
  }
}
