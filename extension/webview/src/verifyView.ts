/**
 * (lane:blind-verifier) Dữ liệu hiển thị của dòng «Kiểm tra độc lập» — thuần, không DOM, để kiểm thử được.
 * Một thứ trong dòng thời gian = MỘT dòng: chấm trạng thái + nhãn xám nhỏ + (tuỳ chọn) mũi tên mở ra.
 */

import type { VerifyInfo } from '../../src/shared/protocol';
import type { Lang } from './i18n';
import { formatDuration } from './format';

export type VerifyTone = 'running' | 'ok' | 'danger' | 'warn' | 'muted';

export interface VerifySection {
  /** Khoá i18n của tiêu đề mục. */
  titleKey: 'verify.missing' | 'verify.defects' | 'verify.unverified';
  items: string[];
}

export interface VerifyViewModel {
  /** Khoá i18n + biến của nhãn chính. */
  labelKey: 'verify.running' | 'verify.pass' | 'verify.fail' | 'verify.uncertain' | 'verify.outstanding' | 'verify.skipped';
  labelVars: Record<string, string | number>;
  tone: VerifyTone;
  /** Chữ phụ xám nhạt: vòng · model · thời gian, hoặc lý do bỏ qua. */
  detail: string;
  sections: VerifySection[];
  /** Có gì để mở ra xem không. */
  expandable: boolean;
  /** Ghi chú tồn đọng (hết vòng) hiện ở cuối khối mở. */
  outstanding: boolean;
}

export function verifyCount(v: Pick<VerifyInfo, 'missing' | 'defects' | 'unverifiedClaims'>): number {
  return (v.missing?.length ?? 0) + (v.defects?.length ?? 0) + (v.unverifiedClaims?.length ?? 0);
}

export function verifySections(v: VerifyInfo): VerifySection[] {
  const out: VerifySection[] = [];
  if (v.missing?.length) out.push({ titleKey: 'verify.missing', items: v.missing });
  if (v.defects?.length) out.push({ titleKey: 'verify.defects', items: v.defects });
  if (v.unverifiedClaims?.length) out.push({ titleKey: 'verify.unverified', items: v.unverifiedClaims });
  return out;
}

export function verifyViewModel(v: VerifyInfo, lang: Lang, roundLabel: (r: number, m: number) => string): VerifyViewModel {
  const n = verifyCount(v);
  const sections = verifySections(v);
  const bits: string[] = [];
  if (v.maxRounds > 1 || v.round > 1) bits.push(roundLabel(v.round, v.maxRounds));
  if (v.model) bits.push(v.model);
  if (v.durationMs && v.durationMs >= 1000) bits.push(formatDuration(v.durationMs, lang));
  const detail = bits.join(' · ');
  const outstanding = v.outstanding === true && n > 0;
  switch (v.state) {
    case 'running':
      return { labelKey: 'verify.running', labelVars: {}, tone: 'running', detail: v.maxRounds > 1 ? roundLabel(v.round, v.maxRounds) : '', sections: [], expandable: false, outstanding: false };
    case 'pass':
      return { labelKey: 'verify.pass', labelVars: {}, tone: 'ok', detail, sections, expandable: sections.length > 0, outstanding: false };
    case 'skipped':
      return { labelKey: 'verify.skipped', labelVars: {}, tone: 'muted', detail: v.reason ?? detail, sections: [], expandable: false, outstanding: false };
    case 'uncertain':
      return { labelKey: outstanding ? 'verify.outstanding' : 'verify.uncertain', labelVars: { n }, tone: 'warn', detail, sections, expandable: sections.length > 0, outstanding };
    case 'fail':
    default:
      return { labelKey: outstanding ? 'verify.outstanding' : 'verify.fail', labelVars: { n }, tone: 'danger', detail, sections, expandable: sections.length > 0, outstanding };
  }
}
