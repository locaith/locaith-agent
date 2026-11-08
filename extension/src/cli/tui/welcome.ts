/** Màn hình khởi động: khung bo tròn với logo «Lo» (nửa ô, gradient thương hiệu), tên + phiên bản, tài khoản, model, thư mục, mẹo xoay vòng. */

import type { RuntimeStatus } from '../runtime/contract';
import { t as tr, type Lang } from '../i18n';
import { middleEllipsis } from './format';
import { LOGO_ASCII, LOGO_ROWS, LOGO_SMALL_ASCII, LOGO_SMALL_ROWS, LOGO_SMALL_WIDTH, LOGO_WIDTH } from './logoArt';
import './strings';
import type { Theme } from './theme';
import { box } from './widgets';
import { padEnd, stringWidth, truncateAnsi, truncatePlain } from './width';

export interface WelcomeInfo {
  version: string;
  lang: Lang;
  theme: Theme;
  width: number;
  /** Số hàng của terminal (chọn logo lớn/nhỏ). */
  height?: number;
  status?: RuntimeStatus | null;
  cwd: string;
  /** Mẹo hiển thị (chỉ số xoay vòng, mặc định theo ngày). */
  tipIndex?: number;
  /** Bỏ khung (ví dụ in lại sau /clear). */
  compact?: boolean;
}

const TIP_KEYS = ['banner.tip1', 'banner.tip2', 'banner.tip3', 'banner.tip4', 'banner.tip5', 'banner.tip6'];

export function pickTip(i = Math.floor(Date.now() / 86_400_000)): string {
  return tr('tui.' + TIP_KEYS[Math.abs(i) % TIP_KEYS.length]);
}

/** Tô gradient dọc cho một hàng logo (có lệch nhẹ theo cột). */
function paintLogoRow(th: Theme, row: string, r: number, rows: number, width: number): string {
  if (th.caps.color === 'none') return row;
  let out = '';
  let i = 0;
  for (const ch of row) {
    if (ch === ' ') out += ch;
    else {
      const t = Math.min(1, ((r + 0.5) / rows) * 0.85 + (i / Math.max(1, width)) * 0.15);
      out += th.gradientFg(t) + ch;
    }
    i++;
  }
  return out + '\x1b[39m';
}

export function logoLines(th: Theme, small: boolean): { lines: string[]; width: number } {
  const unicode = th.caps.unicode;
  const rows = small ? (unicode ? LOGO_SMALL_ROWS : LOGO_SMALL_ASCII) : unicode ? LOGO_ROWS : LOGO_ASCII;
  const width = small ? LOGO_SMALL_WIDTH : LOGO_WIDTH;
  return { lines: rows.map((r, i) => paintLogoRow(th, r, i, rows.length, width).replace(/$/, '')), width };
}

export function renderWelcome(i: WelcomeInfo): string[] {
  const th = i.theme;
  const W = Math.max(30, i.width);
  const st = i.status ?? null;
  const info: string[] = [];
  info.push(th.bold(th.gradient('Locaith CLI')) + ' ' + th.muted('v' + i.version));
  info.push(th.muted(tr('tui.banner.tagline')));
  info.push('');
  if (st?.account?.loggedIn) {
    const who = [st.account.email, st.account.plan].filter(Boolean).join(` ${th.g.sep} `);
    info.push(th.muted(tr('tui.banner.account.in') + ': ') + (who || th.ok(th.g.ok)));
  } else if (st) info.push(th.warn(tr('tui.banner.account.out')));
  if (st?.model) info.push(th.muted(tr('tui.banner.model') + ': ') + st.model);
  const branch = st?.gitBranch ? ' ' + th.muted(`(${th.g.branch} ${st.gitBranch})`) : '';
  info.push(th.muted(tr('tui.banner.cwd') + ': ') + '{CWD}' + branch);

  const rows = i.height ?? 30;
  const showBig = W >= 72 && rows >= 32;
  const showSmall = !showBig && W >= 52;
  const logo = showBig || showSmall ? logoLines(th, showSmall) : null;

  const inner = W - 4;
  const gap = 3;
  const textRoom = logo ? inner - logo.width - gap - 1 : inner - 1;
  // đường dẫn có thể rất dài
  const cwdMax = Math.max(12, textRoom - stringWidth(tr('tui.banner.cwd')) - 2 - (st?.gitBranch ? stringWidth(st.gitBranch) + 5 : 0));
  const cwdShown = middleEllipsis(i.cwd.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1:'), cwdMax);
  const infoRows = info.map((l) => truncateAnsi(l.replace('{CWD}', cwdShown), textRoom));

  const body: string[] = [];
  if (logo) {
    const h = Math.max(logo.lines.length, infoRows.length);
    const topPad = Math.max(0, Math.floor((h - infoRows.length) / 2));
    for (let r = 0; r < h; r++) {
      const l = logo.lines[r] ?? '';
      const t = infoRows[r - topPad] ?? '';
      body.push(padEnd(l, logo.width) + ' '.repeat(gap) + t);
    }
  } else body.push(...infoRows);
  const framed = box(['', ...body, ''], W, th, { border: th.faint });
  const tips = th.faint('  ' + truncatePlain(tr('tui.banner.tips'), W - 3));
  const tip = th.muted('  ' + truncatePlain(i.tipIndex === undefined ? pickTip() : pickTip(i.tipIndex), W - 3));
  return i.compact ? [...body.map((l) => '  ' + l), tip] : [...framed, tips, tip];
}
