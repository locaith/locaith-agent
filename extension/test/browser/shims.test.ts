import { createHash as nodeHash } from 'node:crypto';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import ShimAjv from '../../src/browser/shims/ajv';
import { createHash, sha1Hex, sha256Hex } from '../../src/browser/shims/crypto';
import { NodeToolHost } from '../../src/core/host/nodeHost';
import { builtinSkills } from '../../src/core/skills/builtin';
import { SkillRegistry } from '../../src/core/skills/registry';
import { createToolRegistry } from '../../src/core/tools';
import type { JsonSchema } from '../../src/core/types';

describe('shim node:crypto (băm đồng bộ cho bản trình duyệt)', () => {
  const samples = [
    '',
    'abc',
    'Nguyễn Thị Thuỷ Tiên — Ướ ữ ặ ổ ệ ẫ ể',
    'x'.repeat(55),
    'x'.repeat(56),
    'x'.repeat(63),
    'x'.repeat(64),
    'x'.repeat(65),
    'dòng 1\ndòng 2\r\n'.repeat(500),
    '😀 emoji '.repeat(100),
  ];
  it('sha1 và sha256 khớp node:crypto trên chuỗi biên (độ dài quanh 55/56/64 byte) và tiếng Việt', () => {
    for (const s of samples) {
      expect(sha1Hex(s), `sha1 ${s.slice(0, 12)}`).toBe(nodeHash('sha1').update(s, 'utf8').digest('hex'));
      expect(sha256Hex(s), `sha256 ${s.slice(0, 12)}`).toBe(nodeHash('sha256').update(s, 'utf8').digest('hex'));
    }
  });
  it('createHash().update().update().digest("hex") nối các mảnh; từ chối thuật toán lạ', () => {
    expect(createHash('sha1').update('ab').update('c').digest('hex')).toBe(nodeHash('sha1').update('abc').digest('hex'));
    expect(createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex')).toBe(nodeHash('sha256').update(Buffer.from([1, 2, 3])).digest('hex'));
    expect(() => createHash('md5')).toThrow(/chưa hỗ trợ/);
  });
});

// ── Đối chiếu bộ kiểm tra schema với Ajv thật ──────────────────────────────────

function sample(schema: JsonSchema): unknown {
  const s = schema as Record<string, any>;
  if (s.enum) return s.enum[0];
  switch (s.type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, sub] of Object.entries(s.properties ?? {})) if ((s.required ?? []).includes(k)) out[k] = sample(sub as JsonSchema);
      return out;
    }
    case 'array':
      return s.items ? [sample(s.items)] : [];
    case 'string':
      return 'x';
    case 'integer':
      return s.minimum ?? 1;
    case 'number':
      return s.minimum ?? 1.5;
    case 'boolean':
      return true;
    default:
      return 'x';
  }
}

const PROBES: unknown[] = ['abc', '', '7', '2.5', ' ', 7, 2.5, -1, 0, 1e9, true, false, null, [], ['a'], {}, { a: 1 }];

function variants(schema: JsonSchema): unknown[] {
  const base = sample(schema) as Record<string, unknown>;
  const out: unknown[] = [base, {}, null, 'text', 5, [], { zzz: 1 }];
  const props = ((schema as Record<string, any>).properties ?? {}) as Record<string, JsonSchema>;
  for (const k of Object.keys(props)) {
    const sub = props[k] as Record<string, any>;
    const without = { ...base };
    delete without[k];
    out.push(without);
    for (const p of PROBES) out.push({ ...base, [k]: p });
    if (typeof sub.maximum === 'number') out.push({ ...base, [k]: sub.maximum + 1 }, { ...base, [k]: String(sub.maximum) });
    if (typeof sub.minimum === 'number') out.push({ ...base, [k]: sub.minimum - 1 }, { ...base, [k]: String(sub.minimum) });
    if (sub.type === 'array' && sub.items) {
      const item = sample(sub.items) as Record<string, unknown>;
      out.push({ ...base, [k]: [item] }, { ...base, [k]: [{}] }, { ...base, [k]: [null] });
      const ip = ((sub.items as Record<string, any>).properties ?? {}) as Record<string, JsonSchema>;
      for (const ik of Object.keys(ip)) for (const p of PROBES) out.push({ ...base, [k]: [{ ...item, [ik]: p }] });
    }
  }
  return out;
}

describe('shim ajv (bản trình duyệt) khớp Ajv thật trên schema của mọi công cụ', () => {
  const host = new NodeToolHost({ roots: [] });
  const registry = createToolRegistry({ skills: new SkillRegistry(builtinSkills()), host });
  // Cấu hình giống dispatcher.
  const real = new Ajv({ allErrors: false, strict: false, coerceTypes: true, useDefaults: true });
  const shim = new ShimAjv({ allErrors: false, strict: false, coerceTypes: true, useDefaults: true });

  it('biên dịch được toàn bộ schema (không có từ khoá lạ)', () => {
    for (const def of registry.all()) expect(() => shim.compile(def.inputSchema), def.name).not.toThrow();
  });

  it('cùng kết luận hợp lệ/không hợp lệ và cùng dữ liệu sau khi ép kiểu/điền mặc định', () => {
    let compared = 0;
    for (const def of registry.all()) {
      const a = real.compile(def.inputSchema);
      const b = shim.compile(def.inputSchema);
      for (const v of variants(def.inputSchema)) {
        const x = structuredClone(v);
        const y = structuredClone(v);
        const okA = a(x);
        const okB = b(y);
        const ctx = `${def.name} ← ${JSON.stringify(v)}`;
        expect(okB, `hợp lệ? ${ctx}`).toBe(okA);
        if (okA) expect(y, `dữ liệu sau xử lý ${ctx}`).toEqual(x);
        else expect(b.errors?.length, ctx).toBeGreaterThan(0);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(500);
  });

  it('errorsText nêu đường dẫn và lý do như Ajv', () => {
    const schema = { type: 'object', properties: { n: { type: 'integer', minimum: 1, maximum: 10 }, mode: { type: 'string', enum: ['a', 'b'] } }, required: ['n'] };
    const v = shim.compile(schema);
    expect(v({})).toBe(false);
    expect(shim.errorsText(v.errors, { dataVar: 'input' })).toBe("input must have required property 'n'");
    expect(v({ n: 11 })).toBe(false);
    expect(shim.errorsText(v.errors, { dataVar: 'input' })).toBe('input/n must be <= 10');
    expect(v({ n: '3', mode: 'c' })).toBe(false);
    expect(shim.errorsText(v.errors, { dataVar: 'input' })).toBe('input/mode must be equal to one of the allowed values');
    const ok = { n: '3', mode: 'a' };
    expect(v(ok)).toBe(true);
    expect(ok.n).toBe(3);
  });

  it('từ chối từ khoá chưa hỗ trợ thay vì bỏ qua âm thầm', () => {
    expect(() => shim.compile({ type: 'object', properties: { a: { type: 'string', pattern: '^x' } } })).toThrow(/pattern/);
    expect(() => shim.compile({ anyOf: [{ type: 'string' }] })).toThrow(/anyOf/);
  });
});
