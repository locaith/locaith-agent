import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * LỜI VỀ QUYỀN RIÊNG TƯ PHẢI ĐÚNG VỚI HÀNH VI THẬT.
 *
 * Từ 0.6.0 có một ngoại lệ: chọn mô hình Locaith-v5 thì nội dung trò chuyện đi tới DỊCH VỤ CỦA LOCAITH (sau khi đồng ý thông báo dữ liệu) và được lưu để tìm lỗi
 * và cải thiện mô hình. Vì vậy mọi câu kiểu «nội dung / cuộc trò chuyện KHÔNG BAO GIỜ gửi tới Locaith» đều SAI nếu không nêu ngoại lệ. Câu về KHOÁ API (không bao giờ
 * gửi lên Locaith) thì vẫn đúng và được giữ. Test này quét màn hình đăng nhập (vi + en), hai README và các tài liệu: câu nào vừa "không bao giờ gửi tới Locaith" vừa nói
 * về nội dung/cuộc trò chuyện mà KHÔNG kèm ngoại lệ (trừ/except/unless) thì test đỏ — để lời cũ không quay lại.
 */
const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const i18n = read('webview/src/i18n.ts');
const split = i18n.indexOf('export type I18nKey');
const TABLES = { vi: i18n.slice(0, split), en: i18n.slice(split) };
const str = (lang: 'vi' | 'en', key: string): string => {
  const m = new RegExp(`'${key.replace(/\./g, '\\.')}':\\s*(?:'((?:[^'\\\\]|\\\\.)*)'|"((?:[^"\\\\]|\\\\.)*)")`).exec(TABLES[lang]);
  if (!m) throw new Error(`thiếu chuỗi ${lang}:${key}`);
  return (m[1] ?? m[2])!;
};

/** «không bao giờ / không được / never / not … gửi / sent … tới / to Locaith». */
const NEVER_TO_LOCAITH = [
  /\b(?:never|not|isn'?t|aren'?t|won'?t)\b[^.!?\n|]*\b(?:sent|send|sends|go|goes|leave|leaves|shared?|forwarded)\b[^.!?\n|]*\bto\s+Locaith\b/i,
  /\bnever\b[^.!?\n|]*\bLocaith\b[^.!?\n|]*\b(?:sees?|receives?|stores?)\b/i,
  /(?:không bao giờ|không được|không hề|chẳng bao giờ|không)\s[^.!?\n|]*(?:gửi|đi|chuyển|chia sẻ)[^.!?\n|]*(?:tới|lên|cho|đến)\s+Locaith/i,
];
const ABOUT_CONTENT = /conversation|prompt|message|content|files?\b|tool output|trò chuyện|hội thoại|nội dung|tệp|tin nhắn/i;
/** Ngoại lệ nêu ngay trong câu. (`\b` của JS chỉ hiểu chữ ASCII nên tiếng Việt dùng \p{L}.) */
const QUALIFIER = /\b(?:except|unless)\b|\bapart from\b|(?<!\p{L})(?:trừ|ngoại lệ|ngoại trừ|riêng khi)(?!\p{L})/iu;

/** Tách thành các "câu": theo dấu câu, xuống dòng và ô bảng Markdown. */
function sentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => (line.trim().startsWith('|') ? [line] : line.split(/(?<=[.!?])\s+/)))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Các câu "không bao giờ gửi tới Locaith" mà có nói về nội dung/cuộc trò chuyện nhưng KHÔNG nêu ngoại lệ. */
export function unqualifiedClaims(text: string): string[] {
  // Bỏ dấu nhấn mạnh Markdown (**không**, `code`) để chúng không chen giữa các từ cần khớp.
  return sentences(text.replace(/[*`]/g, '')).filter((s) => NEVER_TO_LOCAITH.some((re) => re.test(s)) && ABOUT_CONTENT.test(s) && !QUALIFIER.test(s));
}

describe('bộ quét lời sai (kiểm chính nó)', () => {
  it('bắt được đúng những câu cũ từng sai (vi + en + bảng Markdown)', () => {
    for (const bad of [
      'Your API keys and conversations are never sent to Locaith.',
      'Khoá API và nội dung trò chuyện của bạn không được gửi lên Locaith.',
      'your API keys and conversations are never sent to Locaith (see `docs/ACCOUNT.md`).',
      'khoá API và nội dung trò chuyện của bạn **không** được gửi lên Locaith.',
      '| **Conversation content, API keys, files, tool output** | **never sent to Locaith** | they go only to the model provider you chose |',
    ]) {
      expect(unqualifiedClaims(bad), bad).toHaveLength(1);
    }
  });

  it('cho qua câu đúng: chỉ nói về khoá API, hoặc có nêu ngoại lệ Locaith-v5', () => {
    for (const ok of [
      'The API keys you enter in Settings are never sent to Locaith.',
      'Khoá API bạn nhập trong Cài đặt không bao giờ được gửi lên Locaith.',
      'Your conversations go only to the provider you choose — except when you choose Locaith-v5.',
      'the API keys you enter are never sent to Locaith, and your conversations go only to the provider you choose — **except the Locaith-v5 model**.',
      '| **Conversation content, files, tool output** | **not sent to Locaith — except when you choose the Locaith-v5 model** | they go only to the model provider you chose |',
      'khoá API bạn nhập **không bao giờ** được gửi lên Locaith, còn nội dung trò chuyện chỉ đi tới nhà cung cấp bạn chọn — **trừ mô hình Locaith-v5**.',
    ]) {
      expect(unqualifiedClaims(ok), ok).toEqual([]);
    }
  });
});

describe('lời về quyền riêng tư không còn tuyệt đối sai', () => {
  const FILES = ['README.md', 'README.vi.md', 'docs/ACCOUNT.md', 'docs/REMOTE.md', 'docs/REMOTE-RELAY.md', 'docs/ARCHITECTURE.md', 'package.nls.json', 'package.nls.en.json'];

  it('MÀN ĐĂNG NHẬP (hiện TRƯỚC mọi sự đồng ý): cả hai ngôn ngữ nêu ngoại lệ Locaith-v5 và không có câu tuyệt đối về nội dung trò chuyện', () => {
    const keys = [...i18n.matchAll(/'(acct\.[a-zA-Z0-9_.]+)':/g)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(10);
    for (const lang of ['vi', 'en'] as const) {
      for (const k of new Set(keys)) {
        let text: string;
        try {
          text = str(lang, k);
        } catch {
          continue;
        }
        expect(unqualifiedClaims(text), `${lang}:${k}`).toEqual([]);
      }
    }
    const vi = str('vi', 'acct.why.body');
    const en = str('en', 'acct.why.body');
    expect(vi).toMatch(/Locaith-v5/);
    expect(vi).toMatch(/đồng ý thông báo dữ liệu/);
    expect(vi).toMatch(/Khoá API bạn nhập trong Cài đặt không bao giờ được gửi lên Locaith/);
    expect(vi).toMatch(/được lưu để tìm lỗi và cải thiện mô hình/);
    expect(en).toMatch(/Locaith-v5/);
    expect(en).toMatch(/data notice/);
    expect(en).toMatch(/API keys you enter in Settings are never sent to Locaith/);
    expect(en).toMatch(/stored to fix errors and improve the model/);
  });

  it('README, README.vi, docs và mô tả cài đặt: không còn câu tuyệt đối thiếu ngoại lệ', () => {
    for (const f of FILES) expect(unqualifiedClaims(read(f)), f).toEqual([]);
  });

  it('những câu cụ thể đã bị thay: "không vận hành API proxy" (en) và "không có máy chủ trung gian và không thu thập dữ liệu" (vi)', () => {
    expect(read('README.md')).not.toMatch(/does not operate an API proxy/i);
    expect(read('README.vi.md')).not.toMatch(/không có máy chủ trung gian và không thu thập dữ liệu/);
    expect(read('README.md')).toMatch(/Locaith-v5/);
    expect(read('README.md')).toMatch(/data notice/);
    expect(read('README.vi.md')).toMatch(/thông báo dữ liệu/);
  });

  it('bảng «What the server learns» trong docs/ACCOUNT.md nêu ngoại lệ và bản ghi đồng ý', () => {
    const doc = read('docs/ACCOUNT.md');
    expect(doc).toMatch(/not sent to Locaith — except when you choose the Locaith-v5 model/);
    expect(doc).toMatch(/Locaith-v5 requests/);
    expect(doc).toMatch(/acceptance of the data notice/);
  });

  it('lời chào và hàng chờ nói thật: Locaith xử lý nội dung (không hứa "riêng tư tuyệt đối"), và không hứa miễn phí', () => {
    for (const lang of ['vi', 'en'] as const) {
      const welcome = str(lang, 'welcome.locaith');
      expect(welcome).toMatch(/Locaith/);
      expect(welcome).not.toMatch(/miễn phí|\bfree\b/i);
      expect(welcome).not.toMatch(/bảo mật dữ liệu|keeps? your data (private|confidential)/i);
      expect(unqualifiedClaims(welcome)).toEqual([]);
    }
    expect(str('vi', 'welcome.locaith')).toMatch(/do Locaith xử lý/);
    expect(str('en', 'welcome.locaith')).toMatch(/processed by Locaith/);
  });

  it('gợi ý điều phối và ghi chú model Auto nhắc rằng Locaith chỉ vào kho sau khi đồng ý', () => {
    expect(str('vi', 'orch.hint')).toMatch(/mô hình Locaith nếu bạn đã đồng ý/);
    expect(str('en', 'orch.hint')).toMatch(/Locaith model if you accepted/);
    expect(read('src/core/orchestration/autoProvider.ts')).toMatch(/mô hình Locaith nếu bạn đã đồng ý thông báo dữ liệu/);
  });
});
