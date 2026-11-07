import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProviderError, type ChatMessage, type ProviderEvent, type ToolResultBlock } from '../src/core/types';
import { pruneOldToolResults } from '../src/core/engine/compaction';
import { newSession } from '../src/core/engine/types';
import { reduceView } from '../src/shared/transcript';
import type { ViewState } from '../src/shared/protocol';
import { eventsOf, makeHarness } from './helpers/harness';
import { FakeProvider, textTurn, toolTurn } from './helpers/fakeProvider';

const lastToolResults = (m: ChatMessage): ToolResultBlock[] => m.content.filter((b): b is ToolResultBlock => b.type === 'tool_result');

describe('vòng lặp engine', () => {
  it('trả lời thẳng khi không cần công cụ', async () => {
    const h = makeHarness([() => textTurn('Xin chào!')]);
    const r = await h.run('chào');
    expect(r.stopReason).toBe('end_turn');
    expect(h.session.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    const types = h.events.map((e) => e.t);
    expect(types[0]).toBe('assistant_start');
    expect(types).toContain('text');
    expect(types).toContain('usage');
    expect(types.at(-1)).toBe('assistant_end');
  });

  it('chạy công cụ rồi nối kết quả vào lượt sau', async () => {
    const h = makeHarness([() => toolTurn([{ name: 'read_file', input: { path: 'a.txt' } }]), () => textTurn('Đã đọc xong')], {
      files: { 'a.txt': 'dòng một\ndòng hai\n' },
    });
    const r = await h.run('đọc a.txt');
    expect(r.stopReason).toBe('end_turn');
    expect(r.turns).toBe(2);

    const second = h.provider.requests[1];
    const results = lastToolResults(second.messages.at(-1)!);
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('dòng hai');
    expect(results[0].isError).toBe(false);
    expect(Object.keys(h.session.readFiles)).toHaveLength(1);

    const [start] = eventsOf(h.events, 'tool_start');
    const [end] = eventsOf(h.events, 'tool_end');
    expect(start.name).toBe('read_file');
    expect(end.state).toBe('done');
  });

  it('chạy song song các lệnh chỉ đọc (5 lệnh tìm kiếm cùng lúc)', async () => {
    let active = 0;
    let peak = 0;
    const html = (n: number) =>
      `<div class="result"><h2><a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://example.com/' + n)}&rut=x">Ví dụ ${n}</a></h2><a class="result__snippet">Đoạn trích ${n}</a></div>`;
    let n = 0;
    const fetchImpl = (async () => {
      active++;
      peak = Math.max(peak, active);
      const mine = ++n;
      await new Promise((r) => setTimeout(r, 60));
      active--;
      return new Response(html(mine), { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;

    const calls = Array.from({ length: 5 }, (_, i) => ({ name: 'web_search', input: { query: `model ${i}` } }));
    const h = makeHarness([() => toolTurn(calls), () => textTurn('ok')], { fetchImpl });
    await h.run('so sánh');
    expect(peak).toBe(5);
    const results = lastToolResults(h.provider.requests[1].messages.at(-1)!);
    expect(results).toHaveLength(5);
    // kết quả giữ đúng thứ tự phát lệnh
    expect(results.map((r) => r.toolUseId)).toEqual(calls.map((_, i) => `call_${i + 1}`));
    expect(results.every((r) => r.content.includes('example.com'))).toBe(true);
  });

  it('todo_write phát sự kiện tasks với các tiêu đề mới thêm', async () => {
    const h = makeHarness([
      () =>
        toolTurn([
          {
            name: 'todo_write',
            input: { todos: [{ id: 't1', title: 'Gom điểm theo model', status: 'in_progress' }, { id: 't2', title: 'Dựng bảng thang điểm', status: 'pending' }] },
          },
        ]),
      () =>
        toolTurn([
          {
            name: 'todo_write',
            input: { todos: [{ id: 't1', title: 'Gom điểm theo model', status: 'completed' }, { id: 't2', title: 'Dựng bảng thang điểm', status: 'completed' }] },
          },
        ]),
      () => textTurn('Hoàn tất.'),
    ]);
    await h.run('lập kế hoạch');
    const tasks = eventsOf(h.events, 'tasks');
    expect(tasks[0].added).toEqual(['Gom điểm theo model', 'Dựng bảng thang điểm']);
    expect(tasks[1].added).toEqual([]);
    expect(h.session.todos.every((t) => t.status === 'completed')).toBe(true);
  });

  it('nạp kỹ năng theo nhu cầu: công cụ artifact chỉ lộ ra sau load_skill', async () => {
    const h = makeHarness([
      () => toolTurn([{ name: 'load_skill', input: { skill_name: 'artifacts' } }]),
      () =>
        toolTurn([{ name: 'create_artifact', input: { title: 'Bảng điểm', type: 'html', content: '<!doctype html><html lang="vi"><body>Xin chào</body></html>' } }]),
      () => textTurn('Đã dựng xong.'),
    ]);
    await h.run('dựng bảng');
    const names = (i: number) => h.provider.requests[i].tools.map((t) => t.name);
    expect(names(0)).not.toContain('create_artifact');
    expect(names(0)).toContain('load_skill');
    expect(names(1)).toContain('create_artifact');
    expect(names(1)).toContain('list_artifact_types');

    const skillResult = lastToolResults(h.provider.requests[1].messages.at(-1)!)[0];
    expect(skillResult.content).toContain('Artifacts — hướng dẫn thiết kế');
    expect(eventsOf(h.events, 'skill')[0].skill).toBe('artifacts');
    expect(Object.values(h.session.artifacts)).toHaveLength(1);
    expect(eventsOf(h.events, 'artifact')[0].title).toBe('Bảng điểm');
  });

  it('create_artifact bị từ chối khi tải script từ nguồn ngoài danh sách cho phép', async () => {
    const h = makeHarness([
      () => toolTurn([{ name: 'load_skill', input: { skill_name: 'artifacts' } }]),
      () => toolTurn([{ name: 'create_artifact', input: { title: 'X', type: 'html', content: '<script src="https://evil.example/x.js"></script>' } }]),
      () => textTurn('ok'),
    ]);
    await h.run('x');
    const res = lastToolResults(h.provider.requests[2].messages.at(-1)!)[0];
    expect(res.isError).toBe(true);
    expect(res.content).toContain('evil.example');
  });

  it('tái hiện kịch bản trong tài liệu: transcript có đủ nhiệm vụ → kỹ năng → công cụ → chữ', async () => {
    const h = makeHarness([
      () => toolTurn([{ id: 'c1', name: 'todo_write', input: { todos: [{ id: 't1', title: 'Gom điểm', status: 'in_progress' }] } }]),
      () => toolTurn([{ id: 'c2', name: 'load_skill', input: { skill_name: 'artifacts' } }]),
      () => toolTurn([{ id: 'c3', name: 'list_artifact_types', input: {} }]),
      () => textTurn('Đây là kết quả.'),
    ]);
    // todo còn dở khi kết thúc → engine nhắc một lần rồi cho qua
    h.provider['script'].push(() => textTurn('Xong hết.'));
    await h.run('so sánh');

    let view: ViewState = { transcript: [], todos: [], running: false, mode: 'default' } as unknown as ViewState;
    for (const ev of h.events) view = reduceView(view, ev);
    const a = view.transcript.find((i) => i.kind === 'assistant');
    expect(a && a.kind === 'assistant' && a.done).toBe(true);
    const kinds = a!.kind === 'assistant' ? a!.blocks.map((b) => b.type) : [];
    expect(kinds.indexOf('tasks')).toBeLessThan(kinds.indexOf('skill'));
    expect(kinds.indexOf('skill')).toBeLessThan(kinds.indexOf('text'));
    expect(kinds.filter((k) => k === 'tool')).toHaveLength(3);
    expect(view.todos[0].title).toBe('Gom điểm');
  });
});

describe('quyền và an toàn', () => {
  const files = { 'src/app.ts': 'const a = 1;\nconst b = 2;\n' };

  it('sửa tệp phải đọc trước', async () => {
    const h = makeHarness([() => toolTurn([{ name: 'edit_file', input: { path: 'src/app.ts', old_string: 'a = 1', new_string: 'a = 9' } }]), () => textTurn('ok')], { files });
    await h.run('sửa');
    const res = lastToolResults(h.provider.requests[1].messages.at(-1)!)[0];
    expect(res.isError).toBe(true);
    expect(res.content).toContain('read_file');
    expect(fs.readFileSync(path.join(h.dir, 'src/app.ts'), 'utf8')).toContain('a = 1');
  });

  it('chế độ mặc định hỏi trước khi sửa; từ chối thì tệp giữ nguyên', async () => {
    const h = makeHarness(
      [
        () => toolTurn([{ name: 'read_file', input: { path: 'src/app.ts' } }]),
        () => toolTurn([{ name: 'edit_file', input: { path: 'src/app.ts', old_string: 'a = 1', new_string: 'a = 9' } }]),
        () => textTurn('đã bị từ chối'),
      ],
      { files, decide: () => 'deny' },
    );
    await h.run('sửa');
    expect(h.permissionRequests).toHaveLength(1);
    expect(h.permissionRequests[0].kind).toBe('edit');
    expect(h.permissionRequests[0].diff?.added).toBe(1);
    expect(h.permissionRequests[0].diff?.removed).toBe(1);
    expect(fs.readFileSync(path.join(h.dir, 'src/app.ts'), 'utf8')).toContain('a = 1');
    const end = eventsOf(h.events, 'tool_end').find((e) => e.state === 'denied');
    expect(end).toBeTruthy();
  });

  it('"cho phép trong phiên này" nhớ lựa chọn cho các lần sửa sau', async () => {
    const h = makeHarness(
      [
        () => toolTurn([{ name: 'read_file', input: { path: 'src/app.ts' } }]),
        () => toolTurn([{ name: 'edit_file', input: { path: 'src/app.ts', old_string: 'a = 1', new_string: 'a = 9' } }]),
        () => toolTurn([{ name: 'edit_file', input: { path: 'src/app.ts', old_string: 'b = 2', new_string: 'b = 8' } }]),
        () => textTurn('xong'),
      ],
      { files, decide: () => 'allow_session' },
    );
    await h.run('sửa hai chỗ');
    expect(h.permissionRequests).toHaveLength(1); // lần hai không hỏi lại
    expect(fs.readFileSync(path.join(h.dir, 'src/app.ts'), 'utf8')).toBe('const a = 9;\nconst b = 8;\n');
    // sau khi duyệt, dòng công cụ phải quay lại trạng thái running rồi done
    const blocks = h.events.filter((e) => e.t === 'tool_start' && e.callId === 'call_1');
    expect(blocks.length).toBeGreaterThanOrEqual(1);
  });

  it('chế độ acceptEdits tự nhận sửa nhưng vẫn hỏi khi chạy lệnh', async () => {
    const h = makeHarness(
      [
        () => toolTurn([{ name: 'read_file', input: { path: 'src/app.ts' } }]),
        () => toolTurn([{ name: 'edit_file', input: { path: 'src/app.ts', old_string: 'a = 1', new_string: 'a = 2' } }]),
        () => toolTurn([{ name: 'run_command', input: { command: 'node --version && echo hi' } }]),
        () => textTurn('xong'),
      ],
      { files, decide: () => 'deny' },
    );
    h.session.mode = 'acceptEdits';
    await h.run('x');
    expect(h.permissionRequests.map((p) => p.kind)).toEqual(['command']);
    expect(fs.readFileSync(path.join(h.dir, 'src/app.ts'), 'utf8')).toContain('a = 2');
  });

  it('chế độ lập kế hoạch ẩn công cụ ghi và chặn gọi lén', async () => {
    const h = makeHarness([() => toolTurn([{ name: 'write_file', input: { path: 'x.txt', content: 'hi' } }]), () => textTurn('ok')], { files });
    h.session.mode = 'plan';
    await h.run('x');
    const names = h.provider.requests[0].tools.map((t) => t.name);
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('run_command');
    expect(names).not.toContain('edit_file');
    expect(names).toContain('exit_plan_mode');
    expect(names).toContain('read_file');
    const res = lastToolResults(h.provider.requests[1].messages.at(-1)!)[0];
    expect(res.isError).toBe(true);
    expect(fs.existsSync(path.join(h.dir, 'x.txt'))).toBe(false);
  });

  it('duyệt kế hoạch chuyển chế độ quyền', async () => {
    const h = makeHarness([() => toolTurn([{ name: 'exit_plan_mode', input: { plan: '1. Làm A\n2. Làm B' } }]), () => textTurn('bắt đầu')], {
      decide: (r) => (r.kind === 'plan' ? 'allow_session' : 'allow'),
    });
    h.session.mode = 'plan';
    await h.run('lập kế hoạch');
    expect(h.session.mode).toBe('acceptEdits');
    expect(eventsOf(h.events, 'mode')[0].mode).toBe('acceptEdits');
    expect(h.permissionRequests[0].planMarkdown).toContain('Làm A');
  });

  it('đọc tệp ngoài workspace phải hỏi', async () => {
    const h = makeHarness([() => toolTurn([{ name: 'read_file', input: { path: path.join(path.parse(process.cwd()).root, 'Windows', 'win.ini') } }]), () => textTurn('ok')], {
      decide: () => 'deny',
    });
    await h.run('x');
    expect(h.permissionRequests[0]?.kind).toBe('outside_workspace');
  });
});

describe('độ bền của vòng lặp', () => {
  it('đối số JSON hỏng → trả lỗi cho model, không chạy công cụ', async () => {
    const h = makeHarness([
      () => toolTurn([{ name: 'read_file', input: {}, rawArgs: '{"path": "a.t' }]),
      () => textTurn('ok'),
    ]);
    await h.run('x');
    const res = lastToolResults(h.provider.requests[1].messages.at(-1)!)[0];
    expect(res.isError).toBe(true);
    expect(res.content).toContain('JSON');
  });

  it('chạm max_tokens khi đang gọi công cụ → lệnh cuối không bao giờ được chạy', async () => {
    const h = makeHarness(
      [
        () => toolTurn([{ name: 'list_dir', input: {} }, { name: 'write_file', input: { path: 'big.txt', content: 'cụt' } }], { stopReason: 'max_tokens' }),
        () => textTurn('ok'),
      ],
      { files: { 'x.txt': '1' } },
    );
    await h.run('x');
    expect(fs.existsSync(path.join(h.dir, 'big.txt'))).toBe(false);
    const results = lastToolResults(h.provider.requests[1].messages.at(-1)!);
    expect(results[0].isError).toBe(false);
    expect(results[1].isError).toBe(true);
  });

  it('chặn vòng lặp vô ích khi gọi lại cùng một lệnh nhiều lần', async () => {
    const same = () => toolTurn([{ name: 'list_dir', input: { path: '.' } }]);
    const h = makeHarness([same, same, same, same, () => textTurn('thôi')], { files: { 'a.txt': '1' } });
    await h.run('x');
    const third = lastToolResults(h.provider.requests[3].messages.at(-1)!)[0];
    expect(third.isError).toBe(true);
    expect(third.content).toMatch(/đổi cách tiếp cận|Change your approach/);
  });

  it('hết số vòng → một lượt tóm tắt CẤM gọi công cụ nhưng vẫn gửi đủ định nghĩa (Anthropic bắt buộc khi lịch sử có tool_use)', async () => {
    const step = () => toolTurn([{ name: 'list_dir', input: { path: '.' } }]);
    const h = makeHarness([step, () => toolTurn([{ name: 'glob', input: { pattern: '*.txt' } }]), () => textTurn('Đã làm A, còn B.')], {
      settings: { maxTurns: 2 },
      files: { 'a.txt': '1' },
    });
    const r = await h.run('x');
    expect(r.stopReason).toBe('end_turn');
    expect(h.provider.requests[2].toolChoice).toBe('none');
    // Cùng bộ công cụ với các lượt trước: đổi danh sách công cụ làm hỏng khối suy luận đã ký.
    expect(h.provider.requests[2].tools.map((t) => t.name)).toEqual(h.provider.requests[1].tools.map((t) => t.name));
    expect(h.provider.requests[1].toolChoice).toBeUndefined();
    expect(eventsOf(h.events, 'notice').some((n) => n.level === 'warn')).toBe(true);
  });

  it('vòng chặn lặp: sau khi sửa tệp, đọc lại cùng tệp là chính đáng (không bị chặn)', async () => {
    const read = () => toolTurn([{ name: 'read_file', input: { path: 'a.txt' } }]);
    const edit = (o: string, n: string) => () => toolTurn([{ name: 'edit_file', input: { path: 'a.txt', old_string: o, new_string: n } }]);
    const h = makeHarness([read, edit('1', '2'), read, edit('2', '3'), read, edit('3', '4'), read, () => textTurn('xong')], { files: { 'a.txt': '1\n' } });
    await h.run('x');
    const reads = h.provider.requests.flatMap((r) => r.messages.flatMap((m) => lastToolResults(m))).filter((x) => x.name === 'read_file');
    expect(reads.every((x) => !x.isError)).toBe(true);
    expect(fs.readFileSync(path.join(h.dir, 'a.txt'), 'utf8')).toBe('4\n');
  });

  it('id công cụ lặp lại giữa các lượt được đổi tên để mỗi lệnh gọi là duy nhất', async () => {
    const h = makeHarness(
      [
        () => toolTurn([{ id: 'call_0', name: 'list_dir', input: { path: '.' } }]),
        () => toolTurn([{ id: 'call_0', name: 'glob', input: { pattern: '*.txt' } }]),
        () => textTurn('xong'),
      ],
      { files: { 'a.txt': '1' } },
    );
    await h.run('x');
    const ids = h.session.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_use').map((b) => (b as { id: string }).id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    const starts = eventsOf(h.events, 'tool_start').map((e) => e.callId);
    expect(new Set(starts).size).toBe(starts.length);
  });

  it('dừng giữa chừng khi công cụ đang chạy: lịch sử vẫn hợp lệ (mọi tool_use đều có kết quả)', async () => {
    const h = makeHarness([() => toolTurn([{ name: 'run_command', input: { command: 'node -e "setTimeout(()=>{},30000)"' } }]), () => textTurn('không tới đây')]);
    const ctl = new AbortController();
    const p = h.run('chạy lệnh dài', ctl.signal);
    setTimeout(() => ctl.abort(), 1500);
    const r = await p;
    expect(r.stopReason).toBe('aborted');
    const last = h.session.messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(lastToolResults(last)).toHaveLength(1);
    expect(h.events.at(-1)).toMatchObject({ t: 'assistant_end', stopReason: 'aborted' });
  }, 30_000);

  it('lỗi xác thực → thông báo rõ ràng, không treo', async () => {
    const h = makeHarness([
      () => {
        throw new ProviderError('401', { kind: 'auth', providerId: 'fake', status: 401 });
      },
    ]);
    const r = await h.run('x');
    expect(r.stopReason).toBe('error');
    const n = eventsOf(h.events, 'notice')[0];
    expect(n.level).toBe('error');
    expect(n.text).toContain('API');
  });

  it('tràn ngữ cảnh → nén lịch sử rồi gọi lại, bỏ khối suy luận cũ', async () => {
    const h = makeHarness([
      () => {
        throw new ProviderError('too long', { kind: 'context_length', providerId: 'fake', status: 400 });
      },
      () => textTurn('Đã tiếp tục'),
    ]);
    h.provider.completeImpl = async () => 'Tóm tắt: người dùng đã hỏi 4 câu.';
    for (let i = 0; i < 4; i++) {
      h.session.messages.push({ role: 'user', content: [{ type: 'text', text: `câu hỏi ${i}` }] });
      h.session.messages.push({ role: 'assistant', content: [{ type: 'thinking', text: 'nghĩ', provider: 'fake' }, { type: 'text', text: `trả lời ${i}` }] });
    }
    const r = await h.run('câu hỏi mới');
    expect(r.stopReason).toBe('end_turn');
    expect(h.provider.requests[1].historyEdited).toBe(true);
    const first = h.provider.requests[1].messages[0];
    expect(first.content[0]).toMatchObject({ type: 'text' });
    expect((first.content[0] as any).text).toContain('Tóm tắt');
    const anyThinking = h.provider.requests[1].messages.some((m) => m.content.some((b) => b.type === 'thinking'));
    expect(anyThinking).toBe(false);
    expect(h.session.historyEdited).toBe(false); // đã gửi đi một lần rồi hạ cờ
  });

  it('nhắc khi còn tác vụ dở lúc kết thúc; model làm xong ngay sau lời nhắc đầu thì chỉ nhắc ĐÚNG MỘT lần', async () => {
    // CẬP NHẬT CÓ CHỦ ĐÍCH (0.6.31): trước đây kịch bản chỉ có `textTurn('Đã cập nhật.')` sau lời nhắc và test vẫn xanh vì việc dở chỉ
    // được nhắc một lần rồi lượt kết thúc im lặng. Nay việc dở còn nguyên thì bị nhắc LẠI (lần 3 thì báo người dùng — xem gateFinal.test.ts),
    // nên model phải thật sự cập nhật todo_write; khi đó vẫn đúng một lời nhắc.
    const h = makeHarness([
      () => toolTurn([{ name: 'todo_write', input: { todos: [{ id: 't1', title: 'Việc dở', status: 'in_progress' }] } }]),
      () => textTurn('Xong rồi.'),
      () => toolTurn([{ name: 'todo_write', input: { todos: [{ id: 't1', title: 'Việc dở', status: 'completed' }] } }]),
      () => textTurn('Đã cập nhật.'),
    ]);
    await h.run('x');
    expect(h.provider.requests).toHaveLength(4);
    const nudge = h.provider.requests[2].messages.at(-1)!;
    expect(nudge.synthetic).toBe(true);
    expect((nudge.content[0] as any).text).toContain('todo_write');
    expect((nudge.content[0] as any).text).toMatch(/^\[nhắc lần 1\]/);
    expect(h.session.messages.filter((m) => m.synthetic)).toHaveLength(1); // đã xong thì không còn lời nhắc thứ hai
  });
});

describe('Stream Interceptor + Summarizer', () => {
  const think = (n: number) => Array.from({ length: n }, (_, i) => ({ type: 'thinking_delta' as const, text: `Đang đối chiếu điểm số chỉ số ${i} giữa hai phiên bản bảng xếp hạng cần kiểm tra. ` }));

  it('gom luồng suy nghĩ thành dòng trạng thái do model nhỏ tóm tắt', async () => {
    const h = makeHarness([() => [...think(40), ...textTurn('Kết quả.')]], { summarizer: true });
    h.provider.completeImpl = async () => '"Đang đối chiếu điểm số giữa các phiên bản."';
    await h.run('x');
    const pills = eventsOf(h.events, 'pill');
    expect(pills.some((p) => p.text === 'Đang đối chiếu điểm số giữa các phiên bản.')).toBe(true);
    expect(eventsOf(h.events, 'thinking').length).toBe(40);
    // bộ tóm tắt luôn nhận yêu cầu "fast" và không bao giờ nhận quá nhiều ký tự
    expect(h.provider.completes.every((c) => c.fast === true)).toBe(true);
    expect(h.provider.completes[0].prompt.length).toBeLessThan(2400);
  });

  it('không có bộ tóm tắt vẫn hiện dòng "Đang suy nghĩ…" chung', async () => {
    const h = makeHarness([() => [...think(3), ...textTurn('ok')]]);
    await h.run('x');
    const pills = eventsOf(h.events, 'pill');
    expect(pills).toHaveLength(1);
    expect(pills[0].text).toBe('Đang suy nghĩ…');
  });

  it('giai đoạn viết mã: dòng "Đang viết <tên tệp>…" khi đối số công cụ đang chảy', async () => {
    const h = makeHarness([
      () => toolTurn([{ name: 'write_file', input: { path: 'src/bang.ts', content: 'x'.repeat(50) } }]),
      () => textTurn('ok'),
    ]);
    await h.run('viết');
    const pills = eventsOf(h.events, 'pill');
    expect(pills.some((p) => p.kind === 'writing' && p.text.includes('src/bang.ts'))).toBe(true);
  });

  it('bộ tóm tắt lỗi liên tiếp → tự ngắt, không làm hỏng câu trả lời', async () => {
    const h = makeHarness([() => [...think(60), ...textTurn('Vẫn trả lời được.')]], { summarizer: true });
    h.provider.completeImpl = async () => {
      throw new Error('boom');
    };
    const r = await h.run('x');
    expect(r.stopReason).toBe('end_turn');
    expect(h.provider.completes.length).toBeLessThanOrEqual(3);
  });

  it('tách thẻ <think> bị chẻ đôi giữa các gói dữ liệu', async () => {
    const chunks = ['<thin', 'king>kế hoạch: ', 'đọc tệp</thin', 'king>\nXin ', 'chào'];
    const events = [
      ...chunks.map((c) => ({ type: 'text_delta' as const, text: c })),
      { type: 'done' as const, stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 }, message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: chunks.join('') }] } },
    ];
    const h = makeHarness([() => events], { thinkTags: true });
    await h.run('x');
    expect(eventsOf(h.events, 'thinking').map((e) => e.delta).join('')).toBe('kế hoạch: đọc tệp');
    expect(eventsOf(h.events, 'text').map((e) => e.delta).join('')).toBe('Xin chào');
    const stored = h.session.messages.at(-1)!;
    expect(stored.content.map((b) => b.type)).toEqual(['thinking', 'text']);
    expect((stored.content[1] as any).text).toBe('Xin chào');
  });
});

describe('khối suy luận đã ký (Anthropic "preserved thinking")', () => {
  const THINK: ChatMessage['content'][number] = { type: 'thinking', text: 'suy nghĩ', signature: 'SIG', provider: 'fake' };
  const turnWithThinking = (text: string, extra: Record<string, unknown> = {}) => (): ProviderEvent[] => [
    { type: 'text_delta', text },
    { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 }, message: { role: 'assistant', content: [THINK, { type: 'text', text }] }, ...extra } as ProviderEvent,
  ];
  const hasThinking = (messages: ChatMessage[]) => messages.some((m) => m.content.some((b) => b.type === 'thinking'));
  const boundProvider = (steps: Array<() => ProviderEvent[]>) => {
    const p = new FakeProvider(steps);
    Object.assign(p.capabilities, { thinkingBoundToPrefix: true });
    return p;
  };

  it('system/công cụ đổi giữa chừng (duyệt kế hoạch…) → xoá suy luận cũ khỏi lịch sử ĐÃ LƯU trước khi gửi', async () => {
    const h = makeHarness([], { provider: boundProvider([turnWithThinking('lượt một'), turnWithThinking('lượt hai')]) });
    await h.run('một');
    expect(hasThinking(h.session.messages)).toBe(true);
    h.session.mode = 'plan'; // đổi <mode> trong system prompt và bộ công cụ
    await h.run('hai');
    expect(h.provider.requests[1].historyEdited).toBe(true);
    expect(hasThinking(h.provider.requests[1].messages)).toBe(false); // thứ thực sự gửi đi
    // Khối mới của lượt hai (sinh ra khi không có khối cũ) được giữ; lượt một không còn.
    const kept = h.session.messages.filter((m) => m.role === 'assistant').map((m) => m.content.some((b) => b.type === 'thinking'));
    expect(kept).toEqual([false, true]);
  });

  it('system/công cụ KHÔNG đổi → giữ suy luận (không cắt vô cớ)', async () => {
    const h = makeHarness([], { provider: boundProvider([turnWithThinking('lượt một'), turnWithThinking('lượt hai')]) });
    await h.run('một');
    await h.run('hai');
    expect(h.provider.requests[1].historyEdited).toBe(false);
    expect(hasThinking(h.provider.requests[1].messages)).toBe(true);
  });

  it('hãng không ràng buộc suy luận vào tiền tố → không bao giờ tự cắt', async () => {
    const h = makeHarness([turnWithThinking('lượt một'), turnWithThinking('lượt hai')]);
    await h.run('một');
    h.session.mode = 'plan';
    await h.run('hai');
    expect(hasThinking(h.provider.requests[1].messages)).toBe(true);
  });

  it('adapter báo đã bỏ suy luận cũ để API chấp nhận → engine xoá chúng khỏi lịch sử đã lưu', async () => {
    const h = makeHarness([turnWithThinking('lượt một'), turnWithThinking('lượt hai', { droppedReplayedThinking: true })]);
    await h.run('một');
    await h.run('hai');
    const flags = h.session.messages.filter((m) => m.role === 'assistant').map((m) => m.content.some((b) => b.type === 'thinking'));
    expect(flags).toEqual([false, true]);
  });

  it('nén thủ công thất bại (sai khoá, mất mạng…) → báo đúng lỗi thay vì "không có gì để nén"', async () => {
    const h = makeHarness([() => textTurn('a'), () => textTurn('b'), () => textTurn('c')]);
    await h.run('một');
    await h.run('hai');
    await h.run('ba');
    h.provider.completeImpl = async () => {
      throw new Error('401 sai khoá');
    };
    await expect(h.engine.compactNow(h.session, new AbortController().signal)).rejects.toThrow(/Không nén được.*401 sai khoá/);
  });
});

describe('cắt tỉa kết quả công cụ cũ', () => {
  it('chỉ bỏ ảnh khỏi kết quả ngắn (saved = 0) vẫn đánh dấu lịch sử đã sửa và xoá suy luận', () => {
    const session = newSession({ id: 's', provider: 'fake', model: 'm' });
    const img = { type: 'image' as const, mediaType: 'image/png', data: 'AAAA' };
    for (let i = 0; i < 8; i++) {
      session.messages.push({ role: 'assistant', content: [{ type: 'thinking', text: 't', signature: 's', provider: 'fake' }, { type: 'tool_use', id: `c${i}`, name: 'read_file', input: {} }] });
      session.messages.push({ role: 'user', content: [{ type: 'tool_result', toolUseId: `c${i}`, name: 'read_file', content: 'ngắn', images: i === 0 ? [img] : undefined }] });
    }
    const saved = pruneOldToolResults(session);
    expect(saved).toBeGreaterThan(0);
    expect(session.historyEdited).toBe(true);
    expect(session.messages.some((m) => m.content.some((b) => b.type === 'thinking'))).toBe(false);
    expect((session.messages[1].content[0] as ToolResultBlock).images).toBeUndefined();
  });

  it('không có gì để cắt thì không đụng tới lịch sử', () => {
    const session = newSession({ id: 's', provider: 'fake', model: 'm' });
    session.messages.push({ role: 'assistant', content: [{ type: 'thinking', text: 't', signature: 's', provider: 'fake' }, { type: 'text', text: 'x' }] });
    expect(pruneOldToolResults(session)).toBe(0);
    expect(session.historyEdited).toBe(false);
    expect(session.messages[0].content).toHaveLength(2);
  });
});

describe('suy luận đã ký: chỉ xoá ở ranh giới lượt, không bao giờ giữa vòng công cụ', () => {
  const THINK: ChatMessage['content'][number] = { type: 'thinking', text: 'suy nghĩ', signature: 'SIG', provider: 'fake' };
  const withThinking = (events: ProviderEvent[]): ProviderEvent[] =>
    events.map((e) => (e.type === 'done' ? { ...e, message: { ...e.message, content: [THINK, ...e.message.content] } } : e));
  const hasThinking = (messages: ChatMessage[]) => messages.some((m) => m.content.some((b) => b.type === 'thinking'));

  it('system/công cụ đổi GIỮA vòng công cụ → giữ nguyên suy luận; ranh giới kế tiếp mới xoá (một lần)', async () => {
    let h!: ReturnType<typeof makeHarness>;
    const provider = new FakeProvider([
      () => {
        h.session.mode = 'plan'; // đổi system + công cụ ngay khi phục vụ lần gọi đầu → lần gọi thứ hai (giữa vòng) thấy bản mới
        return withThinking(toolTurn([{ name: 'list_dir', input: { path: '.' } }]));
      },
      () => withThinking(textTurn('xong lượt một')),
      () => withThinking(textTurn('lượt hai')),
    ]);
    Object.assign(provider.capabilities, { thinkingBoundToPrefix: true });
    h = makeHarness([], { provider, files: { 'a.txt': '1' } });

    await h.run('một');
    expect(h.provider.requests[1].historyEdited).toBe(false);
    expect(hasThinking(h.provider.requests[1].messages)).toBe(true); // tin nhắn assistant đang chờ tool_result giữ khối suy luận

    await h.run('hai'); // ranh giới: system/công cụ đã khác vân tay cũ → xoá suy luận cũ một lần
    expect(h.provider.requests[2].historyEdited).toBe(true);
    expect(hasThinking(h.provider.requests[2].messages)).toBe(false);
  });
});
