import { describe, expect, it } from 'vitest';
import { setLang } from '../../../src/cli/i18n';
import type { RuntimeStatus } from '../../../src/cli/runtime/contract';
import { detectCaps, makeTheme } from '../../../src/cli/tui/theme';
import { renderWelcome } from '../../../src/cli/tui/welcome';

const theme = makeTheme(detectCaps({ env: { NO_COLOR: '1' } as NodeJS.ProcessEnv }));
const status = (o: Partial<RuntimeStatus>): RuntimeStatus => ({
  version: '0.4.1',
  cwd: '/work/demo',
  provider: 'locaith',
  model: 'locaith-v5-flash',
  mode: 'default',
  thinking: 'off',
  context: { tokens: 0, window: 1000, percent: 0 },
  usage: { input: 0, output: 0 },
  running: false,
  queued: [],
  sessionId: 's',
  title: '',
  todos: [],
  bgTasks: { running: 0, total: 0 },
  notices: [],
  ...o,
});
const text = (st: RuntimeStatus, lang: 'vi' | 'en' = 'vi'): string => renderWelcome({ version: '0.4.1', lang, theme, width: 100, height: 40, status: st, cwd: '/work/demo', tipIndex: 0 }).join('\n');

describe('khung chào: dòng tài khoản / nhà cung cấp', () => {
  it('chưa đăng nhập Locaith mà đang dùng Locaith → nhắc /login', () => {
    expect(text(status({ account: { loggedIn: false } }))).toContain('Chưa đăng nhập — gõ /login');
  });
  it('đã đăng nhập → hiện tài khoản, không nhắc /login', () => {
    const t = text(status({ account: { loggedIn: true, email: 'a***@x.vn', plan: 'pro' } }));
    expect(t).toContain('a***@x.vn');
    expect(t).not.toContain('/login');
  });
  it('đang dùng khoá/API của hãng khác (provider ≠ locaith): KHÔNG cảnh báo «chưa đăng nhập», nói rõ đang chạy bằng nhà cung cấp nào', () => {
    const t = text(status({ provider: 'ollama', model: 'qwen3-coder', account: { loggedIn: false } }));
    expect(t).not.toContain('Chưa đăng nhập');
    expect(t).toMatch(/Nhà cung cấp:\s*ollama/);
    expect(t).toContain('qwen3-coder');
    setLang('en'); // chuỗi lấy theo ngôn ngữ hiện hành của CLI
    try {
      expect(text(status({ provider: 'anthropic', model: 'claude-opus-5-5' }), 'en')).toMatch(/Provider:\s*anthropic/);
    } finally {
      setLang('vi');
    }
  });
});
