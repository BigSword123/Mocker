import { describe, expect, it } from 'vitest';
import { captureToRedirectDraft } from '../src/renderer/src/lib/capture-to-maplocal';
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

describe('captureToRedirectDraft', () => {
  it('maps a full event to a prefilled mapLocal redirect draft', () => {
    expect(captureToRedirectDraft(event(), '/data/maplocal/f.json')).toEqual({
      name: 'GET /users/7',
      enabled: true,
      match: {
        urlType: 'exact',
        urlPattern: 'http://api.example.com/users/7?page=2',
        method: 'GET',
      },
      action: 'mapLocal',
      target: '/data/maplocal/f.json',
    });
  });

  it('keeps the full url including query for exact match', () => {
    const draft = captureToRedirectDraft(event({ url: 'http://x.test/p?a=1&b=2', path: '/p' }), '/t/f');
    expect(draft.match.urlPattern).toBe('http://x.test/p?a=1&b=2');
    expect(draft.name).toBe('GET /p');
  });

  it('maps a non-standard method to ANY', () => {
    expect(captureToRedirectDraft(event({ method: 'CONNECT' }), '/t').match.method).toBe('ANY');
  });

  it('uppercases a lowercase method', () => {
    expect(captureToRedirectDraft(event({ method: 'post' }), '/t').match.method).toBe('POST');
  });

  it('match.headers is undefined (no prefill on the match side)', () => {
    expect(captureToRedirectDraft(event(), '/t').match.headers).toBeUndefined();
  });
});
