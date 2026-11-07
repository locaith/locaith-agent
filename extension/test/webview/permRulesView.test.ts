import { describe, expect, it } from 'vitest';
import type { PermissionsView } from '../../src/shared/protocol';
import { isModeCycleKey, nextMode } from '../../webview/src/modeCycle';
import { groupRules, isValidRuleText, permissionCardModel, tryCommand } from '../../webview/src/permRulesView';

describe('Shift+Tab xoay vòng chế độ quyền', () => {
  it('default → acceptEdits → plan → default; bypass về default', () => {
    expect(nextMode('default')).toBe('acceptEdits');
    expect(nextMode('acceptEdits')).toBe('plan');
    expect(nextMode('plan')).toBe('default');
    expect(nextMode('bypass')).toBe('default');
  });
  it('chỉ Shift+Tab (không Ctrl/Alt/Meta) mới là phím đổi chế độ', () => {
    expect(isModeCycleKey({ key: 'Tab', shiftKey: true })).toBe(true);
    expect(isModeCycleKey({ key: 'Tab', shiftKey: false })).toBe(false);
    expect(isModeCycleKey({ key: 'Tab', shiftKey: true, ctrlKey: true })).toBe(false);
    expect(isModeCycleKey({ key: 'Enter', shiftKey: true })).toBe(false);
  });
});

describe('mô hình thẻ xin quyền', () => {
  it('«Luôn cho phép» chỉ khi host đề xuất đặc tả hợp lệ; không cho kế hoạch', () => {
    expect(permissionCardModel({ kind: 'command', canAllowSession: true, suggest: ['run_command(npm test:*)'] })).toEqual({
      isPlan: false,
      always: { defaultRule: 'run_command(npm test:*)' },
      session: true,
    });
    expect(permissionCardModel({ kind: 'command', canAllowSession: false })).toEqual({ isPlan: false, session: false });
    expect(permissionCardModel({ kind: 'command', canAllowSession: true, suggest: ['bad('] })).toEqual({ isPlan: false, session: true });
    expect(permissionCardModel({ kind: 'plan', canAllowSession: true, suggest: ['x(y)'] })).toEqual({ isPlan: true, session: false });
  });
  it('dòng «hỏi theo luật» khi luật ask đã quyết định', () => {
    expect(permissionCardModel({ kind: 'edit', canAllowSession: true, rule: 'write_file(docs/**)' }).askedByRule).toBe('write_file(docs/**)');
  });
  it('isValidRuleText dùng chung bộ phân tích', () => {
    expect(isValidRuleText('edit_file(src/**)')).toBe(true);
    expect(isValidRuleText('edit_file(../**)')).toBe(false);
    expect(isValidRuleText('')).toBe(false);
  });
});

describe('khu quản lý: nhóm luật và thử khớp lệnh', () => {
  const view: PermissionsView = {
    rules: [
      { action: 'deny', text: 'run_command(rm -rf*)', source: 'workspace' },
      { action: 'ask', text: 'run_command(git push*)', source: 'user' },
      { action: 'allow', text: 'run_command(npm test:*)', source: 'user' },
    ],
  };
  it('groupRules chia đúng ba nhóm, giữ thứ tự', () => {
    const g = groupRules(view.rules);
    expect(g.deny.map((r) => r.text)).toEqual(['run_command(rm -rf*)']);
    expect(g.ask).toHaveLength(1);
    expect(g.allow).toHaveLength(1);
  });
  it('tryCommand cho cùng kết quả với engine và trả đúng nguồn', () => {
    expect(tryCommand(view, 'npm test -- --ci', false)).toEqual({ action: 'allow', rule: 'run_command(npm test:*)', source: 'user' });
    expect(tryCommand(view, 'npm test && rm -rf /', false)).toEqual({ action: 'deny', rule: 'run_command(rm -rf*)', source: 'workspace' });
    expect(tryCommand(view, 'git push origin main', false)?.action).toBe('ask');
    expect(tryCommand(view, 'git log', false)).toBeNull();
    expect(tryCommand(view, '   ', false)).toBeNull();
    expect(tryCommand(undefined, 'npm test', false)).toBeNull();
  });
});
