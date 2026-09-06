import type { MockRule, RedirectRule, Scenario } from '../../shared/types';
import { matchRule, type RequestDescription } from './matcher';
import { ruleEffective } from './rule-effective';

export function findMatchingRule(rules: MockRule[], req: RequestDescription): MockRule | undefined {
  return rules
    .filter((r) => r.enabled)
    .sort((a, b) => a.priority - b.priority)
    .find((r) => matchRule(r.match, req));
}

export function findMatchingRedirect(
  redirects: RedirectRule[],
  scenarios: ReadonlyMap<string, Scenario>,
  req: RequestDescription,
): RedirectRule | undefined {
  return [...redirects]
    .filter((r) => ruleEffective(r, scenarios))
    .sort((a, b) => a.priority - b.priority)
    .find((r) => matchRule(r.match, req));
}
