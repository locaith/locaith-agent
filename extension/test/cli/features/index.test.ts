import { afterEach, describe, expect, it } from 'vitest';
import { defaultFeatures } from '../../../src/cli/runtime/features';
import { FakeFeatureContext } from './helpers';

let ctx: FakeFeatureContext;
afterEach(async () => {
  await ctx?.dispose();
  ctx?.cleanup();
});

const EXPECTED = ['rewind', 'tasks', 'hooks', 'mcp', 'skills', 'agents', 'plugins', 'permissions', 'memory', 'init', 'review', 'simplify', 'security-review', 'output-style', 'verify', 'fork'];
const READ_ONLY = ['tasks', 'hooks', 'mcp', 'skills', 'agents', 'plugins', 'permissions', 'memory', 'output-style'];

describe('defaultFeatures()', () => {
  it('mô-đun có tên khác nhau; gắn tất cả vào một ngữ cảnh không lỗi, không trùng lệnh', async () => {
    const mods = defaultFeatures();
    expect(new Set(mods.map((m) => m.name)).size).toBe(mods.length);
    ctx = new FakeFeatureContext();
    for (const m of mods) await ctx.attach(m);
    for (const n of EXPECTED) expect(ctx.slashDefs.has(n), `thiếu /${n}`).toBe(true);
    expect(ctx.logs.filter((l) => l.level === 'error')).toEqual([]);
  });

  it('mọi lệnh có mô tả vi + en; lệnh chỉ đọc chạy được khi đang bận, lệnh chạy lượt agent/đổi trạng thái thì chờ rảnh', async () => {
    ctx = new FakeFeatureContext();
    for (const m of defaultFeatures()) await ctx.attach(m);
    for (const [name, { def }] of ctx.slashDefs) {
      expect(def.description.vi.length, `/${name} vi`).toBeGreaterThan(8);
      expect(def.description.en.length, `/${name} en`).toBeGreaterThan(8);
      expect(def.name).toBe(name);
      expect(name).toBe(name.toLowerCase());
    }
    for (const n of READ_ONLY) expect(ctx.slashNamed(n).needsIdle, `/${n}`).toBe(false);
    for (const n of ['rewind', 'init', 'review', 'simplify', 'security-review', 'verify', 'fork']) expect(ctx.slashNamed(n).needsIdle ?? true, `/${n}`).toBe(true);
  });

  it('RunExtension: verifier cuối; luật quyền và hooks cho cả agent con; mọi extension begin không ném', async () => {
    ctx = new FakeFeatureContext();
    for (const m of defaultFeatures()) await ctx.attach(m);
    const ids = ctx.extensions.map((e) => e.ext.id);
    expect(ids).toEqual(expect.arrayContaining(['permission-rules', 'hooks', 'checkpoints', 'bg-tasks', 'verifier']));
    expect(ctx.extensions.find((e) => e.ext.id === 'verifier')?.opts?.last).toBe(true);
    for (const id of ['permission-rules', 'hooks']) expect(ctx.extensions.find((e) => e.ext.id === id)?.opts?.subAgents).toBe(true);
    expect(() => ctx.begin(ctx.scope())).not.toThrow();
    expect(ctx.status().bgTasks).toEqual({ running: 0, total: 0 });
  });

  it('dọn sạch khi đóng: không còn tiến trình/bộ hẹn giờ treo', async () => {
    ctx = new FakeFeatureContext();
    for (const m of defaultFeatures()) await ctx.attach(m);
    await ctx.dispose();
    expect(ctx.disposers).toHaveLength(0);
  });
});
