import { describe, expect, it } from 'vitest';
import type { VerifyInfo } from '../../src/shared/protocol';
import { verifyCount, verifyViewModel } from '../../webview/src/verifyView';

/** (lane:blind-verifier) Dòng «Kiểm tra độc lập»: nhãn, màu chấm, chữ phụ và các mục mở ra — thuần dữ liệu. */
const round = (r: number, m: number) => `vòng ${r}/${m}`;
const base: VerifyInfo = { key: 'v1', state: 'fail', round: 1, maxRounds: 2 };

describe('verifyViewModel', () => {
  it('đang chạy: chấm nhấp nháy, không mở được, chữ phụ là vòng', () => {
    const vm = verifyViewModel({ ...base, state: 'running' }, 'vi', round);
    expect(vm).toMatchObject({ labelKey: 'verify.running', tone: 'running', expandable: false, detail: 'vòng 1/2' });
  });

  it('đạt: chấm xanh, chữ phụ có model và thời gian; không có gì để mở', () => {
    const vm = verifyViewModel({ ...base, state: 'pass', model: 'deepseek-v4', durationMs: 38_000 }, 'vi', round);
    expect(vm.tone).toBe('ok');
    expect(vm.labelKey).toBe('verify.pass');
    expect(vm.detail).toBe('vòng 1/2 · deepseek-v4 · 38 s');
    expect(vm.expandable).toBe(false);
  });

  it('cần sửa: chấm đỏ, đếm đúng số mục qua ba nhóm, mở ra đủ ba mục theo thứ tự thiếu → lỗi → chưa xác nhận', () => {
    const v: VerifyInfo = { ...base, missing: ['a'], defects: ['b', 'c'], unverifiedClaims: ['d'] };
    expect(verifyCount(v)).toBe(4);
    const vm = verifyViewModel(v, 'en', round);
    expect(vm).toMatchObject({ labelKey: 'verify.fail', labelVars: { n: 4 }, tone: 'danger', expandable: true, outstanding: false });
    expect(vm.sections.map((s) => s.titleKey)).toEqual(['verify.missing', 'verify.defects', 'verify.unverified']);
    expect(vm.sections.flatMap((s) => s.items)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('chưa chắc: chấm vàng; tồn đọng (hết vòng) đổi nhãn và bật ghi chú; tồn đọng mà không còn mục thì không phải tồn đọng', () => {
    expect(verifyViewModel({ ...base, state: 'uncertain', unverifiedClaims: ['x'] }, 'vi', round).tone).toBe('warn');
    const out = verifyViewModel({ ...base, state: 'fail', round: 2, defects: ['x'], outstanding: true }, 'vi', round);
    expect(out).toMatchObject({ labelKey: 'verify.outstanding', labelVars: { n: 1 }, outstanding: true });
    expect(verifyViewModel({ ...base, state: 'fail', outstanding: true }, 'vi', round).outstanding).toBe(false);
  });

  it('bỏ qua: chấm xám, lý do làm chữ phụ, không mở', () => {
    const vm = verifyViewModel({ ...base, state: 'skipped', reason: 'quá 4 phút' }, 'vi', round);
    expect(vm).toMatchObject({ labelKey: 'verify.skipped', tone: 'muted', detail: 'quá 4 phút', expandable: false });
  });
});
