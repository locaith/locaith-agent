/**
 * Kho bí mật của Remote cho CLI: `~/.locaith/remote.json` (quyền 600, ghi nguyên tử).
 *
 * Extension giữ những thứ này trong SecretStorage của VS Code; CLI không có kho đó nên dùng một tệp riêng, tách khỏi `cli.json` (khoá đăng nhập) và `settings.json`
 * (cài đặt, thường được đồng bộ/chia sẻ). Nội dung:
 *   • `machineSecret` — bí mật riêng của MÁY này (256 bit), trộn với khoá thư mục để ra mã máy: cùng một thư mục luôn cho cùng một mã máy (trang web nhớ máy theo mã đó),
 *     nhưng không ai đoán được mã từ bên ngoài. Mã máy là tên kênh Realtime nên cũng là một phần bí mật của kênh.
 *   • `accountKeys[mã máy] = {u, k}` — «khoá tài khoản» 128 bit của từng máy, GẮN với tài khoản đã sinh ra nó: đăng nhập tài khoản khác thì khoá cũ bị thay.
 *   • `devices` — thiết bị đã ghép đôi (đường ghép đôi bằng liên kết/QR), cùng khuôn với `RemoteDevice` của extension.
 *   • `enabled[khoá thư mục]` — Remote có tự bật lại khi mở CLI ở thư mục này không.
 * Không bao giờ ghi nội dung tệp này ra log, thông báo hay màn hình. Đọc lỗi/hỏng = coi như rỗng (không ném).
 */

import { createHash, randomBytes } from 'node:crypto';
import * as path from 'node:path';
import type { RemoteDevice, RemoteStore } from '../../core/remote/server';
import { isPlainObject, pathKey, readJsonFile, writeFileAtomic } from '../runtime/util';

export const ACCOUNT_KEY_RE = /^[A-Za-z0-9_-]{22}$/;
const HOST_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const b64u = (b: Buffer): string => b.toString('base64url');

export function remoteFile(home: string): string {
  return path.join(home, '.locaith', 'remote.json');
}

interface FileShape {
  version: 1;
  machineSecret?: string;
  accountKeys?: Record<string, { u: string; k: string }>;
  devices?: RemoteDevice[];
  enabled?: Record<string, boolean>;
}

function validDevice(d: unknown): d is RemoteDevice {
  if (!isPlainObject(d)) return false;
  if (typeof d.id !== 'string' || typeof d.label !== 'string' || !Number.isFinite(d.createdAt) || !Number.isFinite(d.lastSeen)) return false;
  if (d.kind === 'relay') return typeof d.key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(d.key) && typeof d.hostId === 'string' && HOST_ID_RE.test(d.hostId);
  return typeof d.tokenHash === 'string' && /^[0-9a-f]{64}$/.test(d.tokenHash);
}

/** Một tệp, đọc-sửa-ghi mỗi lần (nhiều tiến trình `locaith` cùng chạy không ghi đè lẫn nhau quá một thao tác ngắn). */
export class RemoteFileStore implements RemoteStore {
  constructor(private readonly home: string) {}

  private read(): FileShape {
    const j = readJsonFile<unknown>(remoteFile(this.home));
    if (!isPlainObject(j)) return { version: 1 };
    const keys: Record<string, { u: string; k: string }> = {};
    if (isPlainObject(j.accountKeys)) {
      for (const [id, v] of Object.entries(j.accountKeys)) {
        if (HOST_ID_RE.test(id) && isPlainObject(v) && typeof v.u === 'string' && typeof v.k === 'string' && ACCOUNT_KEY_RE.test(v.k)) keys[id] = { u: v.u, k: v.k };
      }
    }
    const enabled: Record<string, boolean> = {};
    if (isPlainObject(j.enabled)) for (const [k, v] of Object.entries(j.enabled)) if (typeof v === 'boolean') enabled[k] = v;
    return {
      version: 1,
      ...(typeof j.machineSecret === 'string' && j.machineSecret.length >= 32 ? { machineSecret: j.machineSecret } : {}),
      accountKeys: keys,
      devices: Array.isArray(j.devices) ? j.devices.filter(validDevice) : [],
      enabled,
    };
  }

  private write(s: FileShape): void {
    writeFileAtomic(remoteFile(this.home), `${JSON.stringify(s, null, 2)}\n`, 0o600);
  }

  // ── RemoteStore (thiết bị đã ghép đôi) ──
  async load(): Promise<RemoteDevice[]> {
    return this.read().devices ?? [];
  }
  async save(list: RemoteDevice[]): Promise<void> {
    const s = this.read();
    s.devices = list;
    this.write(s);
  }

  // ── mã máy ──
  /** Mã máy (base64url 22 ký tự = 16 byte): băm(bí mật máy | khoá thư mục). Tạo bí mật máy ở lần đầu. */
  hostId(cwd: string): string {
    const s = this.read();
    let secret = s.machineSecret;
    if (!secret) {
      secret = b64u(randomBytes(32));
      s.machineSecret = secret;
      this.write(s);
      secret = this.read().machineSecret ?? secret; // đọc lại: hai tiến trình cùng tạo thì lấy giá trị cuối cùng được lưu
    }
    return b64u(createHash('sha256').update(`${secret}|${pathKey(cwd)}`).digest().subarray(0, 16));
  }

  // ── khoá tài khoản ──
  /** Khoá hiện có của máy này nếu thuộc ĐÚNG tài khoản `uid`; ngược lại null (chưa có / của tài khoản khác). */
  accountKey(hostId: string, uid: string): string | null {
    const e = this.read().accountKeys?.[hostId];
    return e && e.u === uid ? e.k : null;
  }

  /** Khoá của máy này cho tài khoản `uid`: dùng khoá cũ nếu đúng tài khoản, nếu không sinh khoá mới (và thay khoá của tài khoản trước). */
  ensureAccountKey(hostId: string, uid: string): string {
    const had = this.accountKey(hostId, uid);
    if (had) return had;
    return this.setAccountKey(hostId, uid, b64u(randomBytes(16)));
  }

  setAccountKey(hostId: string, uid: string, key: string): string {
    if (!ACCOUNT_KEY_RE.test(key)) throw new Error('bad_account_key');
    const s = this.read();
    s.accountKeys = { ...(s.accountKeys ?? {}), [hostId]: { u: uid, k: key } };
    this.write(s);
    return this.accountKey(hostId, uid) ?? key; // đọc lại: giá trị cuối cùng được lưu thắng
  }

  /** Xoá khoá (thu hồi): lần bật sau luôn dùng khoá MỚI, khoá cũ không sống lại. */
  dropAccountKey(hostId: string): void {
    const s = this.read();
    if (!s.accountKeys?.[hostId]) return;
    const { [hostId]: _drop, ...rest } = s.accountKeys;
    s.accountKeys = rest;
    this.write(s);
  }

  // ── tự bật lại ──
  isEnabled(cwd: string): boolean {
    return this.read().enabled?.[pathKey(cwd)] === true;
  }
  setEnabled(cwd: string, on: boolean): void {
    const s = this.read();
    const key = pathKey(cwd);
    const cur = { ...(s.enabled ?? {}) };
    if (on) cur[key] = true;
    else delete cur[key];
    s.enabled = cur;
    this.write(s);
  }
}
