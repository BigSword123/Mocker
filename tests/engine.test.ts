import { describe, expect, it } from 'vitest';
import { findMatchingRule } from '../src/main/rules/engine';
import type { RequestDescription } from '../src/main/rules/matcher';
import type { MockRule } from '../src/shared/types';

const req: RequestDescription = {
  method: 'GET',
  url: 'http://api.example.com/users',
  query: new URLSearchParams(),
  headers: {},
  body: '',
};

function rule(id: string, priority: number, enabled = true, pattern = 'http://api.example.com/users'): MockRule {
  return {
    id,
    name: id,
    enabled,
    priority,
    match: { urlType: 'exact', urlPattern: pattern, method: 'ANY' },
    action: { status: 200, headers: {}, body: id },
  };
}

describe('findMatchingRule', () => {
  it('returns undefined when nothing matches', () => {
    expect(findMatchingRule([rule('a', 1, true, 'http://other.com')], req)).toBeUndefined();
  });

  it('skips disabled rules', () => {
    expect(findMatchingRule([rule('a', 1, false)], req)).toBeUndefined();
  });

  it('picks lowest priority value first regardless of array order', () => {
    const hit = findMatchingRule([rule('late', 9), rule('early', 1)], req);
    expect(hit?.id).toBe('early');
  });
});
