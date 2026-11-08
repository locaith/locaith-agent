import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { outputStyleBlock } from '../../../src/core/commands/outputStyles';
import { memoryFeature, memoryPaths } from '../../../src/cli/runtime/features/memory';
import { reviewFeature } from '../../../src/cli/runtime/features/review';
import { getPath, readJsonFile } from '../../../src/cli/runtime/features/settingsFile';
import { FakeFeatureContext, writeFile } from './helpers';

let ctx: FakeFeatureContext;
afterEach(async () => {
  await ctx?.dispose();
  ctx?.cleanup();
});

describe('/memory và /init', () => {
  it('liệt kê các tệp, chọn một tệp → tạo mẫu nếu chưa có và yêu cầu mở bằng $EDITOR', async () => {
    ctx = new FakeFeatureContext();
    writeFile(path.join(ctx.cwd, 'AGENTS.md'), 'x');
    await ctx.attach(memoryFeature);
    ctx.askAnswers = ['project'];
    const out = await ctx.runSlash('memory');
    expect(out).toContain('LOCAITH.md (dự án)');
    expect(out).toContain('chưa có');
    expect(out).toContain('AGENTS.md');
    const paths = memoryPaths(ctx);
    expect(fs.existsSync(paths.project)).toBe(true);
    expect(fs.readFileSync(paths.project, 'utf8')).toContain('Hướng dẫn cho Locaith');
    expect(ctx.events.find((e) => e.t === 'action')).toMatchObject({ action: 'open_editor', payload: paths.project });
    expect(ctx.slashNamed('memory').needsIdle).toBe(false);
    // không tương tác: chỉ liệt kê, không hỏi
    ctx.interactive = false;
    ctx.asks.length = 0;
    await ctx.runSlash('memory');
    expect(ctx.asks).toHaveLength(0);
  });

  it('/memory add thêm dòng vào chỉ mục ký ức (dự án và cá nhân); /memory show in nội dung', async () => {
    ctx = new FakeFeatureContext();
    await ctx.attach(memoryFeature);
    const out = await ctx.runSlash('memory', 'add Luôn dùng pnpm, không dùng npm');
    expect(out).toContain('Đã ghi nhớ');
    const p = memoryPaths(ctx);
    const text = fs.readFileSync(p.mem, 'utf8');
    expect(text).toContain('# Ký ức');
    expect(text).toMatch(/- \[\d{4}-\d{2}-\d{2}\] Luôn dùng pnpm, không dùng npm\n$/);
    await ctx.runSlash('memory', 'add user Tôi thích câu trả lời ngắn');
    expect(fs.readFileSync(p['mem-user'], 'utf8')).toContain('Tôi thích câu trả lời ngắn');
    expect(await ctx.runSlash('memory', 'show mem')).toContain('pnpm');
    expect(await ctx.runSlash('memory', 'show khong')).toMatch(/Không có tệp/);
    expect(await ctx.runSlash('memory', 'add')).toMatch(/Cú pháp/);
    ctx.trusted = false;
    expect(await ctx.runSlash('memory', 'add x')).toMatch(/chưa được tin cậy/);
  });

  it('/init chạy MỘT lượt agent với prompt quét dự án; đã có LOCAITH.md thì hỏi trước', async () => {
    ctx = new FakeFeatureContext();
    writeFile(path.join(ctx.cwd, 'CLAUDE.md'), 'quy ước cũ');
    await ctx.attach(memoryFeature);
    await ctx.runSlash('init');
    expect(ctx.prompts).toHaveLength(1);
    expect(ctx.prompts[0].text).toContain('create a LOCAITH.md');
    expect(ctx.prompts[0].text).toContain('CLAUDE.md');
    expect(ctx.prompts[0].text).toMatch(/SINGLE test/);

    writeFile(path.join(ctx.cwd, 'LOCAITH.md'), '# có sẵn');
    ctx.askAnswers = [false];
    expect(await ctx.runSlash('init')).toMatch(/Giữ nguyên/);
    expect(ctx.prompts).toHaveLength(1);
    ctx.askAnswers = [true];
    await ctx.runSlash('init');
    expect(ctx.prompts[1].text).toContain('IMPROVE');
    ctx.interactive = false;
    expect(await ctx.runSlash('init')).toMatch(/Đã có LOCAITH.md/);
    expect(ctx.prompts).toHaveLength(2);
    ctx.interactive = true;
    ctx.trusted = false;
    expect(await ctx.runSlash('init')).toMatch(/chưa được tin cậy/);
  });
});

describe('/review, /simplify, /security-review', () => {
  it('mỗi lệnh chạy một lượt với prompt đúng và nhận đối số', async () => {
    ctx = new FakeFeatureContext();
    await ctx.attach(reviewFeature);
    await ctx.runSlash('review', 'main...HEAD');
    await ctx.runSlash('simplify', 'src/a.ts');
    await ctx.runSlash('security-review');
    expect(ctx.prompts).toHaveLength(3);
    expect(ctx.prompts[0].text).toContain('DO NOT modify any file');
    expect(ctx.prompts[0].text).toContain('main...HEAD');
    expect(ctx.prompts[1].text).toContain('APPLY');
    expect(ctx.prompts[2].text).toContain('security review');
    for (const n of ['review', 'simplify', 'security-review']) {
      const d = ctx.slashNamed(n);
      expect(d.description.vi.length).toBeGreaterThan(5);
      expect(d.description.en.length).toBeGreaterThan(5);
      expect(d.argHint).toBeTruthy();
      expect(d.needsIdle).toBe(true);
    }
  });
});

describe('/output-style', () => {
  it('liệt kê, chọn cho phiên (engine nhận qua session.outputStyle), --save ghi cài đặt người dùng, phong cách tuỳ chỉnh từ thư mục', async () => {
    ctx = new FakeFeatureContext();
    writeFile(path.join(ctx.home, '.locaith', 'output-styles', 'vui-ve.md'), '---\nname: vui-ve\ndescription: Giọng vui vẻ\n---\nHãy nói chuyện vui vẻ, dùng ví dụ đời thường.');
    await ctx.attach(reviewFeature);
    const list = await ctx.runSlash('output-style');
    for (const n of ['default', 'explanatory', 'learning', 'concise', 'vui-ve']) expect(list).toContain(n);
    expect(list).toMatch(/● \*\*default\*\*/);

    expect(await ctx.runSlash('output-style', 'concise')).toMatch(/\*\*concise\*\*/);
    expect(ctx.session().outputStyle?.name).toBe('concise');
    expect(outputStyleBlock(ctx.session().outputStyle)).toContain('<output_style name="concise">');

    await ctx.runSlash('output-style', 'vui-ve --save');
    expect(ctx.session().outputStyle?.prompt).toContain('vui vẻ');
    expect(getPath(readJsonFile(ctx.settings.file('user')), 'agent.outputStyle')).toBe('vui-ve');

    await ctx.runSlash('output-style', 'default');
    expect(ctx.session().outputStyle).toBeUndefined();
    expect(await ctx.runSlash('output-style', 'khong-co')).toMatch(/Không có phong cách/);
    expect(ctx.slashNamed('output-style').needsIdle).toBe(false);
  });

  it('cài đặt agent.outputStyle là mặc định cho phiên mới / phiên chưa chọn', async () => {
    ctx = new FakeFeatureContext({ user: { agent: { outputStyle: 'explanatory' } } });
    await ctx.attach(reviewFeature);
    await new Promise((r) => setTimeout(r, 50));
    expect(ctx.session().outputStyle?.name).toBe('explanatory');
    ctx.setSession({ ...ctx.session(), id: 'moi', outputStyle: undefined });
    await new Promise((r) => setTimeout(r, 50));
    expect(ctx.session().outputStyle?.name).toBe('explanatory');
    // phiên đã chọn riêng thì không bị ghi đè
    ctx.setSession({ ...ctx.session(), id: 'rieng', outputStyle: { name: 'concise', prompt: 'ngắn' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(ctx.session().outputStyle?.name).toBe('concise');
  });
});

describe('/fork', () => {
  it('rẽ nhánh: lưu phiên gốc, dựng phiên mới qua replaceSession với transcript của lõi', async () => {
    ctx = new FakeFeatureContext();
    await ctx.attach(reviewFeature);
    expect(await ctx.runSlash('fork')).toMatch(/còn trống/);
    const s = ctx.session();
    s.title = 'Sửa lỗi đăng nhập';
    s.messages.push({ role: 'user', content: [{ type: 'text', text: 'sửa lỗi' }] } as never, { role: 'assistant', content: [{ type: 'text', text: 'xong' }] } as never);
    const out = await ctx.runSlash('fork');
    expect(ctx.replaced).toHaveLength(1);
    const a = ctx.replaced[0];
    expect(a.opts?.reason).toBe('fork');
    expect(a.next.id).not.toBe(s.id);
    expect(a.next.title).toContain('(nhánh)');
    expect(a.next.messages).toHaveLength(2);
    expect((a.opts!.transcript as { kind: string }[]).some((i) => i.kind === 'user')).toBe(true);
    expect(s.messages).toHaveLength(2); // phiên gốc không đổi
    expect(ctx.saved).toBe(2); // lưu phiên gốc trước, lưu phiên nhánh sau
    expect(out).toContain('Sửa lỗi đăng nhập');
    ctx.busy = true;
    expect(await ctx.runSlash('fork')).toMatch(/dừng tác vụ/);
  });

  it('lõi chưa hỗ trợ replaceSession → nói rõ, không làm gì', async () => {
    ctx = new FakeFeatureContext();
    (ctx as unknown as { replaceSession: undefined }).replaceSession = undefined;
    await ctx.attach(reviewFeature);
    ctx.session().messages.push({ role: 'user', content: [{ type: 'text', text: 'x' }] } as never);
    expect(await ctx.runSlash('fork')).toMatch(/replaceSession/);
  });
});
