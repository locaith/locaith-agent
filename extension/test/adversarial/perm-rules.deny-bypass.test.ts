import { describe, it, expect } from 'vitest';
import { evaluateRules, buildRules } from '../../src/shared/permissionRules';

const deny = (s: string) => buildRules([{ action: 'deny', source: 'user', items: [s] }]);
const cmd = (command: string) => ({ kind: 'command' as const, command });

describe('perm-rules: deny run_command(rm:*) must not be bypassed by shell constructs the matcher cannot parse', () => {
  const cases = ['echo $(rm -rf /tmp/x)', 'echo `rm -rf /tmp/x`', '(rm -rf /tmp/x)', '{ rm -rf /tmp/x; }', 'echo hi; ( rm -rf x )', 'FOO=1 rm -rf x', 'ls $(rm x)', 'echo "$(rm -rf x)"'];
  for (const c of cases) {
    it(`blocks: ${c}`, () => {
      expect(evaluateRules(deny('run_command(rm:*)'), 'run_command', cmd(c))?.action).toBe('deny');
    });
  }
});
