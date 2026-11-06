// Sinh lại webview/src/brand/logos.ts (phần dữ liệu) từ Simple Icons (CC0-1.0) và Lobe Icons (MIT) — xem docs/BRAND-ASSETS.md.
// Cài gói vào một thư mục TẠM ngoài dự án (không thêm phụ thuộc):
//   <tmp>/icons:  npm i simple-icons@16.36.0 @lobehub/icons-static-svg@1.102.0
//   node webview/dev/gen-logos.mjs <tmp>/icons webview/src/brand/logos.ts
//
// CHỈ dùng bản Simple Icons HIỆN HÀNH. Từ 0.5.2 không còn lấy logo từ các bản Simple Icons cũ (13.21.0, 9.21.0): những logo đó đã bị gỡ khỏi
// bản mới theo yêu cầu của chủ thương hiệu, nên Locaith cũng gỡ (xem REMOVED_AT_OWNER_REQUEST bên dưới).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const [pkgDir, out] = process.argv.slice(2);
const req = createRequire(path.join(pkgDir, 'package.json'));
const SI = req('simple-icons');
const pv = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', name, 'package.json'), 'utf8')).version;
const SI_VER = pv(pkgDir, 'simple-icons');
const LOBE_DIR = path.join(pkgDir, 'node_modules/@lobehub/icons-static-svg/icons');
const LOBE_VER = JSON.parse(fs.readFileSync(path.join(pkgDir, 'node_modules/@lobehub/icons-static-svg/package.json'), 'utf8')).version;

const siIndex = new Map(Object.values(SI).filter((x) => x && x.slug).map((i) => [i.slug, i]));

/**
 * Logo ĐÃ GỠ theo yêu cầu của chủ thương hiệu — KHÔNG ĐƯỢC thêm lại (Simple Icons đã bỏ chúng khỏi bản mới; trước đây Locaith lấy từ bản cũ).
 * Các mục này hiện monogram ở Chợ. Script từ chối chạy nếu một khoá dưới đây xuất hiện lại trong BRANDS.
 */
const REMOVED_AT_OWNER_REQUEST = ['oracle', 'salesforce', 'adobe', 'twilio', 'slack', 'canva', 'azure', 'playwright', 'zoho', 'sourcegraph', 'csharp'];

/**
 * [key, title, source, opts]
 *  source: 'si:slug' | 'lobe:file'
 *  opts.tone: 'color' (mặc định) | 'mono' (theo màu chữ theme) | 'multi' (nhiều màu, nền trung tính) | 'solid' (nền màu hãng)
 *  opts.color: ghi đè màu hãng · opts.alias: tên gọi khác (id kho, tên plugin, chủ repo, nguồn kỹ năng)
 */
const BRANDS = [
  // ── AI & nền tảng ──
  ['anthropic', 'Anthropic', 'si:anthropic', { tone: 'mono', alias: ['anthropics', 'anthropic-claude-plugins-official', 'claude-plugins-official', 'anthropic-skills', 'memory', 'sequential-thinking', 'filesystem'] }],
  ['mcp', 'Model Context Protocol', 'si:modelcontextprotocol', { tone: 'mono', alias: ['modelcontextprotocol', 'model-context-protocol', 'mcp-apps'] }],
  ['huggingface', 'Hugging Face', 'lobe:huggingface-color', { tone: 'multi', color: '#FFD21E', alias: ['hugging-face', 'huggingface-skills'] }],
  ['nvidia', 'NVIDIA', 'si:nvidia', { alias: ['nvidia-skills'] }],
  ['together', 'Together AI', 'lobe:together-color', { tone: 'multi', color: '#EF2CC1', alias: ['togetherai', 'togethercomputer', 'togetherai-skills'] }],
  ['exa', 'Exa', 'lobe:exa-color', { color: '#1F40ED', alias: ['exa-labs', 'exa-search'] }],
  ['tavily', 'Tavily', 'lobe:tavily-color', { tone: 'multi', color: '#468BFF', alias: ['tavily-ai'] }],
  ['firecrawl', 'Firecrawl', 'lobe:firecrawl-color', { color: '#FF4D00' }],
  ['langfuse', 'Langfuse', 'lobe:langfuse-color', { tone: 'multi', color: '#4E9CFF', alias: ['langfuse-observability'] }],
  ['greptile', 'Greptile', 'lobe:greptile-color', { color: '#44A775', alias: ['greptileai'] }],
  ['lovable', 'Lovable', 'lobe:lovable', { color: '#FE4230', alias: ['lovablelabs'] }],
  ['langchain', 'LangChain', 'si:langchain', { tone: 'mono' }],
  ['upstash', 'Upstash', 'si:upstash', { alias: ['context7'] }],
  ['zapier', 'Zapier', 'si:zapier'],
  // ── Hãng lớn ──
  ['google', 'Google', 'lobe:google-color', { tone: 'multi', color: '#4285F4', alias: ['google-skills', 'googlechromelabs'] }],
  ['googlecloud', 'Google Cloud', 'lobe:googlecloud-color', { tone: 'multi', color: '#4285F4', alias: ['google-cloud', 'gemini-cli-extensions', 'googlecloudplatform', 'data-agent-kit', 'alloydb', 'alloydb-omni', 'cloud-sql-mysql', 'cloud-sql-postgresql', 'cloud-sql-sqlserver', 'dataproc', 'firestore-native', 'knowledge-catalog', 'oracledb-gcp', 'google-cloud-storage'] }],
  ['bigquery', 'Google BigQuery', 'si:googlebigquery', { alias: ['googlebigquery', 'bigquery-data-analytics'] }],
  ['spanner', 'Google Cloud Spanner', 'si:googlecloudspanner', { alias: ['googlecloudspanner', 'cloud-spanner'] }],
  ['looker', 'Looker', 'si:looker'],
  ['chrome', 'Google Chrome', 'si:googlechrome', { alias: ['googlechrome', 'chrome-devtools', 'chrome-devtools-mcp', 'chromedevtools', 'modern-web-guidance'] }],
  ['microsoft', 'Microsoft', 'lobe:microsoft-color', { tone: 'multi', color: '#00A4EF', alias: ['microsoft-skills', 'microsoft-learn', 'microsoft-docs', 'microsoftdocs', 'dataverse', 'azure-sql-developer'] }],
  ['aws', 'Amazon Web Services', 'lobe:aws-color', { tone: 'multi', color: '#FF9900', alias: ['amazon', 'amazonwebservices', 'awslabs', 'amzn', 'amazon-location-service', 'databases-on-aws', 'deploy-on-aws', 'migration-to-aws', 'sagemaker-ai'] }],
  ['apple', 'Apple', 'si:apple', { tone: 'mono' }],
  ['imessage', 'iMessage', 'si:imessage'],
  ['sap', 'SAP', 'si:sap', { alias: ['sap-samples', 'cap-js', 'ui5', 'sapui5', 'openui5', 'ui-theme-designer', 'cds-mcp'] }],
  ['amd', 'AMD', 'si:amd', { alias: ['amd-skills'] }],
  ['ibm', 'IBM', null],
  ['intuit', 'Intuit', 'si:intuit'],
  ['quickbooks', 'QuickBooks', 'si:quickbooks', { alias: ['intuit-quickbooks'] }],
  ['spotify', 'Spotify', 'si:spotify', { alias: ['save-to-spotify', 'spotify-ads-api'] }],
  ['jetbrains', 'JetBrains', 'si:jetbrains', { tone: 'mono' }],
  ['teamcity', 'TeamCity', 'si:teamcity', { alias: ['teamcity-cli'] }],
  ['unity', 'Unity', 'si:unity', { tone: 'mono', alias: ['unity-technologies'] }],
  ['unreal', 'Unreal Engine', 'si:unrealengine', { tone: 'mono', alias: ['unrealengine', 'epicgames', 'unreal-engine-skills-for-claude-code'] }],
  ['qt', 'Qt', 'si:qt', { alias: ['theqtcompanyrnd', 'qt-development-skills'] }],
  // ── Phát triển ──
  ['github', 'GitHub', 'si:github', { tone: 'mono' }],
  ['gitlab', 'GitLab', 'si:gitlab'],
  ['gitkraken', 'GitKraken', 'si:gitkraken'],
  ['sentry', 'Sentry', 'si:sentry', { alias: ['getsentry', 'getsentry-skills', 'sentry-cli'] }],
  ['vercel', 'Vercel', 'si:vercel', { tone: 'mono' }],
  ['netlify', 'Netlify', 'si:netlify', { alias: ['netlify-skills'] }],
  ['cloudflare', 'Cloudflare', 'lobe:cloudflare-color', { tone: 'multi', color: '#F38020', alias: ['cloudflare-bindings', 'cloudflare-docs', 'cloudflare-skills'] }],
  ['railway', 'Railway', 'si:railway', { tone: 'mono', alias: ['railwayapp'] }],
  ['render', 'Render', 'si:render', { tone: 'mono', alias: ['render-oss'] }],
  ['hostinger', 'Hostinger', 'si:hostinger'],
  ['fastly', 'Fastly', 'si:fastly', { alias: ['fastly-agent-toolkit'] }],
  ['docker', 'Docker', 'si:docker', { alias: ['docker-skills'] }],
  ['hashicorp', 'HashiCorp', 'si:hashicorp', { tone: 'mono', alias: ['hashicorp-agent-skills'] }],
  ['terraform', 'Terraform', 'si:terraform'],
  ['expo', 'Expo', 'si:expo', { tone: 'mono', alias: ['expo-skills'] }],
  ['firebase', 'Firebase', 'si:firebase', { alias: ['firebase-skills'] }],
  ['appwrite', 'Appwrite', 'si:appwrite'],
  ['postman', 'Postman', 'si:postman', { alias: ['postmanlabs'] }],
  ['laravel', 'Laravel', 'si:laravel', { alias: ['laravel-boost'] }],
  ['shopify', 'Shopify', 'si:shopify', { alias: ['shopify-ai-toolkit', 'liquid-skills', 'liquid-lsp'] }],
  ['wordpress', 'WordPress', 'si:wordpress', { alias: ['automattic', 'build-with-wordpress'] }],
  ['buildkite', 'Buildkite', 'si:buildkite'],
  ['coderabbit', 'CodeRabbit', 'si:coderabbit', { alias: ['coderabbitai'] }],
  ['jfrog', 'JFrog', 'si:jfrog'],
  ['sonarqube', 'SonarQube', 'si:sonarqubeserver', { alias: ['sonarsource', 'sonarqubeserver'] }],
  ['auth0', 'Auth0', 'si:auth0'],
  ['mintlify', 'Mintlify', 'si:mintlify'],
  ['sanity', 'Sanity', 'si:sanity', { tone: 'mono', alias: ['sanity-io'] }],
  ['resend', 'Resend', 'si:resend', { tone: 'mono' }],
  ['revenuecat', 'RevenueCat', 'si:revenuecat', { alias: ['rc'] }],
  ['apollographql', 'Apollo GraphQL', 'si:apollographql', { alias: ['apollo-skills', 'apollo-graphql'] }],
  ['quarkus', 'Quarkus', 'si:quarkus', { alias: ['quarkusio', 'quarkus-agent'] }],
  ['convex', 'Convex', 'si:convex', { alias: ['get-convex'] }],
  ['cloudinary', 'Cloudinary', 'si:cloudinary', { alias: ['cloudinary-devs'] }],
  ['pydantic', 'Pydantic', 'si:pydantic', { alias: ['pydantic-ai', 'logfire'] }],
  ['airflow', 'Apache Airflow', 'si:apacheairflow', { alias: ['apacheairflow', 'astronomer', 'astronomer-data-agents'] }],
  ['mapbox', 'Mapbox', 'si:mapbox', { tone: 'mono' }],
  ['postiz', 'Postiz', 'si:postiz', { alias: ['gitroomhq'] }],
  // ── Ngôn ngữ (plugin LSP) ──
  ['typescript', 'TypeScript', 'si:typescript', { alias: ['typescript-lsp'] }],
  ['python', 'Python', 'si:python', { alias: ['pyright-lsp', 'pyright'] }],
  ['rust', 'Rust', 'si:rust', { tone: 'mono', alias: ['rust-analyzer-lsp', 'rust-analyzer'] }],
  ['go', 'Go', 'si:go', { alias: ['gopls-lsp', 'golang'] }],
  ['swift', 'Swift', 'si:swift', { alias: ['swift-lsp'] }],
  ['kotlin', 'Kotlin', 'si:kotlin', { alias: ['kotlin-lsp'] }],
  ['php', 'PHP', 'si:php', { alias: ['php-lsp'] }],
  ['ruby', 'Ruby', 'si:ruby', { alias: ['ruby-lsp'] }],
  ['lua', 'Lua', 'si:lua', { alias: ['lua-lsp'] }],
  ['cplusplus', 'C++', 'si:cplusplus', { alias: ['clangd-lsp', 'clangd', 'cpp'] }],
  ['java', 'Java (OpenJDK)', 'si:openjdk', { tone: 'mono', alias: ['openjdk', 'jdtls-lsp', 'jdtls'] }],
  // ── Quản lý dự án & cộng tác ──
  ['notion', 'Notion', 'si:notion', { tone: 'mono', alias: ['makenotion'] }],
  ['linear', 'Linear', 'si:linear'],
  ['clickup', 'ClickUp', 'si:clickup'],
  ['asana', 'Asana', 'si:asana'],
  ['atlassian', 'Atlassian', 'si:atlassian', { alias: ['atlassian-labs', 'atlassian-twg-cli', 'forge-skills'] }],
  ['miro', 'Miro', 'si:miro', { tone: 'solid', color: '#FFD02F', alias: ['miroapp'] }],
  ['box', 'Box', 'si:box'],
  ['dropbox', 'Dropbox', 'si:dropbox'],
  ['coursera', 'Coursera', 'si:coursera', { alias: ['learn-with-coursera'] }],
  // ── Giao tiếp ──
  ['discord', 'Discord', 'si:discord'],
  ['telegram', 'Telegram', 'si:telegram'],
  ['intercom', 'Intercom', 'si:intercom', { tone: 'mono' }],
  ['zoom', 'Zoom', 'si:zoom', { alias: ['zoom-plugin'] }],
  ['hubspot', 'HubSpot', 'si:hubspot', { alias: ['hubspot-sales'] }],
  // ── Dữ liệu & hạ tầng ──
  ['supabase', 'Supabase', 'si:supabase', { alias: ['supabase-community', 'supabase-agent-skills'] }],
  ['neon', 'Neon', 'si:neon', { alias: ['neondatabase'] }],
  ['prisma', 'Prisma', 'si:prisma', { tone: 'mono', alias: ['prisma-skills', 'prisma-postgres'] }],
  ['airtable', 'Airtable', 'si:airtable', { alias: ['airtable-skills'] }],
  ['datadog', 'Datadog', 'si:datadog', { alias: ['datadog-labs'] }],
  ['mongodb', 'MongoDB', 'si:mongodb', { alias: ['mongodb-agent-skills', 'mongodb-atlas'] }],
  ['planetscale', 'PlanetScale', 'si:planetscale', { tone: 'mono', alias: ['planetscale-skills'] }],
  ['postgresql', 'PostgreSQL', 'si:postgresql', { alias: ['postgres', 'pg'] }],
  ['mysql', 'MySQL', 'si:mysql'],
  ['sqlite', 'SQLite', 'si:sqlite'],
  ['redis', 'Redis', 'si:redis', { alias: ['redis-development'] }],
  ['clickhouse', 'ClickHouse', 'si:clickhouse', { tone: 'solid', alias: ['clickhouse-best-practices'] }],
  ['cockroachdb', 'CockroachDB', 'si:cockroachlabs', { alias: ['cockroachlabs'] }],
  ['databricks', 'Databricks', 'si:databricks'],
  ['duckdb', 'DuckDB', 'si:duckdb', { tone: 'solid', alias: ['duckdb-skills'] }],
  ['snowflake', 'Snowflake', 'si:snowflake', { alias: ['snowflake-labs', 'snowflake-cortex-code'] }],
  ['qdrant', 'Qdrant', 'si:qdrant', { alias: ['qdrant-skills'] }],
  ['milvus', 'Milvus', 'si:milvus'],
  ['mlflow', 'MLflow', 'si:mlflow'],
  ['grafana', 'Grafana', 'si:grafana', { alias: ['grafana-assistant', 'grafana-cloud-mcp', 'grafana-mcp'] }],
  ['newrelic', 'New Relic', 'si:newrelic'],
  ['dynatrace', 'Dynatrace', 'si:dynatrace'],
  ['pagerduty', 'PagerDuty', 'si:pagerduty'],
  ['posthog', 'PostHog', 'si:posthog', { tone: 'mono' }],
  ['dash0', 'Dash0', 'si:dash0', { alias: ['dash0hq'] }],
  ['stackhawk', 'StackHawk', 'si:stackhawk', { alias: ['stackhawk-hawkscan', 'stackhawk-api'] }],
  // ── Thanh toán ──
  ['stripe', 'Stripe', 'si:stripe'],
  ['paypal', 'PayPal', 'si:paypal'],
  ['square', 'Square', 'si:square', { tone: 'mono', alias: ['squareup'] }],
  ['mercadopago', 'Mercado Pago', 'si:mercadopago'],
  ['sumup', 'SumUp', 'si:sumup', { tone: 'mono' }],
  // ── Thiết kế & website ──
  ['figma', 'Figma', 'lobe:figma-color', { tone: 'multi', color: '#F24E1E' }],
  ['webflow', 'Webflow', 'si:webflow'],
  ['wix', 'Wix', 'si:wix', { tone: 'mono' }],
  ['elevenlabs', 'ElevenLabs', 'si:elevenlabs', { tone: 'mono', alias: ['elevenlabs-skills'] }],
];

// ── Đọc dữ liệu ──
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? m[1] : undefined;
};
const normHex = (c) => {
  if (!c || c === 'currentColor') return c;
  let h = c.replace('#', '').toUpperCase();
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  return '#' + h;
};
function lobe(file) {
  const svg = fs.readFileSync(path.join(LOBE_DIR, file + '.svg'), 'utf8');
  const root = svg.match(/<svg[^>]*>/)[0];
  const vb = attr(root, 'viewBox');
  const rootRule = attr(root, 'fill-rule');
  const layers = [...svg.matchAll(/<path[^>]*>/g)].map(([tag]) => {
    if (/url\(#|transform=/.test(tag)) throw new Error(`${file}: gradient/transform không hỗ trợ`);
    const l = { d: attr(tag, 'd') };
    const fill = attr(tag, 'fill');
    if (fill && fill !== 'currentColor') l.fill = normHex(fill);
    if (fill === 'currentColor') l.fill = 'currentColor';
    if ((attr(tag, 'fill-rule') ?? rootRule) === 'evenodd') l.evenodd = true;
    const op = attr(tag, 'opacity') ?? attr(tag, 'fill-opacity');
    if (op) l.opacity = Number(op);
    return l;
  });
  return { vb, layers, src: `lobe-icons@${LOBE_VER}`, file };
}
function si(slug) {
  const i = siIndex.get(slug);
  if (!i) throw new Error(`thiếu simple-icons:${slug}`);
  return { vb: '0 0 24 24', layers: [{ d: i.path }], color: '#' + i.hex, src: `simple-icons@${SI_VER}`, file: slug, siTitle: i.title };
}

const logos = {};
const alias = {};
const sources = [];
const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '');
for (const [key, title, source, opts = {}] of BRANDS) {
  if (REMOVED_AT_OWNER_REQUEST.includes(key)) throw new Error(`${key}: logo đã gỡ theo yêu cầu của chủ thương hiệu, không được thêm lại (xem REMOVED_AT_OWNER_REQUEST)`);
  if (!source) continue; // không có nguồn hợp lệ → để monogram
  const [kind, name] = source.split(':');
  if (kind !== 'lobe' && kind !== 'si') throw new Error(`${key}: nguồn "${source}" không hợp lệ — chỉ nhận si:<slug> (Simple Icons hiện hành) hoặc lobe:<tệp>`);
  const raw = kind === 'lobe' ? lobe(name) : si(name);
  let layers = raw.layers;
  const color = normHex(opts.color ?? raw.color ?? layers.find((l) => l.fill && l.fill !== 'currentColor')?.fill ?? '#888888');
  const tone = opts.tone ?? 'color';
  // Logo một màu: bỏ fill riêng của lớp → tô theo tông.
  if (tone !== 'multi') layers = layers.map(({ fill, ...l }) => l);
  logos[key] = { t: title, vb: raw.vb, c: color, tone, l: layers };
  sources.push({ key, title, src: raw.src, file: raw.file });
  for (const a of [key, fold(title), ...(opts.alias ?? [])]) {
    const k = fold(a);
    if (k.length < 2) continue;
    if (alias[k] && alias[k] !== key) throw new Error(`alias trùng: ${a} (${alias[k]} / ${key})`);
    alias[k] = key;
  }
}

const q = (s) => JSON.stringify(s);
const layerTs = (l) => `{ d: ${q(l.d)}${l.fill ? `, fill: ${q(l.fill)}` : ''}${l.evenodd ? ', evenodd: true' : ''}${l.opacity != null ? `, opacity: ${l.opacity}` : ''} }`;
let ts = `/**
 * Logo thương hiệu cho các ô dịch vụ (MCP, plugin, nguồn kỹ năng) — dữ liệu SVG tĩnh đã kiểm duyệt, KHÔNG tải gì qua mạng.
 * Tệp này được SINH bằng script (xem docs/BRAND-ASSETS.md): Simple Icons (CC0-1.0) và Lobe Icons (MIT).
 * Logo là nhãn hiệu của chủ sở hữu tương ứng, chỉ dùng để nhận diện dịch vụ tương thích.
 * Logos are trademarks of their respective owners and are shown only to identify compatible services.
 */
import { LO_BOX, LO_PATH } from './lo';

/** color: glyph màu hãng trên nền nhuộm nhẹ · mono: theo màu chữ của theme · multi: logo nhiều màu trên nền trung tính · solid: nền màu hãng, glyph tương phản · locaith: logo Locaith (gradient). */
export type BrandTone = 'color' | 'mono' | 'multi' | 'solid' | 'locaith';

export interface BrandLayer {
  /** Dữ liệu path SVG. */
  readonly d: string;
  /** Chỉ có ở logo nhiều màu ('multi'): mã hex hoặc 'currentColor'. */
  readonly fill?: string;
  readonly evenodd?: boolean;
  readonly opacity?: number;
}

export interface BrandLogo {
  /** Tên hiển thị của thương hiệu. */
  readonly t: string;
  /** viewBox của SVG. */
  readonly vb: string;
  /** Màu hãng (#RRGGBB). */
  readonly c: string;
  readonly tone: BrandTone;
  readonly l: readonly BrandLayer[];
}

export const LOGOS: Readonly<Record<string, BrandLogo>> = {
  locaith: { t: 'Locaith', vb: \`\${LO_BOX.x} \${LO_BOX.y} \${LO_BOX.w} \${LO_BOX.h}\`, c: '#625AEC', tone: 'locaith', l: [{ d: LO_PATH, evenodd: true }] },
`;
for (const [k, v] of Object.entries(logos)) {
  ts += `  ${/^[a-z][a-z0-9]*$/.test(k) ? k : q(k)}: { t: ${q(v.t)}, vb: ${q(v.vb)}, c: ${q(v.c)}, tone: ${q(v.tone)}, l: [${v.l.map(layerTs).join(', ')}] },\n`;
}
ts += `};

/** Tên gọi khác (đã chuẩn hoá: chữ thường, bỏ dấu, chỉ a-z0-9) → khoá logo. Gồm id kho MCP, tên plugin, chủ repo GitHub và nguồn kỹ năng. */
export const BRAND_ALIASES: Readonly<Record<string, string>> = {
  locaith: 'locaith',
  biomemorylocaith: 'locaith',
  biomemory: 'locaith',
  bioagentos: 'locaith',
`;
for (const [k, v] of Object.entries(alias)) if (!['locaith'].includes(k)) ts += `  ${/^[a-z][a-z0-9]*$/.test(k) ? k : q(k)}: ${q(v)},\n`;
ts += `};
`;
// Phần viết tay (brandFor, monogram, màu glyph) giữ nguyên từ tệp hiện có, bắt đầu ở dấu mốc dưới đây.
const MARK = "\n// ───────────────────────────── Tra cứu";
const prev = fs.readFileSync(out, "utf8");
if (!prev.includes(MARK)) throw new Error("không thấy phần viết tay trong " + out);
ts += prev.slice(prev.indexOf(MARK));
fs.writeFileSync(out, ts);
console.log('logos', Object.keys(logos).length + 1, 'aliases', Object.keys(alias).length, 'bytes', Buffer.byteLength(ts));
