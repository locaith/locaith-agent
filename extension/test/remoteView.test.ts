import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { QueueState } from '../src/core/remote/queue';
import { buildRemoteView } from '../src/core/remote/remoteView';

const q = (o: Partial<QueueState> = {}): QueueState => ({ kind: 'connections', reason: 'HTTP 403: {"error":"too_many_connections"} (chuỗi thô của relay)', attempt: 2, since: 1_000, retryAt: 31_000, waitMs: 30_000, trying: false, ...o });

describe('buildRemoteView — trạng thái Remote hiển thị trong khung chat', () => {
  it('không có đường Internet (tắt / chưa đăng nhập / remote.cloud tắt) → off', () => {
    expect(buildRemoteView({ enabled: false, signedIn: true, devices: 0, streams: 0 })).toEqual({ enabled: false, signedIn: true, relay: 'off', devices: 0, streams: 0 });
    expect(buildRemoteView({ enabled: true, signedIn: false, devices: 1, streams: 0 }).relay).toBe('off');
  });

  it('trạng thái bình thường: đã nối / đang nối / mất kết nối', () => {
    expect(buildRemoteView({ enabled: true, signedIn: true, relay: { status: 'online' }, devices: 2, streams: 1 })).toEqual({ enabled: true, signedIn: true, relay: 'online', devices: 2, streams: 1 });
    expect(buildRemoteView({ enabled: true, signedIn: true, relay: { status: 'connecting' }, devices: 0, streams: 0 }).relay).toBe('connecting');
    expect(buildRemoteView({ enabled: true, signedIn: true, relay: { status: 'idle' }, devices: 0, streams: 0 }).relay).toBe('connecting');
    expect(buildRemoteView({ enabled: true, signedIn: true, relay: { status: 'offline' }, devices: 0, streams: 0 }).relay).toBe('offline');
    expect(buildRemoteView({ enabled: true, signedIn: true, relay: { status: 'offline', queue: null }, devices: 0, streams: 0 }).queue).toBeUndefined();
  });

  it('relay quá tải → queued kèm hàng chờ để khung chat đếm ngược; CHUỖI LỖI THÔ của relay không đi xuống giao diện', () => {
    const v = buildRemoteView({ enabled: true, signedIn: true, relay: { status: 'offline', queue: q() }, devices: 0, streams: 0 });
    expect(v.relay).toBe('queued');
    expect(v.queue).toEqual({ kind: 'connections', attempt: 2, retryAt: 31_000, waitMs: 30_000, since: 1_000, trying: false });
    expect(JSON.stringify(v)).not.toContain('too_many_connections');
    expect(Object.keys(v.queue!)).not.toContain('reason');
  });

  it('tin cậy theo tài khoản (0.6.5): chỉ có trường `trust` khi đang hoạt động — giao diện nhờ đó chọn «Mở trang Remote» thay vì «Ghép đôi»', () => {
    const on = buildRemoteView({ enabled: true, signedIn: true, relay: { status: 'online' }, devices: 0, streams: 0, trust: true });
    expect(on).toEqual({ enabled: true, signedIn: true, relay: 'online', devices: 0, streams: 0, trust: true });
    const off = buildRemoteView({ enabled: true, signedIn: true, relay: { status: 'online' }, devices: 0, streams: 0, trust: false });
    expect('trust' in off).toBe(false);
    expect('trust' in buildRemoteView({ enabled: true, signedIn: true, relay: { status: 'online' }, devices: 0, streams: 0 })).toBe(false);
  });

  it('đang xếp hàng thì status của đường truyền (offline/connecting) không che trạng thái queued; đang thử → trying', () => {
    for (const status of ['offline', 'connecting', 'idle'] as const) expect(buildRemoteView({ enabled: true, signedIn: true, relay: { status, queue: q({ trying: status === 'connecting' }) }, devices: 0, streams: 0 }).relay).toBe('queued');
    expect(buildRemoteView({ enabled: true, signedIn: true, relay: { status: 'connecting', queue: q({ trying: true }) }, devices: 0, streams: 0 }).queue?.trying).toBe(true);
  });
});

describe('quy tắc giao diện: hàng chờ quá tải nằm TRONG khung chat, không dùng thông báo của hệ thống VS Code', () => {
  const root = path.resolve(__dirname, '..');
  const remote = fs.readFileSync(path.join(root, 'src/host/remote.ts'), 'utf8');

  it('remote.ts không dựng thông báo tiến trình / thông điệp thanh trạng thái / nền cảnh báo cho việc quá tải', () => {
    expect(remote).not.toMatch(/withProgress|ProgressLocation|setStatusBarMessage|statusBarItem\.warningBackground/);
  });

  it('onQueue chỉ cập nhật khung QR (của extension) và báo thay đổi cho khung chat — không gọi hộp thoại', () => {
    const body = remote.slice(remote.indexOf('private onQueue('), remote.indexOf('retryQueueNow(): boolean'));
    expect(body).not.toMatch(/vscode\.window\.show/);
    expect(body).toMatch(/this\.notify\(\)/);
  });

  it('khi đang xếp hàng, ghép đôi qua Internet không bật hộp thoại (khung QR + khung chat đã nói rõ)', () => {
    const i = remote.indexOf("if (relay.host.status !== 'online' && queue) return;");
    expect(i).toBeGreaterThan(0);
  });

  it('tin cậy theo tài khoản BẬT SẴN, chỉ đọc từ cài đặt người dùng (kho mã lạ không tự bật/tắt hộ chủ máy) và khung chat nói đúng về nó', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const props = (pkg.contributes.configuration.properties ?? pkg.contributes.configuration[0].properties) as Record<string, { default: unknown; scope?: string }>;
    expect(props['locaithAgent.remote.trustAccount']).toMatchObject({ default: true, scope: 'machine' });
    const config = fs.readFileSync(path.join(root, 'src/host/config.ts'), 'utf8');
    expect(config).toMatch(/get<boolean>\('remote\.trustAccount', true\)/);
    expect(config).toMatch(/SECURE_KEYS[\s\S]*'remote\.trustAccount'[\s\S]*\]\);/);
    const nls = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.json'), 'utf8'));
    const nlsEn = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.en.json'), 'utf8'));
    for (const n of [nls, nlsEn]) {
      expect(n['cfg.remoteTrustAccount']).toMatch(/trustAccount|tài khoản|account/i);
      // mô tả chung của Remote không được còn nói «mỗi lần ghép đều cần Cho phép» như thể đó là cách duy nhất vào được máy
      expect(n['cfg.remoteEnabled']).not.toMatch(/Until you pair a device nobody can control|Chưa ghép đôi thiết bị nào thì không ai điều khiển được gì/);
    }
  });

  it('Remote BẬT SẴN cho người đã đăng nhập; đường cục bộ mặc định TẮT (không mở cổng nào)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const props = (pkg.contributes.configuration.properties ?? pkg.contributes.configuration[0].properties) as Record<string, { default: unknown }>;
    expect(props['locaithAgent.remote.enabled']!.default).toBe(true);
    expect(props['locaithAgent.remote.cloud']!.default).toBe(true);
    expect(props['locaithAgent.remote.local']!.default).toBe(false);
    const config = fs.readFileSync(path.join(root, 'src/host/config.ts'), 'utf8');
    expect(config).toMatch(/get<boolean>\('remote\.enabled', true\)/);
    expect(config).toMatch(/get<boolean>\('remote\.local', false\)/);
  });
});
