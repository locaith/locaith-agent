import { describe, expect, it } from 'vitest';
import { pickCommandModel } from '../src/host/commandModel';

const providers = [
  { id: 'locaith', models: [{ id: 'locaith-v5-flash', label: 'Locaith v5 Flash' }, { id: 'locaith-v5-si', label: 'Locaith v5 SI' }] },
  { id: 'gemini', models: [{ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }] },
];

describe('pickCommandModel (model: trong frontmatter lệnh tuỳ chỉnh)', () => {
  it('rỗng / inherit giữ model của phiên', () => {
    expect(pickCommandModel(undefined, providers)).toBeNull();
    expect(pickCommandModel('inherit', providers)).toBeNull();
  });
  it('khớp id đầy đủ hoặc nhàCungCấp:id', () => {
    expect(pickCommandModel('gemini-3.8-flash', providers)).toEqual({ ok: true, pick: { provider: 'gemini', model: 'gemini-3.8-flash' } });
    expect(pickCommandModel('locaith:locaith-v5-si', providers)).toEqual({ ok: true, pick: { provider: 'locaith', model: 'locaith-v5-si' } });
  });
  it('đoạn chữ duy nhất khớp được, mơ hồ hoặc không có thì từ chối', () => {
    expect(pickCommandModel('gemini', providers)).toEqual({ ok: true, pick: { provider: 'gemini', model: 'gemini-3.8-flash' } });
    expect(pickCommandModel('flash', providers)).toEqual({ ok: false, reason: 'ambiguous' });
    expect(pickCommandModel('opus', providers)).toEqual({ ok: false, reason: 'none' });
  });
});
