import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, constitutionFor, type SystemPromptInput } from '../src/core/engine/context';
import type { ToolHost } from '../src/core/engine/types';

const host = { workspaceRoots: () => ['C:/dự-án'], platform: { os: 'windows', shellLabel: 'PowerShell' } } as unknown as ToolHost;
const base = (over: Partial<SystemPromptInput> = {}): SystemPromptInput => ({
  host,
  model: 'm',
  providerLabel: 'P',
  mode: 'default',
  language: 'vi',
  now: new Date('2026-11-04T10:00:00'),
  ...over,
});

describe('system prompt — đoạn nhắc kỹ năng riêng của họ mô hình Locaith', () => {
  it('chỉ nhà cung cấp locaith (hồ sơ IDE) được thêm khối <locaith_model>, đứng ngay sau hiến pháp (cùng tiền tố prompt-cache)', () => {
    const p = buildSystemPrompt(base({ providerId: 'locaith' }));
    expect(p.startsWith(`${constitutionFor('ide')}\n\n<locaith_model>\n`)).toBe(true);
    expect(p).toContain('soan-thao-van-ban-nd30');
    expect(p).toContain('ghi-nho-memory');
    expect(p).toContain('</locaith_model>');
    expect(p.indexOf('<locaith_model>')).toBeLessThan(p.indexOf('<environment>'));
  });

  it('nhà cung cấp khác (hoặc không rõ): prompt GIỮ NGUYÊN TỪNG BYTE như trước — prompt-cache của họ không bị phá', () => {
    const plain = buildSystemPrompt(base());
    for (const id of ['anthropic', 'openai', 'gemini', 'deepseek', 'xai', 'demo', 'locaith-auto', 'locaith-v5', '']) {
      expect(buildSystemPrompt(base({ providerId: id })), id).toBe(plain);
    }
    expect(plain).not.toContain('locaith_model');
  });

  it('hồ sơ trình duyệt không bao giờ có khối này, kể cả với locaith', () => {
    expect(buildSystemPrompt(base({ providerId: 'locaith', profile: 'browser' }))).not.toContain('locaith_model');
  });

  it('khối này không làm mất các phần khác (môi trường, chế độ plan, hướng dẫn dự án, MCP)', () => {
    const p = buildSystemPrompt(base({ providerId: 'locaith', mode: 'plan', projectInstructions: { file: 'LOCAITH.md', text: 'Dùng pnpm.' }, mcpInstructions: [{ server: 'bio', text: 'recall trước khi trả lời' }] }));
    expect(p).toContain('<environment>');
    expect(p).toContain('<mode name="plan">');
    expect(p).toContain('<project_instructions source="LOCAITH.md">');
    expect(p).toContain('<mcp_servers>');
  });
});
