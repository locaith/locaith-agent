/**
 * (0.7.4) «Bị ra cả tiếng tàu» (anh chụp màn hình 08/11/2026): mô hình gốc Trung (DeepSeek — nền của Locaith-v5) trả lời bằng tiếng Trung sau tin «tiếp tục».
 * Hai lớp: (1) lời dặn ngôn ngữ trong system prompt + trong chỉ dẫn «tiếp tục»; (2) lớp bảo vệ ở engine — câu trả lời cuối toàn chữ Trung/Nhật/Hàn mà người dùng
 * không viết/nhắc tới các thứ tiếng đó thì bị bỏ khỏi màn hình + lịch sử và hỏi lại ĐÚNG MỘT LẦN. Ở đây kiểm cả hai, bằng số.
 */
import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, languageRule } from '../src/core/engine/context';
import { expectedReplyLanguage, isCjkDrift, joinTailNotes, languageDrift, languageRetryNote, recentUserTexts, userAllowsCjk } from '../src/core/engine/languageGuard';
import { resumeInstruction } from '../src/core/engine/resume';
import { DEFAULT_ENGINE_SETTINGS } from '../src/core/engine/types';
import type { ChatMessage } from '../src/core/types';
import { textTurn, toolTurn } from './helpers/fakeProvider';
import { eventsOf, makeHarness } from './helpers/harness';

const ZH = '好的，我继续完成这项工作。我会先检查文件，然后运行测试，最后向你报告结果。';
const user = (text: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const assistant = (text: string): ChatMessage => ({ role: 'assistant', content: [{ type: 'text', text }] });
/** Khối volatile ở cuối tin user cuối của payload (dòng ngân sách / dòng nhắc ngôn ngữ do harness gắn), hoặc undefined. */
const tailNote = (msgs: readonly { role: string; content: readonly any[] }[]): string | undefined => {
  const last = msgs[msgs.length - 1];
  const tail = last && last.role === 'user' ? last.content[last.content.length - 1] : undefined;
  return tail && tail.type === 'text' && tail.volatile === true ? tail.text : undefined;
};

describe('isCjkDrift — chỉ bắt khi PHẦN LỚN câu trả lời là chữ Trung/Nhật/Hàn', () => {
  it('tiếng Trung, Nhật, Hàn → trượt; tiếng Việt/Anh → không', () => {
    expect(isCjkDrift(ZH)).toBe(true);
    expect(isCjkDrift('はい、作業を続けます。まずファイルを確認してからテストを実行します。')).toBe(true);
    expect(isCjkDrift('네, 작업을 계속하겠습니다. 먼저 파일을 확인하고 테스트를 실행하겠습니다.')).toBe(true);
    expect(isCjkDrift('Đã làm tiếp: sửa xong lỗi đăng nhập và chạy lại test, tất cả đều qua.')).toBe(false);
    expect(isCjkDrift('Done: fixed the login bug and re-ran the tests, all green.')).toBe(false);
    expect(isCjkDrift('')).toBe(false);
  });

  it('vài chữ Hán lẫn trong câu tiếng Việt (tên riêng, thuật ngữ) KHÔNG bị coi là trượt', () => {
    expect(isCjkDrift('Trong tiếng Trung, 你好 nghĩa là «xin chào», còn 谢谢 là «cảm ơn». Mình giải thích thêm cách đọc pinyin bên dưới nhé.')).toBe(false);
    expect(isCjkDrift('Tên công ty là 华为 (Huawei), trụ sở ở Thâm Quyến.')).toBe(false);
  });

  it('chữ Trung nằm trong khối mã / mã nội dòng không tính (chuỗi và chú thích của mã là hợp lệ)', () => {
    expect(isCjkDrift('Đã thêm bản dịch:\n```json\n{"hello": "你好，世界，欢迎使用我们的产品和服务"}\n```\nXong.')).toBe(false);
    expect(isCjkDrift('Khoá `你好世界欢迎使用` đã được thêm.')).toBe(false);
    expect(isCjkDrift('Đã thêm:\n```\n' + ZH + '\n')).toBe(false); // khối mã chưa đóng
  });
});

describe('userAllowsCjk / expectedReplyLanguage / recentUserTexts', () => {
  it('người dùng viết chữ Trung/Nhật/Hàn hoặc nhắc tới các thứ tiếng đó → được phép', () => {
    expect(userAllowsCjk(['tiếp tục'])).toBe(false);
    expect(userAllowsCjk(['dịch câu này sang tiếng Trung giúp mình'])).toBe(true);
    expect(userAllowsCjk(['Translate this into Japanese'])).toBe(true);
    expect(userAllowsCjk(['写一段欢迎词'])).toBe(true);
    expect(userAllowsCjk(['học tiếng Hàn', 'ok'])).toBe(true);
    expect(userAllowsCjk(['viết bằng chữ Hán'])).toBe(true);
  });

  it('ngôn ngữ cần ép: có dấu tiếng Việt → vi; còn lại theo ngôn ngữ giao diện', () => {
    expect(expectedReplyLanguage('tiếp tục', 'en')).toBe('vi');
    expect(expectedReplyLanguage('ok', 'vi')).toBe('vi');
    expect(expectedReplyLanguage('ok', 'en')).toBe('en');
    expect(expectedReplyLanguage('please continue', 'en')).toBe('en');
  });

  it('recentUserTexts: mới nhất ở đầu, bỏ khối volatile của harness và tin chỉ có kết quả công cụ', () => {
    const msgs: ChatMessage[] = [
      user('một'),
      assistant('a'),
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: '写点什么' }] as never },
      user('hai'),
      { role: 'user', content: [{ type: 'text', text: 'ba' }, { type: 'text', text: '[vòng 2/8]', volatile: true }] },
    ];
    expect(recentUserTexts(msgs)).toEqual(['ba', 'hai', 'một']);
    expect(recentUserTexts(msgs, 2)).toEqual(['ba', 'hai']);
  });

  it('languageDrift: trượt + người dùng không dùng/nhắc CJK → trả ngôn ngữ cần ép; ngược lại null', () => {
    expect(languageDrift(ZH, [user('tiếp tục')], 'en')).toBe('vi');
    expect(languageDrift(ZH, [user('dịch sang tiếng Trung')], 'vi')).toBeNull();
    expect(languageDrift(ZH, [user('写一个函数')], 'vi')).toBeNull();
    expect(languageDrift('Xong rồi.', [user('tiếp tục')], 'vi')).toBeNull();
    // chỉ nhìn 6 tin gần nhất: yêu cầu tiếng Trung cách đây quá xa thì không còn tính
    const old = [user('dịch sang tiếng Trung'), ...Array.from({ length: 7 }, (_, i) => user(`việc ${i}`))];
    expect(languageDrift(ZH, old, 'vi')).toBe('vi');
  });

  it('dòng nhắc theo ngôn ngữ; gộp dòng ở đuôi payload thành MỘT khối', () => {
    expect(languageRetryNote('vi')).toContain('tiếng Việt');
    expect(languageRetryNote('en')).toContain('English');
    expect(joinTailNotes(null, undefined)).toBeNull();
    expect(joinTailNotes('a', null, 'b')).toBe('a\nb');
  });
});

describe('lời dặn ngôn ngữ trong system prompt và chỉ dẫn «tiếp tục»', () => {
  const host = { workspaceRoots: () => ['/w'], extraReadRoots: () => [], platform: { os: 'windows', shell: 'pwsh', shellLabel: 'PowerShell' } } as never;
  const base = { host, model: 'locaith-v5-si', providerLabel: 'Locaith', mode: 'default' as const };

  it('nêu thẳng các chỗ mô hình hay trượt: tin ngắn, dữ liệu tiếng khác (nhất là tiếng Trung), và cấm CJK trừ khi người dùng viết/yêu cầu — ở cả hai hồ sơ', () => {
    for (const language of ['vi', 'en'] as const) {
      for (const profile of ['ide', 'browser'] as const) {
        const sys = buildSystemPrompt({ ...base, language, profile });
        expect(sys, `${language}/${profile}`).toContain(languageRule(language));
      }
    }
    const vi = languageRule('vi');
    expect(vi).toContain('Vietnamese (full diacritics)');
    expect(vi).toContain('"tiếp tục"');
    expect(vi).toContain('especially Chinese');
    expect(vi).toContain('Never write Chinese, Japanese or Korean');
    expect(languageRule('en')).toContain('Reply language: English');
  });

  it('phần dành riêng cho mô hình Locaith cũng có quy tắc ngôn ngữ', () => {
    const sys = buildSystemPrompt({ ...base, language: 'vi', providerId: 'locaith' });
    expect(sys).toContain("Always reply in the user's language (default: Vietnamese)");
    expect(sys).toContain('never write Chinese, Japanese or Korean unless the user does');
  });

  it('«tiếp tục» → chỉ dẫn nói rõ trả lời bằng tiếng Việt, DÙ giao diện là tiếng Anh; «continue» → tiếng Anh, dù giao diện là tiếng Việt', () => {
    const vi = resumeInstruction('tiếp tục', [], 'en')!;
    expect(vi).toContain('[Tiếp tục sau khi dừng');
    expect(vi).toContain('Trả lời bằng tiếng Việt');
    const en = resumeInstruction('continue', [], 'vi')!;
    expect(en).toContain('[Continue after a stop');
    expect(en).toContain('Reply in English');
    // có việc tồn + việc bị chặn: dòng ngôn ngữ vẫn ở cuối
    const full = resumeInstruction('tiếp tục', [{ title: 'A', status: 'pending' }, { title: 'B', status: 'blocked' }], 'vi')!;
    expect(full.trimEnd().endsWith('không chuyển sang ngôn ngữ khác.')).toBe(true);
  });
});

describe('engine · chống trượt ngôn ngữ', () => {
  it('«tiếp tục» → model trả lời tiếng Trung: bị bỏ, hỏi lại MỘT lần kèm dòng nhắc, người dùng chỉ thấy câu tiếng Việt', async () => {
    const h = makeHarness([() => textTurn(ZH), () => textTurn('Đã làm tiếp: mọi thứ đều ổn.')], { settings: { language: 'vi' } });
    const r = await h.run('tiếp tục');
    expect(h.provider.rawRequests).toHaveLength(2);
    // lần hỏi lại: dòng nhắc là MỘT khối volatile ở cuối tin cuối, bằng tiếng Việt; lần đầu thì không có
    expect(tailNote(h.provider.rawRequests[0].messages)).toBeUndefined();
    const note = tailNote(h.provider.rawRequests[1].messages)!;
    expect(note).toContain('Câu trả lời trước viết sai ngôn ngữ');
    expect(h.provider.rawRequests[1].messages.flatMap((m) => m.content).filter((b) => b.type === 'text' && b.volatile)).toHaveLength(1);
    // lịch sử: chỉ có tin người dùng + câu trả lời tiếng Việt (không có tiếng Trung, không có dòng nhắc)
    expect(h.session.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(JSON.stringify(h.session.messages)).not.toMatch(/[\u4e00-\u9fff]/);
    expect(JSON.stringify(h.session.messages)).not.toContain('sai ngôn ngữ');
    // giao diện: chữ tiếng Trung đã hiện bị lùi lại đúng số ký tự; có thông báo; kết quả cuối là câu tiếng Việt
    const texts = eventsOf(h.events, 'text');
    expect(texts.some((e) => e.trimTail === ZH.length)).toBe(true);
    expect(eventsOf(h.events, 'notice').some((e) => e.text.includes('tiếng Trung/Nhật/Hàn'))).toBe(true);
    expect(r.turns).toBe(1); // lần hỏi lại không tính vào ngân sách vòng
    // token: lần gọi bị bỏ vẫn tốn thật → được tính (2 × (100 vào + 20 ra))
    expect(h.session.usageTotals).toEqual({ input: 200, output: 40 });
  });

  it('chỉ hỏi lại MỘT lần: lần hai vẫn tiếng Trung thì chấp nhận (không lặp vô hạn)', async () => {
    const h = makeHarness([() => textTurn(ZH), () => textTurn(ZH), () => textTurn('không được tới đây')], { settings: { language: 'vi' } });
    await h.run('tiếp tục');
    expect(h.provider.rawRequests).toHaveLength(2);
    expect(h.session.messages.at(-1)!.content.some((b) => b.type === 'text' && b.text === ZH)).toBe(true);
  });

  it('người dùng viết/nhắc tiếng Trung → KHÔNG can thiệp (một lần gọi)', async () => {
    for (const ask of ['dịch "xin chào" sang tiếng Trung', 'viết lời chào 你好']) {
      const h = makeHarness([() => textTurn(ZH)], { settings: { language: 'vi' } });
      await h.run(ask);
      expect(h.provider.rawRequests, ask).toHaveLength(1);
    }
  });

  it('chữ Trung chỉ nằm trong khối mã của câu trả lời tiếng Việt → KHÔNG can thiệp', async () => {
    const h = makeHarness([() => textTurn('Đã thêm bản dịch:\n```json\n{"hello": "你好，世界，欢迎使用我们的产品和服务"}\n```\nXong.')], { settings: { language: 'vi' } });
    await h.run('thêm bản dịch vào file');
    expect(h.provider.rawRequests).toHaveLength(1);
  });

  it('lượt có gọi công cụ KHÔNG bị chạm tới (lệnh công cụ đã hiện trên giao diện, không rút lại được)', async () => {
    const h = makeHarness([() => toolTurn([{ name: 'list_dir', input: { path: '.' } }], { text: ZH }), () => textTurn('Xong.')], { files: { 'a.txt': '1' }, settings: { language: 'vi' } });
    await h.run('tiếp tục');
    expect(h.provider.rawRequests).toHaveLength(2); // lượt công cụ + câu trả lời cuối, không có lần hỏi lại thêm
    expect(h.session.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('giao diện tiếng Anh + người dùng gõ tiếng Anh → dòng nhắc bằng tiếng Anh', async () => {
    const h = makeHarness([() => textTurn(ZH), () => textTurn('Continuing: all good.')], { settings: { language: 'en' } });
    await h.run('please continue');
    expect(tailNote(h.provider.rawRequests[1].messages)).toContain('ONLY in English');
  });

  it('mô hình có thẻ <think>: suy luận tiếng Trung trong <think> KHÔNG bị tính là câu trả lời', async () => {
    const reply = '<think>' + ZH + ZH + '</think>Đã làm tiếp: mọi thứ đều ổn.';
    const h = makeHarness([() => textTurn(reply)], { settings: { language: 'vi' }, thinkTags: true });
    await h.run('tiếp tục');
    expect(h.provider.rawRequests).toHaveLength(1);
  });
});

describe('không còn trần vòng khi chạy tương tác (như Claude Code)', () => {
  it('mặc định KHÔNG giới hạn; chỉ `--max-turns`/sub-agent mới đặt số hữu hạn', () => {
    expect(DEFAULT_ENGINE_SETTINGS.maxTurns).toBe(Number.POSITIVE_INFINITY);
  });

  it('một việc dài 60 vòng chạy tới cùng: không thông báo «đạt số vòng tối đa», không lượt tổng kết, không dòng ngân sách', async () => {
    const steps = Array.from({ length: 60 }, (_, i) => () => toolTurn([{ id: `c${i}`, name: 'glob', input: { pattern: `*.x${i}` } }]));
    const h = makeHarness([...steps, () => textTurn('Đã hoàn tất cả 60 bước: mỗi bước tìm tệp theo một mẫu khác nhau, không có lỗi nào và không có thay đổi nào cần hoàn tác. ' + 'Kết quả đầy đủ nằm ở các lần gọi công cụ phía trên; không cần làm thêm gì nữa cho yêu cầu này, và không có việc nào còn dở dang để tiếp tục lần sau.')], { files: { 'a.txt': '1' } });
    const r = await h.run('làm việc dài');
    expect(r.stopReason, JSON.stringify(eventsOf(h.events, 'notice'))).toBe('end_turn');
    expect(r.turns).toBe(61);
    expect(eventsOf(h.events, 'notice').some((e) => /vòng lặp tối đa|loop turns/.test(e.text))).toBe(false);
    expect(h.provider.rawRequests.every((q) => tailNote(q.messages) === undefined)).toBe(true); // không có dòng «[vòng N/M]»
  }, 60_000);

  it('trần hữu hạn (sub-agent, -p --max-turns) vẫn hoạt động: chạm trần thì có lượt tổng kết', async () => {
    const step = (i: number) => () => toolTurn([{ id: `c${i}`, name: 'glob', input: { pattern: `*.y${i}` } }]);
    const h = makeHarness([step(1), step(2), () => textTurn('Tóm tắt tiến độ.')], { files: { 'a.txt': '1' }, settings: { maxTurns: 2 } });
    await h.run('đi');
    expect(eventsOf(h.events, 'notice').some((e) => /vòng lặp tối đa/.test(e.text))).toBe(true);
  });
});
