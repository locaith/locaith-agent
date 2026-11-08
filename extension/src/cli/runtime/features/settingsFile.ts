/**
 * Đọc/ghi thẳng tệp cài đặt JSON theo TỪNG phạm vi (user/project/local). `SettingsApi.get` đã gộp các phạm vi nên không đủ cho
 * những tính năng cần biết ai viết gì (hook và luật quyền của DỰ ÁN phải được duyệt, của người dùng thì không).
 * Khoá nhận cả dạng lồng (`{"permissions":{"allow":[]}}`) lẫn dạng chấm (`{"permissions.allow":[]}`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export type Scope = 'user' | 'project' | 'local';

export function readJsonFile(file: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Giá trị theo khoá chấm: thử khoá phẳng trước (`"a.b"`), rồi đi xuống từng cấp. undefined = không có. */
export function getPath(obj: Record<string, unknown> | null | undefined, key: string): unknown {
  if (!obj) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  const parts = key.split('.');
  for (let i = parts.length - 1; i >= 1; i--) {
    const head = parts.slice(0, i).join('.');
    if (Object.prototype.hasOwnProperty.call(obj, head)) {
      const v = obj[head];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const r = getPath(v as Record<string, unknown>, parts.slice(i).join('.'));
        if (r !== undefined) return r;
      }
    }
  }
  return undefined;
}

/** Ghi giá trị vào tệp cài đặt (tạo thư mục/tệp nếu chưa có), giữ nguyên các khoá khác. Dạng lồng; nếu tệp đang dùng khoá phẳng thì cập nhật khoá đó. */
export function setPathInFile(file: string, key: string, value: unknown): void {
  const obj = readJsonFile(file) ?? {};
  if (Object.prototype.hasOwnProperty.call(obj, key)) obj[key] = value;
  else {
    const parts = key.split('.');
    let cur: Record<string, unknown> = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const next = cur[parts[i]];
      if (!next || typeof next !== 'object' || Array.isArray(next)) cur[parts[i]] = {};
      cur = cur[parts[i]] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]] = value;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
    fs.rmSync(tmp, { force: true });
  }
}

export const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
