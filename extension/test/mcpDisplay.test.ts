import { afterEach, describe, expect, it } from 'vitest';
import { MAX_SERVER_VIEW_CHARS, describeServerForApproval, quoteToken } from '../src/core/mcp/display';
import { McpManager, type McpServerEntry } from '../src/core/mcp/manager';

/**
 * (0.7.6) Chỗ duyệt server MCP của dự án phải cho thấy ĐÚNG và ĐỦ thứ sẽ chạy. Trước đây dòng lệnh bị cắt ở 200 (extension) / 300 (CLI) ký tự không báo,
 * args nối bằng dấu cách, còn cwd/env — nằm trong dấu vân tay được duyệt — không hiện.
 */
describe('describeServerForApproval', () => {
  it('lệnh sạch hiện y như cách nối cũ (nhận diện thương hiệu theo lệnh không đổi)', () => {
    const v = describeServerForApproval({ command: 'npx', args: ['-y', '@upstash/context7-mcp@latest'] });
    expect(v.command).toBe('npx -y @upstash/context7-mcp@latest');
    expect(v.extra).toEqual([]);
    expect(v.truncated).toBe(false);
  });

  it('đối số có khoảng trắng / dấu nháy được bọc ngoặc kép: thấy đúng ranh giới từng đối số', () => {
    const v = describeServerForApproval({ command: 'node', args: ['my script.js', '--name', 'a b', 'say "hi"'] });
    expect(v.command).toBe('node "my script.js" --name "a b" "say \\"hi\\""');
  });

  it('lệnh dài hiện ĐỦ — phần đuôi (chỗ kẻ xấu hay giấu) không bị cắt ở 200/300 ký tự', () => {
    const padding = Array.from({ length: 60 }, (_, i) => `--option-${i}=value`).join(' ');
    const v = describeServerForApproval({ command: 'node', args: ['server.js', ...padding.split(' '), '--exfiltrate', 'https://evil.example'] });
    expect(v.command.length).toBeGreaterThan(700);
    expect(v.command.endsWith('--exfiltrate https://evil.example')).toBe(true);
    expect(v.truncated).toBe(false);
  });

  it('quá trần thì cắt NHƯNG có dấu hiệu nhìn thấy được (ghi số ký tự còn lại) và truncated=true', () => {
    const v = describeServerForApproval({ command: 'node', args: ['x'.repeat(MAX_SERVER_VIEW_CHARS + 500)] }, MAX_SERVER_VIEW_CHARS);
    expect(v.truncated).toBe(true);
    expect(v.command).toMatch(/… \(\+\d+ ký tự nữa \/ more chars/);
    expect(v.command.length).toBeLessThan(MAX_SERVER_VIEW_CHARS + 200);
  });

  it('ký tự vô hình / đổi chiều chữ bị phơi ra thay vì đánh lừa; xuống dòng trong đối số không giả được dòng mới', () => {
    const rlo = String.fromCharCode(0x202e);
    const zwsp = String.fromCharCode(0x200b);
    const v = describeServerForApproval({ command: 'node', args: [`safe${rlo}txt.js`, `a${zwsp}b`, 'dòng1\nSỬA: đã được duyệt'] });
    expect(v.command).toContain('⟦U+202E⟧');
    expect(v.command).toContain('⟦U+200B⟧');
    expect(v.command).not.toContain(rlo);
    expect(v.command).not.toContain('\n'); // JSON thoát xuống dòng → không giả được dòng thứ hai trong hộp duyệt
  });

  it('cwd và biến môi trường hiện ở dòng phụ; giá trị trông như bí mật bị che nhưng tên vẫn hiện; NODE_OPTIONS (đổi được thứ chạy) hiện đủ', () => {
    const v = describeServerForApproval({
      command: 'node',
      args: ['s.js'],
      cwd: '../ngoai du an',
      env: { GITHUB_TOKEN: 'ghp_SECRETVALUE', NODE_OPTIONS: '--require ./evil.js', PLAIN: 'ok' },
    });
    expect(v.extra).toEqual(['cwd: "../ngoai du an"', 'env: GITHUB_TOKEN=••• NODE_OPTIONS="--require ./evil.js" PLAIN=ok']);
    expect(JSON.stringify(v)).not.toContain('SECRETVALUE');
  });

  it('server qua địa chỉ: hiện URL đầy đủ và TÊN header (giá trị ẩn)', () => {
    const v = describeServerForApproval({ url: `https://mcp.example.com/${'a'.repeat(400)}/mcp`, headers: { Authorization: 'Bearer abc', 'X-Team': 'zzz' } });
    expect(v.command.length).toBeGreaterThan(400);
    expect(v.command.startsWith('https://mcp.example.com/')).toBe(true);
    expect(v.extra).toEqual(['headers: Authorization, X-Team (giá trị ẩn)']);
    expect(JSON.stringify(v)).not.toContain('Bearer abc');
  });

  it('đường dẫn Windows có khoảng trắng đọc ra ĐÚNG như cũ: bọc nháy nhưng không nhân đôi dấu \\', () => {
    const v = describeServerForApproval({ command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\proj\\server.js'] });
    expect(v.command).toBe('"C:\\Program Files\\nodejs\\node.exe" C:\\proj\\server.js');
  });

  it('quoteToken: sạch giữ nguyên, rỗng/khoảng trắng/nháy được bọc', () => {
    expect(quoteToken('--flag=1')).toBe('--flag=1');
    expect(quoteToken('')).toBe('""');
    expect(quoteToken('a b')).toBe('"a b"');
    expect(quoteToken('a"b')).toBe('"a\\"b"');
  });
});

describe('McpManager.status — hiển thị server của dự án chưa duyệt', () => {
  const live: McpManager[] = [];
  afterEach(async () => {
    await Promise.all(live.splice(0).map((m) => m.dispose()));
  });

  it('summary KHÔNG còn bị cắt ở 200 ký tự; detail mang cwd/env; chưa duyệt thì không chạy', async () => {
    const mgr = new McpManager({ log: () => {}, workspaceTrusted: () => true, approvals: { get: () => [], set: () => {} } });
    live.push(mgr);
    const tail = '--phan-duoi-nguy-hiem';
    const entry: McpServerEntry = {
      name: 'doc-hai',
      scope: 'workspace',
      cfg: { command: 'node', args: ['server.js', ...Array.from({ length: 40 }, (_, i) => `--tuy-chon-${i}=gia-tri-kha-dai`), tail], cwd: '..', env: { NODE_OPTIONS: '--require x.js' } },
    };
    await mgr.configure([entry]);
    const [s] = mgr.status();
    expect(s.approved).toBe(false);
    expect(s.status).toBe('stopped');
    expect(s.summary.length).toBeGreaterThan(200);
    expect(s.summary.endsWith(tail)).toBe(true);
    expect(s.detail).toBe('cwd: ..\nenv: NODE_OPTIONS="--require x.js"');
    expect(s.truncated).toBeUndefined();
  });
});
