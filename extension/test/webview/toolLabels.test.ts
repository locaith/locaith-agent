import { describe, expect, it } from 'vitest';
import { describeTool, groupLabel, GROUPABLE } from '../../webview/src/toolLabels';
import { makeT, t, tOpt } from '../../webview/src/i18n';

describe('describeTool (tiếng Việt)', () => {
  it('web_search: nhãn chung + truy vấn ở chi tiết', () => {
    const d = describeTool('vi', 'web_search', { query: 'Intelligence Index v2' }, 'done');
    expect(d.label).toBe('Đã tìm kiếm trên web');
    expect(d.detail).toBe('Intelligence Index v2');
    expect(d.icon).toBe('search');
    expect(describeTool('vi', 'web_search', { query: 'x' }, 'running').label).toBe('Đang tìm kiếm trên web…');
  });
  it('fetch_url: "Đã đọc <host>"', () => {
    const d = describeTool('vi', 'fetch_url', { url: 'https://www.artificialanalysis.ai/models' }, 'done');
    expect(d.label).toBe('Đã đọc artificialanalysis.ai');
    expect(d.detailKind).toBe('url');
  });
  it('đọc/sửa/tạo tệp dùng tên tệp và cho phép mở', () => {
    expect(describeTool('vi', 'read_file', { path: 'src/utils/băm.ts' }, 'done').label).toBe('Đã đọc băm.ts');
    const e = describeTool('vi', 'edit_file', { path: 'src/app.ts' }, 'running');
    expect(e.label).toBe('Đang sửa app.ts…');
    expect(e.file).toEqual({ path: 'src/app.ts', line: undefined });
    expect(describeTool('vi', 'write_file', { path: 'a/b.md' }, 'done').label).toBe('Đã tạo b.md');
  });
  it('run_command hiển thị lệnh (dòng đầu) dạng command', () => {
    const d = describeTool('vi', 'run_command', { command: 'npm test\nnpm run build' }, 'done');
    expect(d.label).toBe('Đã chạy lệnh');
    expect(d.detailKind).toBe('command');
    expect(d.detail).toBe('npm test …');
  });
  it('list_dir ở thư mục gốc', () => {
    expect(describeTool('vi', 'list_dir', { path: '.' }, 'done').label).toBe('Đã liệt kê thư mục gốc');
    expect(describeTool('vi', 'list_dir', { path: 'src/core' }, 'done').label).toBe('Đã liệt kê core');
  });
  it('công cụ lạ → nhãn chung theo tên', () => {
    expect(describeTool('vi', 'my_custom_tool', {}, 'done').label).toBe('Đã dùng công cụ my_custom_tool');
    expect(describeTool('vi', 'my_custom_tool', {}, 'running').label).toBe('Đang dùng công cụ my_custom_tool…');
  });
  it('ẩn todo_write/load_skill khi chạy bình thường nhưng hiện khi lỗi', () => {
    expect(describeTool('vi', 'todo_write', {}, 'done').hidden).toBe(true);
    expect(describeTool('vi', 'load_skill', { skill_name: 'artifacts' }, 'running').hidden).toBe(true);
    expect(describeTool('vi', 'todo_write', {}, 'error').hidden).toBe(false);
    expect(describeTool('vi', 'web_search', {}, 'done').hidden).toBe(false);
  });
  it('chịu được đối số thiếu hoặc sai kiểu', () => {
    expect(() => describeTool('vi', 'read_file', undefined, 'done')).not.toThrow();
    expect(describeTool('vi', 'fetch_url', { url: 42 as unknown as string }, 'done').label).toContain('Đã đọc');
    expect(describeTool('vi', 'read_file', { path: 'a.ts', line: 'abc' }, 'done').file).toEqual({ path: 'a.ts', line: undefined });
  });
});

describe('describeTool (English)', () => {
  it('dùng chuỗi tiếng Anh', () => {
    expect(describeTool('en', 'web_search', { query: 'x' }, 'done').label).toBe('Searched the web');
    expect(describeTool('en', 'read_file', { path: 'a/b.ts' }, 'running').label).toBe('Reading b.ts…');
  });
});

describe('groupLabel', () => {
  it('nhãn gộp có số lần', () => {
    expect(groupLabel('vi', 'web_search', 5)).toBe('Đã tìm kiếm trên web 5 lần');
    expect(groupLabel('vi', 'read_file', 3)).toBe('Đã đọc 3 tệp');
    expect(GROUPABLE.has('web_search')).toBe(true);
    expect(groupLabel('vi', 'run_command', 3)).toBe('Đã chạy 3 lệnh');
    expect(GROUPABLE.has('run_command')).toBe(true); // 0.6.13: lệnh chạy cũng gộp như sửa tệp
  });
});

describe('i18n', () => {
  it('t nội suy tham số', () => {
    // (0.6.31) Khoá `todo.progress` đã bỏ cùng bảng Tasks; dùng khoá còn sống có tham số để thử nội suy.
    expect(t('vi', 'act.taskAdded', { title: 'Vá lỗi' })).toBe('Đã thêm tác vụ: Vá lỗi');
    expect(t('en', 'act.taskAdded', { title: 'Fix bug' })).toBe('Added task: Fix bug');
    expect(makeT('vi')('hist.messages', { n: 7 })).toBe('7 tin nhắn');
  });
  it('tOpt trả undefined khi không có khóa', () => {
    expect(tOpt('vi', 'khong.co.khoa')).toBeUndefined();
    expect(tOpt('vi', 'tool.web_search.done')).toBe('Đã tìm kiếm trên web');
  });
  it('mọi chuỗi tiếng Việt đều có tiếng Anh tương ứng và không để sót tham số {…} lệch nhau', () => {
    // dictionaries không export trực tiếp → kiểm tra gián tiếp qua các khóa có tham số
    const keys = ['act.taskAdded', 'act.skillLoaded', 'tool.fetch_url.done', 'perm.kind.edit', 'model.custom'] as const;
    for (const k of keys) {
      const params = { title: 'T', skill: 'S', target: 'X', name: 'N', q: 'Q', provider: 'P' };
      expect(t('vi', k, params)).not.toContain('{');
      expect(t('en', k, params)).not.toContain('{');
    }
  });
});
