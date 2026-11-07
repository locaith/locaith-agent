/**
 * Dữ liệu mẫu cho harness: trạng thái ban đầu + kịch bản sự kiện (phát lại theo thời gian).
 * Kịch bản chính lấy từ tài liệu kiến trúc: 2 tác vụ → nạp kỹ năng artifacts → 5 lệnh tìm kiếm song song →
 * các dòng trạng thái suy nghĩ → đọc trang gốc → dựng artifact → câu trả lời có bảng + mã + văn xuôi nhiều dấu.
 */
import type {
  AttachmentInfo,
  DiffInfo,
  HostMessage,
  ModelInfo,
  PermissionRequest,
  ProviderSummary,
  SessionSummary,
  TItem,
  TodoItem,
  UiEvent,
  ViewState,
} from '../../src/shared/protocol';
import { DEFAULT_UI_SETTINGS } from '../../src/shared/protocol';

// ── nhà cung cấp & model ────────────────────────────────────────────────────

const m = (id: string, label: string, tier: ModelInfo['tier'], contextWindow: number, reasoning = true): ModelInfo => ({
  id,
  label,
  tier,
  contextWindow,
  reasoning,
});

export const PROVIDERS: ProviderSummary[] = [
  {
    id: 'anthropic',
    label: 'Claude (Anthropic)',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    hasKey: true,
    builtin: true,
    keyUrl: 'https://console.anthropic.com/settings/keys',
    modelSource: 'live',
    models: [
      m('claude-fable-5-1', 'Claude Fable 5.1', 'top', 1_000_000),
      m('claude-opus-5-5', 'Claude Opus 5.5', 'top', 1_000_000),
      m('claude-sonnet-5-5', 'Claude Sonnet 5.5', 'balanced', 1_000_000),
      m('claude-haiku-5-5', 'Claude Haiku 5.5', 'fast', 1_000_000),
    ],
  },
  {
    id: 'openai',
    label: 'ChatGPT (OpenAI)',
    kind: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    hasKey: true,
    builtin: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    modelSource: 'live',
    models: [
      m('gpt-6-astra', 'GPT-6 Astra', 'top', 1_050_000),
      m('gpt-6.1-sol', 'GPT-6.1 Sol', 'balanced', 1_050_000),
      m('gpt-6.1-terra', 'GPT-6.1 Terra', 'balanced', 1_050_000),
      m('gpt-6-luna', 'GPT-6 Luna', 'fast', 1_050_000),
    ],
  },
  {
    id: 'gemini',
    label: 'Gemini (Google)',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    hasKey: false,
    builtin: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    modelSource: 'fallback',
    models: [
      m('gemini-4-argon', 'Gemini 4 Argon', 'top', 1_000_000),
      m('gemini-3.8-flash', 'Gemini 3.8 Flash', 'balanced', 1_000_000),
      m('gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite', 'fast', 1_000_000),
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai-chat',
    baseUrl: 'https://api.deepseek.com',
    hasKey: true,
    builtin: true,
    keyUrl: 'https://platform.deepseek.com/api_keys',
    modelSource: 'fallback',
    modelError: 'Không kết nối được tới api.deepseek.com (hết thời gian chờ 5 giây).',
    models: [m('deepseek-v4-pro', 'DeepSeek V4 Pro', 'top', 1_000_000), m('deepseek-flash', 'DeepSeek V4.1 Flash', 'fast', 1_000_000)],
  },
  {
    id: 'xai',
    label: 'Grok (xAI)',
    kind: 'openai-responses',
    baseUrl: 'https://api.x.ai/v1',
    hasKey: true,
    keyFromEnv: true,
    builtin: true,
    keyUrl: 'https://console.x.ai',
    modelSource: 'cache',
    models: [
      m('grok-4.7', 'Grok 4.7', 'top', 500_000),
      m('grok-4.6', 'Grok 4.6', 'balanced', 500_000),
      m('grok-4.20-0309-non-reasoning', 'Grok 4.20 (không suy luận)', 'fast', 1_000_000, false),
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai-chat',
    baseUrl: 'https://openrouter.ai/api/v1',
    hasKey: true,
    builtin: false,
    modelSource: 'live',
    models: [m('anthropic/claude-sonnet-5-5', 'Claude Sonnet 5.5 (OpenRouter)', 'balanced', 1_000_000), m('meta-llama/llama-4-maverick', 'Llama 4 Maverick', undefined, 400_000)],
  },
];

export function noKeyProviders(): ProviderSummary[] {
  return PROVIDERS.map((p) => ({ ...p, hasKey: false, keyFromEnv: false }));
}

export const SESSIONS: SessionSummary[] = [
  { id: 's1', title: 'So sánh điểm Intelligence Index của các model AI', updatedAt: Date.now() - 4 * 60_000, provider: 'anthropic', model: 'claude-opus-5-5', messageCount: 14 },
  { id: 's2', title: 'Sửa lỗi hiển thị dấu tiếng Việt trong báo cáo PDF', updatedAt: Date.now() - 3 * 3600_000, provider: 'openai', model: 'gpt-6.1-sol', messageCount: 22 },
  { id: 's3', title: 'Viết hàm tính thuế GTGT 10% cho báo giá', updatedAt: Date.now() - 86400_000, provider: 'deepseek', model: 'deepseek-v4-pro', messageCount: 8 },
  { id: 's4', title: 'Tối ưu chuyển đổi chiến dịch Facebook tháng 10', updatedAt: Date.now() - 6 * 86400_000, provider: 'xai', model: 'grok-4.7', messageCount: 31 },
  { id: 's5', title: 'Dựng landing page cho khóa học Digital Marketing', updatedAt: Date.now() - 40 * 86400_000, provider: 'anthropic', model: 'claude-sonnet-5-5', messageCount: 47 },
];

export function baseState(over: Partial<ViewState> = {}): ViewState {
  return {
    version: '0.1.0',
    sessionId: 's1',
    title: '',
    transcript: [],
    todos: [],
    running: false,
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    mode: 'default',
    thinkingLevel: 'medium',
    providers: PROVIDERS,
    settings: { ...DEFAULT_UI_SETTINGS },
    sessions: SESSIONS,
    trash: [],
    workspace: { name: 'Extension NamDigital', folders: ['c:\\Users\\nguye\\Desktop\\Extension NamDigital'] },
    context: { usedTokens: 64_500, limitTokens: 200_000 },
    editor: { file: 'src/core/engine/engine.ts', language: 'typescript', selection: { startLine: 42, endLine: 57, chars: 612 } },
    skills: [
      { name: 'artifacts', description: 'Dựng giao diện/bảng biểu', loaded: false, source: 'builtin' },
      { name: 'web-research', description: 'Nghiên cứu web song song', loaded: false, source: 'builtin' },
    ],
    slashCommands: [
      { name: 'new', description: 'Bắt đầu cuộc trò chuyện mới' },
      { name: 'clear', description: 'Xóa cuộc trò chuyện hiện tại' },
      { name: 'compact', description: 'Nén các tin nhắn cũ để giải phóng ngữ cảnh' },
      { name: 'model', description: 'Đổi nhà cung cấp và model — ví dụ /model gpt-6-astra' },
      { name: 'mode', description: 'Đổi chế độ quyền' },
      { name: 'thinking', description: 'Đổi mức suy luận' },
      { name: 'skills', description: 'Xem các kỹ năng đang có' },
      { name: 'export', description: 'Xuất cuộc trò chuyện ra Markdown' },
      { name: 'init', description: 'Tạo tệp hướng dẫn dự án LOCAITH.md' },
      { name: 'help', description: 'Xem hướng dẫn sử dụng' },
    ],
    allowBypass: false,
    ...over,
  };
}

// ── kịch bản nghiên cứu (từ tài liệu kiến trúc) ─────────────────────────────

export interface Step {
  /** Thời điểm (ms) kể từ khi bắt đầu kịch bản; nhân với `speed` ở người chạy. */
  at: number;
  events?: UiEvent[];
  messages?: HostMessage[];
  /** Dấu mốc để dừng giữa chừng (?stop=...). */
  marker?: string;
}

export const RESEARCH_PROMPT =
  'So sánh điểm Intelligence Index của các model AI hiện nay và dựng bảng thang điểm có đánh dấu ranh giới mua được';

const TODOS_STAGE1: TodoItem[] = [
  { id: 't1', title: 'Gom điểm Intelligence Index theo model và mức thinking', status: 'in_progress' },
  { id: 't2', title: 'Dựng bảng thang điểm có đánh dấu ranh giới mua được', status: 'pending' },
];
const TODOS_STAGE2: TodoItem[] = [
  { id: 't1', title: 'Gom điểm Intelligence Index theo model và mức thinking', status: 'completed' },
  { id: 't2', title: 'Dựng bảng thang điểm có đánh dấu ranh giới mua được', status: 'in_progress' },
];
const TODOS_DONE: TodoItem[] = TODOS_STAGE2.map((t) => ({ ...t, status: 'completed' as const }));

export const FINAL_ANSWER = `Mình đã gom điểm từ **Artificial Analysis** (phiên bản chỉ số **v2** — đã thống nhất một phiên bản duy nhất để các con số cùng hệ quy chiếu) và dựng sẵn bảng thang điểm tương tác. Mở thẻ **Bảng thang điểm** phía trên để lọc theo nhà cung cấp.

## Kết quả chính

| Model | Mức suy luận | Điểm v2 | Giá / 1 triệu token | Mua được? |
|:--|:--|--:|--:|:-:|
| GPT-6 Astra | cao | **78,4** | 10 $ / 50 $ | Ngoài ngân sách |
| Claude Opus 5.5 | vừa | **76,9** | 4 $ / 20 $ | Trong ranh giới |
| Gemini 4 Argon | cao | **75,2** | 5 $ / 25 $ | Trong ranh giới |
| DeepSeek V4 Pro | vừa | **71,8** | 0,6 $ / 2,4 $ | Rất rẻ |
| Grok 4.7 | cao | **70,3** | 3 $ / 15 $ | Trong ranh giới |

> Ranh giới "mua được" được tính theo ngân sách **không quá 25 $ cho mỗi triệu token đầu ra**, quy đổi khoảng 650.000 ₫ theo tỷ giá hôm nay.

### Vì sao điểm số từng bị lệch?

Trang xếp hạng có **hai phiên bản** thang đo (v1 và v2), nên cùng một model có thể xuất hiện hai điểm khác nhau. Mình đã:

1. Kiểm tra phiên bản của từng nguồn trước khi lấy số.
2. Đọc trực tiếp trang gốc \`artificialanalysis.ai\` thay vì tin kết quả tìm kiếm đầu tiên.
3. Quy đổi mọi điểm về **v2** rồi mới xếp hạng.

- [x] Thống nhất phiên bản chỉ số
- [x] Gắn nhãn ranh giới "mua được"
- [ ] Bổ sung điểm cho các model mã nguồn mở chạy cục bộ (cần thêm dung lượng VRAM)

### Mã dựng thanh điểm

\`\`\`ts
// src/artifacts/scoreBar.ts
export function tạoThanhĐiểm(điểm: number, ranhGiới = 74): string {
  const phầnTrăm = Math.min(100, Math.max(0, điểm));
  const màu = điểm >= ranhGiới ? 'var(--nd-secondary)' : 'var(--nd-primary)';
  return \`<div class="bar" style="width:\${phầnTrăm}%;background:\${màu}"></div>\`;
}
\`\`\`

Chi tiết nằm trong [\`src/artifacts/scoreBar.ts:3\`](src/artifacts/scoreBar.ts) và tài liệu tại [Artificial Analysis](https://artificialanalysis.ai). Nếu muốn, mình có thể thêm bộ lọc theo **giá** hoặc **ngữ cảnh** — chỉ cần nói nhé.`;

function chunkText(text: string, size = 18): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export function researchScenario(opts: { id?: string; provider?: string; model?: string } = {}): { prompt: string; steps: Step[] } {
  const A = opts.id ?? 'asst_research';
  const provider = opts.provider ?? 'anthropic';
  const model = opts.model ?? 'claude-opus-5-5';
  const now = Date.now();
  const searches: { id: string; query: string; results: string }[] = [
    { id: 'c1', query: 'Artificial Analysis Intelligence Index GPT-6 Astra điểm số', results: '8 kết quả' },
    { id: 'c2', query: 'Intelligence Index Claude Opus 5.5 Sonnet 5.5 thinking', results: '7 kết quả' },
    { id: 'c3', query: 'Gemini 4 Argon vs Gemini 3.8 Flash benchmark', results: '9 kết quả' },
    { id: 'c4', query: 'DeepSeek V4.1 Pro Intelligence Index v2', results: '6 kết quả' },
    { id: 'c5', query: 'Grok 4.7 Intelligence Index reasoning effort', results: '8 kết quả' },
  ];
  const steps: Step[] = [];
  let t = 0;
  const at = (dt: number) => (t += dt);

  steps.push({
    at: at(0),
    events: [
      { t: 'user', id: 'u_research', text: RESEARCH_PROMPT, attachments: [], ts: now },
      { t: 'run_state', running: true },
      { t: 'assistant_start', id: A, provider, model, ts: now },
      { t: 'pill', id: A, pillId: 'pw0', text: 'Đang chuẩn bị…', kind: 'working' },
    ],
  });
  steps.push({
    at: at(500),
    marker: 'tasks',
    events: [
      { t: 'tasks', id: A, todos: TODOS_STAGE1, added: TODOS_STAGE1.map((x) => x.title) },
      { t: 'skill', id: A, skill: 'artifacts', unlocked: ['list_artifact_types', 'create_artifact', 'update_artifact'] },
    ],
  });
  // 5 lệnh tìm kiếm song song
  steps.push({
    at: at(450),
    marker: 'searching',
    events: searches.map<UiEvent>((s) => ({ t: 'tool_start', id: A, callId: s.id, name: 'web_search', args: { query: s.query, max_results: 8 } })),
  });
  steps.push({
    at: at(700),
    events: searches.slice(0, 3).map<UiEvent>((s, i) => ({
      t: 'tool_end',
      id: A,
      callId: s.id,
      state: 'done',
      summary: s.results,
      output: `1. ${s.query} — Artificial Analysis\n   https://artificialanalysis.ai/models\n2. Bảng xếp hạng mô hình AI tháng 10/2026\n   https://example.com/leaderboard`,
      durationMs: 1200 + i * 310,
    })),
  });
  steps.push({
    at: at(500),
    marker: 'pills',
    events: [
      { t: 'tool_end', id: A, callId: 'c4', state: 'done', summary: searches[3].results, output: 'DeepSeek V4.1 …', durationMs: 2100 },
      { t: 'tool_end', id: A, callId: 'c5', state: 'done', summary: searches[4].results, output: 'Grok 4.7 …', durationMs: 2480 },
      { t: 'pill', id: A, pillId: 'p1', text: 'Checking which index version the data came from', kind: 'thinking' },
    ],
  });
  steps.push({ at: at(900), events: [{ t: 'pill', id: A, pillId: 'p2', text: 'Reconciling conflicting index scores across versions', kind: 'thinking' }] });
  steps.push({ at: at(900), events: [{ t: 'pill', id: A, pillId: 'p3', text: 'Choosing one index version so the scores line up', kind: 'thinking' }] });
  steps.push({
    at: at(800),
    marker: 'fetch',
    events: [
      { t: 'tool_start', id: A, callId: 'c6', name: 'fetch_url', args: { url: 'https://artificialanalysis.ai/leaderboards/models' } },
      { t: 'tool_start', id: A, callId: 'c7', name: 'web_search', args: { query: 'DeepSeek V4.1 GGUF VRAM yêu cầu bộ nhớ' } },
      { t: 'tool_start', id: A, callId: 'c8', name: 'web_search', args: { query: 'Gemma 4 31B quantized RAM requirements' } },
    ],
  });
  steps.push({
    at: at(1100),
    events: [
      { t: 'tool_end', id: A, callId: 'c6', state: 'done', summary: '34 KB', output: '# Models leaderboard\nIntelligence Index v2 …', durationMs: 1830 },
      { t: 'tool_end', id: A, callId: 'c7', state: 'done', summary: '5 kết quả', output: '…', durationMs: 1400 },
      { t: 'tool_end', id: A, callId: 'c8', state: 'done', summary: '6 kết quả', output: '…', durationMs: 1650 },
      { t: 'pill', id: A, pillId: 'p4', text: 'Correcting an earlier figure after checking a newer index update', kind: 'thinking' },
      { t: 'tool_start', id: A, callId: 'c9', name: 'list_artifact_types', args: {} },
    ],
  });
  steps.push({
    at: at(500),
    events: [
      { t: 'tool_end', id: A, callId: 'c9', state: 'done', summary: '3 loại', output: 'html — Single-file HTML\ndashboard — Bảng điều khiển có SQLite\nsvg — Hình vector', durationMs: 90 },
      { t: 'pill', id: A, pillId: 'p5', text: 'Weighing a simpler single-file HTML against the Dashboard type', kind: 'thinking' },
    ],
  });
  steps.push({
    at: at(900),
    marker: 'writing',
    events: [
      { t: 'tool_start', id: A, callId: 'c10', name: 'create_artifact', args: { title: 'Bảng thang điểm Intelligence Index', type: 'html' } },
      { t: 'artifact', id: A, artifactId: 'art1', title: 'Bảng thang điểm Intelligence Index', artifactType: 'html', state: 'writing', sizeChars: 1800 },
      { t: 'pill', id: A, pillId: 'p6', text: 'Viết hàm vẽ bảng và các ô số liệu', kind: 'writing' },
    ],
  });
  steps.push({
    at: at(900),
    events: [
      { t: 'artifact', id: A, artifactId: 'art1', title: 'Bảng thang điểm Intelligence Index', artifactType: 'html', state: 'writing', sizeChars: 6200 },
      { t: 'pill', id: A, pillId: 'p7', text: 'Đang viết kiểu dáng cho bảng và thẻ.', kind: 'writing' },
    ],
  });
  steps.push({
    at: at(900),
    events: [
      { t: 'artifact', id: A, artifactId: 'art1', title: 'Bảng thang điểm Intelligence Index', artifactType: 'html', state: 'writing', sizeChars: 11800 },
      { t: 'pill', id: A, pillId: 'p8', text: 'Đang viết hàm xếp hạng và gán nhóm…', kind: 'writing' },
    ],
  });
  steps.push({
    at: at(800),
    marker: 'artifact',
    events: [
      { t: 'tool_end', id: A, callId: 'c10', state: 'done', summary: '12,4 KB', output: 'Đã tạo artifact art1', durationMs: 5200 },
      { t: 'artifact', id: A, artifactId: 'art1', title: 'Bảng thang điểm Intelligence Index', artifactType: 'html', state: 'ready', sizeChars: 12_700 },
      { t: 'todos', todos: TODOS_STAGE2 },
    ],
  });
  const chunks = chunkText(FINAL_ANSWER, 22);
  chunks.forEach((c, i) => {
    steps.push({
      at: at(i === 0 ? 400 : 28),
      marker: i === Math.floor(chunks.length * 0.45) ? 'streaming' : undefined,
      events: [{ t: 'text', id: A, delta: c }],
    });
  });
  steps.push({
    at: at(300),
    marker: 'done',
    events: [
      { t: 'usage', id: A, usage: { inputTokens: 48_210, outputTokens: 6_840, reasoningTokens: 3_100 } },
      { t: 'todos', todos: TODOS_DONE },
      { t: 'assistant_end', id: A, stopReason: 'end_turn' },
      { t: 'run_state', running: false },
    ],
  });
  return { prompt: RESEARCH_PROMPT, steps };
}

// ── câu trả lời ngắn cho tin nhắn gõ tay trong harness ───────────────────────

export function quickReply(id: string, userText: string, provider: string, model: string): Step[] {
  const answer =
    `Mình đã nhận được: “${userText.slice(0, 80)}”. Đây là câu trả lời mẫu từ **host giả lập** để thử giao diện.\n\n` +
    '```ts\nconst xinChào = (tên: string) => `Xin chào, ${tên}!`;\n```\n\nBạn có thể thử gõ `@` để nhắc tệp hoặc `/` để dùng lệnh.';
  const steps: Step[] = [
    { at: 0, events: [{ t: 'user', id: `u_${id}`, text: userText, attachments: [], ts: Date.now() }, { t: 'run_state', running: true }, { t: 'assistant_start', id, provider, model, ts: Date.now() }] },
    { at: 500, events: [{ t: 'pill', id, pillId: `${id}p`, text: 'Đang suy nghĩ về câu hỏi…', kind: 'thinking' }] },
  ];
  chunkText(answer, 14).forEach((c, i) => steps.push({ at: 900 + i * 35, events: [{ t: 'text', id, delta: c }] }));
  steps.push({
    at: 900 + chunkText(answer, 14).length * 35 + 200,
    events: [
      { t: 'usage', id, usage: { inputTokens: 1210, outputTokens: 180 } },
      { t: 'assistant_end', id, stopReason: 'end_turn' },
      { t: 'run_state', running: false },
    ],
  });
  return steps;
}

// ── các trạng thái dựng sẵn ─────────────────────────────────────────────────

const DIFF_EDIT: DiffInfo = {
  path: 'src/utils/formatMoney.ts',
  added: 9,
  removed: 3,
  hunks: [
    {
      oldStart: 12,
      newStart: 12,
      lines: [
        { t: ' ', s: '/** Định dạng tiền Việt Nam: 1.234.567 ₫ */' },
        { t: '-', s: 'export function formatMoney(n: number) {' },
        { t: '-', s: "  return n.toLocaleString('en-US') + ' VND';" },
        { t: '-', s: '}' },
        { t: '+', s: 'export function formatMoney(n: number, withVat = false): string {' },
        { t: '+', s: '  const total = withVat ? Math.round(n * 1.1) : n;' },
        { t: '+', s: "  const text = new Intl.NumberFormat('vi-VN').format(total);" },
        { t: '+', s: "  return withVat ? `${text} ₫ (đã gồm VAT 10%)` : `${text} ₫`;" },
        { t: '+', s: '}' },
        { t: ' ', s: '' },
        { t: ' ', s: 'export const VAT_RATE = 0.1;' },
        { t: '+', s: "export const VAT_LABEL = 'chưa bao gồm thuế GTGT 10%';" },
        { t: '+', s: '' },
        { t: '+', s: '// Giá luôn là con số cố định, không ghi khoảng.' },
      ],
    },
  ],
};

const permEdit: PermissionRequest = {
  id: 'perm1',
  callId: 'call_edit',
  tool: 'edit_file',
  kind: 'edit',
  title: 'Cho phép sửa src/utils/formatMoney.ts?',
  detail: 'Thay hàm formatMoney để định dạng theo vi-VN và hỗ trợ VAT.',
  diff: DIFF_EDIT,
  canAllowSession: true,
  sessionLabel: 'Cho phép sửa tệp trong phiên này',
};

const permCmd: PermissionRequest = {
  id: 'perm2',
  callId: 'call_cmd',
  tool: 'run_command',
  kind: 'command',
  title: 'Cho phép chạy lệnh này?',
  command: 'npm test -- --run src/utils/formatMoney.test.ts',
  canAllowSession: true,
  sessionLabel: 'Luôn cho phép `npm test` trong phiên này',
};

const permPlan: PermissionRequest = {
  id: 'perm3',
  callId: 'call_plan',
  tool: 'exit_plan_mode',
  kind: 'plan',
  title: 'Duyệt kế hoạch để bắt đầu thực hiện?',
  planMarkdown: `## Kế hoạch chuyển đổi định dạng tiền tệ

1. Rà soát mọi nơi đang gọi \`formatMoney\` (6 tệp).
2. Đổi sang \`Intl.NumberFormat('vi-VN')\` và thêm tham số \`withVat\`.
3. Cập nhật bộ kiểm thử trong \`src/utils/formatMoney.test.ts\`.
4. Chạy \`npm test\` và sửa các ca lỗi.

> Lưu ý: ngân sách quảng cáo trả cho Meta/Google **không xuất được hóa đơn**, chỉ phí quản trị mới có VAT.`,
  canAllowSession: false,
};

function userItem(id: string, text: string, ago = 0, attachments: AttachmentInfo[] = []): TItem {
  return { kind: 'user', id, text, attachments, ts: Date.now() - ago };
}

export function permissionState(kind: 'edit' | 'cmd' | 'plan'): ViewState {
  const req = kind === 'edit' ? permEdit : kind === 'cmd' ? permCmd : permPlan;
  const toolName = req.tool;
  const args =
    kind === 'edit'
      ? { path: 'src/utils/formatMoney.ts' }
      : kind === 'cmd'
        ? { command: req.command }
        : { plan: req.planMarkdown };
  return baseState({
    title: 'Sửa định dạng tiền tệ',
    running: true,
    mode: kind === 'plan' ? 'plan' : 'default',
    todos: [
      { id: 'a', title: 'Đọc hàm formatMoney hiện tại', status: 'completed' },
      { id: 'b', title: 'Sửa định dạng theo vi-VN và thêm VAT', status: 'in_progress' },
      { id: 'c', title: 'Chạy bộ kiểm thử', status: 'pending' },
    ],
    transcript: [
      userItem('u1', 'Sửa hàm formatMoney để hiển thị 1.234.567 ₫ và thêm tuỳ chọn VAT 10%.', 90_000, [
        { kind: 'file', label: 'formatMoney.ts', path: 'src/utils/formatMoney.ts' },
      ]),
      {
        kind: 'assistant',
        id: 'a1',
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        ts: Date.now() - 80_000,
        done: false,
        blocks: [
          { type: 'tasks', id: 'a1:task0', added: ['Đọc hàm formatMoney hiện tại', 'Sửa định dạng theo vi-VN và thêm VAT', 'Chạy bộ kiểm thử'] },
          { type: 'tool', id: 'r1', name: 'read_file', args: { path: 'src/utils/formatMoney.ts' }, state: 'done', summary: '42 dòng', output: 'export function formatMoney(n: number) {…}', startedAt: 0, durationMs: 40 },
          { type: 'text', id: 'a1:t1', text: 'Mình đã đọc xong hàm hiện tại. Giờ mình sẽ sửa để dùng `Intl.NumberFormat` theo **vi-VN** và thêm tham số `withVat`.' },
          {
            type: 'tool',
            id: req.callId,
            name: toolName,
            args,
            state: 'awaiting_permission',
            permission: req,
            startedAt: 0,
          },
        ],
      },
    ],
  });
}

export function errorState(): ViewState {
  return baseState({
    title: 'Hỏi về chiến dịch Facebook',
    transcript: [
      userItem('u1', 'Tóm tắt hiệu quả chiến dịch Facebook tháng 10 giúp mình.', 120_000),
      {
        kind: 'assistant',
        id: 'a1',
        provider: 'openai',
        model: 'gpt-6-astra',
        ts: Date.now() - 100_000,
        done: true,
        stopReason: 'error',
        blocks: [
          { type: 'pill', id: 'p1', text: 'Đang thử lại sau 4 giây (lần 2/5)', kind: 'working', active: false },
          {
            type: 'notice',
            id: 'n1',
            level: 'error',
            text: 'Máy chủ OpenAI đang quá tải (HTTP 529). Đã thử lại 5 lần nhưng chưa thành công.\nHãy thử lại sau ít phút hoặc đổi sang model khác.',
          },
        ],
      },
    ],
  });
}

export function longConversation(): ViewState {
  const longPrompt =
    'Mình có bảng báo cáo quảng cáo Facebook tháng 10/2026 của khách hàng “Công ty TNHH Thương mại & Dịch vụ Thiên Phú”. Hãy kiểm tra giúp mình:\n- chi phí trên mỗi khách hàng tiềm năng\n- chiến dịch nào đang đốt tiền\n- đề xuất phân bổ lại ngân sách tuần tới (đã bao gồm VAT 10%)';
  return baseState({
    title: 'Báo cáo quảng cáo Facebook tháng 10',
    todos: TODOS_DONE,
    mode: 'acceptEdits',
    context: { usedTokens: 181_000, limitTokens: 200_000 },
    transcript: [
      userItem('u1', longPrompt, 3600_000, [
        { kind: 'file', label: 'bao-cao-thang-10.csv', path: 'data/báo-cáo-tháng-10.csv' },
        { kind: 'selection', label: 'dòng', path: 'src/ads/phanBoNganSach.ts', range: [42, 57] },
      ]),
      {
        kind: 'assistant',
        id: 'a1',
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        ts: Date.now() - 3500_000,
        done: true,
        stopReason: 'end_turn',
        usage: { inputTokens: 38_420, outputTokens: 4_105 },
        blocks: [
          { type: 'tasks', id: 'a1:task0', added: ['Đọc báo cáo CSV và tính CPL theo chiến dịch', 'Đề xuất phân bổ lại ngân sách'] },
          { type: 'pill', id: 'p1', text: 'Đang đối chiếu số liệu giữa các cột chi phí…', kind: 'thinking', active: false },
          { type: 'pill', id: 'p2', text: 'Nhận thấy hai chiến dịch dùng cùng tệp đối tượng', kind: 'thinking', active: false },
          { type: 'pill', id: 'p3', text: 'Chọn cách tính CPL theo ngày để so sánh công bằng', kind: 'thinking', active: false },
          {
            type: 'thinking',
            id: 'k1',
            text: 'Người dùng cần biết chiến dịch nào đang đốt tiền. Mình sẽ tính CPL = chi phí / số khách tiềm năng cho từng chiến dịch, rồi so với ngưỡng 150.000 ₫.\n\nLưu ý hai chiến dịch dùng chung một tệp đối tượng nên số khách có thể bị tính trùng — cần khử trùng theo mã khách hàng trước khi chia.',
          },
          { type: 'tool', id: 'r1', name: 'read_file', args: { path: 'data/báo-cáo-tháng-10.csv' }, state: 'done', summary: '1.284 dòng', output: 'chiến_dịch,chi_phí,khách_tiềm_năng\nRemarketing 30 ngày,12.400.000,86\n…', startedAt: 0, durationMs: 62 },
          { type: 'tool', id: 'r2', name: 'grep', args: { pattern: 'đốt tiền|CPL > 150000', path: 'src' }, state: 'done', summary: '3 kết quả', output: 'src/ads/canhBao.ts:18: if (cpl > 150000) …', startedAt: 0, durationMs: 220 },
          {
            type: 'tool',
            id: 'c1',
            name: 'run_command',
            args: { command: 'node scripts/tinh-cpl.mjs data/báo-cáo-tháng-10.csv' },
            state: 'done',
            output: 'Chiến dịch                 Chi phí         Khách   CPL\nRemarketing 30 ngày      12.400.000 ₫      86   144.186 ₫\nLookalike 1%             18.950.000 ₫     312    60.737 ₫\nTệp cũ — nội dung 3      9.300.000 ₫      21   442.857 ₫\n\nHoàn tất trong 1,2 giây.',
            startedAt: 0,
            durationMs: 1200,
          },
          {
            type: 'tool',
            id: 'e1',
            name: 'edit_file',
            args: { path: 'src/ads/phanBoNganSach.ts' },
            state: 'done',
            summary: '+9 −3',
            diff: DIFF_EDIT,
            startedAt: 0,
            durationMs: 130,
          },
          {
            type: 'text',
            id: 'a1:t1',
            text: `## Kết quả kiểm tra

Chi phí trên mỗi khách hàng tiềm năng (CPL) **trung bình 98.400 ₫**, nhưng có một chiến dịch kéo số này lên rất nhiều:

| Chiến dịch | Chi phí | Khách tiềm năng | CPL |
|:--|--:|--:|--:|
| Lookalike 1% | 18.950.000 ₫ | 312 | **60.737 ₫** |
| Remarketing 30 ngày | 12.400.000 ₫ | 86 | 144.186 ₫ |
| Tệp cũ — nội dung 3 | 9.300.000 ₫ | 21 | **442.857 ₫** |

**Đề xuất tuần tới:** tạm dừng "Tệp cũ — nội dung 3", chuyển 60% ngân sách sang Lookalike 1%. Mình đã sửa \`src/ads/phanBoNganSach.ts\` để tính lại tỷ lệ phân bổ.

> Lưu ý: ngân sách trả cho Meta **không xuất được hóa đơn** mang tên Locaith AI — chỉ phí quản trị mới xuất VAT 10%.`,
          },
        ],
      },
      userItem('u2', 'Tuyệt vời! Cho mình xem lại phần đã sửa trong tệp phân bổ ngân sách nhé.', 600_000),
      {
        kind: 'assistant',
        id: 'a2',
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        ts: Date.now() - 590_000,
        done: true,
        stopReason: 'end_turn',
        usage: { inputTokens: 52_000, outputTokens: 900 },
        blocks: [
          { type: 'text', id: 'a2:t0', text: 'Đây là phần chính của hàm mới (đã bỏ comment cho gọn):\n\n```ts\nexport function phânBổNgânSách(chiếnDịch: ChiếnDịch[], tổng: number) {\n  const hiệuQuả = chiếnDịch.filter((c) => c.cpl < 100_000);\n  const trọngSố = hiệuQuả.map((c) => 1 / c.cpl);\n  const tổngTrọngSố = trọngSố.reduce((a, b) => a + b, 0);\n  return hiệuQuả.map((c, i) => ({\n    tên: c.tên,\n    ngânSách: Math.round((trọngSố[i] / tổngTrọngSố) * tổng),\n  }));\n}\n```\n\nBạn có muốn mình viết thêm bộ kiểm thử cho hàm này không?' },
        ],
      },
    ],
  });
}

export function onboardingState(): ViewState {
  return baseState({ providers: noKeyProviders(), model: '', provider: '', sessions: [], context: null, editor: null });
}

export function settingsState(withKeys: boolean): ViewState {
  return baseState({ screen: 'settings', providers: withKeys ? PROVIDERS : noKeyProviders() });
}

// ── 0.6.0: nhiều việc cùng lúc — dòng tóm tắt «N lệnh gọi công cụ» + dòng agent con sống (webview/src/styles/parallel.css) ──
import type { ABlock } from '../../src/shared/protocol';

/**
 * Một lượt đang chạy như ảnh chụp Claude Code: 80 lệnh đã xong (1 lỗi) gộp thành MỘT dòng tóm tắt, ba agent con đang chạy mỗi cái một dòng sống,
 * rồi câu dẫn của trợ lý, một khối suy nghĩ và bước hiện tại («4 lệnh gọi công cụ · 1 lỗi», lệnh cuối còn đang chạy).
 * narrow: tiêu đề/đường dẫn dài hơn và một agent có lệnh lỗi — để thử cắt chữ và xuống dòng ở bề ngang rất hẹp.
 */
export function parallelAgentsState(opts: { narrow?: boolean } = {}): ViewState {
  const now = Date.now();
  const A = 'asst_parallel';
  const kinds = ['read_file', 'grep', 'glob', 'run_command', 'read_file', 'edit_file', 'list_dir', 'web_search'] as const;
  const argsOf = (name: string, i: number): Record<string, unknown> => {
    switch (name) {
      case 'read_file':
        return { path: 'backend/app/locaith_llm/router.py' };
      case 'grep':
        return { pattern: 'locaith_queue', path: 'src' };
      case 'glob':
        return { pattern: 'src/**/*.test.ts' };
      case 'run_command':
        return { command: 'npx vitest run test/relayQueue.test.ts' };
      case 'edit_file':
        return { path: 'src/core/providers/presets.ts' };
      case 'list_dir':
        return { path: 'webview/src/components' };
      default:
        return { query: 'DeepSeek V4.1 Flash context window ' + i };
    }
  };
  const finished: ABlock[] = [];
  for (let i = 0; i < 80; i++) {
    const name = kinds[i % kinds.length];
    const failed = i === 37;
    finished.push({
      type: 'tool',
      id: 'p' + i,
      name,
      args: argsOf(name, i),
      state: failed ? 'error' : 'done',
      summary: failed ? undefined : '12 dòng',
      output: failed ? 'Lỗi: không tìm thấy chuỗi cần thay.' : 'ok',
      startedAt: now - 400_000 + i * 2000,
      durationMs: 300 + i * 7,
    });
  }
  const agent = (id: string, description: string, startedAgo: number, agentProgress: NonNullable<Extract<ABlock, { type: 'tool' }>['agent']>): ABlock => ({
    type: 'tool',
    id,
    name: 'agent',
    args: { description, prompt: 'Làm đúng phần việc được giao và báo cáo ngắn gọn, có dẫn chứng.', agent_type: 'general' },
    state: 'running',
    startedAt: now - startedAgo,
    agent: agentProgress,
  });
  const long = opts.narrow;
  const agents: ABlock[] = [
    agent('ag1', long ? 'Cổng backend cho các mô hình Locaith-v5: hàng chờ, nhật ký, tách persona' : 'Cổng backend cho các mô hình Locaith-v5', 318_000, {
      tokens: 461_400,
      tools: 12,
      activity: 'Đang đọc C:\\locaith\\locaith-ai-v2\\docs\\LOCAITH-MODELS.md',
    }),
    agent('ag2', long ? 'Tiện ích VS Code: nhà cung cấp Locaith, hàng chờ đếm ngược, thẻ đồng ý dữ liệu' : 'Tiện ích VS Code: nhà cung cấp Locaith', 295_000, {
      tokens: 591_400,
      tools: 44,
      ...(long ? { failed: 1 } : {}),
      activity: 'Đang chạy lệnh: npx vitest run test/relayQueue.test.ts test/remoteView.test.ts',
    }),
    agent('ag3', 'Kỹ năng soạn văn bản theo NĐ 30 và bộ nhớ', 244_000, {
      tokens: 489_700,
      tools: 22,
      activity: 'Đang đọc https://lsvn.vn/nhung-diem-moi-ve-quy-dinh-cong-tac-van-thu-nghi-dinh-30-2020-nd-cp.html',
    }),
  ];
  const step: ABlock[] = [
    { type: 'thinking', id: 'k1', text: 'Cần đặt trang ở #ext-browser, tái dùng khung ea-* của màn «Cho phép» và ghi đồng ý trước khi tạo mã.' },
    { type: 'tool', id: 's1', name: 'read_file', args: { path: 'src/screens/ext/ExtAuth.tsx' }, state: 'done', summary: '229 dòng', output: 'ok', startedAt: now - 9000, durationMs: 40 },
    { type: 'tool', id: 's2', name: 'grep', args: { pattern: 'readExtAuthBoot', path: 'src' }, state: 'done', summary: '3 kết quả', output: 'ok', startedAt: now - 8000, durationMs: 120 },
    { type: 'tool', id: 's3', name: 'edit_file', args: { path: 'src/App.tsx' }, state: 'error', output: 'Lỗi: không tìm thấy chuỗi cần thay.', startedAt: now - 6000, durationMs: 90 },
    { type: 'tool', id: 's4', name: 'run_command', args: { command: 'npx vitest run src/lib/extBrowserToken.test.ts' }, state: 'running', startedAt: now - 2000 },
  ];
  return baseState({
    title: 'Cổng mô hình Locaith-v5',
    running: true,
    transcript: [
      { kind: 'user', id: 'u_par', text: 'Dựng giúp mình cổng mô hình Locaith-v5, tiện ích VS Code và trang kết nối trình duyệt.', attachments: [], ts: now - 420_000 },
      {
        kind: 'assistant',
        id: A,
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        ts: now - 410_000,
        done: false,
        blocks: [
          ...finished,
          ...agents,
          { type: 'text', id: A + ':t1', text: 'Giờ mình dựng trang kết nối trình duyệt, phần nhận diện route và nối vào App.' },
          ...step,
        ],
      },
    ],
  });
}

// ── (lane:cc-timeline-ui) Dòng thời gian gọn kiểu Claude Code: tái hiện CẢ BA ảnh mẫu trong một cuộc trò chuyện ─────────────────
//    nhóm gập xanh «22 lệnh gọi công cụ» · dòng nén · nhóm đỏ «54 · 2 lỗi» + dòng agent có số · nhóm «36 · 2 lỗi» có Write/Edit/Bash ·
//    ngày mới + giờ · lượt đang chạy nền («Đang chạy Lệnh · 10 lệnh gọi công cụ / Chạy nền») · ô nhập đang chạy (đồng hồ, placeholder xếp hàng).

const GATE_TS = `/**
 * Cổng hoàn thành như một RunExtension (trước đây là khối \`completionGate\` nằm thẳng trong \`run()\`).
 * Gắn vào seams: finalize → kiểm «câu trả lời cuối có khớp việc đã làm», end → ghi trace.
 */
import type { RunExtension, RunHooks } from '../seams';
import { t } from '../strings';

export interface GateOptions {
  /** Số vòng tối đa trước khi buộc chốt. */
  maxTurns: number;
  /** Ngưỡng ký tự coi là «câu trả lời cuối» (đã có nội dung thật, không chỉ lời dẫn). */
  minAnswerChars: number;
}

const DEFAULTS: GateOptions = { maxTurns: 200, minAnswerChars: 80 };

export function gateExtension(opts: Partial<GateOptions> = {}): RunExtension {
  const o = { ...DEFAULTS, ...opts };
  return {
    name: 'gate',
    hooks(): RunHooks {
      return {
        beforeModel(ctx) {
          if (ctx.turn >= o.maxTurns) ctx.stop(t(ctx.lang, 'gate.maxTurns'));
        },
        finalize(ctx) {
          if (ctx.answer.length < o.minAnswerChars && ctx.pendingTodos > 0) ctx.reject(t(ctx.lang, 'gate.unfinished'));
        },
      };
    },
  };
}
`;

const REGISTRY_TS = `/**
 * Đăng ký các RunExtension DÙNG CHUNG mọi bề mặt (VS Code, Chrome, CLI, agent con): không phụ thuộc môi trường.
 * Extension chỉ-VS-Code nằm ở src/host/hostExtensions.ts.
 */
import type { RunExtension } from '../seams';
import { gateExtension } from './gate';

export function coreExtensions(): RunExtension[] {
  return [gateExtension()];
}
`;

/** Khối lệnh shell với mô tả do model đặt, IN/OUT thật (đầu ra dài để thử cắt + mờ dần). */
function cmd(id: string, startedAt: number, description: string, command: string, output: string, extra: Partial<Extract<ABlock, { type: 'tool' }>> = {}): ABlock {
  return { type: 'tool', id, name: 'run_command', args: { command, description }, state: 'done', output, startedAt, durationMs: 1800, ...extra };
}

export function ccTimelineState(opts: { working?: boolean } = {}): ViewState {
  const now = Date.now();
  const d = new Date(now);
  const today = (h: number, m: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
  const yesterday = (h: number, m: number) => today(h, m) - 86_400_000;
  const img = (n: number): AttachmentInfo => ({ kind: 'image', label: 'image.png', mediaType: 'image/png', sizeBytes: 180_000 + n * 11_000 });
  const T1 = today(17, 52);
  const T2 = today(18, 16);
  const T3 = today(18, 29);
  const reads = (prefix: string, from: number, n: number, failAt: number[] = []): ABlock[] =>
    Array.from({ length: n }, (_, i) => {
      const kind = i % 3 === 0 ? 'read_file' : i % 3 === 1 ? 'grep' : 'glob';
      const args = kind === 'read_file' ? { path: `src/core/engine/${['engine', 'seams', 'completion', 'dispatcher'][i % 4]}.ts` } : kind === 'grep' ? { pattern: ['completionGate', 'RunExtension', 'registerSlash'][i % 3], path: 'src' } : { pattern: 'src/**/*.ts' };
      const failed = failAt.includes(i);
      return { type: 'tool', id: `${prefix}${i}`, name: kind, args, state: failed ? 'error' : 'done', summary: failed ? undefined : kind === 'read_file' ? `${120 + i * 7} dòng` : `${3 + (i % 5)} kết quả`, output: failed ? 'Lỗi: không tìm thấy tệp src/core/engine/dispatcher.ts (đã bị đổi tên ở 0.6.30).' : 'ok', startedAt: from + i * 2500, durationMs: 120 + i * 9 } as ABlock;
    });
  const live: ABlock[] = [
    ...reads('L', now - 60_000, 9),
    { type: 'tool', id: 'Lbg', name: 'run_command', args: { command: 'npx vitest run --no-file-parallelism', description: 'Chạy toàn bộ bộ kiểm thử', run_in_background: true }, state: 'running', output: '', startedAt: now - 8000 },
  ];
  if (opts.working) live[live.length - 1] = { ...(live[live.length - 1] as Extract<ABlock, { type: 'tool' }>), state: 'done', output: 'Test Files  118 passed (118)\nTests  1.642 passed (1.642)', durationMs: 7800 };
  return baseState({
    title: 'Phiên locaith-ai-sao-luu.json dở dang',
    running: true,
    canQueue: true,
    mode: 'bypass',
    allowBypass: true,
    thinkingLevel: 'max',
    context: { usedTokens: 412_000, limitTokens: 1_000_000 },
    remote: { enabled: true, signedIn: true, relay: 'online', devices: 1, streams: 1 },
    transcript: [
      { kind: 'user', id: 'u0', text: '"locaith-ai-sao-luu-em-day-san-pham-extension-chrome-len-kho-2026-11-06.json" thằng Locaith-v5-flash vừa cải thiện rất nhiều thứ cho anh, em kiểm lại và cập nhật hết cho anh nhé.', attachments: [], ts: yesterday(1, 27) },
      {
        kind: 'assistant',
        id: 'a0',
        provider: 'locaith',
        model: 'locaith-v5-flash',
        ts: yesterday(1, 27) + 4000,
        done: true,
        stopReason: 'end_turn',
        endedAt: yesterday(1, 29),
        blocks: [{ type: 'text', id: 'a0:t', text: 'Em chưa tự thử trên điện thoại thật. Nếu anh thử mà vẫn không vào, nhắn em chi tiết màn hình hiện gì.' }],
      },
      { kind: 'notice', id: 'n0', level: 'info', text: 'Nghỉ 1 ngày 16 giờ. Bộ nhớ đệm prompt có thể đã hết hạn, nên tin kế tiếp sẽ nạp lại khoảng 895k token.', ts: today(17, 51) },
      { kind: 'user', id: 'u1', text: 'đọc hết lịch sử phần này và xem các vấn đề mà thằng Locaith nó không làm được cho cái extension vscode để được như extension claude code, em làm full hết lại cho anh để được như claude code nhé.', attachments: [img(1)], ts: T1 },
      {
        kind: 'assistant',
        id: 'a1',
        provider: 'locaith',
        model: 'locaith-v5-flash',
        ts: T1 + 2000,
        done: true,
        stopReason: 'end_turn',
        endedAt: T2,
        usage: { inputTokens: 212_000, outputTokens: 9_400 },
        blocks: [
          { type: 'thinking', id: 'a1:k', text: 'Cần xem phiên bản hiện tại, CHANGELOG và các repo phát hành trước khi chạm vào mã. Sau đó so với danh sách tính năng của Claude Code.', startedAt: T1 + 2000, durationMs: 14_000 },
          cmd('a1:c0', T1 + 16_000, 'Xem phiên bản hiện tại của extension, CHANGELOG và các repo phát hành', 'cd /c/locaith/extension/locaith-agent-vscode/locaith-extension-main && grep -m1 \'"version"\' package.json && head -20 CHANGELOG.md', '    "version": "0.6.30",\n# Changelog\n\n## 0.6.30 — 2026-11-06\n- no full row fills, paths with spaces open, artifact in browser\n- compact threshold setting\n\n## 0.6.29 — 2026-11-05\n- clarify at the start never after the work; loop budget 200 turns'),
          { type: 'thinking', id: 'a1:k2', text: 'Ghi nhớ mới và repo phát hành nằm ở C:\\locaith-agent-repo.', startedAt: T1 + 20_000, durationMs: 3_000 },
          cmd('a1:c1', T1 + 24_000, 'Xem ghi nhớ mới và repo phát hành mới C:\\locaith-agent-repo', 'cd /c/Users/PC_WORK/.claude/projects/c--locaith/memory && ls -lt --time-style=+%m-%d_%H:%M | head', 'total 260\n-rw-r--r-- 1 PC_WORK 197121 80936 11-06_07:16 daily-column-sandbox-limits.md\n-rw-r--r-- 1 PC_WORK 197121 12798 11-06_01:41 locaith-agent-vscode-release.md\n-rw-r--r-- 1 PC_WORK 197121  7733 11-06_00:12 locaith-remote-account-trust.md\n-rw-r--r-- 1 PC_WORK 197121  6012 11-05_21:40 locaith-v5-flash-error-catalog.md'),
          ...reads('a1:r', T1 + 30_000, 20),
          { type: 'text', id: 'a1:t', text: 'Giờ mình viết gate extension và hai registry (chỉ tệp mới, chưa đụng hub).' },
        ],
      },
      { kind: 'notice', id: 'n1', level: 'info', text: 'Đã nén cuộc trò chuyện · tự động · giải phóng 968k token', ts: T2 + 30_000, compact: { mode: 'auto', tokensFreed: 968_000, summarizedMessages: 41, clearedResults: 12, summary: 'Đã đọc: engine.ts, seams.ts, completion.ts, CHANGELOG.md. Đang làm: tách completionGate thành RunExtension, đăng ký coreExtensions() và hostExtensions(). Còn lại: vá run() theo cấp mô hình, bọc thử lại, chạy test.' } },
      {
        kind: 'assistant',
        id: 'a2',
        provider: 'locaith',
        model: 'locaith-v5-flash',
        ts: T2 + 40_000,
        done: true,
        stopReason: 'end_turn',
        endedAt: T3,
        blocks: [
          ...reads('a2:r', T2 + 41_000, 53, [17, 40]),
          { type: 'tool', id: 'a2:ag', name: 'agent', args: { description: 'Hoàn thiện 0.6.31 dở dang của Locaith: Monitoring: Wait for test run, then package', prompt: 'Chạy test, đóng gói, báo cáo.', agent_type: 'general' }, state: 'done', startedAt: T2 + 60_000, durationMs: 2_394_000, agent: { tokens: 654_900, tools: 249 }, output: 'Đã chạy 249 lệnh; bộ kiểm thử xanh; VSIX 0.6.31 đã đóng gói.' },
          { type: 'text', id: 'a2:t', text: 'Giờ mình viết gate extension và hai registry (chỉ tệp mới, chưa đụng hub).' },
        ],
      },
      {
        kind: 'assistant',
        id: 'a3',
        provider: 'locaith',
        model: 'locaith-v5-flash',
        ts: T3 + 5000,
        done: true,
        stopReason: 'end_turn',
        endedAt: today(18, 41),
        blocks: [
          ...reads('a3:r', T3 + 6000, 31, [4]),
          { type: 'tool', id: 'a3:w1', name: 'write_file', args: { path: 'src/core/engine/extensions/gate.ts', content: GATE_TS }, state: 'done', summary: '58 dòng', diff: { path: 'src/core/engine/extensions/gate.ts', added: 58, removed: 0, hunks: [], isNew: true }, startedAt: T3 + 90_000, durationMs: 60 },
          { type: 'tool', id: 'a3:w2', name: 'write_file', args: { path: 'src/core/engine/extensions/index.ts', content: REGISTRY_TS }, state: 'done', summary: '23 dòng', diff: { path: 'src/core/engine/extensions/index.ts', added: 23, removed: 0, hunks: [], isNew: true }, startedAt: T3 + 92_000, durationMs: 40 },
          { type: 'tool', id: 'a3:e1', name: 'edit_file', args: { path: 'src/utils/formatMoney.ts' }, state: 'done', summary: '+9 −3', diff: DIFF_EDIT, startedAt: T3 + 95_000, durationMs: 130 },
          cmd('a3:c1', T3 + 100_000, 'Chạy typecheck ba tsconfig', 'npm run typecheck', '> tsc -p tsconfig.json && tsc -p webview/tsconfig.json && tsc -p tsconfig.browser.json\n\nsrc/core/engine/extensions/gate.ts(31,11): error TS2339: Property \'reject\' does not exist on type \'FinalizeContext\'.\nsrc/core/engine/extensions/gate.ts(27,32): error TS2339: Property \'stop\' does not exist on type \'BeforeModelContext\'.', { state: 'error', durationMs: 6200 }),
          cmd('a3:c2', T3 + 110_000, 'Chạy lại typecheck sau khi sửa', 'npm run typecheck', '> tsc -p tsconfig.json && tsc -p webview/tsconfig.json && tsc -p tsconfig.browser.json\n', { durationMs: 5900 }),
          { type: 'text', id: 'a3:t', text: 'Giờ vá phần run: cấp mô hình theo giai đoạn và bọc thử lại.' },
        ],
      },
      {
        kind: 'assistant',
        id: 'a4',
        provider: 'locaith',
        model: 'locaith-v5-flash',
        ts: now - 62_000,
        done: false,
        blocks: live,
      },
    ],
  });
}

// ── Mô hình Locaith (AI Local): hàng chờ khi đông người dùng, thẻ thông báo dữ liệu, mục Cài đặt ─────────────────────

export const LOCAITH_PROVIDER: ProviderSummary = {
  id: 'locaith',
  label: 'Locaith AI Local',
  kind: 'openai-chat',
  baseUrl: 'https://studio-api.locaith.com/api/llm/v1',
  hasKey: true,
  builtin: true,
  account: true,
  needsConsent: false,
  modelSource: 'live',
  models: [m('locaith-v5-flash', 'Locaith-v5-flash', 'fast', 1_000_000), m('locaith-v5-si', 'Locaith-v5-SI', 'top', 1_000_000)],
};

export interface LocaithSceneOptions {
  /** Đã đồng ý thông báo dữ liệu. */
  accepted?: boolean;
  /** Thẻ thông báo đang mở trong khung chat. */
  card?: boolean;
  saving?: boolean;
  error?: string;
  outdated?: boolean;
  /** Có cuộc trò chuyện sẵn (mặc định: chưa có — màn chào). */
  conversation?: boolean;
  screen?: ViewState['screen'];
  /** Đang xếp hàng: số giây còn lại tới lần hỏi lại, và tổng thời gian chờ. */
  queue?: { position: number; attempt: number; leftSec: number; waitSec: number; limit?: number };
}

export function locaithState(o: LocaithSceneOptions = {}): ViewState {
  const now = Date.now();
  const base = o.conversation ? longConversation() : baseState();
  return {
    ...base,
    ...(o.screen ? { screen: o.screen } : {}),
    provider: 'locaith',
    model: 'locaith-v5-flash',
    providers: [{ ...LOCAITH_PROVIDER, needsConsent: !o.accepted }, ...PROVIDERS],
    context: { usedTokens: o.conversation ? 128_400 : 0, limitTokens: 1_000_000 },
    account: { status: 'signedIn', user: { name: 'Nguyễn Tuấn Anh', email: 'tuananh@locaith.ai' }, webUrl: 'https://locaith.ai' },
    locaith: {
      noticeVersion: 1,
      accepted: !!o.accepted,
      card: !!o.card,
      ...(o.saving ? { saving: true } : {}),
      ...(o.error ? { error: o.error } : {}),
      ...(o.outdated ? { outdated: true } : {}),
    },
    ...(o.queue
      ? { modelQueue: { position: o.queue.position, ahead: o.queue.position - 1, attempt: o.queue.attempt, retryAt: now + o.queue.leftSec * 1000 - 400, waitMs: o.queue.waitSec * 1000, since: now - 38_000, limit: o.queue.limit, active: o.queue.limit, waiting: 23 } }
      : {}),
  };
}

// ── (lane:output-timeouts) câu trả lời bị cắt ở ranh giới câu + nút «Chạy tiếp phần 2» ──
export function cutContinueState(opts: { forced?: boolean } = {}): ViewState {
  const answer =
    '## Báo cáo hiệu quả quảng cáo tháng 10\n\n' +
    'Tổng chi 184,2 triệu ₫ cho 6 chiến dịch, thu về 1.912 khách hàng tiềm năng — CPL trung bình **96.300 ₫**, tốt hơn tháng 9 (112.000 ₫).\n\n' +
    '### 1. Chiến dịch đang đốt tiền\n\n' +
    '| Chiến dịch | Chi | CPL |\n|---|---|---|\n| Retarget 30 ngày | 41,0 tr | 201.000 ₫ |\n| Lookalike 1% | 22,5 tr | 88.000 ₫ |\n\n' +
    'Retarget 30 ngày trùng 68% đối tượng với Lookalike 1% nên hai chiến dịch tự đấu giá với nhau.\n\n' +
    '### 2. Đề xuất phân bổ tuần tới\n\n- Tạm dừng Retarget 30 ngày, chuyển 30 triệu sang Lookalike 1%.\n- Giữ nguyên ba chiến dịch tìm kiếm mới.';
  return baseState({
    title: 'Báo cáo quảng cáo Facebook tháng 10',
    options: opts.forced
      ? [{ id: 'continue-work', kind: 'continue', label: 'Chạy tiếp', prompt: 'Tiếp tục đúng việc đang dở…' }]
      : [{ id: 'continue-part-2', kind: 'continue', label: 'Chạy tiếp phần 2', prompt: 'Viết tiếp phần 2 từ đúng chỗ vừa dừng: không lặp lại phần trước, không mở đầu lại, không tóm tắt lại.' }],
    transcript: [
      userItem('u1', 'Viết báo cáo đầy đủ về hiệu quả quảng cáo tháng 10 (kèm VAT 10%).', 95_000),
      {
        kind: 'assistant',
        id: 'a1',
        provider: 'locaith',
        model: 'locaith-v5-flash',
        ts: Date.now() - 90_000,
        done: true,
        stopReason: 'end_turn',
        usage: { inputTokens: 12_400, outputTokens: 32_000 },
        endedAt: Date.now() - 4_000,
        blocks: opts.forced
          ? [
              { type: 'text', id: 'a1:t0', text: answer },
              {
                type: 'notice',
                id: 'a1:n0',
                level: 'warn',
                text: 'Model vẫn không phản hồi sau 45 giây ở lần thử lại. Đã giữ phần đã viết và dừng lượt — đây là lỗi phía máy chủ/model, không phải lỗi của bạn.\nĐã dừng vì model không phản hồi.\n• Đã làm: chưa có thay đổi nào được ghi lại (chưa sửa tệp, chưa chạy lệnh).\n• Còn lại: không còn việc nào trong danh sách.\n• Chạy tiếp: bấm «Chạy tiếp» bên dưới hoặc nhắn "tiếp tục" — trợ lý làm nốt từ đúng chỗ dừng.',
              },
            ]
          : [
              { type: 'text', id: 'a1:t0', text: `${answer}\n\n[tiếp phần 2]\n\n` },
              { type: 'notice', id: 'a1:n0', level: 'info', text: 'Câu trả lời dài hơn trần đầu ra nên đã cắt ở ranh giới câu. Bấm «Chạy tiếp phần 2» để viết tiếp.' },
            ],
      },
    ],
  });
}

// ── (lane:blind-verifier) Kiểm tra độc lập: lượt đã xong có dòng «Kiểm tra độc lập» (đạt / cần sửa / tồn đọng / đang chạy) ──
export function verifyScene(kind: 'pass' | 'fail' | 'outstanding' | 'running' | 'skipped' = 'fail'): ViewState {
  const A = 'a_v1';
  const running = kind === 'running';
  const verify: TItem[] = [
    userItem('u1', 'Thêm hàm formatMoney(vi-VN, có VAT) vào src/utils/formatMoney.ts, viết test và chạy test cho mình.', 200_000),
    {
      kind: 'assistant',
      id: A,
      provider: 'locaith',
      model: 'locaith-v5-flash',
      ts: Date.now() - 190_000,
      done: !running,
      endedAt: running ? undefined : Date.now() - 20_000,
      stopReason: running ? undefined : 'end_turn',
      blocks: [
        { type: 'tool', id: 'r1', name: 'read_file', args: { path: 'src/utils/formatMoney.ts' }, state: 'done', summary: '42 dòng', startedAt: Date.now() - 180_000, durationMs: 40 },
        { type: 'tool', id: 'e1', name: 'edit_file', args: { path: 'src/utils/formatMoney.ts' }, state: 'done', summary: '+9 −3', startedAt: Date.now() - 170_000, durationMs: 120, diff: DIFF_EDIT },
        { type: 'tool', id: 'w1', name: 'write_file', args: { path: 'src/utils/formatMoney.test.ts' }, state: 'done', summary: '+18', startedAt: Date.now() - 160_000, durationMs: 90 },
        { type: 'tool', id: 'c1', name: 'run_command', args: { command: 'npx vitest run src/utils/formatMoney.test.ts' }, state: 'done', summary: 'thành công', output: ' ✓ src/utils/formatMoney.test.ts (3)\n Test Files  1 passed (1)\n      Tests  3 passed (3)', startedAt: Date.now() - 150_000, durationMs: 4200 },
        { type: 'text', id: 't1', text: 'Đã thêm `formatMoney` (định dạng `vi-VN`, tuỳ chọn VAT 10 %) và 3 test; `vitest` chạy xanh.' },
        kind === 'running'
          ? { type: 'notice', id: 'n1', level: 'info', text: 'Kiểm tra độc lập: đang chạy (vòng 1/2)', verify: { key: 'v1', state: 'running', round: 1, maxRounds: 2 } }
          : kind === 'pass'
            ? { type: 'notice', id: 'n1', level: 'info', text: 'Đã kiểm tra độc lập: đạt', verify: { key: 'v1', state: 'pass', round: 1, maxRounds: 2, durationMs: 38_000, model: 'locaith-v5-flash', tokens: 6400 } }
            : kind === 'skipped'
              ? { type: 'notice', id: 'n1', level: 'info', text: 'Không kiểm tra độc lập được: quá 4 phút', verify: { key: 'v1', state: 'skipped', round: 1, maxRounds: 2, reason: 'quá 4 phút', durationMs: 240_000 } }
              : {
                  type: 'notice',
                  id: 'n1',
                  level: 'warn',
                  text: 'Kiểm tra độc lập: 3 điểm cần sửa',
                  verify: {
                    key: 'v1',
                    state: 'fail',
                    round: kind === 'outstanding' ? 2 : 1,
                    maxRounds: 2,
                    missing: ['Yêu cầu "có VAT" chưa có test: src/utils/formatMoney.test.ts chỉ kiểm tra 3 trường hợp không VAT (dòng 4–18).'],
                    defects: ['formatMoney(1234.5, { vat: true }) trả về "1.357 ₫" thay vì "1.358 ₫" — làm tròn trước khi cộng VAT (src/utils/formatMoney.ts:21).'],
                    unverifiedClaims: ['Câu trả lời nói "vitest chạy xanh" nhưng lệnh đã chạy chỉ gồm tệp test mới, chưa chạy toàn bộ bộ test (npx vitest run).'],
                    ...(kind === 'outstanding' ? { outstanding: true } : {}),
                    durationMs: 52_000,
                    model: 'locaith-v5-flash',
                    tokens: 9100,
                  },
                },
      ],
    },
  ];
  return baseState({ title: 'Thêm formatMoney có VAT', transcript: verify, running, provider: 'anthropic', model: 'claude-sonnet-5-5' });
}
