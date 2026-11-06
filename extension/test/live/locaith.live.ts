/**
 * Kiểm thử THẬT: engine của extension + provider `locaith` (đúng lớp ProviderRegistry sản phẩm dùng) ↔ cổng mô hình Locaith thử (cổng 8671, xác thực giả,
 * khoá DeepSeek thật nằm phía sau). Kiểm HÀNH VI của mô hình với hai kỹ năng riêng và kỹ năng video — không phải đoán qua prompt.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, beforeAll } from 'vitest';
import { ProviderRegistry } from '../../src/core/providers/registry';
import { textOf } from '../../src/core/types';
import { eventsOf, makeHarness } from '../helpers/harness';
import type { FakeProvider } from '../helpers/fakeProvider';

const BASE = process.env.LIVE_BASE ?? 'http://127.0.0.1:8671/api/llm/v1';
const TOKEN = 'jwt-user-5';

function realProvider() {
  // Đúng đường đi của sản phẩm: ProviderRegistry + `account` (token thiết bị + tiêu đề cho cổng) — ở đây token là người dùng thử của máy chủ thử.
  const registry = new ProviderRegistry({
    resolveApiKey: async () => undefined,
    baseUrlOverrides: { locaith: BASE },
    env: {},
    account: {
      token: () => TOKEN,
      headers: ({ sessionKey, ticket }) => ({ 'x-locaith-client': 'vscode/live-test', 'x-locaith-queue': 'ticket', ...(sessionKey ? { 'x-locaith-session': sessionKey } : {}), ...(ticket ? { 'x-locaith-ticket': ticket } : {}) }),
    },
  });
  return registry.get('locaith');
}

async function ensureConsent() {
  const r = await fetch(`${BASE}/consent`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, client: 'vscode/live-test' }) });
  if (!r.ok) throw new Error(`consent ${r.status}`);
}

function harness(files: Record<string, string> = {}, dir?: string) {
  const h = makeHarness([], { provider: realProvider() as unknown as FakeProvider, sessionProvider: 'locaith', files, settings: { maxTurns: 14 } });
  h.session.model = 'locaith-v5-flash';
  void dir;
  return h;
}

const skillsLoaded = (events: ReturnType<typeof harness>['events']) => eventsOf(events, 'skill').map((e) => e.skill);
const finalText = (h: ReturnType<typeof harness>) => {
  const last = [...h.session.messages].reverse().find((m) => m.role === 'assistant');
  return last ? textOf(last) : '';
};

beforeAll(ensureConsent);

describe('Locaith-v5-flash thật: kỹ năng riêng', () => {
  it('soạn công văn → nạp soan-thao-van-ban-nd30 rồi soạn đúng thể thức', async () => {
    const h = harness();
    const r = await h.run('Soạn giúp tôi công văn của Công ty TNHH ABC (địa chỉ Hà Nội) gửi Sở Kế hoạch và Đầu tư thành phố Hà Nội đề nghị gia hạn thời gian nộp báo cáo giám sát đầu tư quý III đến hết ngày 20 tháng 11 năm 2026, lý do hệ thống kế toán đang nâng cấp. Người ký: ông Nguyễn Văn An, Giám đốc. Chỉ trả lời trong chat, không tạo tệp.');
    expect(r.stopReason).toBe('end_turn');
    const text = finalText(h);
    console.log('--- kỹ năng đã nạp:', skillsLoaded(h.events).join(', '), '\n--- văn bản (đầu):\n' + text.slice(0, 1800));
    expect(skillsLoaded(h.events)).toContain('soan-thao-van-ban-nd30');
    for (const re of [/CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM/, /Độc lập - Tự do - Hạnh phúc/, /Số:/, /V\/v/i, /Kính gửi/i, /Nơi nhận/i, /ngày\s+\d{2}\s+tháng\s+(\d{1,2})\s+năm\s+20\d\d/i, /(Trân trọng|Rất mong nhận được|Kính đề nghị)/i, /Nguyễn Văn An/, /Cần điền\/kiểm tra/i, /Kế hoạch và Đầu tư/]) expect(text, String(re)).toMatch(re);
  });

  it('nhớ giúp → nạp ghi-nho-memory và ghi tệp ký ức; cuộc trò chuyện MỚI nhớ lại được', async () => {
    const h1 = harness();
    const r1 = await h1.run('Nhớ giúp tôi: trong mọi dự án tôi dùng pnpm chứ không dùng npm, và tôi thích câu trả lời ngắn gọn.');
    expect(r1.stopReason).toBe('end_turn');
    console.log('--- kỹ năng đã nạp:', skillsLoaded(h1.events).join(', '), '| trả lời:', finalText(h1).slice(0, 300));
    expect(skillsLoaded(h1.events)).toContain('ghi-nho-memory');
    const memDir = path.join(h1.dir, '.locaith', 'memory');
    const files = fs.existsSync(memDir) ? fs.readdirSync(memDir) : [];
    console.log('--- tệp ký ức:', files.join(', '));
    expect(files.length).toBeGreaterThan(0);
    const all = files.map((f) => fs.readFileSync(path.join(memDir, f), 'utf8')).join('\n');
    expect(all).toMatch(/pnpm/i);

    // Cuộc trò chuyện MỚI trong cùng thư mục dự án: phải đọc ký ức rồi trả lời đúng.
    const h2 = makeHarness([], { provider: realProvider() as unknown as FakeProvider, sessionProvider: 'locaith', settings: { maxTurns: 10 } });
    // dùng chung thư mục dự án: chép ký ức sang workspace của h2
    const memDir2 = path.join(h2.dir, '.locaith', 'memory');
    fs.mkdirSync(memDir2, { recursive: true });
    for (const f of files) fs.copyFileSync(path.join(memDir, f), path.join(memDir2, f));
    h2.session.model = 'locaith-v5-flash';
    const r2 = await h2.run('Dự án này tôi dùng trình quản lý gói nào? Trả lời đúng một câu.');
    expect(r2.stopReason).toBe('end_turn');
    console.log('--- cuộc mới: kỹ năng', skillsLoaded(h2.events).join(', '), '| trả lời:', finalText(h2));
    expect(finalText(h2)).toMatch(/pnpm/i);
  });

  it('nhờ làm video → nạp quy-trinh-video-locaith (kỹ năng cài sẵn)', async () => {
    const h = harness();
    const r = await h.run('Anh cần làm một video quảng cáo 1 phút khổ dọc cho sản phẩm của khách. Nên làm theo đường nào? Chỉ cần nêu hướng đi, ngắn gọn.');
    expect(r.stopReason).toBe('end_turn');
    console.log('--- kỹ năng đã nạp:', skillsLoaded(h.events).join(', '), '| trả lời:', finalText(h).slice(0, 600));
    expect(skillsLoaded(h.events)).toContain('quy-trinh-video-locaith');
  });
});
