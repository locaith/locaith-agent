/**
 * Nhà cung cấp DEMO: chạy hoàn toàn offline theo kịch bản có sẵn, không cần API key.
 *
 * Mục đích: (1) người dùng thử giao diện và quy trình agent ngay lần đầu mở extension;
 * (2) kiểm thử đầu-cuối vòng lặp engine thật (công cụ thật, kỹ năng thật, artifact thật) mà không tốn tiền.
 * Kịch bản mô phỏng đúng tài liệu kiến trúc: kế hoạch → nạp kỹ năng → công cụ → dòng trạng thái → artifact → câu trả lời.
 */

import {
  type ChatMessage,
  type CompleteRequest,
  type ContentBlock,
  type LLMProvider,
  type ModelInfo,
  type ProviderCapabilities,
  type ProviderEvent,
  type StreamRequest,
  type Usage,
} from '../types';

export const DEMO_PROVIDER_ID = 'demo';
export const DEMO_MODELS: ModelInfo[] = [
  { id: 'demo-1', label: 'Demo — kịch bản mẫu', tier: 'top', contextWindow: 200_000, reasoning: true },
];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const THINKING_PILLS = [
  'Đang đối chiếu điểm số giữa các phiên bản bảng xếp hạng',
  'Đang chọn một phiên bản chỉ số thống nhất để so sánh',
  'Đang quy đổi số liệu về cùng một hệ quy chiếu',
  'Đang cân nhắc định dạng phù hợp với dữ liệu thực tế',
];
const WRITING_PILLS = [
  'Đang viết hàm vẽ bảng và các ô số liệu',
  'Đang viết kiểu dáng cho bảng và thẻ',
  'Đang viết hàm lọc và gán nhóm cho từng dòng',
];

const THINK_PLAN =
  'Yêu cầu này cần nhiều bước: gom số liệu, đối chiếu giữa các nguồn, rồi dựng bảng trực quan. ' +
  'Trước hết nên lập danh sách tác vụ để giữ mục tiêu xuyên suốt, vì sau đó còn nhiều lần tra cứu và dựng giao diện. ' +
  'Dữ liệu cần có ba nhóm: điểm tổng hợp theo từng model, mức chi phí vận hành, và ranh giới "mua được" để đánh dấu trên bảng. ' +
  'Điểm cần cẩn thận là các nguồn thường dùng nhiều phiên bản thang đo khác nhau nên số liệu dễ lệch nhau; ' +
  'tôi sẽ phải chọn một phiên bản duy nhất và quy đổi tất cả về đó trước khi vẽ bảng. ' +
  'Sau khi có dữ liệu chuẩn hoá, tôi sẽ nạp kỹ năng dựng artifact để đọc tiêu chuẩn thiết kế thay vì tự đoán, ' +
  'rồi cân nhắc giữa một trang HTML một tệp và một tài liệu Markdown thuần. ' +
  'Một điều nữa cần để ý là số lượng model rất nhiều nên nếu liệt kê hết thì bảng sẽ quá dài; hợp lý hơn là gom theo nhóm triển khai (đám mây, chạy cục bộ, giá rẻ) ' +
  'và cho phép lọc nhanh bằng các chip. Khi đối chiếu cần nhớ rằng cùng một model có thể có điểm khác nhau tuỳ cấu hình suy luận, ' +
  'vì vậy phải ghi rõ mức cấu hình đã dùng trong chú thích. Cuối cùng là kiểm tra lại các con số sau khi quy đổi để chắc chắn thứ hạng không bị đảo.';
const THINK_SKILL =
  'Danh sách tác vụ đã có. Bước tiếp theo là nạp kỹ năng artifacts để biết giới hạn của khung xem trước: ' +
  'không được gọi mạng, không dùng ảnh ngoài, font đã được nạp sẵn. Song song, ghi lại số liệu đã chuẩn hoá vào scratchpad ' +
  'để không bị mất khi ngữ cảnh dài ra. Hai việc này độc lập nên có thể phát lệnh cùng một lượt. ';
const THINK_TYPES =
  'Đã đọc hướng dẫn thiết kế. Tôi cần xem đặc tả từng loại artifact trước khi chọn: loại HTML cho phép thanh điểm tuỳ biến cao, ' +
  'chip lọc và đánh dấu ranh giới, còn Markdown thì không có tương tác. Dữ liệu này cần thanh điểm màu theo nhóm và bộ lọc nên HTML một tệp là hợp lý hơn. ' +
  'Cần lưu ý giới hạn của khung xem trước: không có mạng, không có lưu trữ cục bộ, nên toàn bộ dữ liệu phải nhúng sẵn trong tệp và mọi tương tác chạy bằng JavaScript thuần. ' +
  'Tôi cũng cân nhắc loại SVG nhưng nó chỉ phù hợp với hình tĩnh, không có bộ lọc hay sắp xếp theo cột, nên không đáp ứng được yêu cầu của người dùng. ' +
  'Với tài liệu Markdown thì dễ sao chép nhưng không đánh dấu được ranh giới bằng hình ảnh, vì vậy loại HTML vẫn là phương án phù hợp nhất cho bài toán này.';
const THINK_BUILD =
  'Chọn HTML một tệp. Cấu trúc: một mảng dữ liệu nhúng sẵn ở đầu script, hàm render dựng từng dòng bảng với thanh điểm, ' +
  'chip lọc theo nhóm, và một vạch đánh dấu ranh giới mua được. Màu thanh điểm theo nhóm, chữ có độ tương phản đủ, ' +
  'hỗ trợ cả giao diện sáng và tối. Đặt line-height từ 1.5 trở lên để dấu tiếng Việt không bị cắt. Bây giờ viết toàn bộ tệp trong một lần gọi. ' +
  'Phần dữ liệu đặt ở đầu thẻ script để dễ chỉnh sửa về sau; hàm lọc nhận tên nhóm và vẽ lại danh sách đã sắp xếp theo điểm giảm dần; ' +
  'thanh điểm dùng gradient từ tím sang mint theo bảng màu thương hiệu, còn vạch ranh giới dùng màu đỏ để nổi bật trên cả hai giao diện. ' +
  'Số điểm hiển thị theo định dạng Việt Nam bằng Intl.NumberFormat, và có trạng thái rỗng khi bộ lọc không còn dòng nào. ' +
  'Cuối cùng thêm phần chú thích nguồn dữ liệu ở chân trang để người đọc biết đây là số liệu mẫu và hiểu cách đọc vạch ranh giới.';

/** Trang HTML mẫu (dữ liệu minh hoạ, không phải số liệu thật). */
const DEMO_HTML = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bảng thang điểm minh hoạ</title>
<style>
  :root { --bg:#ffffff; --fg:#1f1d2b; --muted:#6b6880; --line:#e6e3f3; --brand:#5138ee; --mint:#02ebad; --card:#f7f5ff; --cut:#e5484d; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14121c; --fg:#ece9f7; --muted:#a7a3bd; --line:#2b2840; --card:#1c1a2a; --brand:#a89bff; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:28px 24px 48px; background:var(--bg); color:var(--fg); font-family:'Be Vietnam Pro',system-ui,sans-serif; font-size:15px; line-height:1.65; }
  main { max-width: 880px; margin: 0 auto; }
  h1 { font-size: 26px; line-height: 1.3; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 20px; }
  .chips { display:flex; flex-wrap:wrap; gap:8px; margin: 0 0 18px; }
  .chip { border:1px solid var(--line); background:var(--card); color:var(--fg); padding:6px 14px; border-radius:999px; cursor:pointer; font:inherit; line-height:1.5; }
  .chip[aria-pressed="true"] { background:var(--brand); border-color:var(--brand); color:#fff; }
  .row { display:grid; grid-template-columns: 170px 1fr 70px; gap:14px; align-items:center; padding:10px 0; border-bottom:1px solid var(--line); }
  .name { font-weight:600; }
  .tag { display:block; font-weight:400; font-size:12.5px; color:var(--muted); }
  .bar { position:relative; height:14px; border-radius:7px; background:var(--card); overflow:visible; }
  .fill { height:100%; border-radius:7px; background:linear-gradient(115deg,#5138ee,#02ebad); }
  .cut { position:absolute; top:-5px; bottom:-5px; width:2px; background:var(--cut); }
  .cutlabel { position:absolute; top:-26px; transform:translateX(-50%); font-size:12px; color:var(--cut); white-space:nowrap; }
  .score { font-weight:700; text-align:right; font-variant-numeric: tabular-nums; }
  .legend { margin-top: 36px; color:var(--muted); font-size:13px; }
  .empty { padding:24px 0; color:var(--muted); }
  @media (max-width: 560px) { .row { grid-template-columns: 1fr 56px; } .bar { grid-column: 1 / -1; order: 3; } }
</style>
</head>
<body>
<main>
  <h1>Bảng thang điểm minh hoạ</h1>
  <p class="sub">Số liệu giả lập để thử giao diện — không phải dữ liệu thật.</p>
  <div class="chips" id="chips" role="group" aria-label="Lọc theo nhóm"></div>
  <div id="list"></div>
  <p class="legend">Vạch đỏ: ranh giới "mua được" (65 điểm). Nguồn: dữ liệu mẫu của chế độ demo, tạo ngày hôm nay.</p>
</main>
<script>
  const DATA = [
    { name: 'Mô hình Alpha', tag: 'Đóng nguồn · đám mây', group: 'Đám mây', score: 82 },
    { name: 'Mô hình Beta', tag: 'Đóng nguồn · đám mây', group: 'Đám mây', score: 77 },
    { name: 'Mô hình Gamma', tag: 'Mã nguồn mở · 70B', group: 'Chạy cục bộ', score: 71 },
    { name: 'Mô hình Delta', tag: 'Mã nguồn mở · 32B', group: 'Chạy cục bộ', score: 64 },
    { name: 'Mô hình Epsilon', tag: 'Mã nguồn mở · 8B', group: 'Chạy cục bộ', score: 52 },
    { name: 'Mô hình Zeta', tag: 'Đóng nguồn · giá rẻ', group: 'Giá rẻ', score: 69 },
  ];
  const CUT = 65;
  let active = 'Tất cả';
  const groups = ['Tất cả', ...new Set(DATA.map(d => d.group))];
  const chips = document.getElementById('chips');
  const list = document.getElementById('list');
  function renderChips() {
    chips.innerHTML = '';
    for (const g of groups) {
      const b = document.createElement('button');
      b.className = 'chip'; b.textContent = g; b.setAttribute('aria-pressed', String(g === active));
      b.onclick = () => { active = g; renderChips(); renderRows(); };
      chips.appendChild(b);
    }
  }
  function renderRows() {
    const rows = DATA.filter(d => active === 'Tất cả' || d.group === active).sort((a, b) => b.score - a.score);
    list.innerHTML = rows.length ? '' : '<div class="empty">Không có mô hình nào trong nhóm này.</div>';
    rows.forEach((d, i) => {
      const el = document.createElement('div'); el.className = 'row';
      el.innerHTML = '<div class="name">' + d.name + '<span class="tag">' + d.tag + '</span></div>' +
        '<div class="bar"><div class="fill" style="width:' + d.score + '%"></div><div class="cut" style="left:' + CUT + '%"></div>' +
        (i === 0 ? '<div class="cutlabel" style="left:' + CUT + '%">mua được</div>' : '') + '</div>' +
        '<div class="score">' + new Intl.NumberFormat('vi-VN').format(d.score) + '</div>';
      list.appendChild(el);
    });
  }
  renderChips(); renderRows();
</script>
</body>
</html>`;

const FINAL_TEXT = `Đã dựng xong **bảng thang điểm minh hoạ** — bạn có thể mở khung xem trước bên cạnh để lọc theo nhóm.

| Nhóm | Số mô hình | Điểm cao nhất | Qua ranh giới "mua được" (65) |
| --- | ---: | ---: | --- |
| Đám mây | 2 | 82 | Cả 2 |
| Chạy cục bộ | 3 | 71 | 1 / 3 |
| Giá rẻ | 1 | 69 | Có |

**Cách đọc:** thanh càng dài điểm càng cao; vạch đỏ là ngưỡng mua được. Mô hình Gamma là lựa chọn chạy cục bộ duy nhất vượt ngưỡng.

> Đây là **chế độ demo**: số liệu giả lập và không gọi mô hình thật. Để dùng trợ lý với dữ liệu thật, mở **Cài đặt → thêm API key** (Claude, ChatGPT, Gemini, DeepSeek, Grok…) rồi chọn model ở dưới ô nhập.

Bạn có thể thử tiếp: *"giải thích kiến trúc agent của extension này"*, hoặc đính kèm một tệp bằng \`@\` rồi nhờ tóm tắt.`;

const INTRO_TEXT = `Xin chào! Tôi đang chạy ở **chế độ demo** nên chưa gọi mô hình thật nào.

Hãy gõ một yêu cầu có chữ **"bảng"**, **"so sánh"** hoặc **"demo"** (ví dụ: *"so sánh điểm các model AI và dựng bảng thang điểm"*) để xem toàn bộ quy trình agent chạy:

1. Lập danh sách **tác vụ** để neo mục tiêu
2. **Nạp kỹ năng** \`artifacts\` đúng lúc cần
3. Các **dòng trạng thái** tóm tắt suy nghĩ theo thời gian thực
4. Dựng **artifact** (trang HTML) hiện ở khung xem trước

Khi sẵn sàng dùng thật: nhấn biểu tượng bánh răng → thêm **API key** cho Claude, ChatGPT, Gemini, DeepSeek, Grok hoặc bất kỳ API tương thích OpenAI nào.`;

interface DemoStep {
  thinking?: string;
  text?: string;
  calls?: { name: string; input: Record<string, unknown> }[];
  slow?: boolean;
}

function lastUserText(messages: ChatMessage[]): { text: string; step: number } {
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    // Khối `volatile` (dòng ngân sách vòng lặp harness gắn vào cuối tin user cuối) không phải lời người dùng.
    if (m.role === 'user' && !m.synthetic && m.content.some((b) => b.type === 'text' && !b.volatile)) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return { text: '', step: 0 };
  const text = messages[idx].content.filter((b) => b.type === 'text' && !b.volatile).map((b) => (b as { text: string }).text).join('\n');
  const step = messages.slice(idx + 1).filter((m) => m.role === 'assistant' && !m.synthetic).length;
  return { text, step };
}

function planFor(userText: string): DemoStep[] {
  const wantsScenario = /b[ảa]ng|so s[áa]nh|demo|artifact|dashboard|thang [đd]i[ểe]m|benchmark/i.test(userText);
  if (!wantsScenario) return [{ text: INTRO_TEXT }];
  const todos = (done: number) => [
    { id: 't1', title: 'Gom và chuẩn hoá điểm số theo model', status: done > 0 ? 'completed' : 'in_progress' },
    { id: 't2', title: 'Dựng bảng thang điểm có đánh dấu ranh giới', status: done > 1 ? 'completed' : done > 0 ? 'in_progress' : 'pending' },
    { id: 't3', title: 'Tóm tắt kết quả cho người dùng', status: done > 1 ? 'in_progress' : 'pending' },
  ];
  return [
    { thinking: THINK_PLAN, slow: true, calls: [{ name: 'todo_write', input: { todos: todos(0) } }] },
    {
      thinking: THINK_SKILL,
      calls: [
        { name: 'load_skill', input: { skill_name: 'artifacts' } },
        { name: 'scratchpad', input: { action: 'write', key: 'du_lieu_chuan_hoa', value: 'Alpha 82; Beta 77; Gamma 71; Zeta 69; Delta 64; Epsilon 52 (thang v2, ngưỡng mua được = 65)' } },
      ],
    },
    { thinking: THINK_TYPES, calls: [{ name: 'list_artifact_types', input: {} }] },
    { thinking: THINK_BUILD, slow: true, calls: [{ name: 'create_artifact', input: { title: 'Bảng thang điểm minh hoạ', type: 'html', content: DEMO_HTML } }] },
    { calls: [{ name: 'todo_write', input: { todos: todos(2).map((t) => ({ ...t, status: 'completed' })) } }] },
    { text: FINAL_TEXT },
  ];
}

/** Dùng cho test: kịch bản sẽ chạy với câu hỏi này. */
export function demoPlan(userText: string): DemoStep[] {
  return planFor(userText);
}

function chunks(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

function estimateTokens(s: string): number {
  return Math.ceil(s.length / 3);
}

export class DemoProvider implements LLMProvider {
  readonly id = DEMO_PROVIDER_ID;
  readonly label = 'Chế độ demo (không cần API key)';
  readonly kind = 'anthropic' as const;
  readonly flavor = 'anthropic' as const;
  readonly capabilities: ProviderCapabilities = { reasoning: 'native-visible', parallelTools: true, vision: false, toolArgStreaming: 'incremental' };
  private thinkCount = 0;
  private writeCount = 0;

  constructor(private readonly opts: { speed?: number } = {}) {}

  private get speed(): number {
    return this.opts.speed ?? 1;
  }

  async *stream(req: StreamRequest): AsyncGenerator<ProviderEvent, void, void> {
    const { text: userText, step } = lastUserText(req.messages);
    const plan = planFor(userText);
    const s: DemoStep = plan[Math.min(step, plan.length - 1)];
    const content: ContentBlock[] = [];
    let produced = 0;
    const check = () => {
      if (req.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };

    if (s.thinking) {
      const pace = (s.slow ? 70 : 45) / this.speed;
      for (const part of chunks(s.thinking, 90)) {
        check();
        yield { type: 'thinking_delta', text: part };
        produced += part.length;
        await sleep(pace);
      }
      content.push({ type: 'thinking', text: s.thinking, provider: this.id });
    }
    if (s.text) {
      for (const part of chunks(s.text, 18)) {
        check();
        yield { type: 'text_delta', text: part };
        produced += part.length;
        await sleep(12 / this.speed);
      }
      content.push({ type: 'text', text: s.text, provider: this.id });
    }
    let n = 0;
    for (const c of s.calls ?? []) {
      const id = `demo_${Date.now().toString(36)}_${step}_${n++}`;
      const json = JSON.stringify(c.input);
      yield { type: 'tool_start', id, name: c.name };
      const big = json.length > 600;
      for (const part of chunks(json, big ? 140 : 400)) {
        check();
        yield { type: 'tool_args_delta', id, name: c.name, delta: part };
        produced += part.length;
        await sleep(big ? 28 / this.speed : 4);
      }
      yield { type: 'tool_end', id, name: c.name };
      content.push({ type: 'tool_use', id, name: c.name, input: c.input, provider: this.id });
    }

    const inputChars = req.messages.reduce((a, m) => a + JSON.stringify(m.content).length, 0) + req.system.length;
    const usage: Usage = { inputTokens: Math.ceil(inputChars / 3), outputTokens: estimateTokens('x'.repeat(produced)) };
    yield {
      type: 'done',
      stopReason: (s.calls?.length ?? 0) > 0 ? 'tool_use' : 'end_turn',
      usage,
      message: { role: 'assistant', content, provider: this.id, model: req.model },
    };
  }

  /** Bộ tóm tắt nền của chế độ demo: trả câu trạng thái có sẵn theo loại nội dung. */
  async complete(req: CompleteRequest): Promise<string> {
    await sleep(120 / this.speed);
    if (/<loai>đang viết/.test(req.prompt)) return WRITING_PILLS[this.writeCount++ % WRITING_PILLS.length];
    if (/<loai>suy nghĩ/.test(req.prompt)) return THINKING_PILLS[this.thinkCount++ % THINKING_PILLS.length];
    return 'Tóm tắt (demo): cuộc trò chuyện mẫu về bảng thang điểm.';
  }

  async fetchModels(): Promise<ModelInfo[]> {
    return DEMO_MODELS;
  }

  async ping(): Promise<void> {
    /* luôn sẵn sàng */
  }
}


