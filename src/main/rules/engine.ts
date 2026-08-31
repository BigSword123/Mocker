import type { MockRule } from '../../shared/types';
import { matchRule, type RequestDescription } from './matcher';

export function findMatchingRule(rules: MockRule[], req: RequestDescription): MockRule | undefined {
  return rules
    .filter((r) => r.enabled)
    .sort((a, b) => a.priority - b.priority)
    .find((r) => matchRule(r.match, req));
}
