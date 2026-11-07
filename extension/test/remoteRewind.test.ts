/** (lane:checkpoints-rewind) Remote: lệnh rewind_* được kiểm chặt, thanh thay đổi / thẻ Quay lại bị cắt kích thước và đi qua bộ lọc. */
import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/core/remote/protocol';
import { sanitizeCheckpoints, sanitizePatch, sanitizeRewind, toRemoteState } from '../src/core/remote/sanitize';
import type { CheckpointTurn, RewindView } from '../src/shared/checkpoints';
import type { ViewState } from '../src/shared/protocol';

const opts = { canBypass: false };
const ok = (raw: unknown) => {
  const r = parseCommand(raw, opts);
  if (!r.ok) throw new Error(`bị từ chối: ${r.error}`);
  return r.cmd;
};
const err = (raw: unknown) => {
  const r = parseCommand(raw, opts);
  return r.ok ? null : r.error;
};

describe('parseCommand: rewind_*', () => {
  it('chấp nhận các lệnh hợp lệ và chuẩn hoá', () => {
    expect(ok({ type: 'rewind_open', promptId: 'u_abc123', list: true })).toEqual({ type: 'rewind_open', promptId: 'u_abc123', list: true });
    expect(ok({ type: 'rewind_open', promptId: 'u_abc123' })).toEqual({ type: 'rewind_open', promptId: 'u_abc123' });
    expect(ok({ type: 'rewind_plan', promptId: 'u_1', what: 'both', scope: 'turn', files: ['src/a.ts'] })).toEqual({ type: 'rewind_plan', promptId: 'u_1', what: 'both', scope: 'turn', files: ['src/a.ts'] });
    expect(ok({ type: 'rewind_plan', promptId: 'u_1', what: 'code', scope: 'xyz' })).toMatchObject({ scope: 'from' });
    for (const type of ['rewind_apply', 'rewind_cancel', 'rewind_redo']) expect(ok({ type, thua: 'bị bỏ' })).toEqual({ type });
  });

  it('từ chối id sai, what lạ, danh sách tệp quá lớn / chứa ký tự điều khiển / sai kiểu', () => {
    expect(err({ type: 'rewind_open', promptId: '../../etc' })).toBe('bad_id');
    expect(err({ type: 'rewind_open' })).toBe('bad_id');
    expect(err({ type: 'rewind_plan', promptId: 'u_1', what: 'format-disk' })).toBe('bad_rewind');
    expect(err({ type: 'rewind_plan', promptId: 'u_1', what: 'code', files: Array.from({ length: 201 }, (_, i) => `f${i}`) })).toBe('bad_files');
    expect(err({ type: 'rewind_plan', promptId: 'u_1', what: 'code', files: ['a\u0000b'] })).toBe('bad_files');
    expect(err({ type: 'rewind_plan', promptId: 'u_1', what: 'code', files: ['a\nb'] })).toBe('bad_files');
    expect(err({ type: 'rewind_plan', promptId: 'u_1', what: 'code', files: [42] })).toBe('bad_files');
    expect(err({ type: 'rewind_plan', promptId: 'u_1', what: 'code', files: ['x'.repeat(501)] })).toBe('bad_files');
  });

  it('checkpoint_diff (mở editor) KHÔNG nằm trong tập lệnh từ xa', () => {
    expect(err({ type: 'checkpoint_diff', promptId: 'u_1', rel: 'a.ts' })).toBe('unknown_command');
  });
});

describe('sanitize', () => {
  const big: CheckpointTurn[] = Array.from({ length: 40 }, (_, i) => ({
    promptId: `p${i}`,
    files: Array.from({ length: 100 }, (_, j) => ({ rel: `${'d/'.repeat(200)}f${j}.ts`, kind: 'edit' as const, added: 1.9, removed: 2 })),
  }));

  it('checkpoints bị cắt: 30 lượt cuối × 60 tệp, đường dẫn ≤ 300 ký tự', () => {
    const out = sanitizeCheckpoints(big)!;
    expect(out).toHaveLength(30);
    expect(out[0].promptId).toBe('p10');
    expect(out[0].files).toHaveLength(60);
    expect(out[0].files[0].rel.length).toBeLessThanOrEqual(300);
    expect(out[0].files[0].added).toBe(1);
  });

  it('thẻ Quay lại bị cắt danh sách tệp / tin gần đây / lỗi; null và undefined giữ nguyên nghĩa', () => {
    const r: RewindView = {
      promptId: 'u',
      stage: 'plan',
      error: 'e'.repeat(1000),
      files: Array.from({ length: 300 }, (_, i) => ({ rel: `f${i}`, action: 'restore' as const, added: 0, removed: 0 })),
      recent: Array.from({ length: 20 }, (_, i) => ({ promptId: `u${i}`, text: 't'.repeat(500), files: 1 })),
    };
    const out = sanitizeRewind(r)!;
    expect(out!.files).toHaveLength(100);
    expect(out!.recent).toHaveLength(8);
    expect(out!.recent![0].text.length).toBe(80);
    expect(out!.error!.length).toBe(300);
    expect(sanitizeRewind(null)).toBeNull();
    expect(sanitizeRewind(undefined)).toBeUndefined();
  });

  it('sanitizePatch cho qua checkpoints/rewind (đã cắt) và vẫn trả null khi không có gì cần gửi', () => {
    const p = sanitizePatch({ checkpoints: big, rewind: { promptId: 'u', stage: 'menu' } });
    expect(p?.checkpoints).toHaveLength(30);
    expect(p?.rewind).toEqual({ promptId: 'u', stage: 'menu' });
    expect(sanitizePatch({ rewind: null })).toEqual({ rewind: null });
    expect(sanitizePatch({ settings: {} as never })).toBeNull();
  });

  it('toRemoteState mang checkpoints khi host có; vắng thì không có trường (host cũ)', () => {
    const base = { sessionId: 's', title: 't', transcript: [], todos: [], running: false, queued: [], provider: 'p', model: 'm', mode: 'default', thinkingLevel: 'medium', providers: [], sessions: [], context: null, allowBypass: false } as unknown as ViewState;
    const host = { name: 'h', vscode: '1', ext: '1', platform: 'win32' };
    expect(toRemoteState({ ...base, checkpoints: [{ promptId: 'p1', files: [] }] }, host, opts).checkpoints).toEqual([{ promptId: 'p1', files: [] }]);
    expect('checkpoints' in toRemoteState(base, host, opts)).toBe(false);
  });
});
