/**
 * Bộ kiểm tra JSON-schema thay cho `ajv` trong bản trình duyệt.
 *
 * Ajv biên dịch schema bằng `new Function`, mà trang tiện ích Manifest V3 cấm `unsafe-eval` → Ajv không chạy được. Bản này THÔNG DỊCH
 * schema (không sinh mã), chỉ hỗ trợ đúng tập từ khoá mà công cụ của extension dùng và bắt chước cấu hình Ajv của dispatcher:
 * `coerceTypes: true` (model hay gửi "5" thay cho 5), `useDefaults: true`, `allErrors: false` (lỗi đầu tiên).
 * Từ khoá lạ → ném lỗi khi biên dịch để không âm thầm bỏ qua việc kiểm tra (dispatcher bắt lỗi và ghi log).
 * Có bài kiểm thử đối chiếu với Ajv thật trên toàn bộ schema của công cụ (test/browser/ajvShim.test.ts).
 */

export interface ErrorObject {
  instancePath: string;
  message: string;
}

export interface ValidateFunction {
  (data: unknown): boolean;
  errors?: ErrorObject[] | null;
}

type Schema = Record<string, unknown>;
type Type = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';

const KNOWN = new Set([
  'type',
  'description',
  'title',
  'properties',
  'required',
  'minimum',
  'maximum',
  'enum',
  'default',
  'items',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'additionalProperties',
  '$schema',
  'examples',
]);

export interface Options {
  allErrors?: boolean;
  strict?: boolean;
  coerceTypes?: boolean | 'array';
  useDefaults?: boolean;
}

class Fail extends Error {
  constructor(
    readonly path: string,
    readonly msg: string,
  ) {
    super(msg);
  }
}

function typeOf(v: unknown): Type | 'undefined' {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  switch (typeof v) {
    case 'string':
      return 'string';
    case 'boolean':
      return 'boolean';
    case 'number':
      return Number.isInteger(v) ? 'integer' : 'number';
    case 'object':
      return 'object';
    default:
      return 'undefined';
  }
}

function matches(v: unknown, t: Type): boolean {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

/** Quy tắc ép kiểu của Ajv (coerceTypes: true) cho giá trị vô hướng. `undefined` = không ép được. */
function coerce(v: unknown, t: Type): unknown {
  switch (t) {
    case 'string':
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      if (v === null) return '';
      return undefined;
    case 'number':
    case 'integer': {
      let n: number | undefined;
      if (typeof v === 'boolean') n = v ? 1 : 0;
      else if (v === null) n = 0;
      // Đúng công thức của Ajv: chuỗi không rỗng mà `data == +data` (so sánh LỎNG: " " → 0, "0x10" → 16, "1e3" → 1000).
      else if (typeof v === 'string' && v !== '' && (v as unknown) == +v) {
        if (t === 'integer' && +v % 1) return undefined;
        n = +v;
      }
      return n;
    }
    case 'boolean':
      if (v === 'true' || v === 1) return true;
      if (v === 'false' || v === 0 || v === null) return false;
      return undefined;
    case 'null':
      if (v === '' || v === 0 || v === false) return null;
      return undefined;
    default:
      return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function check(schema: Schema, data: unknown, path: string, opts: Options, set: (v: unknown) => void): void {
  // type (+ ép kiểu)
  const declared = schema.type;
  if (declared !== undefined) {
    const types = (Array.isArray(declared) ? declared : [declared]) as Type[];
    if (!types.some((t) => matches(data, t))) {
      let coerced = false;
      if (opts.coerceTypes) {
        for (const t of types) {
          const c = coerce(data, t);
          if (c !== undefined) {
            // `null` cũng là kết quả hợp lệ của phép ép kiểu sang 'null' (khác với "không ép được" = undefined).
            data = c;
            coerced = true;
            break;
          }
        }
      }
      if (!coerced) throw new Fail(path, `must be ${types.join(',')}`);
      set(data);
    }
  }

  if (schema.enum !== undefined) {
    const allowed = schema.enum as unknown[];
    if (!allowed.some((a) => a === data)) throw new Fail(path, 'must be equal to one of the allowed values');
  }

  if (typeof data === 'number') {
    if (typeof schema.minimum === 'number' && data < schema.minimum) throw new Fail(path, `must be >= ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && data > schema.maximum) throw new Fail(path, `must be <= ${schema.maximum}`);
  }

  if (typeof data === 'string') {
    // Ajv đếm theo điểm mã Unicode.
    const len = [...data].length;
    if (typeof schema.minLength === 'number' && len < schema.minLength) throw new Fail(path, `must NOT have fewer than ${schema.minLength} characters`);
    if (typeof schema.maxLength === 'number' && len > schema.maxLength) throw new Fail(path, `must NOT have more than ${schema.maxLength} characters`);
  }

  if (Array.isArray(data)) {
    if (typeof schema.minItems === 'number' && data.length < schema.minItems) throw new Fail(path, `must NOT have fewer than ${schema.minItems} items`);
    if (typeof schema.maxItems === 'number' && data.length > schema.maxItems) throw new Fail(path, `must NOT have more than ${schema.maxItems} items`);
    if (isRecord(schema.items)) {
      const itemSchema = schema.items as Schema;
      for (let i = 0; i < data.length; i++) check(itemSchema, data[i], `${path}/${i}`, opts, (v) => (data as unknown[])[i] = v);
    }
  }

  if (isRecord(data)) {
    const props = isRecord(schema.properties) ? (schema.properties as Record<string, Schema>) : {};
    if (opts.useDefaults) {
      for (const [k, sub] of Object.entries(props)) {
        if (data[k] === undefined && isRecord(sub) && 'default' in sub) data[k] = structuredCloneSafe(sub.default);
      }
    }
    if (Array.isArray(schema.required)) {
      for (const k of schema.required as string[]) if (data[k] === undefined) throw new Fail(path, `must have required property '${k}'`);
    }
    for (const [k, sub] of Object.entries(props)) {
      if (data[k] !== undefined && isRecord(sub)) check(sub, data[k], `${path}/${k}`, opts, (v) => (data as Record<string, unknown>)[k] = v);
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(data)) if (!(k in props)) throw new Fail(path, 'must NOT have additional properties');
    }
  }
}

function structuredCloneSafe<T>(v: T): T {
  return v !== null && typeof v === 'object' ? (JSON.parse(JSON.stringify(v)) as T) : v;
}

function assertSupported(schema: unknown, where: string): void {
  if (!isRecord(schema)) return;
  for (const k of Object.keys(schema)) {
    if (!KNOWN.has(k)) throw new Error(`Từ khoá JSON-schema chưa hỗ trợ trong bản trình duyệt: "${k}" (${where})`);
  }
  if (isRecord(schema.properties)) for (const [k, sub] of Object.entries(schema.properties)) assertSupported(sub, `${where}.${k}`);
  if (isRecord(schema.items)) assertSupported(schema.items, `${where}[]`);
}

export default class Ajv {
  constructor(private readonly opts: Options = {}) {}

  compile(schema: object): ValidateFunction {
    assertSupported(schema, '$');
    const opts = this.opts;
    const validate: ValidateFunction = (data: unknown): boolean => {
      validate.errors = null;
      let root = data;
      try {
        check(schema as Schema, root, '', opts, (v) => (root = v));
        return true;
      } catch (err) {
        if (err instanceof Fail) {
          validate.errors = [{ instancePath: err.path, message: err.msg }];
          return false;
        }
        throw err;
      }
    };
    return validate;
  }

  errorsText(errors: ErrorObject[] | null | undefined, opts: { dataVar?: string; separator?: string } = {}): string {
    if (!errors || errors.length === 0) return 'No errors';
    const dataVar = opts.dataVar ?? 'data';
    return errors.map((e) => `${dataVar}${e.instancePath} ${e.message}`).join(opts.separator ?? ', ');
  }
}
