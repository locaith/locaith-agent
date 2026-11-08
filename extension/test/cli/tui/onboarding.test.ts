import { describe, expect, it } from 'vitest';
import type { AccountDeps } from '../../../src/cli/account';
import { getLang, setLang } from '../../../src/cli/i18n';
import { runOnboarding, runOnboardingFlow, detectByokKeys, type OnboardingOptions, type OnboardingUi } from '../../../src/cli/tui/onboarding';
import type { PickItem } from '../../../src/cli/runtime/contract';
import { FakeIn, VT, sleep } from './helpers/vt';

/** Giao diện giả: trả lời theo kịch bản. */
function scripted(answers: Array<string | boolean | null>): OnboardingUi & { said: string[]; asked: string[] } {
  const said: string[] = [];
  const asked: string[] = [];
  const next = (): string | boolean | null => (answers.length ? (answers.shift() as string | boolean | null) : null);
  return {
    said,
    asked,
    async pick(title: string, _items: PickItem[]) {
      asked.push('pick:' + title);
      return next() as string | null;
    },
    async confirm(title: string) {
      asked.push('confirm:' + title);
      return next() as boolean | null;
    },
    async input(title: string) {
      asked.push('input:' + title);
      return next() as string | null;
    },
    say: (k, t) => void said.push(`${k}:${t}`),
    wait: () => ({ stop() {}, cancelled: new Promise<void>(() => undefined) }),
    heading: () => undefined,
    close: () => undefined,
  };
}

const base = (o: Partial<OnboardingOptions> = {}): OnboardingOptions => ({ version: '0.4.0', lang: 'vi', cwd: 'C:\\Dev\\x', env: {}, ...o });

const deps = (calls: string[], browserOk = true): ((io: unknown) => AccountDeps) => () => ({
  baseUrl: 'http://x',
  readKey: () => undefined,
  writeKey: (k: string) => {
    calls.push('write:' + k.slice(0, 4));
    return 'cfg.json';
  },
  ask: async () => '',
  json: false,
  listModels: async () => [],
  out: () => undefined,
  err: () => undefined,
  browserLogin: async () => (browserOk ? { ok: true as const, token: 'lat_' + 'a'.repeat(43), user: { name: 'An' } } : { ok: false as const, error: 'denied' as const }),
});

describe('runOnboardingFlow (logic)', () => {
  it('chọn English → ngôn ngữ đổi và được lưu', async () => {
    const ui = scripted(['en', 'skip', 'yes']);
    const saved: string[] = [];
    const r = await runOnboardingFlow(base({ saveLang: (l) => saved.push(l) }), ui);
    expect(getLang()).toBe('en');
    expect(saved).toEqual(['en']);
    expect(r.lang).toBe('en');
    setLang('vi');
  });

  it('bỏ qua đăng nhập → vẫn hỏi tin cậy; trả lời Có', async () => {
    const ui = scripted(['skip', 'yes']);
    const saved: boolean[] = [];
    const r = await runOnboardingFlow(base({ languageChosen: true, saveTrust: (t) => saved.push(t) }), ui);
    expect(r).toMatchObject({ loggedIn: false, trusted: true, cancelled: false });
    expect(saved).toEqual([true]);
  });

  it('không tin cậy → thoát (cancelled, reason untrusted)', async () => {
    const ui = scripted(['skip', 'no']);
    const saved: boolean[] = [];
    const r = await runOnboardingFlow(base({ languageChosen: true, saveTrust: (t) => saved.push(t) }), ui);
    expect(r).toMatchObject({ cancelled: true, reason: 'untrusted', trusted: false });
    expect(saved).toEqual([false]);
  });

  it('Esc ở bước đầu → cancelled', async () => {
    const r = await runOnboardingFlow(base(), scripted([null]));
    expect(r.cancelled).toBe(true);
  });

  it('đã đăng nhập + đã tin cậy → không hỏi gì', async () => {
    const ui = scripted([]);
    const r = await runOnboardingFlow(base({ languageChosen: true, loggedIn: true, trusted: true, consentAccepted: true }), ui);
    expect(ui.asked).toEqual([]);
    expect(r).toMatchObject({ loggedIn: true, trusted: true, cancelled: false });
  });

  it('BYOK: thấy khoá trong môi trường → coi như có thông tin xác thực', async () => {
    const ui = scripted(['byok', 'yes']);
    const r = await runOnboardingFlow(base({ languageChosen: true, env: { ANTHROPIC_API_KEY: 'sk-x' } }), ui);
    expect(r.loggedIn).toBe(true);
    expect(ui.said.some((s) => s.includes('ANTHROPIC_API_KEY'))).toBe(true);
    expect(detectByokKeys({ OPENAI_API_KEY: ' ', GEMINI_API_KEY: 'k' })).toEqual(['GEMINI_API_KEY']);
  });

  it('BYOK: không có khoá → hướng dẫn và dừng', async () => {
    const ui = scripted(['byok']);
    const r = await runOnboardingFlow(base({ languageChosen: true }), ui);
    expect(r).toMatchObject({ cancelled: true, reason: 'byok-missing' });
    expect(ui.said.some((s) => s.startsWith('warn:'))).toBe(true);
  });

  it('đồng ý thông báo dữ liệu: chọn «chưa» thì không gọi cổng', async () => {
    let called = false;
    const ui = scripted(['byok', false, 'yes']);
    // BYOK đặt consented = true nên không hỏi; dùng nhánh token với accountDeps lỗi → bỏ qua đăng nhập
    const r = await runOnboardingFlow(base({ languageChosen: true, loggedIn: true, acceptConsent: async () => ((called = true), { ok: true }) }), scripted([false, 'yes']));
    expect(called).toBe(false);
    expect(r.consented).toBe(false);
    void ui;
  });

  it('đồng ý → gọi acceptConsent và ghi nhận', async () => {
    let called = false;
    const r = await runOnboardingFlow(base({ languageChosen: true, loggedIn: true, acceptConsent: async () => ((called = true), { ok: true }) }), scripted([true, 'yes']));
    expect(called).toBe(true);
    expect(r.consented).toBe(true);
  });

  it('đăng nhập lỗi (trình duyệt bị từ chối) → báo lỗi rồi cho chọn lại', async () => {
    const calls: string[] = [];
    const ui = scripted(['browser', 'skip', 'yes']);
    const r = await runOnboardingFlow(base({ languageChosen: true, accountDeps: deps(calls, false) as never }), ui);
    expect(r.loggedIn).toBe(false);
    expect(ui.said.some((s) => s.startsWith('warn:'))).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe('runOnboarding trên terminal ảo', () => {
  it('chọn ngôn ngữ, bỏ qua đăng nhập, tin cậy — bằng phím thật', async () => {
    const vt = new VT(90, 28);
    const inp = new FakeIn();
    const p = runOnboarding({ ...base(), stdin: inp as never, stdout: vt as never, env: { COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' } });
    await sleep(100);
    await vt.settle();
    expect(vt.text()).toContain('Chọn ngôn ngữ');
    inp.type('\x1b[B'); // English
    inp.type('\r');
    await sleep(100);
    await vt.settle();
    expect(vt.text()).toContain('Sign in');
    inp.type('\x1b[B\x1b[B\x1b[B'); // Skip
    inp.type('\r');
    await sleep(100);
    await vt.settle();
    expect(vt.text()).toContain('Trust this folder?');
    expect(vt.text()).toContain('1. Yes, trust this folder');
    inp.type('\r');
    const r = await p;
    expect(r).toMatchObject({ lang: 'en', trusted: true, cancelled: false, loggedIn: false });
    expect(vt.raw.join('')).toContain('\x1b[?2004l'); // khôi phục terminal
    setLang('vi');
  });

  it('Ctrl+C ở hộp chọn → cancelled và terminal được khôi phục', async () => {
    const vt = new VT(90, 28);
    const inp = new FakeIn();
    const p = runOnboarding({ ...base({ languageChosen: true }), stdin: inp as never, stdout: vt as never, env: { COLORTERM: 'truecolor' } });
    await sleep(100);
    await vt.settle();
    inp.type('\x03');
    const r = await p;
    expect(r.cancelled).toBe(true);
    expect(inp.raw).toBe(false);
  });
});
