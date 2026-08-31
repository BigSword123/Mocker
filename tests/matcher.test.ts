import { describe, expect, it } from 'vitest';
import { matchRule, type RequestDescription } from '../src/main/rules/matcher';
import type { RuleMatch } from '../src/shared/types';

function req(overrides: Partial<RequestDescription> = {}): RequestDescription {
  return {
    method: 'GET',
    url: 'http://api.example.com/users?page=2',
    query: new URL('http://api.example.com/users?page=2').searchParams,
    headers: { 'content-type': 'application/json', 'x-token': 'abc' },
    body: '',
    ...overrides,
  };
}

const base: RuleMatch = { urlType: 'exact', urlPattern: 'http://api.example.com/users?page=2', method: 'ANY' };

describe('matchRule', () => {
  it('matches exact url', () => {
    expect(matchRule(base, req())).toBe(true);
    expect(matchRule(base, req({ url: 'http://api.example.com/other' }))).toBe(false);
  });

  it('matches wildcard url (* and ?)', () => {
    const m: RuleMatch = { ...base, urlType: 'wildcard', urlPattern: 'http://api.example.com/*page=?' };
    expect(matchRule(m, req())).toBe(true);
    expect(matchRule({ ...m, urlPattern: 'http://other.com/*' }, req())).toBe(false);
  });

  it('matches regex url', () => {
    const m: RuleMatch = { ...base, urlType: 'regex', urlPattern: '^http://api\\.example\\.com/users.*$' };
    expect(matchRule(m, req())).toBe(true);
    expect(matchRule({ ...m, urlPattern: '[invalid' }, req())).toBe(false);
  });

  it('matches method with ANY support', () => {
    expect(matchRule({ ...base, method: 'GET' }, req())).toBe(true);
    expect(matchRule({ ...base, method: 'POST' }, req())).toBe(false);
    expect(matchRule({ ...base, method: 'ANY' }, req({ method: 'DELETE' }))).toBe(true);
  });

  it('matches all query entries', () => {
    const m: RuleMatch = { ...base, query: { page: '2' } };
    expect(matchRule(m, req())).toBe(true);
    expect(matchRule({ ...m, query: { page: '3' } }, req())).toBe(false);
  });

  it('matches headers case-insensitively by name', () => {
    const m: RuleMatch = { ...base, headers: { 'X-Token': 'abc' } };
    expect(matchRule(m, req())).toBe(true);
    expect(matchRule({ ...m, headers: { 'X-Token': 'zzz' } }, req())).toBe(false);
  });

  it('matches body substring', () => {
    const m: RuleMatch = { ...base, bodyContains: '"id":1' };
    expect(matchRule(m, req({ body: '{"id":1,"x":2}' }))).toBe(true);
    expect(matchRule(m, req({ body: '{}' }))).toBe(false);
  });

  it('combines conditions with AND', () => {
    const m: RuleMatch = { ...base, method: 'GET', query: { page: '2' }, bodyContains: 'nomatch' };
    expect(matchRule(m, req())).toBe(false);
  });
});
