import { describe, expect, it } from 'vitest';
import { ruleEffective } from '../src/main/rules/rule-effective';
import type { Scenario } from '../src/shared/types';

const scenarios = (entries: Array<[string, boolean]>): Map<string, Scenario> =>
  new Map(entries.map(([name, enabled]) => [name, { name, enabled }]));

describe('ruleEffective', () => {
  it('rule disabled → false', () => {
    expect(ruleEffective({ enabled: false }, scenarios([]))).toBe(false);
  });

  it('rule enabled without scenario → true', () => {
    expect(ruleEffective({ enabled: true }, scenarios([]))).toBe(true);
  });

  it('rule enabled + scenario enabled → true', () => {
    expect(
      ruleEffective({ enabled: true, scenario: 'dev' }, scenarios([['dev', true]])),
    ).toBe(true);
  });

  it('rule enabled + scenario disabled → false', () => {
    expect(
      ruleEffective({ enabled: true, scenario: 'dev' }, scenarios([['dev', false]])),
    ).toBe(false);
  });

  it('rule enabled + unknown scenario → true (treat as default)', () => {
    expect(
      ruleEffective({ enabled: true, scenario: 'gone' }, scenarios([])),
    ).toBe(true);
  });
});
