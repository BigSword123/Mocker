import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReplayService } from '../src/main/replay/replay';
import type { MockRule, TrafficEvent } from '../src/shared/types';

let server: Server;
let port: number;
let calls = 0;
const seen: { path?: string; body?: string; headers?: Record<string, unknown> } = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    calls += 1;
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.path = req.url;
      seen.body = body;
      seen.headers = req.headers;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"upstream":true}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

function service(rules: MockRule[] = []): { svc: ReplayService; events: TrafficEvent[] } {
  const events: TrafficEvent[] = [];
  return { svc: new ReplayService({ getRules: () => rules, onEvent: (e) => events.push(e) }), events };
}

describe('sendReplay passthrough', () => {
  it('sends method/headers/body upstream and records the response', async () => {
    const before = calls;
    const { svc, events } = service();
    const id = await svc.send({
      method: 'POST',
      url: `http://127.0.0.1:${port}/echo?x=1`,
      headers: {
        'content-type': 'application/json',
        'content-length': '7',
        host: 'elsewhere.example.com',
        connection: 'keep-alive',
      },
      body: '{"a":1}',
    });
    expect(calls).toBe(before + 1);
    expect(seen.path).toBe('/echo?x=1');
    expect(seen.body).toBe('{"a":1}');
    expect(seen.headers?.['content-type']).toBe('application/json');
    expect(seen.headers?.host).toBe(`127.0.0.1:${port}`);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.id).toBe(id);
    expect(e.id.startsWith('replay-')).toBe(true);
    expect(e.origin).toBe('replay');
    expect(e.status).toBe(200);
    expect(e.responseBody).toBe('{"upstream":true}');
    expect(e.completedAt).toBeDefined();
  });

  it('records connection failures in error', async () => {
    const { svc, events } = service();
    await svc.send({ method: 'GET', url: 'http://127.0.0.1:1/nope', headers: {}, body: '' });
    expect(events[0]!.error).toBeDefined();
    expect(events[0]!.completedAt).toBeDefined();
  });
});

describe('sendReplay with rules', () => {
  function mockRule(url: string): MockRule {
    return {
      id: 'r1',
      name: 'mock',
      enabled: true,
      priority: 0,
      match: { urlType: 'exact', urlPattern: url, method: 'ANY' },
      action: { status: 418, headers: { 'x-mock': 'yes' }, body: 'mocked-body' },
    };
  }

  it('returns the mock without touching the network', async () => {
    const before = calls;
    const { svc, events } = service([mockRule(`http://127.0.0.1:${port}/mocked`)]);

    const id = await svc.send({
      method: 'POST',
      url: `http://127.0.0.1:${port}/mocked`,
      headers: {},
      body: 'x',
    }, 'evt-origin');

    expect(calls).toBe(before);
    const e = events[0]!;
    expect(e.id).toBe(id);
    expect(e.mocked).toBe(true);
    expect(e.matchedRuleId).toBe('r1');
    expect(e.status).toBe(418);
    expect(e.responseHeaders?.['x-mock']).toBe('yes');
    expect(e.responseBody).toBe('mocked-body');
    expect(e.replayedFromId).toBe('evt-origin');
  });

  it('renders templates with the replay request context', async () => {
    const rule = mockRule(`http://127.0.0.1:${port}/tpl`);
    rule.action = { status: 200, headers: {}, body: 'q={{req.query.x}}' };
    const { svc, events } = service([rule]);
    await svc.send({ method: 'GET', url: `http://127.0.0.1:${port}/tpl?x=7`, headers: {}, body: '' });
    expect(events[0]!.responseBody).toBe('q=7');
  });

  it('fires probabilistic network error at 100%', async () => {
    const rule = mockRule(`http://127.0.0.1:${port}/err`);
    rule.action = {
      status: 200,
      headers: {},
      body: 'unused',
      networkError: { probability: 100, type: 'HTTP_STATUS', errorStatusCode: 504 },
    };
    const { svc, events } = service([rule]);
    await svc.send({ method: 'GET', url: `http://127.0.0.1:${port}/err`, headers: {}, body: '' });
    const e = events[0]!;
    expect(e.errorTriggered).toBe(true);
    expect(e.error).toBe('network-error:HTTP_STATUS');
    expect(e.status).toBe(504);
  });

  it('connection-level error leaves status undefined', async () => {
    const rule = mockRule(`http://127.0.0.1:${port}/reset`);
    rule.action = {
      status: 200,
      headers: {},
      body: 'unused',
      networkError: { probability: 100, type: 'ECONNRESET' },
    };
    const { svc, events } = service([rule]);
    await svc.send({ method: 'GET', url: `http://127.0.0.1:${port}/reset`, headers: {}, body: '' });
    const e = events[0]!;
    expect(e.errorTriggered).toBe(true);
    expect(e.error).toBe('network-error:ECONNRESET');
    expect(e.status).toBeUndefined();
  });
});
