import { describe, expect, it } from 'vitest';
import { fromHar, toHar } from '../src/shared/har';
import type { TrafficEvent } from '../src/shared/types';

function event(overrides: Partial<TrafficEvent> = {}): TrafficEvent {
  return {
    id: 'evt-1',
    startedAt: 1_700_000_000_000,
    completedAt: 1_700_000_000_120,
    method: 'POST',
    url: 'http://api.example.com/orders?page=2',
    host: 'api.example.com',
    path: '/orders',
    status: 200,
    requestHeaders: { 'content-type': 'application/json' },
    requestBody: '{"a":1}',
    responseHeaders: { 'content-type': 'application/json' },
    responseBody: '{"ok":true}',
    mocked: true,
    matchedRuleId: 'r1',
    origin: 'capture',
    ...overrides,
  };
}

describe('toHar', () => {
  it('maps an event to HAR 1.2 with mock metadata', () => {
    const har = toHar([event()]);
    expect(har.log.version).toBe('1.2');
    expect(har.log.creator.name).toBe('Mocker');
    const entry = har.log.entries[0]!;
    expect(entry.startedDateTime).toBe(new Date(1_700_000_000_000).toISOString());
    expect(entry.time).toBe(120);
    expect(entry.request.method).toBe('POST');
    expect(entry.request.queryString).toEqual([{ name: 'page', value: '2' }]);
    expect(entry.request.postData?.text).toBe('{"a":1}');
    expect(entry.response.status).toBe(200);
    expect(entry.response.content.text).toBe('{"ok":true}');
    expect(entry._mocked).toBe(true);
    expect(entry._matchedRuleId).toBe('r1');
    expect(entry._origin).toBe('capture');
  });

  it('drops entries that never completed', () => {
    const har = toHar([event({ completedAt: undefined }), event({ id: 'done' })]);
    expect(har.log.entries).toHaveLength(1);
    expect(har.log.entries[0]!.request.url).not.toBe('');
  });
});

describe('fromHar', () => {
  it('round-trips through toHar with fresh ids and origin=imported', () => {
    const back = fromHar(JSON.stringify(toHar([event()])));
    expect(back).toHaveLength(1);
    const e = back[0]!;
    expect(e.id).not.toBe('evt-1');
    expect(e.method).toBe('POST');
    expect(e.url).toBe('http://api.example.com/orders?page=2');
    expect(e.host).toBe('api.example.com');
    expect(e.path).toBe('/orders?page=2');
    expect(e.status).toBe(200);
    expect(e.requestHeaders).toEqual({ 'content-type': 'application/json' });
    expect(e.requestBody).toBe('{"a":1}');
    expect(e.responseBody).toBe('{"ok":true}');
    expect(e.mocked).toBe(true);
    expect(e.matchedRuleId).toBe('r1');
    expect(e.origin).toBe('imported');
    expect(e.completedAt! - e.startedAt).toBe(120);
  });

  it('throws on non-JSON input', () => {
    expect(() => fromHar('nope')).toThrow();
  });

  it('throws when log.entries is missing', () => {
    expect(() => fromHar(JSON.stringify({ log: {} }))).toThrow();
  });

  it('tolerates minimal entries', () => {
    const events = fromHar(
      JSON.stringify({
        log: {
          version: '1.2',
          creator: { name: 'x' },
          entries: [
            {
              startedDateTime: '2026-01-01T00:00:00.000Z',
              time: 5,
              request: { method: 'GET', url: 'http://a.example.com/' },
              response: { status: 200 },
            },
          ],
        },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe(200);
    expect(events[0]!.requestBody).toBe('');
    expect(events[0]!.mocked).toBe(false);
    expect(events[0]!.origin).toBe('imported');
  });
});
