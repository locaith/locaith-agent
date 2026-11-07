// Đối kháng: mention khoảng dòng chỉ-có-chữ không được vượt ngân sách tổng của tin (MAX_TOTAL_CHARS = 240k).
import { describe, expect, it } from 'vitest';
import { newSession } from '../../src/core/engine/types';
import { NodeToolHost } from '../../src/core/host/nodeHost';
import { buildUserContent } from '../../src/host/userContent';
import { makeWorkspace } from '../helpers/harness';

describe('ide-context: ngân sách đính kèm với @tệp#L…', () => {
  it('20 mention x 2000 dòng dài không được đẩy tin vượt ~250k ký tự', async () => {
    const big = Array.from({ length: 2000 }, (_, i) => `d${i} ` + 'x'.repeat(36)).join('\n') + '\n'; // ~80k ký tự / mention
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`f${i}.ts`] = big;
    const dir = makeWorkspace(files);
    const host = new NodeToolHost({ roots: [dir] });
    const session = newSession({ id: 's', provider: 'p', model: 'm' });
    const text = Array.from({ length: 20 }, (_, i) => `@f${i}.ts#L1-2000`).join(' ');
    const r = await buildUserContent({ text, attachments: [], host, session, editor: null });
    const total = r.content.map((b) => ('text' in b ? (b as { text: string }).text.length : 0)).reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(260_000);
  });
});
