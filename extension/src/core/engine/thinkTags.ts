/**
 * Tách thẻ suy nghĩ nằm trong dòng chữ (`<think>…</think>`, `<thinking>…</thinking>`, `<reasoning>…`)
 * khỏi câu trả lời thật — Tầng 2 "Stream Interceptor" của kiến trúc: luồng <thinking> đi sang bộ tóm tắt,
 * luồng chữ thường đi lên giao diện.
 *
 * Cần cho model không có kênh suy luận riêng: DeepSeek-R1/Qwen qua Ollama (phát `<think>` thẳng vào nội dung)
 * và chế độ "suy nghĩ qua prompt".
 *
 * Thẻ chỉ được nhận ở đầu tin nhắn hoặc đầu dòng (không nhận giữa câu) để không cắt nhầm khi đoạn mã/HTML
 * có chứa chữ `<think>`. Chịu được việc thẻ bị chẻ đôi giữa hai gói dữ liệu.
 */

export interface Segment {
  kind: 'text' | 'thinking';
  text: string;
}

const TAG_NAMES = ['think', 'thinking', 'reasoning'];
const OPEN_TAGS = TAG_NAMES.map((n) => `<${n}>`);
const MAX_TAG_LEN = Math.max(...TAG_NAMES.map((n) => n.length + 3));

/** `s` có phải tiền tố thực sự (chưa đủ) của một trong các chuỗi `candidates` không. */
function isProperPrefix(s: string, candidates: string[]): boolean {
  return candidates.some((c) => c.length > s.length && c.startsWith(s));
}

export class ThinkTagSplitter {
  private inside: string | null = null;
  private pending = '';
  /** true nếu dòng hiện tại chưa có ký tự khác khoảng trắng (được phép mở thẻ). */
  private lineBlank = true;
  private trimLeadingText = false;

  push(chunk: string): Segment[] {
    const out: Segment[] = [];
    const emit = (kind: Segment['kind'], text: string) => {
      if (!text) return;
      const last = out[out.length - 1];
      if (last && last.kind === kind) last.text += text;
      else out.push({ kind, text });
    };
    const emitText = (text: string) => {
      if (!text) return;
      if (this.trimLeadingText) {
        text = text.replace(/^\s+/, '');
        if (!text) return;
        this.trimLeadingText = false;
      }
      for (let i = text.length - 1; i >= 0; i--) {
        const c = text[i];
        if (c === '\n') {
          this.lineBlank = true;
          break;
        }
        if (c !== ' ' && c !== '\t' && c !== '\r') {
          this.lineBlank = false;
          break;
        }
      }
      emit('text', text);
    };

    const buf = this.pending + chunk;
    this.pending = '';
    let i = 0;

    while (i < buf.length) {
      if (this.inside === null) {
        const lt = buf.indexOf('<', i);
        if (lt < 0) {
          emitText(buf.slice(i));
          i = buf.length;
          break;
        }
        emitText(buf.slice(i, lt));
        // Chỉ nhận thẻ mở khi dòng hiện tại chưa có chữ.
        if (!this.lineBlank) {
          emitText('<');
          i = lt + 1;
          continue;
        }
        const rest = buf.slice(lt);
        const matched = OPEN_TAGS.find((t) => rest.startsWith(t));
        if (matched) {
          this.inside = matched.slice(1, -1);
          i = lt + matched.length;
          // Bỏ một dấu xuống dòng ngay sau thẻ mở.
          if (buf[i] === '\r') i++;
          if (buf[i] === '\n') i++;
          continue;
        }
        if (rest.length < MAX_TAG_LEN && isProperPrefix(rest, OPEN_TAGS)) {
          this.pending = rest; // chờ gói dữ liệu sau để biết có phải thẻ không
          i = buf.length;
          break;
        }
        emitText('<');
        i = lt + 1;
      } else {
        const closing = `</${this.inside}>`;
        const lt = buf.indexOf('<', i);
        if (lt < 0) {
          emit('thinking', buf.slice(i));
          i = buf.length;
          break;
        }
        emit('thinking', buf.slice(i, lt));
        const rest = buf.slice(lt);
        if (rest.startsWith(closing)) {
          this.inside = null;
          this.trimLeadingText = true;
          this.lineBlank = true;
          i = lt + closing.length;
          continue;
        }
        // Gói dữ liệu kết thúc giữa chừng thẻ đóng (kể cả chỉ mới có dấu '<') → giữ lại chờ gói sau.
        if (rest.length < closing.length && closing.startsWith(rest)) {
          this.pending = rest;
          i = buf.length;
          break;
        }
        emit('thinking', '<');
        i = lt + 1;
      }
    }
    return out;
  }

  /** Hết luồng: xả phần đang giữ lại (thẻ dở dang được coi là chữ thường). */
  flush(): Segment[] {
    const rest = this.pending;
    this.pending = '';
    if (!rest) return [];
    return [{ kind: this.inside === null ? 'text' : 'thinking', text: rest }];
  }

  get isInsideThinking(): boolean {
    return this.inside !== null;
  }
}

/** Tách một đoạn văn bản hoàn chỉnh (dùng cho tin nhắn đã nhận xong). */
export function splitThinkTags(text: string): { thinking: string; text: string } {
  const s = new ThinkTagSplitter();
  const segs = [...s.push(text), ...s.flush()];
  let thinking = '';
  let visible = '';
  for (const seg of segs) {
    if (seg.kind === 'thinking') thinking += seg.text;
    else visible += seg.text;
  }
  return { thinking: thinking.trim(), text: visible };
}
