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

describe('perm-rules: deny/ask prefix handling does not weaken allow and does not over-block unrelated commands', () => {
  it('wrappers and env prefixes are looked through for deny', () => {
    for (const c of ['sudo rm -rf x', 'env A=1 B=2 rm x', 'time rm x', 'A=1 B=2 rm x && echo ok']) {
      expect(evaluateRules(deny('run_command(rm:*)'), 'run_command', cmd(c))?.action).toBe('deny');
    }
  });
  it('unrelated commands are not denied', () => {
    for (const c of ['echo $(date)', 'FOO=1 ls -la', '(cd src && ls)', 'echo rmdir']) {
      expect(evaluateRules(deny('run_command(rm:*)'), 'run_command', cmd(c))).toBeNull();
    }
  });
  it('allow stays strict: env prefix or subshell never matches an allow rule', () => {
    const allow = buildRules([{ action: 'allow', source: 'user', items: ['run_command(ls:*)'] }]);
    for (const c of ['FOO=1 ls', 'ls $(rm x)', '(ls)']) {
      expect(evaluateRules(allow, 'run_command', cmd(c))).toBeNull();
    }
  });
  it('ask rules also see nested commands', () => {
    const ask = buildRules([{ action: 'ask', source: 'user', items: ['run_command(git push:*)'] }]);
    expect(evaluateRules(ask, 'run_command', cmd('echo $(git push origin main)'))?.action).toBe('ask');
  });
});
