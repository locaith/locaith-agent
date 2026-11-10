import { describe, expect, it } from 'vitest';
import { CATALOG, CATEGORY_ORDER, catalogEntry, describeServer, type CatalogEntry } from '../src/core/mcp/catalog';
import { describeServerForApproval } from '../src/core/mcp/display';
import { ConnectorService, inputSecretName, type ConnectorDeps } from '../src/host/connectors';

/**
 * (0.7.7) Mục kho có `inputs`: khoá API / ID khách hàng / địa chỉ máy chủ riêng do người dùng nhập khi kết nối. Kiểm: hỏi lần lượt, lưu vào SecretStorage (không vào cài đặt),
 * ghép vào cấu hình CHỈ lúc khởi động, che «•••» trên giao diện, huỷ giữa chừng không lưu gì, ngắt kết nối xoá sạch.
 */

function mkDeps(answers: Array<string | undefined>, over: Partial<ConnectorDeps> = {}) {
  const store = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  const asked: Array<{ title: string; prompt: string; password?: boolean }> = [];
  const registered: string[] = [];
  const queue = [...answers];
  const deps: ConnectorDeps = {
    memento: { get: <T>(k: string, d: T) => (store.has(k) ? (store.get(k) as T) : d), update: (k, v) => void store.set(k, v) },
    secrets: { get: async (n) => secrets.get(n), set: async (n, v) => void secrets.set(n, v), delete: async (n) => void secrets.delete(n) },
    openExternal: async () => {},
    githubToken: async () => undefined,
    prompt: async (o) => {
      asked.push({ title: o.title, prompt: o.prompt, password: o.password });
      return queue.shift();
    },
    registerSecret: (v) => void registered.push(v),
    workspaceFolder: () => 'C:/du-an',
    homedir: 'C:/Users/x',
    log: () => {},
    ...over,
  };
  return { deps, store, secrets, asked, registered };
}

const ID_ENV = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

describe('kho kết nối: tính hợp lệ của `inputs` và các nhóm mới', () => {
  const withInputs = CATALOG.filter((e) => e.inputs?.length);

  it('mỗi mục có `inputs` hợp lệ: khoá duy nhất, đúng loại, bí mật không đi qua đối số, header chỉ ở mục «key»', () => {
    expect(withInputs.length).toBeGreaterThan(15);
    for (const e of withInputs) {
      const keys = e.inputs!.map((i) => `${i.kind}:${i.key}`);
      expect(new Set(keys).size, `${e.id}: khoá trùng`).toBe(keys.length);
      for (const i of e.inputs!) {
        expect(i.label.length, `${e.id}: thiếu nhãn`).toBeGreaterThan(3);
        if (i.kind === 'env') expect(i.key, `${e.id}: tên biến`).toMatch(ID_ENV);
        if (i.kind === 'header') {
          expect(i.key, `${e.id}: tên header`).toMatch(HEADER_NAME);
          expect(e.transport, `${e.id}: header chỉ cho máy chủ HTTP`).toBe('http');
        }
        if (i.kind === 'arg') {
          expect(i.secret, `${e.id}: bí mật không được đi qua đối số (lộ trong danh sách tiến trình)`).toBeFalsy();
          expect(e.transport).toBe('stdio');
        }
        if (i.prefix) expect(i.kind).toBe('header');
      }
    }
  });

  it('mục «key» là máy chủ HTTP và có ít nhất một header; mục stdio không dùng auth «key»', () => {
    for (const e of CATALOG.filter((x) => x.auth === 'key')) {
      expect(e.transport).toBe('http');
      expect(e.inputs?.some((i) => i.kind === 'header' && i.secret), `${e.id}: cần header bí mật`).toBe(true);
    }
    for (const e of CATALOG.filter((x) => x.transport === 'stdio')) expect(e.auth).not.toBe('key');
  });

  it('mọi mục thuộc một nhóm có trong CATEGORY_ORDER; nhóm mới có mục; không còn đối số giữ chỗ «<…>»', () => {
    for (const e of CATALOG) {
      expect(CATEGORY_ORDER, e.id).toContain(e.category);
      for (const a of e.args ?? []) expect(a, `${e.id}: đối số giữ chỗ`).not.toMatch(/^<.*>$/);
    }
    for (const c of ['office', 'cloud', 'crm', 'auto'] as const) expect(CATALOG.some((e) => e.category === c), c).toBe(true);
  });

  it('trình chạy khớp loại: needs=node ↔ npx, needs=python ↔ uvx (trừ Bio-Memory)', () => {
    for (const e of CATALOG.filter((x) => x.transport === 'stdio' && x.id !== 'bio-memory-locaith')) {
      if (e.needs === 'node') expect(e.command, e.id).toBe('npx');
      if (e.needs === 'python') expect(e.command, e.id).toBe('uvx');
    }
  });

  it('địa chỉ từ xa: https, không nhúng tài khoản/khoá trong địa chỉ', () => {
    for (const e of CATALOG.filter((x) => x.transport === 'http')) {
      const u = new URL(e.url!);
      expect(u.protocol, e.id).toBe('https:');
      expect(u.username + u.password, `${e.id}: có tài khoản trong địa chỉ`).toBe('');
      expect(u.search, `${e.id}: có tham số truy vấn (nghi chứa khoá)`).toBe('');
    }
  });

  it('Google Workspace (Forms, Sheets, Docs, Drive, Apps Script) có mặt và nhận diện được cấu hình có sẵn', () => {
    const e = catalogEntry('google-workspace-mcp')!;
    expect(e.category).toBe('office');
    expect(e.args).toContain('forms');
    expect(e.args).toContain('appscript');
    expect(e.inputs?.map((i) => i.key)).toEqual(['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET']);
    expect(e.inputs?.[1].secret).toBe(true);
    expect(describeServer({ command: 'uvx', args: ['workspace-mcp', '--tools', 'drive', 'docs', 'sheets', 'forms', 'appscript'] })).toMatchObject({ catalogId: 'google-workspace-mcp' });
  });
});

describe('ConnectorService: kết nối mục có `inputs`', () => {
  it('stdio: hỏi lần lượt (ô bí mật dạng mật khẩu), lưu SecretStorage, entries() ghép vào env, bản ghi KHÔNG chứa giá trị', async () => {
    const { deps, store, secrets, asked, registered } = mkDeps(['1234-abc.apps.googleusercontent.com', 'GOCSPX-bi-mat-123']);
    const cs = new ConnectorService(deps);
    const r = await cs.connect('google-workspace-mcp');
    expect(r.ok).toBe(true);
    expect(r.message).toContain('uv');
    expect(asked).toHaveLength(2);
    expect(asked[0].title).toContain('(1/2)');
    expect(asked[0].password).toBe(false);
    expect(asked[1].password).toBe(true);
    expect(secrets.get(inputSecretName('google-workspace-mcp', 0))).toBe('1234-abc.apps.googleusercontent.com');
    expect(secrets.get(inputSecretName('google-workspace-mcp', 1))).toBe('GOCSPX-bi-mat-123');
    // Giá trị KHÔNG nằm trong thứ ghi ra cài đặt/bộ nhớ của VS Code (globalState không mã hoá).
    expect(JSON.stringify([...store.entries()])).not.toContain('GOCSPX-bi-mat-123');
    expect(JSON.stringify([...store.entries()])).not.toContain('1234-abc');
    expect(registered).toContain('GOCSPX-bi-mat-123');
    const [e] = await cs.entries();
    expect(e.cfg.command).toBe('uvx');
    expect(e.cfg.env).toEqual({ GOOGLE_OAUTH_CLIENT_ID: '1234-abc.apps.googleusercontent.com', GOOGLE_OAUTH_CLIENT_SECRET: 'GOCSPX-bi-mat-123' });
    expect(e.maskEnv).toEqual(['GOOGLE_OAUTH_CLIENT_SECRET']);
    expect(e.scope).toBe('connector');
  });

  it('huỷ (Esc) ở ô thứ hai → không lưu gì, không tạo kết nối', async () => {
    const { deps, store, secrets } = mkDeps(['id-dang-nhap', undefined]);
    const cs = new ConnectorService(deps);
    const r = await cs.connect('google-workspace-mcp');
    expect(r).toEqual({ ok: false, message: 'Đã huỷ.' });
    expect(secrets.size).toBe(0);
    expect(cs.list()).toEqual([]);
    expect([...store.keys()].filter((k) => store.get(k)).length).toBe(0);
  });

  it('ô bắt buộc để trống → báo thiếu và không lưu; ô tuỳ chọn để trống → bỏ qua, không để sót giá trị', async () => {
    const empty = mkDeps(['', 'x']);
    const r0 = await new ConnectorService(empty.deps).connect('google-workspace-mcp');
    expect(r0.ok).toBe(false);
    expect(r0.message).toContain('Thiếu');
    expect(empty.secrets.size).toBe(0);

    const { deps, secrets } = mkDeps(['C:\\khoa\\sa.json', 'thu-muc-1', 'C:\\khoa\\sa.json', '']);
    const cs = new ConnectorService(deps);
    expect((await cs.connect('google-sheets-sa')).ok).toBe(true);
    expect(secrets.get(inputSecretName('google-sheets-sa', 1))).toBe('thu-muc-1');
    // Kết nối lại, lần này bỏ trống ô tuỳ chọn: giá trị cũ phải bị xoá, entries() không còn DRIVE_FOLDER_ID.
    expect((await cs.connect('google-sheets-sa')).ok).toBe(true);
    expect(secrets.has(inputSecretName('google-sheets-sa', 1))).toBe(false);
    const [e] = await cs.entries();
    expect(e.cfg.env).toEqual({ SERVICE_ACCOUNT_PATH: 'C:\\khoa\\sa.json' });
  });

  it('giá trị có xuống dòng bị từ chối (chống chèn header / biến môi trường lạ)', async () => {
    const { deps, secrets } = mkDeps(['abc\nEVIL=1']);
    const r = await new ConnectorService(deps).connect('brave-search');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('xuống dòng');
    expect(secrets.size).toBe(0);
  });

  it('mục «key» (HTTP + header): auth.headers() ghép tiền tố, đọc khoá MỚI NHẤT mỗi lần; mất khoá thì báo lỗi rõ', async () => {
    const { deps, secrets } = mkDeps(['rnd_khoa_that']);
    const cs = new ConnectorService(deps);
    expect((await cs.connect('render')).ok).toBe(true);
    const [e] = await cs.entries();
    expect(e.cfg).toEqual({ url: 'https://mcp.render.com/mcp' });
    expect(await e.auth!.headers()).toEqual({ Authorization: 'Bearer rnd_khoa_that' });
    secrets.set(inputSecretName('render', 0), 'rnd_khoa_moi'); // đổi khoá không cần khởi động lại
    expect(await e.auth!.headers()).toEqual({ Authorization: 'Bearer rnd_khoa_moi' });
    secrets.delete(inputSecretName('render', 0));
    await expect(e.auth!.headers()).rejects.toThrow(/Chưa có khoá cho Render/);
  });

  it('PagerDuty dùng tiền tố «Token token=» (không phải Bearer); Google Developer Knowledge dùng X-Goog-Api-Key', async () => {
    const a = mkDeps(['pd-key']);
    const csA = new ConnectorService(a.deps);
    await csA.connect('pagerduty');
    expect(await (await csA.entries())[0].auth!.headers()).toEqual({ Authorization: 'Token token=pd-key' });
    const b = mkDeps(['AIza-key']);
    const csB = new ConnectorService(b.deps);
    await csB.connect('google-developer-knowledge');
    expect(await (await csB.entries())[0].auth!.headers()).toEqual({ 'X-Goog-Api-Key': 'AIza-key' });
  });

  it('đối số vị trí (Azure DevOps): nối sau đối số cố định; biến cố định (n8n) giữ nguyên cùng giá trị người dùng nhập', async () => {
    const { deps } = mkDeps(['congty-abc']);
    const cs = new ConnectorService(deps);
    await cs.connect('azure-devops');
    expect((await cs.entries())[0].cfg.args).toEqual(['-y', '@azure-devops/mcp', 'congty-abc']);

    const n8n = mkDeps(['https://n8n.congty.vn', 'n8n-api-key']);
    const cs2 = new ConnectorService(n8n.deps);
    await cs2.connect('n8n-mcp');
    const env = (await cs2.entries())[0].cfg.env!;
    expect(env).toMatchObject({ MCP_MODE: 'stdio', LOG_LEVEL: 'error', DISABLE_CONSOLE_OUTPUT: 'true', N8N_API_URL: 'https://n8n.congty.vn', N8N_API_KEY: 'n8n-api-key' });
  });

  it('giao diện che giá trị bí mật dù tên biến không có chữ KEY/TOKEN (MDB_MCP_CONNECTION_STRING)', async () => {
    const { deps } = mkDeps(['mongodb+srv://nguoidung:matkhau@cum.mongodb.net/']);
    const cs = new ConnectorService(deps);
    await cs.connect('mongodb');
    const [e] = await cs.entries();
    expect(e.cfg.env!.MDB_MCP_CONNECTION_STRING).toContain('matkhau');
    expect(describeServerForApproval(e.cfg, undefined, e.maskEnv).extra.join(' ')).toContain('MDB_MCP_CONNECTION_STRING=•••');
    expect(describeServerForApproval(e.cfg, undefined, e.maskEnv).extra.join(' ')).not.toContain('matkhau');
    // đối chứng: không có maskEnv thì tên này KHÔNG bị che — chính vì vậy cần maskEnv
    expect(describeServerForApproval(e.cfg).extra.join(' ')).toContain('matkhau');
  });

  it('ngắt kết nối xoá sạch mọi giá trị đã nhập khỏi SecretStorage và bản ghi', async () => {
    const { deps, secrets } = mkDeps(['rnd_khoa_that']);
    const cs = new ConnectorService(deps);
    await cs.connect('render');
    expect(secrets.size).toBe(1);
    expect((await cs.disconnect('render')).ok).toBe(true);
    expect(secrets.size).toBe(0);
    expect(cs.list()).toEqual([]);
  });

  it('mục không có `inputs` (context7) vẫn kết nối thẳng, không hỏi gì', async () => {
    const { deps, asked } = mkDeps([]);
    expect((await new ConnectorService(deps).connect('context7')).ok).toBe(true);
    expect(asked).toHaveLength(0);
  });

  it('mọi mục có inputs đều kết nối được với câu trả lời giả (không mục nào kẹt/ném lỗi) và entries() dựng được cấu hình', async () => {
    const withInputs: CatalogEntry[] = CATALOG.filter((e) => e.inputs?.length && !e.unsupported);
    for (const e of withInputs) {
      const answers = e.inputs!.map((i) => (i.optional ? 'giatri-tuychon' : `gia-tri-${i.key || 'doi-so'}`));
      const { deps } = mkDeps(answers);
      const cs = new ConnectorService(deps);
      const r = await cs.connect(e.id);
      expect(r.ok, `${e.id}: ${r.message}`).toBe(true);
      const [entry] = await cs.entries();
      expect(entry.name).toBe(e.id);
      if (e.transport === 'http') expect(entry.auth, e.id).toBeDefined();
      else expect(entry.cfg.command, e.id).toBeTruthy();
    }
  });
});
