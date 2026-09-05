import type { Scenario } from '../../shared/types';

export interface RuleEnabledRef {
  enabled: boolean;
  scenario?: string;
}

export function ruleEffective(rule: RuleEnabledRef, scenarios: ReadonlyMap<string, Scenario>): boolean {
  if (!rule.enabled) return false;
  if (rule.scenario === undefined) return true;
  const s = scenarios.get(rule.scenario);
  return s ? s.enabled : true;
}
