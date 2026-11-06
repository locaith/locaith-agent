import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BIO_SERVER_NAME, CATALOG } from '../../src/core/mcp/catalog';
import { BRAND_ALIASES, LOGOS, brandFor, contrast, inkFor, monogram, THEME_INK } from '../../webview/src/brand/logos';

/**
 * 11 logo đã GỠ theo yêu cầu của chủ thương hiệu (Simple Icons bỏ chúng khỏi bản mới; Locaith trước đây lấy từ bản 13.21.0 / 9.21.0).
 * Các mục này phải hiện monogram — danh sách phải khớp REMOVED_AT_OWNER_REQUEST trong webview/dev/gen-logos.mjs (kiểm bên dưới).
 */
const REMOVED = ['oracle', 'salesforce', 'adobe', 'twilio', 'slack', 'canva', 'azure', 'playwright', 'zoho', 'sourcegraph', 'csharp'];

/**
 * Mục kho MCP cố ý dùng monogram: (1) chưa tìm được logo SVG có giấy phép cho phép phân phối lại — monday, honeycomb, deepwiki;
 * (2) logo đã gỡ theo yêu cầu chủ thương hiệu — slack, canva, playwright (xem docs/BRAND-ASSETS.md).
 */
const INTENTIONAL_MONOGRAM = new Set(['monday', 'honeycomb', 'deepwiki', 'slack', 'canva', 'playwright']);

/** Plugin tiêu biểu trong chợ chính thức của Anthropic (tên, nguồn) → logo mong đợi. */
const PLUGINS: [string, string, string][] = [
  ['github', 'anthropics', 'github'],
  ['figma', 'figma/mcp-server-guide', 'figma'],
  ['supabase', 'supabase-community/supabase-plugin', 'supabase'],
  ['vercel', 'vercel/vercel-plugin', 'vercel'],
  ['stripe', 'stripe/ai', 'stripe'],
  ['notion', 'makenotion/claude-code-notion-plugin', 'notion'],
  ['linear', 'anthropics', 'linear'],
  ['sentry', 'getsentry/plugin-claude', 'sentry'],
  ['sentry-cli', 'getsentry/cli', 'sentry'],
  ['aws-serverless', 'awslabs/agent-plugins', 'aws'],
  ['microsoft-docs', 'MicrosoftDocs/mcp', 'microsoft'],
  ['bigquery-data-analytics', 'gemini-cli-extensions/bigquery-data-analytics', 'bigquery'],
  ['cloud-sql-postgresql', 'gemini-cli-extensions/cloud-sql-postgresql', 'googlecloud'],
  ['chrome-devtools-mcp', 'ChromeDevTools/chrome-devtools-mcp', 'chrome'],
  ['cloudflare', 'cloudflare/skills', 'cloudflare'],
  ['typescript-lsp', 'anthropics', 'typescript'],
  ['pyright-lsp', 'anthropics', 'python'],
  ['rust-analyzer-lsp', 'anthropics', 'rust'],
  ['clickhouse', 'ClickHouse/clickhouse-claude-code-plugin', 'clickhouse'],
  ['huggingface-skills', 'huggingface/skills', 'huggingface'],
  ['context7', 'anthropics', 'upstash'],
  ['terraform', 'anthropics', 'terraform'],
  ['code-review', 'anthropics', 'anthropic'],
  ['datadog', 'datadog-labs/claude-code-plugin', 'datadog'],
  ['unreal-engine-skills-for-claude-code', 'EpicGames/unreal-engine-skills-for-claude-code-plugin', 'unreal'],
  ['mongodb-atlas', 'mongodb/agent-skills', 'mongodb'],
  ['shopify-ai-toolkit', 'Shopify/Shopify-AI-Toolkit', 'shopify'],
];

/** Plugin không có logo (monogram) — có chủ đích. */
const PLUGIN_MONOGRAM: [string, string][] = [
  ['superpowers', 'obra/superpowers'],
  ['serena', 'anthropics'], // bên thứ ba nằm trong kho chính thức → không được mang logo Anthropic
  ['vanguard-advisor-tools', 'Vanguard-oss/vanguard-advisor-tools'],
  ['gl-plugin', 'gitlab.com'], // nguồn ngoài GitHub: tên miền nơi lưu không phải thương hiệu
  ['sec-scan', 'sec-co/claude-plugins'], // repo tên "claude-plugins" của bên thứ ba không phải Anthropic
  // — logo đã gỡ theo yêu cầu chủ thương hiệu: monogram, KHÔNG rơi sang logo hãng mẹ / kho chứa —
  ['slack', 'slackapi/slack-mcp-plugin'],
  ['azure', 'microsoft/azure-skills'], // không mượn logo Microsoft của chủ plugin
  ['playwright', 'anthropics'], // không mang logo Anthropic theo nguồn
  ['csharp-lsp', 'anthropics'],
  ['salesforce-development', 'forcedotcom/sf-skills'],
  ['twilio-developer-kit', 'twilio/ai'],
  ['adobe-for-creativity', 'adobe/adobe-for-creativity'],
  ['canva-sdks', 'canva-sdks/canva-sdks'],
  ['oracle-samples', 'oracle-samples/oracle-samples'],
];

const SKILL_SOURCES = fs.readdirSync(path.join(__dirname, '../../market/licenses'));

describe('kho logo thương hiệu', () => {
  it('mọi mục trong kho kết nối MCP đều có logo, trừ danh sách monogram có chủ đích', () => {
    for (const e of CATALOG) {
      const m = brandFor({ id: e.id, name: e.name, vendor: e.vendor });
      if (INTENTIONAL_MONOGRAM.has(e.id)) expect(m, e.id).toBeUndefined();
      else expect(m, e.id).toBeDefined();
    }
    expect(brandFor({ id: BIO_SERVER_NAME })?.key).toBe('locaith');
    expect(brandFor({ id: 'microsoft-learn', name: 'Microsoft Learn', vendor: 'Microsoft' })?.key).toBe('microsoft');
    expect(brandFor({ id: 'context7', name: 'Context7', vendor: 'Upstash' })?.key).toBe('upstash');
  });

  it('plugin tiêu biểu khớp đúng logo', () => {
    for (const [name, origin, key] of PLUGINS) expect(brandFor({ id: name, name, origin })?.key, name).toBe(key);
    for (const [name, origin] of PLUGIN_MONOGRAM) expect(brandFor({ id: name, name, origin }), name).toBeUndefined();
  });

  it('nguồn kỹ năng: hãng có logo, cộng đồng và hãng đã gỡ logo dùng monogram', () => {
    const noLogo = new Set(['obra-superpowers', 'wshobson-agents', 'twilio-skills']); // twilio-skills: logo Twilio đã gỡ
    for (const src of SKILL_SOURCES) {
      if (noLogo.has(src)) expect(brandFor({ origin: src }), src).toBeUndefined();
      else expect(brandFor({ origin: src }), src).toBeDefined();
    }
    expect(brandFor({ origin: 'getsentry-skills' })?.key).toBe('sentry');
  });

  it('không phân biệt hoa thường / dấu; server MCP nhận theo tên, lệnh hoặc địa chỉ', () => {
    expect(brandFor({ name: 'GITHUB' })?.key).toBe('github');
    expect(brandFor({ name: 'Nôtion' })?.key).toBe('notion');
    expect(brandFor({ name: 'db:postgres' })?.key).toBe('postgresql');
    expect(brandFor({ name: 'tools', url: 'npx -y @upstash/context7-mcp' })?.key).toBe('upstash');
    expect(brandFor({ name: 'x', url: 'https://mcp.notion.com/mcp' })?.key).toBe('notion');
    expect(brandFor({ name: 'memory-notes' })).toBeUndefined(); // "memory" chỉ khớp nguyên vẹn
  });

  it('11 logo đã gỡ theo yêu cầu chủ thương hiệu: không còn dữ liệu, không còn alias, mọi cách tra cứu đều ra monogram', () => {
    for (const k of REMOVED) expect(LOGOS[k], k).toBeUndefined();
    expect(Object.entries(BRAND_ALIASES).filter(([, k]) => REMOVED.includes(k))).toEqual([]);
    // tra theo id / tên / hãng / nguồn / lệnh: không được rơi sang logo khác (hãng mẹ, kho chứa) mà phải là undefined → BrandIcon vẽ monogram
    const queries: Parameters<typeof brandFor>[0][] = [
      { id: 'slack', name: 'Slack', vendor: 'Slack' },
      { id: 'canva', name: 'Canva', vendor: 'Canva' },
      { id: 'playwright', name: 'Playwright', vendor: 'Microsoft' }, // vendor Microsoft có logo, nhưng mục này phải là monogram
      { id: 'azure', name: 'azure', origin: 'microsoft/azure-skills' },
      { name: 'Microsoft Azure' },
      { id: 'azure-cosmos-db-assistant', name: 'azure-cosmos-db-assistant' },
      { id: 'playwright', name: 'playwright', origin: 'anthropics' },
      { name: 'tools', url: 'npx -y @playwright/mcp@latest' },
      { id: 'csharp-lsp', name: 'csharp-lsp', origin: 'anthropics' },
      { name: 'Oracle', vendor: 'Oracle' },
      { id: 'oracle-samples', name: 'oracle-samples', origin: 'oracle-samples/oracle-samples' },
      { id: 'salesforce-development', name: 'salesforce-development', origin: 'forcedotcom/sf-skills' },
      { id: 'adobe-for-creativity', name: 'adobe-for-creativity', origin: 'adobe/adobe-for-creativity' },
      { id: 'twilio-developer-kit', name: 'twilio-developer-kit', origin: 'twilio/ai' },
      { origin: 'twilio-skills' },
      { id: 'zoho', name: 'Zoho', vendor: 'Zoho' },
      { name: 'catalyst-by-zoho' },
      { name: 'Sourcegraph', vendor: 'Sourcegraph' },
      { name: 'x', url: 'https://mcp.slack.com/mcp' },
    ];
    for (const q of queries) expect(brandFor(q), JSON.stringify(q)).toBeUndefined();
    // monogram dùng đúng chữ cái đầu của tên hãng (cùng kích thước ô với logo)
    expect(monogram('Slack').text).toBe('S');
    expect(monogram('Canva').text).toBe('C');
    expect(monogram('Playwright').text).toBe('P');
    expect(monogram('Microsoft Azure').text).toBe('MA');
    expect(monogram('C#').text).toBe('C');
    expect(monogram('twilio').text).toBe('T');
    // không làm hỏng các hãng còn logo có tên gần giống
    expect(brandFor({ id: 'oracledb-gcp', name: 'oracledb-gcp', origin: 'gemini-cli-extensions/oracledb-gcp' })?.key).toBe('googlecloud');
    expect(brandFor({ name: 'Microsoft' })?.key).toBe('microsoft');
    expect(brandFor({ name: 'microsoft-docs', origin: 'MicrosoftDocs/mcp' })?.key).toBe('microsoft');
  });

  it('script sinh logo từ chối thêm lại các logo đã gỡ và chỉ dùng Simple Icons hiện hành', () => {
    const gen = fs.readFileSync(path.join(__dirname, '../../webview/dev/gen-logos.mjs'), 'utf8');
    const list = /const REMOVED_AT_OWNER_REQUEST = \[([^\]]*)\]/.exec(gen)?.[1];
    expect(list, 'thiếu REMOVED_AT_OWNER_REQUEST trong gen-logos.mjs').toBeTruthy();
    expect([...list!.matchAll(/'([a-z0-9]+)'/g)].map((m) => m[1]).sort()).toEqual([...REMOVED].sort());
    expect(gen).not.toMatch(/si13|si9|simple-icons@13|simple-icons@9/); // không còn nguồn từ bản cũ
    // không dòng nào trong BRANDS dùng khoá đã gỡ
    for (const k of REMOVED) expect(gen, k).not.toMatch(new RegExp(`^\\s*\\['${k}',`, 'm'));
  });

  it('dữ liệu hợp lệ: khoá không trùng, path chỉ có ký tự SVG, alias trỏ tới logo có thật, dung lượng < 200 KB', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../webview/src/brand/logos.ts'), 'utf8');
    const keys = [...src.slice(src.indexOf('export const LOGOS'), src.indexOf('export const BRAND_ALIASES')).matchAll(/^ {2}"?([a-z0-9-]+)"?: \{ t:/gm)].map((m) => m[1]);
    expect(keys.length).toBe(Object.keys(LOGOS).length);
    expect(new Set(keys).size).toBe(keys.length);
    const aliasKeys = [...src.slice(src.indexOf('export const BRAND_ALIASES')).matchAll(/^ {2}"?([a-z0-9]+)"?: "?'?[a-z0-9]+/gm)].map((m) => m[1]);
    expect(new Set(aliasKeys).size).toBe(aliasKeys.length);
    for (const [k, logo] of Object.entries(LOGOS)) {
      expect(logo.l.length, k).toBeGreaterThan(0);
      expect(logo.vb, k).toMatch(/^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/);
      expect(logo.c, k).toMatch(/^#[0-9A-F]{6}$/);
      for (const l of logo.l) {
        expect(l.d.trim().length, k).toBeGreaterThan(0);
        expect(l.d, k).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9.,\s+eE-]+$/);
        if (l.fill) expect(l.fill, k).toMatch(/^(#[0-9A-F]{6}|currentColor)$/);
      }
    }
    for (const [a, k] of Object.entries(BRAND_ALIASES)) expect(LOGOS[k], a).toBeDefined();
    expect(Buffer.byteLength(src)).toBeLessThan(200 * 1024);
  });

  it('màu glyph đủ tương phản ở mọi theme; monogram ổn định', () => {
    for (const [k, logo] of Object.entries(LOGOS)) {
      if (logo.tone !== 'color') continue;
      for (const th of Object.keys(THEME_INK) as (keyof typeof THEME_INK)[]) {
        expect(contrast(inkFor(logo.c, th), THEME_INK[th].bg), `${k}/${th}`).toBeGreaterThanOrEqual(THEME_INK[th].min);
      }
    }
    expect(monogram('monday.com').text).toBe('M');
    expect(monogram('DeepWiki').text).toBe('DW');
    expect(monogram('Công cụ CSDL').text).toBe('CC');
    expect(monogram('Honeycomb')).toEqual(monogram('Honeycomb'));
  });
});
