import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { textTurn } from '../../helpers/fakeProvider';
import { cleanupDirs, harness } from './harness';

afterEach(() => cleanupDirs());

const FILES = {
  'README.md': '# demo',
  'src/app.ts': 'export const app = 1;',
  'src/util/helpers.ts': 'export const h = 2;',
  'src/util/strings.ts': 'export const s = 3;',
  'docs/Hướng dẫn.md': 'nội dung',
  'node_modules/pkg/index.js': 'x',
  'sample.txt': 'ALPHA\nBETA\n',
};

describe('complete({kind:"file"})', () => {
  it('khớp theo tên tệp, đoạn đường dẫn, không phân biệt hoa/thường và dấu; bỏ node_modules', async () => {
    const h = await harness({ files: FILES, script: [] });
    const labels = async (q: string, limit?: number) => (await h.rt.complete({ kind: 'file', query: q, limit })).map((c) => c.label);
    expect((await labels('app'))[0]).toBe('src/app.ts');
    expect(await labels('HELPERS')).toContain('src/util/helpers.ts');
    expect((await labels('readme'))[0]).toBe('README.md');
    expect(await labels('huong dan')).toContain('docs/Hướng dẫn.md');
    expect((await labels('index'))).not.toContain('node_modules/pkg/index.js');
    expect(await labels('sutil')).toEqual(expect.arrayContaining(['src/util/strings.ts'])); // chuỗi con theo thứ tự (fuzzy)
    expect(await labels('src/u')).toEqual(expect.arrayContaining(['src/util/']));
    expect((await labels('', 3)).length).toBeLessThanOrEqual(3);
    const c = (await h.rt.complete({ kind: 'file', query: '@app' }))[0];
    expect(c.insert).toBe('@src/app.ts ');
    const sp = (await h.rt.complete({ kind: 'file', query: 'Hướng' }))[0];
    expect(sp.insert).toBe('@"docs/Hướng dẫn.md" ');
    expect(await labels('zzzkhongco')).toEqual([]);
    await h.cleanup();
  });

  it('git ls-files được ưu tiên: tôn trọng .gitignore', async () => {
    const h = await harness({ files: { ...FILES, '.gitignore': 'secret.txt\n', 'secret.txt': 's', 'public.txt': 'p' }, script: [] });
    const { spawnSync } = await import('node:child_process');
    if (spawnSync('git', ['--version']).status !== 0) return; // máy không có git: bỏ qua (đường quét thư mục đã kiểm ở test trên)
    spawnSync('git', ['init', '-q'], { cwd: h.cwd });
    const labels = (await h.rt.complete({ kind: 'file', query: 'txt' })).map((c) => c.label);
    expect(labels).toContain('public.txt');
    // .gitignore cũng được quét-thư-mục tôn trọng
    expect(labels).not.toContain('secret.txt');
    await h.cleanup();
  });

  it('đệm ~5 giây: tệp mới tạo trong 5 giây chưa chắc thấy, nhưng sau `!lệnh` thì thấy ngay', async () => {
    const h = await harness({ files: FILES, script: [] });
    await h.rt.complete({ kind: 'file', query: 'app' });
    fs.writeFileSync(path.join(h.cwd, 'moi-tao.ts'), 'x');
    await h.rt.submit('!echo xong');
    await h.rt.idle();
    expect((await h.rt.complete({ kind: 'file', query: 'moi-tao' })).map((c) => c.label)).toContain('moi-tao.ts');
    await h.cleanup();
  });
});

describe('complete({kind:"slash"}) và slashCommands()', () => {
  it('liệt kê lệnh dựng sẵn với mô tả tiếng Việt và lọc theo tiền tố', async () => {
    const h = await harness({ script: [] });
    const names = h.rt.slashCommands().map((c) => c.name);
    for (const n of ['help', 'clear', 'new', 'compact', 'context', 'cost', 'model', 'mode', 'thinking', 'status', 'login', 'logout', 'whoami', 'resume', 'sessions', 'exit', 'quit', 'config', 'doctor', 'update', 'theme', 'export', 'copy']) {
      expect(names).toContain(n);
    }
    expect(h.rt.slashCommands().find((c) => c.name === 'compact')!.description).toMatch(/[Nn]én/);
    const co = (await h.rt.complete({ kind: 'slash', query: '/co' })).map((c) => c.label);
    expect(co).toEqual(expect.arrayContaining(['/compact', '/config', '/context', '/cost']));
    expect(co).not.toContain('/help');
    expect((await h.rt.complete({ kind: 'slash', query: 'model' }))[0].insert).toBe('/model ');
    await h.cleanup();
  });

  it('mô tả theo ngôn ngữ en khi lang:"en"', async () => {
    const h = await harness({ script: [], lang: 'en' });
    expect(h.rt.slashCommands().find((c) => c.name === 'compact')!.description).toMatch(/Compact/);
    expect(h.rt.helpText()).toContain('Shortcuts');
    await h.cleanup();
  });
});

describe('!lệnh', () => {
  it('chạy shell trực tiếp, in kết quả và ghi vào ngữ cảnh như ghi chú cho tin kế tiếp', async () => {
    const h = await harness({ script: [() => textTurn('đã thấy')] });
    await h.rt.submit('!echo xin-chao-shell');
    expect(h.outputs().join('\n')).toContain('xin-chao-shell');
    expect(h.provider.requests).toHaveLength(0); // không gửi cho model
    await h.rt.submit('kết quả lệnh vừa rồi là gì?');
    await h.rt.idle();
    const sent = JSON.stringify(h.provider.requests[0].messages);
    expect(sent).toContain('xin-chao-shell');
    expect(sent).toContain('attached_shell');
    // người dùng chỉ thấy chữ họ gõ
    const user = h.events.filter((e) => e.t === 'ui' && e.ev.t === 'user').pop() as unknown as { ev: { text: string } };
    expect(user.ev.text).toBe('kết quả lệnh vừa rồi là gì?');
    await h.cleanup();
  });

  it('lệnh lỗi hiện mã thoát; "!" trống chỉ nhắc', async () => {
    const h = await harness({ script: [] });
    await h.rt.submit('!node -e "process.exit(3)"');
    const out = h.events.filter((e) => e.t === 'output').pop() as { text: string; kind?: string };
    expect(out.text).toContain('exit 3');
    expect(out.kind).toBe('error');
    await h.rt.submit('!');
    expect(h.toasts().join(' ')).toMatch(/!git status/);
    await h.cleanup();
  });
});

describe('@tệp trong tin nhắn', () => {
  it('mở rộng @đường-dẫn thành nội dung tệp; @tên-không-có và email để nguyên', async () => {
    const h = await harness({ files: FILES, script: [() => textTurn('ok')] });
    await h.rt.submit('xem @sample.txt và @khong-co.txt, gửi tới a@b.com và @src/util');
    await h.rt.idle();
    const sent = JSON.stringify(h.provider.requests[0].messages);
    expect(sent).toContain('ALPHA');
    expect(sent).toContain('attached_file');
    expect(sent).toContain('attached_folder');
    expect(sent).toContain('helpers.ts');
    expect(sent).not.toContain('khong-co.txt"'); // không có chip cho tệp không tồn tại
    await h.cleanup();
  });

  it('@tệp#L1-1 đính kèm đúng dòng', async () => {
    const h = await harness({ script: [() => textTurn('ok')] });
    await h.rt.submit('đọc @sample.txt#L2-2');
    await h.rt.idle();
    const sent = JSON.stringify(h.provider.requests[0].messages);
    expect(sent).toContain('attached_selection');
    expect(sent).toContain('BETA');
    await h.cleanup();
  });

  it('ảnh đính kèm đi vào nội dung gửi model; ảnh quá 5 MB bị bỏ kèm cảnh báo', async () => {
    const h = await harness({ script: [() => textTurn('ok')] });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64').toString('base64');
    await h.rt.submit('ảnh này là gì', { attachments: [{ kind: 'image', name: 'a.png', mediaType: 'image/png', data: png }] });
    await h.rt.idle();
    expect(JSON.stringify(h.provider.requests[0].messages)).toContain(png.slice(0, 40));
    const big = Buffer.alloc(6 * 1024 * 1024, 1).toString('base64');
    await h.rt.submit('ảnh to', { attachments: [{ kind: 'image', name: 'big.png', mediaType: 'image/png', data: big }] });
    await h.rt.idle();
    expect(h.events.some((e) => e.t === 'ui' && e.ev.t === 'notice' && /5 MB/.test((e.ev as { text: string }).text))).toBe(true);
    await h.cleanup();
  });
});

describe('lệnh gạch chéo dựng sẵn', () => {
  it('/help, /status, /cost, /context, /config in kết quả; lệnh lạ báo lỗi; đường dẫn /tmp/x là tin thường', async () => {
    const h = await harness({ script: [() => textTurn('ok')] });
    await h.rt.submit('/help');
    expect(h.outputs().pop()).toContain('/compact');
    await h.rt.submit('/status');
    expect(h.outputs().pop()).toContain('test-model');
    await h.rt.submit('/cost');
    await h.rt.submit('/context');
    expect(h.outputs().length).toBeGreaterThanOrEqual(4);
    await h.rt.submit('/config');
    expect(h.outputs().pop()).toContain('settings.json');
    await h.rt.submit('/khongcolenhnay');
    const last = h.events.filter((e) => e.t === 'output').pop() as { text: string; kind?: string };
    expect(last.kind).toBe('error');
    expect(last.text).toContain('khongcolenhnay');
    expect(h.provider.requests).toHaveLength(0);
    await h.rt.submit('/tmp/log.txt có gì?');
    await h.rt.idle();
    expect(h.provider.requests).toHaveLength(1);
    await h.cleanup();
  });

  it('/mode, /thinking đổi trạng thái; /model đổi model; /clear = phiên mới + replay rỗng; /exit phát action exit', async () => {
    const h = await harness({ script: [() => textTurn('ok')] });
    await h.rt.submit('/mode acceptEdits');
    expect(h.rt.status().mode).toBe('acceptEdits');
    await h.rt.submit('/mode bypass'); // chưa bật → từ chối
    expect(h.rt.status().mode).toBe('acceptEdits');
    expect(h.rt.cycleMode()).toBe('plan');
    expect(h.rt.cycleMode()).toBe('default');
    await h.rt.submit('/thinking high');
    expect(h.rt.status().thinking).toBe('high');
    await h.rt.submit('/thinking vô-cực');
    expect(h.rt.status().thinking).toBe('high');
    await h.rt.submit('/model otro-model');
    expect(h.rt.status().model).toBe('otro-model');
    await h.rt.submit('/model'); // không đối số + tương tác → hộp chọn; huỷ (Esc)
    const ask = h.events.find((e) => e.t === 'ask') as { ask: { id: string; kind: string; items?: Array<{ id: string; current?: boolean }> } } | undefined;
    expect(ask?.ask.kind).toBe('pick');
    expect(ask!.ask.items!.some((i) => i.current)).toBe(true);
    h.rt.answer(ask!.ask.id, null);
    await h.rt.submit('chào');
    await h.rt.idle();
    const id = h.rt.status().sessionId;
    await h.rt.submit('/clear');
    expect(h.rt.status().sessionId).not.toBe(id);
    const rep = h.events.filter((e) => e.t === 'replay').pop() as { items: unknown[]; reason: string };
    expect(rep).toMatchObject({ items: [], reason: 'clear' });
    await h.rt.submit('/exit');
    expect(h.events.some((e) => e.t === 'action' && e.action === 'exit')).toBe(true);
    await h.cleanup();
  });

  it('/export ghi Markdown vào thư mục làm việc; /copy phát action copy với câu trả lời cuối', async () => {
    const h = await harness({ script: [() => textTurn('Câu trả lời để sao chép')] });
    await h.rt.submit('/export');
    expect(h.outputs().pop()).toMatch(/Chưa có gì để xuất/);
    await h.rt.submit('hỏi');
    await h.rt.idle();
    await h.rt.submit('/export bao-cao.md');
    const md = fs.readFileSync(path.join(h.cwd, 'bao-cao.md'), 'utf8');
    expect(md).toContain('## Bạn');
    expect(md).toContain('Câu trả lời để sao chép');
    await h.rt.submit('/copy');
    const copy = h.events.find((e) => e.t === 'action' && e.action === 'copy') as { payload?: string };
    expect(copy.payload).toBe('Câu trả lời để sao chép');
    await h.cleanup();
  });

  it('/paste và /image phát action paste_image khi đang tương tác; ngoài giao diện thì giải thích thay vì im lặng', async () => {
    const h = await harness({ script: [] });
    expect(h.rt.slashCommands().map((c) => c.name)).toEqual(expect.arrayContaining(['paste', 'image']));
    await h.rt.submit('/paste');
    await h.rt.submit('/image');
    expect(h.events.filter((e) => e.t === 'action' && e.action === 'paste_image')).toHaveLength(2);
    await h.cleanup();
    const p = await harness({ script: [], interactive: false });
    await p.rt.submit('/paste');
    expect(p.events.some((e) => e.t === 'action' && e.action === 'paste_image')).toBe(false);
    expect(p.outputs().pop()).toMatch(/giao diện tương tác/);
    await p.cleanup();
  });

  it('/config đặt và đọc cài đặt người dùng; /theme phát redraw; /whoami khi chưa đăng nhập', async () => {
    const h = await harness({ script: [] });
    await h.rt.submit('/config agent.maxTurns 12');
    expect(h.rt.settings!.get('agent.maxTurns', 0)).toBe(12);
    await h.rt.submit('/config agent.maxTurns');
    expect(h.outputs().pop()).toContain('12');
    await h.rt.submit('/config unset agent.maxTurns');
    expect(h.rt.settings!.get('agent.maxTurns', 0)).toBe(0);
    await h.rt.submit('/theme dark');
    expect(h.events.some((e) => e.t === 'action' && e.action === 'redraw' && e.payload === 'theme:dark')).toBe(true);
    await h.rt.submit('/whoami');
    expect(h.outputs().pop()).toMatch(/test-model/);
    await h.cleanup();
  });

  it('lệnh cần rảnh bị từ chối khi đang chạy, lệnh chỉ-đọc vẫn chạy được', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = await harness({
      script: [
        async () => {
          await gate;
          return textTurn('xong');
        },
      ],
    });
    await h.rt.submit('việc dài');
    await new Promise((r) => setTimeout(r, 30));
    await h.rt.submit('/clear');
    expect(h.toasts().join(' ')).toMatch(/đang bận|busy/i);
    await h.rt.submit('/status');
    expect(h.outputs().pop()).toContain('test-model');
    release();
    await h.rt.idle();
    await h.cleanup();
  });

  it('/doctor chạy được không cần mạng khi dùng providerOverride', async () => {
    const h = await harness({ script: [] });
    await h.rt.submit('/doctor');
    const out = h.outputs().pop()!;
    expect(out).toContain('Node.js');
    expect(out).toContain('Nhật ký');
    await h.cleanup();
  });

  it('/update so sánh phiên bản từ PyPI giả', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ info: { version: '99.0.0' } }), { status: 200 })) as unknown as typeof fetch;
    const h = await harness({ script: [], fetchImpl });
    await h.rt.submit('/update');
    expect(h.outputs().pop()).toContain('99.0.0');
    await h.cleanup();
  });
});
