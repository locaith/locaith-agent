import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BIO_SPEC, bioPaths, findPython, installBio, parsePyVersion, pythonCandidates, type Runner } from '../src/core/mcp/bioInstall';
import { BIO_AUTO_ALLOW, BIO_WORKSPACE_ID, BioMemoryService } from '../src/host/bioMemory';

/** Runner giả ghi lại từng lệnh; `script` quyết định kết quả theo lệnh. */
function fakeRunner(script: (cmd: string, args: string[]) => { code: number | null; out?: string } | undefined) {
  const calls: string[] = [];
  const runner: Runner = async (cmd, args, o) => {
    calls.push([cmd, ...args].join(' '));
    const r = script(cmd, args) ?? { code: 0, out: '' };
    for (const l of (r.out ?? '').split('\n')) if (l) o?.onLine?.(l);
    return { code: r.code, out: r.out ?? '' };
  };
  return { runner, calls };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nd-bio-'));
const memento = () => {
  const m = new Map<string, unknown>();
  return { get: <T>(k: string, d: T) => (m.has(k) ? (m.get(k) as T) : d), update: (k: string, v: unknown) => void m.set(k, v) };
};

describe('tìm Python', () => {
  it('đọc số phiên bản; lối tắt Microsoft Store (không có số) bị bỏ qua', () => {
    expect(parsePyVersion('3.11')).toEqual([3, 11]);
    expect(parsePyVersion('Python 3.9.13')).toEqual([3, 9]);
    expect(parsePyVersion('Python was not found; run without arguments to install from the Microsoft Store')).toBeNull();
  });

  it('ứng viên theo hệ điều hành: Windows có py -3 và thư mục cài đặt; hệ khác dùng python3', () => {
    const win = pythonCandidates({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' } as NodeJS.ProcessEnv, 'win32', (d) => (d.endsWith('Python') ? ['Python39', 'Python311', 'khac'] : []));
    expect(win[0]).toEqual({ cmd: 'py', args: ['-3'] });
    expect(win.map((c) => c.cmd).filter((c) => /Python3\d+/.test(c)).map((c) => path.basename(path.dirname(c)))).toEqual(['Python311', 'Python39']);
    expect(pythonCandidates({}, 'linux', () => [])[0]).toEqual({ cmd: 'python3', args: [] });
  });

  it('chọn ứng viên đầu tiên chạy được và ≥ 3.10; bỏ qua lối tắt Store và bản cũ', async () => {
    const { runner } = fakeRunner((cmd) => (cmd === 'py' ? { code: 9009, out: 'Python was not found' } : cmd === 'python' ? { code: 0, out: '3.8' } : cmd === 'python3' ? { code: 0, out: '3.12\n' } : { code: null }));
    const f = await findPython(runner, [{ cmd: 'py', args: ['-3'] }, { cmd: 'python', args: [] }, { cmd: 'python3', args: [] }]);
    expect(f).toMatchObject({ cmd: 'python3', version: '3.12' });
    expect(await findPython(fakeRunner(() => ({ code: 1 })).runner, [{ cmd: 'x', args: [] }])).toBeNull();
  });
});

describe('cài Bio-Agent OS vào môi trường riêng', () => {
  it('chạy đúng thứ tự: tạo venv → pip cài từ GitHub (kèm extra mcp) → kiểm tra chạy được; có tiến trình báo dòng', async () => {
    const root = tmp();
    const p = bioPaths(root, 'win32');
    const lines: string[] = [];
    const { runner, calls } = fakeRunner((cmd, args) => (args.includes('pip') ? { code: 0, out: 'Collecting bio-agent-os\nSuccessfully installed bio-agent-os-0.8.2rc1' } : { code: 0 }));
    const r = await installBio({ root, log: (l) => lines.push(l), runner, python: { cmd: 'py', args: ['-3'], version: '3.11' }, platform: 'win32' });
    expect(r).toEqual({ ok: true, exe: p.exe });
    expect(calls[0]).toBe(`py -3 -m venv ${p.venv}`);
    expect(calls[1]).toBe(`${p.python} -m pip install --disable-pip-version-check --upgrade ${BIO_SPEC}`);
    expect(calls[2]).toBe(`${p.exe} --help`);
    expect(BIO_SPEC).toContain('bio-agent-os[mcp]');
    expect(lines.join('\n')).toContain('Successfully installed');
  });

  it('không có Python → thông báo hướng dẫn cài; pip lỗi → trả lỗi kèm đuôi nhật ký, không báo thành công', async () => {
    const root = tmp();
    const none = await installBio({ root, log: () => {}, runner: fakeRunner(() => ({ code: 0 })).runner, python: null, platform: 'win32' });
    expect(none).toMatchObject({ ok: false });
    expect((none as { message: string }).message).toContain('python.org');
    const bad = await installBio({ root: tmp(), log: () => {}, runner: fakeRunner((_c, a) => (a.includes('pip') ? { code: 1, out: 'ERROR: No matching distribution' } : { code: 0 })).runner, python: { cmd: 'py', args: [], version: '3.11' }, platform: 'win32' });
    expect(bad).toMatchObject({ ok: false });
    expect((bad as { message: string }).message).toContain('No matching distribution');
  });

  it('venv đã có thì không tạo lại (cài lại/cập nhật nhanh)', async () => {
    const root = tmp();
    const p = bioPaths(root, 'win32');
    fs.mkdirSync(path.dirname(p.python), { recursive: true });
    fs.writeFileSync(p.python, '');
    const { runner, calls } = fakeRunner(() => ({ code: 0 }));
    await installBio({ root, log: () => {}, runner, python: { cmd: 'py', args: [], version: '3.11' }, platform: 'win32' });
    expect(calls.some((c) => c.includes('-m venv'))).toBe(false);
    expect(calls).toHaveLength(2);
  });
});

describe('BioMemoryService', () => {
  it('chưa cài → không có mục MCP; cài xong + bật → mục dùng MỘT thư mục dữ liệu và workspace-id cố định, tự cho phép công cụ chỉ đọc', async () => {
    const root = tmp();
    const m = memento();
    const p = bioPaths(root, 'win32');
    let changes = 0;
    const svc = new BioMemoryService({
      root,
      memento: m,
      log: () => {},
      onChange: () => void changes++,
      platform: 'win32',
      runner: fakeRunner((_c, a) => {
        if (a.includes('pip')) {
          fs.mkdirSync(path.dirname(p.exe), { recursive: true });
          fs.writeFileSync(p.exe, '');
          return { code: 0, out: 'Successfully installed' };
        }
        return { code: 0, out: '3.11' };
      }).runner,
    });
    expect(svc.status()).toMatchObject({ state: 'none', enabled: false, dataDir: p.data });
    expect(svc.entry()).toBeNull();
    const r = await svc.install();
    expect(r.ok).toBe(true);
    expect(changes).toBeGreaterThan(2);
    expect(svc.status()).toMatchObject({ state: 'ready', enabled: true });
    const e = svc.entry()!;
    expect(e).toMatchObject({ name: 'bio-memory-locaith', scope: 'connector', label: 'Bio-Memory-Locaith', autoAllow: BIO_AUTO_ALLOW });
    expect(e.cfg.command).toBe(p.exe);
    expect(e.cfg.args).toEqual(['serve-mcp', '--workspace-id', BIO_WORKSPACE_ID]);
    expect(e.cfg.env).toMatchObject({ STORAGE_DIR: p.data });
    expect(BIO_AUTO_ALLOW).toEqual(['recall', 'list_rules', 'memory_status']); // store_memory/consolidate KHÔNG tự cho phép
    await svc.setEnabled(false);
    expect(svc.entry()).toBeNull();
  });

  it('tự bật mặc định cho Locaith-v5: «Đừng hỏi lại» được nhớ qua memento (dùng chung các cửa sổ) và không đụng tới việc đã bật/đã cài', async () => {
    const m = memento();
    const svc = new BioMemoryService({ root: tmp(), memento: m, log: () => {}, onChange: () => {}, platform: 'win32' });
    expect(svc.autoDeclined()).toBe(false);
    await svc.setAutoDeclined(true);
    expect(svc.autoDeclined()).toBe(true);
    // một cửa sổ VS Code khác dùng cùng memento (globalState) thấy ngay lựa chọn đó
    expect(new BioMemoryService({ root: tmp(), memento: m, log: () => {}, onChange: () => {}, platform: 'win32' }).autoDeclined()).toBe(true);
    expect(svc.enabled()).toBe(false);
    expect(svc.installed()).toBe(false);
    await svc.setAutoDeclined(false);
    expect(svc.autoDeclined()).toBe(false);
  });

  it('cài thất bại → trạng thái error kèm lý do, không bật', async () => {
    const svc = new BioMemoryService({ root: tmp(), memento: memento(), log: () => {}, onChange: () => {}, platform: 'win32', runner: fakeRunner((_c, a) => (a.includes('pip') ? { code: 1, out: 'boom' } : { code: 0, out: '3.11' })).runner });
    const r = await svc.install();
    expect(r.ok).toBe(false);
    expect(svc.status()).toMatchObject({ state: 'error', enabled: false });
    expect(svc.entry()).toBeNull();
  });
});
