import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolResultBlock } from '../src/core/types';
import { BEFORE_AFTER_MAX_BYTES, matchesImageSignature, showBeforeAfterTool } from '../src/core/tools/beforeAfter';
import { builtinSkills } from '../src/core/skills/builtin';
import { SkillRegistry } from '../src/core/skills/registry';
import { sanitizeEvents, toRemoteState } from '../src/core/remote/sanitize';
import { findToolImage, toolImageKeys } from '../src/shared/toolImages';
import { imageKey } from '../src/shared/transcriptRebuild';
import type { TItem, UiEvent } from '../src/shared/protocol';
import constitution from '../src/core/prompts/constitution.md';
import { beforeAfterModel } from '../webview/src/beforeAfterModel';
import { eventsOf, makeHarness } from './helpers/harness';
import { textTurn, toolTurn } from './helpers/fakeProvider';

// PNG hợp lệ tối thiểu (chữ ký + IHDR) — đủ qua kiểm tra chữ ký byte.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 3)]);

function workspace(files: Record<string, Buffer | string>) {
  const h = makeHarness([], {});
  for (const [rel, data] of Object.entries(files)) {
    const abs = path.join(h.dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
  }
  return h;
}

const run = (h: ReturnType<typeof workspace>, input: Parameters<NonNullable<typeof showBeforeAfterTool.execute>>[0]) =>
  showBeforeAfterTool.execute(input, {
    signal: new AbortController().signal,
    session: h.session,
    host: h.host,
    callId: 'c1',
    assistantId: 'a1',
    emit: () => undefined,
    progress: () => undefined,
    log: () => undefined,
  });

describe('show_before_after — công cụ', () => {
  it('hai ảnh hợp lệ → displayImages (chỉ cho giao diện), không có images gửi model', async () => {
    const h = workspace({ '.locaith/shots/a-truoc.png': PNG, '.locaith/shots/a-sau.jpg': JPG });
    const r = await run(h, { before: '.locaith/shots/a-truoc.png', after: '.locaith/shots/a-sau.jpg', caption: 'Nút đổi sang màu nhấn', label_before: 'Cũ' });
    expect(r.isError).toBeFalsy();
    expect(r.images).toBeUndefined();
    expect(r.displayImages).toHaveLength(2);
    expect(r.displayImages![0]).toMatchObject({ type: 'image', mediaType: 'image/png' });
    expect(r.displayImages![1].mediaType).toBe('image/jpeg');
    expect(Buffer.from(r.displayImages![0].data, 'base64').equals(PNG)).toBe(true);
    expect(r.content).toContain('Cũ: .locaith/shots/a-truoc.png');
    expect(r.content).toContain('Sau: .locaith/shots/a-sau.jpg');
    expect(r.display).toContain('Nút đổi sang màu nhấn');
  });

  it('tệp không có → lỗi nói rõ phải chụp trước; sai đuôi → lỗi định dạng', async () => {
    const h = workspace({ 'a.png': PNG, 'ghi-chu.txt': 'hello', 'doi-lot.png': 'khong phai anh' });
    const miss = await run(h, { before: 'a.png', after: 'khong-co.png' });
    expect(miss.isError).toBe(true);
    expect(miss.content).toMatch(/Không thấy ảnh «sau»/);
    const bad = await run(h, { before: 'a.png', after: 'ghi-chu.txt' });
    expect(bad.isError).toBe(true);
    expect(bad.content).toMatch(/không phải PNG\/JPEG\/GIF\/WebP/);
  });

  it('tệp đuôi .png nhưng nội dung không phải ảnh → bị từ chối (không đưa tệp bất kỳ lên giao diện)', async () => {
    const h = workspace({ 'a.png': PNG, 'doi-lot.png': 'API_KEY=bi-mat' });
    const r = await run(h, { before: 'a.png', after: 'doi-lot.png' });
    expect(r.isError).toBe(true);
    expect(r.displayImages).toBeUndefined();
    expect(r.content).not.toContain('API_KEY');
  });

  it('ảnh quá trần kích thước thẻ → lỗi gợi ý chụp nhỏ lại', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(BEFORE_AFTER_MAX_BYTES, 1)]);
    const h = workspace({ 'a.png': PNG, 'lon.png': big });
    const r = await run(h, { before: 'a.png', after: 'lon.png' });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/vượt trần/);
  });

  it('validate: thiếu đường dẫn hoặc trùng nhau', () => {
    const ctx = {} as never;
    expect(showBeforeAfterTool.validate!({ before: '', after: 'b.png' }, ctx)).toMatch(/Cần cả/);
    expect(showBeforeAfterTool.validate!({ before: 'a.png', after: ' a.png ' }, ctx)).toMatch(/cùng một tệp/);
    expect(showBeforeAfterTool.validate!({ before: 'a.png', after: 'b.png' }, ctx)).toBeNull();
  });

  it('nhãn/chú thích bị làm sạch (ký tự điều khiển) và cắt độ dài', async () => {
    const h = workspace({ 'a.png': PNG, 'b.png': PNG });
    const r = await run(h, { before: 'a.png', after: 'b.png', caption: 'x\u0007y\n'.repeat(200), label_after: 'S'.repeat(500) });
    expect(r.content).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/);
    expect(r.content.length).toBeLessThan(900);
  });

  it('đường dẫn ngoài workspace → xin phép (như read_file); tệp bí mật → xin phép', async () => {
    const h = workspace({ 'a.png': PNG, '.env': 'TOKEN=1' });
    const outside = path.join(os.tmpdir(), 'ngoai-workspace-xyz.png');
    const ctx = { host: h.host } as never;
    const need = await showBeforeAfterTool.permission!({ before: 'a.png', after: outside }, ctx);
    expect(need?.kind).toBe('outside_workspace');
    expect(await showBeforeAfterTool.permission!({ before: 'a.png', after: 'a.png' }, ctx)).toBeNull();
    const sec = await showBeforeAfterTool.permission!({ before: '.env', after: 'a.png' }, ctx);
    expect(sec).not.toBeNull();
  });

  it('chữ ký byte: PNG/JPEG/GIF/WebP đúng, sai loại thì không', () => {
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);
    expect(matchesImageSignature(PNG, 'image/png')).toBe(true);
    expect(matchesImageSignature(JPG, 'image/jpeg')).toBe(true);
    expect(matchesImageSignature(Buffer.from('GIF89a......'), 'image/gif')).toBe(true);
    expect(matchesImageSignature(webp, 'image/webp')).toBe(true);
    expect(matchesImageSignature(PNG, 'image/jpeg')).toBe(false);
    expect(matchesImageSignature(Buffer.from('<svg>'), 'image/png')).toBe(false);
  });
});

describe('show_before_after — qua engine thật (fakeProvider)', () => {
  it('ẩn cho tới khi nạp kỹ năng ui-truoc-sau; sau đó phát tool_end có 2 ảnh và tool_result gửi model KHÔNG có ảnh', async () => {
    const h = makeHarness(
      [
        () => toolTurn([{ name: 'load_skill', input: { skill_name: 'ui-truoc-sau' } }]),
        () => toolTurn([{ name: 'show_before_after', input: { before: 'truoc.png', after: 'sau.png', caption: 'Đã bo góc nút' } }]),
        () => textTurn('Đã so sánh xong.'),
      ],
      {},
    );
    fs.writeFileSync(path.join(h.dir, 'truoc.png'), PNG);
    fs.writeFileSync(path.join(h.dir, 'sau.png'), JPG.length ? PNG : PNG);
    await h.run('Làm đẹp nút đăng nhập');
    // Lượt 1: công cụ chưa lộ ra.
    expect(h.provider.requests[0].tools?.some((t) => t.name === 'show_before_after')).toBe(false);
    // Lượt 2: đã mở khoá.
    expect(h.provider.requests[1].tools?.some((t) => t.name === 'show_before_after')).toBe(true);
    const ends = eventsOf(h.events, 'tool_end');
    const shot = ends[1];
    expect(shot.state).toBe('done');
    expect(shot.images).toHaveLength(2);
    expect(shot.output).toContain('Đã bo góc nút');
    const results = h.provider.requests[2].messages.flatMap((m) => m.content.filter((b): b is ToolResultBlock => b.type === 'tool_result'));
    const last = results[results.length - 1];
    expect(last.isError).toBe(false);
    expect(last.images).toBeUndefined();
  });

  it('lỗi (ảnh không tồn tại) → tool_end lỗi, không có ảnh trên giao diện', async () => {
    const h = makeHarness(
      [
        () => toolTurn([{ name: 'load_skill', input: { skill_name: 'ui-truoc-sau' } }]),
        () => toolTurn([{ name: 'show_before_after', input: { before: 'khong.png', after: 'cung-khong.png' } }]),
        () => textTurn('Chưa chụp được.'),
      ],
      {},
    );
    await h.run('Làm đẹp trang');
    const shot = eventsOf(h.events, 'tool_end')[1];
    expect(shot.state).toBe('error');
    expect(shot.images).toBeUndefined();
  });
});

describe('kỹ năng ui-truoc-sau & hiến pháp', () => {
  it('đăng ký như kỹ năng dựng sẵn, frontmatter hợp lệ, mở khoá đúng công cụ', () => {
    const def = builtinSkills().find((s) => s.name === 'ui-truoc-sau');
    expect(def).toBeTruthy();
    expect(def!.unlocks).toEqual(['show_before_after']);
    expect(def!.description.length).toBeGreaterThan(40);
    expect(def!.providers).toBeUndefined(); // dùng được với mọi nhà cung cấp
    expect(def!.body).toMatch(/show_before_after/);
    expect(new SkillRegistry(builtinSkills()).get('ui-truoc-sau')).toBeTruthy();
  });

  it('hiến pháp nhắc kỹ năng và công cụ trong một dòng', () => {
    expect(constitution).toMatch(/ui-truoc-sau/);
    expect(constitution).toMatch(/show_before_after/);
  });
});

describe('Remote: ảnh trước/sau', () => {
  const img = (n: number) => ({ mediaType: 'image/png', data: Buffer.alloc(300 + n, n).toString('base64') });

  it('tool_end ra Remote: bỏ ảnh thô, giữ imageCount + imageKeys (bản cũ bỏ qua trường lạ)', () => {
    const images = [img(1), img(2)];
    const ev: UiEvent = { t: 'tool_end', id: 'a', callId: 'c', state: 'done', summary: '2 ảnh', output: 'Trước: a → Sau: b', images, durationMs: 5 };
    const out = sanitizeEvents([ev])[0] as unknown as Record<string, unknown>;
    expect(out.images).toBeUndefined();
    expect(out.imageCount).toBe(2);
    expect(out.imageKeys).toEqual([imageKey(images[0].data), imageKey(images[1].data)]);
    expect(JSON.stringify(out)).not.toContain(images[0].data);
    expect(out.output).toBe('Trước: a → Sau: b'); // dòng chữ dự phòng cho trang Remote cũ
  });

  it('snapshot Remote: khối công cụ mang imageKeys nhưng không mang ảnh', () => {
    const images = [img(3), img(4)];
    const items: TItem[] = [
      { kind: 'assistant', id: 'a', blocks: [{ type: 'tool', id: 'c', name: 'show_before_after', args: {}, state: 'done', images, startedAt: 0 }] } as TItem,
    ];
    const state = toRemoteState({ transcript: items } as never, { name: 'pc' } as never, { canBypass: false });
    const block = (state as unknown as { transcript: { blocks: Record<string, unknown>[] }[] }).transcript[0].blocks[0];
    expect(block.imageCount).toBe(2);
    expect(block.imageKeys).toHaveLength(2);
    expect(block.images).toBeUndefined();
  });

  it('toolImageKeys cắt tối đa 4; findToolImage tra đúng ảnh trong transcript (cho get_image)', () => {
    const imgs = [1, 2, 3, 4, 5, 6].map(img);
    expect(toolImageKeys(imgs)).toHaveLength(4);
    const items: TItem[] = [
      { kind: 'assistant', id: 'a', blocks: [{ type: 'tool', id: 'c', name: 'show_before_after', args: {}, state: 'done', images: imgs.slice(0, 2), startedAt: 0 }] } as TItem,
    ];
    expect(findToolImage(items, imageKey(imgs[1].data))).toEqual(imgs[1]);
    expect(findToolImage(items, 'khong-co')).toBeUndefined();
    expect(findToolImage(items, '')).toBeUndefined();
  });
});

describe('thẻ webview — mô hình hiển thị', () => {
  it('đọc đường dẫn/nhãn/chú thích từ đối số đã lưu, làm sạch và cắt', () => {
    const m = beforeAfterModel({ before: ' a.png ', after: 'b.png', caption: 'x'.repeat(500), label_before: 'Cũ\u0007', label_after: 7 });
    expect(m).toEqual({ before: 'a.png', after: 'b.png', caption: 'x'.repeat(200), labelBefore: 'Cũ', labelAfter: undefined });
  });
  it('thiếu một trong hai đường dẫn → không có thẻ', () => {
    expect(beforeAfterModel({ before: 'a.png' })).toBeNull();
    expect(beforeAfterModel(undefined)).toBeNull();
  });
});

describe('thẻ webview — nối dây, chuỗi vi/en, kiểu dáng', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  it('mọi chuỗi của thẻ và nhãn công cụ có đủ tiếng Việt và tiếng Anh', async () => {
    const { tOpt } = await import('../webview/src/i18n');
    for (const k of ['ba.region', 'ba.before', 'ba.after', 'ba.slide', 'ba.sideBySide', 'ba.slideAria', 'ba.zoom', 'tool.show_before_after.run', 'tool.show_before_after.done']) {
      const vi = tOpt('vi', k);
      const en = tOpt('en', k);
      expect(vi, k).toBeTruthy();
      expect(en, k).toBeTruthy();
      expect(vi, k).not.toBe(en);
      expect(vi! + en!).not.toContain('…'); // không dấu «…» thừa ở nhãn
    }
  });

  it('ToolRow vẽ BeforeAfter cho show_before_after và KHÔNG vẽ thêm hàng ảnh chụp thường', () => {
    const src = read('webview/src/components/timeline/ToolRow.tsx');
    expect(src).toMatch(/block\.name === 'show_before_after' && <BeforeAfter block=\{block\} \/>/);
    expect(src).toMatch(/block\.name !== 'show_before_after' && block\.images/);
  });

  it('CSS: khung hẹp xếp dọc (minmax), viền mảnh không tô nền kín, tương phản cao, được import vào main.css', () => {
    const css = read('webview/src/styles/beforeafter.css');
    expect(css).toMatch(/grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*150px\)/);
    expect(css).toMatch(/vscode-high-contrast/);
    expect(css).not.toMatch(/\.ba(-pane|-grid)?\s*\{[^}]*background:\s*(var\(--surface|#)/);
    expect(read('webview/src/styles/main.css')).toContain("@import './beforeafter.css'");
  });

  it('công cụ được đăng ký là hidden và thẻ biết tên công cụ (KNOWN → không in «Đối số» thô)', () => {
    expect(showBeforeAfterTool.hidden).toBe(true);
    expect(read('webview/src/toolLabels.ts')).toMatch(/'show_before_after',/);
  });
});
