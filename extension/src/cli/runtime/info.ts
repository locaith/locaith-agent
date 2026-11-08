/**
 * Thông tin phụ cho dải trạng thái: nhánh git (spawn ngắn, đệm) và tài khoản/gói/đồng ý thông báo (đệm ra đĩa, KHÔNG chặn khởi động).
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { gatewayDiagnosticHeaders } from '../../core/providers/gatewayDiagnostics';
import { LOCAITH_GATEWAY_URL, LocaithGatewayClient } from '../../core/providers/locaithGateway';
import { readJsonFile, writeFileAtomic } from './util';

/** Nhánh git hiện tại, đệm vài giây; `refresh()` chạy nền, `current()` trả ngay giá trị đã biết. */
export class GitBranch {
  private value: string | undefined;
  private at = 0;
  private inflight = false;

  constructor(
    private readonly cwd: string,
    private readonly onChange: () => void,
  ) {}

  current(): string | undefined {
    return this.value;
  }

  refresh(force = false): void {
    if (this.inflight) return;
    if (!force && Date.now() - this.at < 3000) return;
    this.inflight = true;
    this.at = Date.now();
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: this.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      this.inflight = false;
      return;
    }
    let out = '';
    let done = false;
    const finish = (v: string | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.inflight = false;
      const next = v || undefined;
      if (next !== this.value) {
        this.value = next;
        this.onChange();
      }
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* đã thoát */
      }
      finish(this.value);
    }, 1000);
    timer.unref?.();
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString('utf8');
    });
    child.on('error', () => finish(undefined));
    child.on('close', (code) => finish(code === 0 ? out.trim().split(/\r?\n/)[0] || undefined : undefined));
  }
}

export interface AccountInfo {
  loggedIn: boolean;
  email?: string;
  name?: string;
  plan?: string;
  /** Đã đồng ý thông báo dữ liệu (undefined = chưa biết). */
  consent?: boolean;
}

interface CacheFile {
  fp: string;
  at: number;
  name?: string;
  email?: string;
  plan?: string;
  consent?: boolean;
}

const OK_TTL_MS = 60 * 60_000;
const BAD_TTL_MS = 2 * 60_000;

export class AccountInfoCache {
  private cache: CacheFile | undefined;
  private inflight: Promise<void> | null = null;
  private readonly file: string;

  constructor(
    home: string,
    private readonly o: {
      key(): string | undefined;
      baseUrl(): string;
      version: string;
      fetchImpl?: typeof fetch;
      onChange(): void;
      log(level: 'debug' | 'info' | 'warn' | 'error', msg: string): void;
    },
  ) {
    this.file = path.join(home, '.locaith', 'cache', 'account.json');
    this.cache = readJsonFile<CacheFile>(this.file);
  }

  private fp(key: string): string {
    return createHash('sha256').update(key).digest('hex').slice(0, 16);
  }

  current(): AccountInfo {
    const key = this.o.key();
    if (!key) return { loggedIn: false };
    const c = this.cache && this.cache.fp === this.fp(key) ? this.cache : undefined;
    return { loggedIn: true, ...(c?.email ? { email: c.email } : {}), ...(c?.name ? { name: c.name } : {}), ...(c?.plan ? { plan: c.plan } : {}), ...(c?.consent !== undefined ? { consent: c.consent } : {}) };
  }

  /** Làm mới từ cổng (có hạn giờ, không ném). Bỏ qua khi bộ đệm còn mới. */
  refresh(force = false): Promise<void> {
    const key = this.o.key();
    if (!key) return Promise.resolve();
    const fp = this.fp(key);
    const c = this.cache;
    if (!force && c && c.fp === fp && Date.now() - c.at < (c.consent === false ? BAD_TTL_MS : OK_TTL_MS)) return Promise.resolve();
    this.inflight ??= (async () => {
      const client = new LocaithGatewayClient({
        baseUrl: () => this.o.baseUrl() || LOCAITH_GATEWAY_URL,
        timeoutMs: 5000,
        headers: () => gatewayDiagnosticHeaders({ family: 'cli', version: this.o.version }),
        ...(this.o.fetchImpl ? { fetch: this.o.fetchImpl } : {}),
      });
      try {
        const [acct, consent] = await Promise.all([client.getAccount(key), client.getConsent(key)]);
        const card = acct.ok ? acct.account.account : null;
        const next: CacheFile = {
          fp,
          at: Date.now(),
          ...(card?.name ? { name: card.name } : {}),
          ...(card?.email_masked ? { email: card.email_masked } : {}),
          ...((card?.plan ?? (acct.ok ? acct.account.plan : undefined)) ? { plan: card?.plan ?? (acct.ok ? acct.account.plan : undefined) } : {}),
          ...(consent.ok ? { consent: consent.state.accepted } : {}),
        };
        // Lỗi mạng (không có kết quả nào) → giữ bộ đệm cũ, đừng ghi đè bằng rỗng.
        if (!acct.ok && !consent.ok && this.cache?.fp === fp) return;
        this.cache = next;
        try {
          writeFileAtomic(this.file, JSON.stringify(next), 0o600);
        } catch {
          /* không ghi được bộ đệm thì thôi */
        }
        this.o.onChange();
      } catch (err) {
        this.o.log('debug', `Làm mới thông tin tài khoản lỗi: ${err instanceof Error ? err.message : String(err)}`);
      }
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  forget(): void {
    this.cache = undefined;
  }
}
