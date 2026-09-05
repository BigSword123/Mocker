import { describe, expect, it } from 'vitest';
import { EMPTY_FILTER, matchesFilter } from '../src/renderer/src/lib/traffic-filter';
import type { TrafficEvent } from '../src/shared/types';

function event(overrides: Partial<TrafficEvent> = {}): TrafficEvent {
  return {
    id: 'e1',
    startedAt: 0,
    method: 'GET',
    url: 'http://api.example.com/users/7?page=2',
    host: 'api.example.com',
    path: '/users/7',
    status: 200,
    requestHeaders: { 'x-token': 'abc' },
    requestBody: '{"name":"伟"}',
    responseHeaders: { 'content-type': 'application/json' },
    responseBody: '{"ok":true}',
    mocked: false,
    ...overrides,
  };
}

describe('matchesFilter', () => {
  it('empty filter matches everything', () => {
    expect(matchesFilter(event(), EMPTY_FILTER)).toBe(true);
  });

  it('method match is case-insensitive', () => {
    expect(matchesFilter(event({ method: 'POST' }), { ...EMPTY_FILTER, method: 'get' })).toBe(false);
    expect(matchesFilter(event(), { ...EMPTY_FILTER, method: 'GET' })).toBe(true);
  });

  it('status buckets by first digit', () => {
    expect(matchesFilter(event(), { ...EMPTY_FILTER, status: '2' })).toBe(true);
    expect(matchesFilter(event(), { ...EMPTY_FILTER, status: '5' })).toBe(false);
  });

  it('in-flight events match no status bucket', () => {
    expect(matchesFilter(event({ status: undefined }), { ...EMPTY_FILTER, status: '2' })).toBe(false);
  });

  it('error bucket matches non-empty error field only', () => {
    expect(matchesFilter(event({ error: 'ECONNRESET' }), { ...EMPTY_FILTER, status: 'error' })).toBe(true);
    expect(matchesFilter(event(), { ...EMPTY_FILTER, status: 'error' })).toBe(false);
  });

  it('host is a case-insensitive substring match', () => {
    expect(matchesFilter(event(), { ...EMPTY_FILTER, host: 'EXAMPLE' })).toBe(true);
    expect(matchesFilter(event(), { ...EMPTY_FILTER, host: 'other.com' })).toBe(false);
  });

  it('full-text searches url, headers and bodies', () => {
    expect(matchesFilter(event(), { ...EMPTY_FILTER, text: 'users/7' })).toBe(true);
    expect(matchesFilter(event(), { ...EMPTY_FILTER, text: 'x-token' })).toBe(true);
    expect(matchesFilter(event(), { ...EMPTY_FILTER, text: 'ABC' })).toBe(true);
    expect(matchesFilter(event(), { ...EMPTY_FILTER, text: 'ok":true' })).toBe(true);
    expect(matchesFilter(event(), { ...EMPTY_FILTER, text: 'missing' })).toBe(false);
  });

  it('conditions AND together', () => {
    expect(matchesFilter(event(), { ...EMPTY_FILTER, method: 'GET', host: 'api.example.com', status: '2' })).toBe(true);
    expect(matchesFilter(event(), { ...EMPTY_FILTER, method: 'GET', status: '5' })).toBe(false);
  });
});
