import { describe, expect, it } from 'vitest';
import { SlashRegistry, type SlashCommandDef } from '../src/host/slashRegistry';

const def = (name: string, extra: Partial<SlashCommandDef> = {}): SlashCommandDef => ({
  name,
  description: { vi: `mô tả ${name}`, en: `desc ${name}` },
  run: () => undefined,
  ...extra,
});

describe('SlashRegistry', () => {
  it('đăng ký, tra cứu không phân biệt hoa-thường và bỏ dấu /', () => {
    const r = new SlashRegistry();
    r.register(def('Rewind'));
    expect(r.has('/rewind')).toBe(true);
    expect(r.get('REWIND')?.name).toBe('rewind');
    expect(r.get('nope')).toBeUndefined();
  });

  it('tên rỗng bị từ chối', () => {
    const r = new SlashRegistry();
    expect(() => r.register(def('  /  '))).toThrow();
  });

  it('list theo ngôn ngữ, kèm gợi ý đối số và nhãn nguồn', () => {
    const r = new SlashRegistry();
    r.register(def('fork', { argHint: '<tên>' }));
    r.replaceSource('project', [def('deploy', { source: 'project' })]);
    r.replaceSource('user', [def('mine', { source: 'user' })]);
    const vi = r.list('vi').map((c) => `${c.name}|${c.description}`);
    expect(vi).toContain('fork|mô tả fork — <tên>');
    expect(vi).toContain('deploy|mô tả deploy (dự án)');
    expect(vi).toContain('mine|mô tả mine (cá nhân)');
    expect(r.list('en').find((c) => c.name === 'deploy')!.description).toBe('desc deploy (project)');
  });

  it('thứ tự: dựng sẵn → dự án → cá nhân → plugin → mcp', () => {
    const r = new SlashRegistry();
    r.replaceSource('mcp', [def('zz-mcp')]);
    r.replaceSource('plugin', [def('yy-plugin')]);
    r.replaceSource('user', [def('xx-user')]);
    r.replaceSource('project', [def('ww-project')]);
    r.register(def('vv-builtin'));
    expect(r.list('vi').map((c) => c.name)).toEqual(['vv-builtin', 'ww-project', 'xx-user', 'yy-plugin', 'zz-mcp']);
  });

  it('replaceSource thay cả nhóm và gỡ lệnh không còn; nguồn ưu tiên cao hơn thắng khi trùng tên', () => {
    const r = new SlashRegistry();
    r.replaceSource('project', [def('a'), def('b')]);
    r.replaceSource('project', [def('b')]);
    expect(r.has('a')).toBe(false);
    expect(r.has('b')).toBe(true);
    r.register(def('c')); // dựng sẵn
    r.replaceSource('user', [def('c', { description: { vi: 'của người dùng', en: 'user' } })]);
    expect(r.get('c')!.description.vi).toBe('mô tả c'); // dựng sẵn thắng cá nhân
    r.replaceSource('plugin', [def('b', { description: { vi: 'plugin', en: 'plugin' } })]);
    expect(r.get('b')!.source).toBe('project'); // dự án thắng plugin
  });

  it('hàm gỡ trả về chỉ gỡ đúng bản đã đăng ký; onChange được gọi và có thể huỷ', () => {
    const r = new SlashRegistry();
    let changes = 0;
    const off = r.onChange(() => changes++);
    const unregister = r.register(def('x'));
    expect(changes).toBe(1);
    r.register(def('x', { description: { vi: 'mới', en: 'new' } })); // thay bản cũ
    unregister(); // bản cũ đã bị thay → không được gỡ bản mới
    expect(r.get('x')!.description.vi).toBe('mới');
    off();
    r.replaceSource('project', []);
    expect(changes).toBe(2);
  });

  it('người nghe ném lỗi không làm hỏng đăng ký', () => {
    const r = new SlashRegistry();
    r.onChange(() => {
      throw new Error('nổ');
    });
    expect(() => r.register(def('ok'))).not.toThrow();
    expect(r.has('ok')).toBe(true);
  });
});
