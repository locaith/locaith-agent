import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, constitutionFor, type SystemPromptInput } from '../src/core/engine/context';
import type { ToolHost } from '../src/core/engine/types';

/**
 * (0.4.4) Bề mặt của lời nhắc hệ thống. Báo cáo đánh giá 08/11: `locaith -p "hi"` trả lời «Mình là Locaith AI Agent, đang chạy trong VS Code của bạn»
 * dù đang ở terminal — vì hiến pháp dùng chung với extension mở đầu bằng «works inside the user's VS Code».
 */
const host = { workspaceRoots: () => ['C:/dự-án'], platform: { os: 'windows', shellLabel: 'PowerShell' } } as unknown as ToolHost;
const base = (over: Partial<SystemPromptInput> = {}): SystemPromptInput => ({
  host,
  model: 'm',
  providerLabel: 'P',
  mode: 'default',
  language: 'vi',
  now: new Date('2026-11-08T10:00:00'),
  ...over,
});
const firstLine = (s: string) => s.split('\n')[0];

describe('system prompt — bề mặt terminal (CLI) so với VS Code', () => {
  it('VS Code (mặc định): hiến pháp GIỮ NGUYÊN TỪNG BYTE và vẫn nói đang ở VS Code — prompt-cache của extension không bị phá', () => {
    expect(constitutionFor('ide', 'vscode')).toBe(constitutionFor('ide'));
    expect(buildSystemPrompt(base({ surface: 'vscode' }))).toBe(buildSystemPrompt(base()));
    expect(firstLine(constitutionFor('ide'))).toContain("works inside the user's VS Code");
    expect(buildSystemPrompt(base())).not.toContain('Surface:');
  });

  it('CLI: câu mở đầu nói TERMINAL / Locaith CLI và không nhắc VS Code; phần còn lại của hiến pháp giống hệt bản VS Code', () => {
    const cli = constitutionFor('ide', 'cli');
    const ide = constitutionFor('ide', 'vscode');
    const head = firstLine(cli);
    expect(head).toContain("works in the user's terminal");
    expect(head).toContain('Locaith CLI');
    expect(head).not.toContain('VS Code');
    // chỉ đổi đúng một câu: mọi dòng sau dòng đầu y hệt
    expect(cli.split('\n').slice(1)).toEqual(ide.split('\n').slice(1));
    // phần còn lại của câu đầu (khả năng đọc/sửa tệp, chạy lệnh…) không bị mất
    expect(head).toContain('You can read and change files in their workspace, run commands');
  });

  it('CLI: khối <environment> có dòng «Surface» đứng đầu, nói rõ không phải VS Code; VS Code thì không có dòng đó', () => {
    const p = buildSystemPrompt(base({ surface: 'cli' }));
    const env = p.slice(p.indexOf('<environment>'), p.indexOf('</environment>'));
    expect(env).toContain("Surface: the user's terminal (the Locaith CLI), not VS Code");
    expect(env.indexOf('Surface:')).toBeLessThan(env.indexOf('Operating system:'));
    expect(p).not.toContain("works inside the user's VS Code");
    // các dòng môi trường còn lại không đổi
    const plain = buildSystemPrompt(base());
    const envPlain = plain.slice(plain.indexOf('<environment>'), plain.indexOf('</environment>'));
    expect(env.split('\n').filter((l) => !l.startsWith('Surface:'))).toEqual(envPlain.split('\n'));
  });

  it('họ mô hình Locaith ở CLI vẫn được thêm khối <locaith_model> ngay sau hiến pháp', () => {
    const p = buildSystemPrompt(base({ surface: 'cli', providerId: 'locaith' }));
    expect(p.startsWith(`${constitutionFor('ide', 'cli')}\n\n<locaith_model>\n`)).toBe(true);
  });

  it('hồ sơ trình duyệt không bị ảnh hưởng bởi surface', () => {
    expect(constitutionFor('browser', 'cli')).toBe(constitutionFor('browser'));
    expect(buildSystemPrompt(base({ profile: 'browser', surface: 'cli' }))).toBe(buildSystemPrompt(base({ profile: 'browser' })));
  });
});
