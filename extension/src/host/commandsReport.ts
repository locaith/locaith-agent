/**
 * Dựng nội dung (Markdown) cho `/status` và `/doctor` từ dữ liệu đã thu thập — hàm thuần, không đụng `vscode`, để test được.
 * Hiển thị bằng một 'notice' (loại sự kiện đã có) nên đi qua Remote/Chrome nguyên vẹn.
 */

import type { Lang } from '../core/engine/strings';

export interface StatusInfo {
  version: string;
  account: { signedIn: boolean; who?: string } | null;
  provider: string;
  model: string;
  mode: string;
  thinking: string;
  swarm: boolean;
  contextWindow: number;
  lastContextTokens: number;
  mcp: { name: string; status: string; tools: number }[];
  hooks: number | null;
  instructions: string | null;
  memoryFiles: number;
  outputStyle: string;
  commands: { project: number; user: number; plugin: number };
  agents: number;
  skillsLoaded: string[];
  trusted: boolean;
}

const fmtK = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));

export function formatStatus(s: StatusInfo, lang: Lang): string {
  const vi = lang === 'vi';
  const pct = s.contextWindow > 0 ? Math.round((s.lastContextTokens / s.contextWindow) * 100) : 0;
  const mcp = s.mcp.length
    ? s.mcp.map((m) => `${m.name} (${m.status}${m.tools ? `, ${m.tools} ${vi ? 'công cụ' : 'tools'}` : ''})`).join(', ')
    : vi
      ? 'chưa có'
      : 'none';
  const rows: [string, string][] = [
    [vi ? 'Phiên bản' : 'Version', s.version],
    [vi ? 'Tài khoản' : 'Account', s.account ? (s.account.signedIn ? s.account.who || (vi ? 'đã đăng nhập' : 'signed in') : vi ? 'chưa đăng nhập' : 'signed out') : '—'],
    ['Model', `${s.provider} · ${s.model}`],
    [vi ? 'Chế độ quyền' : 'Permission mode', s.mode + (s.trusted ? '' : vi ? ' (workspace chưa tin cậy)' : ' (workspace not trusted)')],
    [vi ? 'Suy luận' : 'Thinking', s.thinking + (s.swarm ? ' + swarm' : '')],
    [vi ? 'Cửa sổ ngữ cảnh' : 'Context window', `${fmtK(s.lastContextTokens)} / ${fmtK(s.contextWindow)} (${pct}%)`],
    ['MCP', mcp],
    ['Hooks', s.hooks == null ? (vi ? 'chưa cấu hình' : 'not configured') : String(s.hooks)],
    [vi ? 'Hướng dẫn dự án' : 'Project instructions', s.instructions ?? (vi ? 'không có' : 'none')],
    [vi ? 'Ký ức' : 'Memory', vi ? `${s.memoryFiles} tệp` : `${s.memoryFiles} files`],
    [vi ? 'Phong cách đầu ra' : 'Output style', s.outputStyle],
    [
      vi ? 'Lệnh tuỳ chỉnh' : 'Custom commands',
      vi ? `${s.commands.project} dự án · ${s.commands.user} cá nhân · ${s.commands.plugin} plugin` : `${s.commands.project} project · ${s.commands.user} user · ${s.commands.plugin} plugin`,
    ],
    [vi ? 'Agent con' : 'Sub-agents', String(s.agents)],
    [vi ? 'Kỹ năng đã nạp' : 'Loaded skills', s.skillsLoaded.length ? s.skillsLoaded.join(', ') : vi ? 'chưa có' : 'none'],
  ];
  return `**${vi ? 'Trạng thái' : 'Status'}**\n\n${rows.map(([k, v]) => `- ${k}: ${v}`).join('\n')}`;
}

export interface DoctorCheck {
  ok: boolean;
  label: string;
  detail: string;
  /** Cách sửa (chỉ hiện khi !ok). */
  fix?: string;
}

export function formatDoctor(checks: readonly DoctorCheck[], lang: Lang): string {
  const vi = lang === 'vi';
  const bad = checks.filter((c) => !c.ok).length;
  const head = bad === 0 ? (vi ? 'Mọi mục đều ổn.' : 'Everything looks good.') : vi ? `${bad} mục cần xem.` : `${bad} item(s) need attention.`;
  const lines = checks.map((c) => `- ${c.ok ? '✓' : '⚠'} **${c.label}**: ${c.detail}${!c.ok && c.fix ? `\n  ${vi ? 'Cách sửa' : 'Fix'}: ${c.fix}` : ''}`);
  return `**${vi ? 'Chẩn đoán' : 'Doctor'}** — ${head}\n\n${lines.join('\n')}`;
}
