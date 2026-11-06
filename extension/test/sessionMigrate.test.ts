import { describe, expect, it } from 'vitest';
import { migrateSession, SESSION_SCHEMA } from '../src/shared/sessionMigrate';
import { newSession } from '../src/core/engine/types';

const base = () => {
  const s = newSession({ id: 's1', provider: 'anthropic', model: 'claude-x' });
  s.messages = [
    { role: 'user', content: [{ type: 'text', text: 'xin chào' }], ts: 1 },
    { role: 'assistant', content: [{ type: 'text', text: 'chào bạn' }], ts: 2 },
  ];
  return s;
};

describe('migrateSession — phiên cũ nhận thay đổi của bản mới', () => {
  it('điền mặc định cho trường mà bản cũ chưa có', () => {
    const raw = { id: 's1', provider: 'anthropic', model: 'claude-x', mode: 'default', thinkingLevel: 'medium', messages: [] };
    const r = migrateSession(raw)!;
    expect(r.session.todos).toEqual([]);
    expect(r.session.scratchpad).toEqual({});
    expect(r.session.approvals).toEqual([]);
    expect(r.session.usageTotals).toEqual({ input: 0, output: 0 });
    expect(r.filledFields).toBeGreaterThan(0);
    expect(r.changed).toBe(true);
  });

  it("phiên bản ứng dụng đổi → bỏ vân tay prompt và đánh dấu lịch sử đã sửa", () => {
    const s = base();
    s.promptFingerprint = 'abc123';
    s.historyEdited = false;
    const r = migrateSession(s, { storedAppVersion: '0.6.24', appVersion: '0.6.26' })!;
    expect(r.fromOtherVersion).toBe(true);
    expect(r.session.promptFingerprint).toBeUndefined();
    expect(r.session.historyEdited).toBe(true);
  });

  it('cùng phiên bản → giữ nguyên vân tay (không phá prompt-cache)', () => {
    const s = base();
    s.promptFingerprint = 'abc123';
    const r = migrateSession(s, { storedAppVersion: '0.6.26', appVersion: '0.6.26' })!;
    expect(r.fromOtherVersion).toBe(false);
    expect(r.session.promptFingerprint).toBe('abc123');
    expect(r.session.historyEdited).toBe(false);
  });

  it('bỏ tin nhắc tổng hợp của bản cũ nhưng giữ tin tóm tắt sau khi nén', () => {
    const s = base();
    s.messages = [
      { role: 'user', synthetic: true, content: [{ type: 'text', text: '<tom_tat_hoi_thoai_truoc_do>\nđã làm A\n</tom_tat_hoi_thoai_truoc_do>' }], ts: 1 },
      { role: 'assistant', synthetic: true, content: [{ type: 'text', text: 'ok' }], ts: 2 },
      { role: 'user', synthetic: true, content: [{ type: 'text', text: 'Hãy tiếp tục từ đúng chỗ bị dừng.' }], ts: 3 },
      { role: 'user', content: [{ type: 'text', text: 'việc mới' }], ts: 4 },
    ];
    const r = migrateSession(s)!;
    expect(r.droppedNudges).toBe(1);
    expect(r.session.messages).toHaveLength(3);
    expect(JSON.stringify(r.session.messages[0])).toContain('tom_tat_hoi_thoai_truoc_do');
  });

  it("thinkingLevel 'swarm' kiểu cũ → cờ swarm + mức 'max'", () => {
    const s = { ...base(), thinkingLevel: 'swarm' };
    const r = migrateSession(s)!;
    expect(r.session.swarm).toBe(true);
    expect(r.session.thinkingLevel).toBe('max');
  });

  it('giá trị không hợp lệ được thay bằng mặc định, không ném lỗi', () => {
    const raw = { id: 's1', provider: 'x', model: 'y', mode: 'lung-tung', thinkingLevel: 'cao', messages: 'không phải mảng', todos: 42, readFiles: [], artifacts: null };
    const r = migrateSession(raw)!;
    expect(r.session.mode).toBe('default');
    expect(r.session.thinkingLevel).toBe('medium');
    expect(r.session.messages).toEqual([]);
    expect(r.session.todos).toEqual([]);
    expect(r.session.artifacts).toEqual({});
  });

  it('phiên không có id dùng được → null', () => {
    expect(migrateSession({ model: 'x' })).toBeNull();
    expect(migrateSession(null)).toBeNull();
  });

  it('giữ nguyên lựa chọn hướng đi đã lưu (và bỏ mục rỗng)', () => {
    const s = { ...base(), options: [{ id: 'o1', label: ' Chạy thử ', prompt: ' Chạy thử toàn bộ luồng. ', detail: ' 5 phút ' }, { label: '', prompt: 'x' }] };
    const r = migrateSession(s)!;
    expect(r.session.options).toEqual([{ id: 'o1', label: 'Chạy thử', prompt: 'Chạy thử toàn bộ luồng.', detail: '5 phút' }]);
  });

  it('lược đồ hiện tại là 2 và idempotent: chạy hai lần cho cùng kết quả', () => {
    expect(SESSION_SCHEMA).toBe(2);
    const once = migrateSession(base())!.session;
    const twice = migrateSession(once)!.session;
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });
});
