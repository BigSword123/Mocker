import { describe, expect, it } from 'vitest';
import { captureToRuleInput } from '../src/renderer/src/lib/capture-to-rule';
import type { TrafficEvent } from '../src/shared/types';

function event(overrides: Partial<TrafficEvent> = {}): TrafficEvent {
  return {
    id: 'evt-1',
    startedAt: 0,
    method: 'GET',
    url: 'http://api.example.com/users/7?page=2',
    host: 'api.example.com',
    path: '/users/7',
    status: 200,
    requestHeaders: { 'x-token': 'abc' },
    responseBody: '{"id":7}',
    responseHeaders: { 'content-type': 'application/json' },
    mocked: false,
    ...overrides,
  };
}

describe('captureToRuleInput', () => {
  it('maps a full event to a prefilled rule input', () => {
    expect(captureToRuleInput(event())).toEqual({
      name: 'GET /users/7',
      enabled: true,
      match: {
        urlType: 'exact',
        urlPattern: 'http://api.example.com/users/7?page=2',
        method: 'GET',
      },
      action: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"id":7}',
      },
    });
  });

  it('keeps the full url including query for exact match', () => {
    const input = captureToRuleInput(event({ url: 'http://x.test/p?a=1&b=2', path: '/p' }));
    expect(input.match.urlPattern).toBe('http://x.test/p?a=1&b=2');
    expect(input.name).toBe('GET /p');
  });

  it('falls back to 200 and empty body for an errored request', () => {
    const input = captureToRuleInput(
      event({ status: undefined, responseBody: undefined, responseHeaders: undefined, error: 'ECONNRESET' }),
    );
    expect(input.action.status).toBe(200);
    expect(input.action.body).toBe('');
    expect(input.action.headers).toEqual({});
  });

  it('omits headers when response has no content-type', () => {
    const input = captureToRuleInput(event({ responseHeaders: { 'x-other': '1' } }));
    expect(input.action.headers).toEqual({});
  });

  it('finds content-type case-insensitively', () => {
    const input = captureToRuleInput(event({ responseHeaders: { 'Content-Type': 'text/plain' } }));
    expect(input.action.headers).toEqual({ 'content-type': 'text/plain' });
  });

  it('match.headers is undefined (no prefill on the match side)', () => {
    const out = captureToRuleInput(event());
    expect(out.match.headers).toBeUndefined();
  });

  it('maps a non-standard method to ANY', () => {
    expect(captureToRuleInput(event({ method: 'CONNECT' })).match.method).toBe('ANY');
  });

  it('uppercases a lowercase method', () => {
    expect(captureToRuleInput(event({ method: 'post' })).match.method).toBe('POST');
  });

  it('converts a mocked event without special handling', () => {
    const input = captureToRuleInput(event({ mocked: true, matchedRuleId: 'r1' }));
    expect(input.match.urlPattern).toBe('http://api.example.com/users/7?page=2');
    expect(input.enabled).toBe(true);
  });
});
