import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { AddressInfo } from 'node:net';
import { fetch, ProxyAgent } from 'undici';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureCa } from '../src/main/certs/ca';
import { ProxyServer } from '../src/main/proxy/proxy-server';
import { DEFAULT_SETTINGS, type MockRule, Settings, TrafficEvent } from '../src/shared/types';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let proxy: ProxyServer;
let rules: MockRule[] = [];
let events: TrafficEvent[] = [];
let upstream: Server;
let upstreamPort: number;
let settings: Settings;
let caPem: string;
let tmpDir: string;

function rule(pattern: string, body: string): MockRule {
  return {
    id: body,
    name: body,
    enabled: true,
    priority: 1,
    match: { urlType: 'exact', urlPattern: pattern, method: 'ANY' },
    action: { status: 200, headers: { 'content-type': 'text/plain' }, body },
  };
}

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'mocker-proxy-'));
  const ca = await ensureCa(tmpDir);
  caPem = ca.certPem;

  upstream = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('upstream-ok');
  });
  upstream.listen(0);
  await once(upstream, 'listening');
  upstreamPort = (upstream.address() as AddressInfo).port;

  settings = { ...DEFAULT_SETTINGS, proxyPort: 0, httpsMode: 'whitelist', whitelist: ['mocked.test'] };
  proxy = new ProxyServer({
    caKey: (await ensureCa(tmpDir)).keyPem,
    caCert: caPem,
    getSettings: () => settings,
    getRules: () => rules,
    onEvent: (e) => events.push(e),
  });
  await proxy.start();
});

afterAll(async () => {
  await proxy.stop();
  upstream.close();
  await rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  rules = [];
  events = [];
});

describe('ProxyServer', () => {
  it('serves a mock response for a matched http request', async () => {
    rules = [rule('http://api.example.test/ping', 'mocked-body')];
    const agent = new ProxyAgent(`http://127.0.0.1:${proxy.port}`);
    const res = await fetch('http://api.example.test/ping', { dispatcher: agent });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('mocked-body');
    await waitFor(() => events.some((e) => e.mocked));
    const ev = events.find((e) => e.mocked)!;
    expect(ev.url).toContain('api.example.test');
    expect(ev.status).toBe(200);
  });

  it('passes unmatched http requests through to the upstream', async () => {
    const agent = new ProxyAgent(`http://127.0.0.1:${proxy.port}`);
    const res = await fetch(`http://127.0.0.1:${upstreamPort}/hello`, { dispatcher: agent });
    expect(await res.text()).toBe('upstream-ok');
    await waitFor(() => events.some((e) => e.status === 200 && !e.mocked));
  });

  it('mitm-decrypts whitelisted https hosts and mocks them', async () => {
    rules = [rule('https://mocked.test/secure', 'https-mocked')];
    const agent = new ProxyAgent({
      uri: `http://127.0.0.1:${proxy.port}`,
      requestTls: { ca: caPem },
    });
    const res = await fetch('https://mocked.test/secure', { dispatcher: agent });
    expect(await res.text()).toBe('https-mocked');
  });

  it('tunnels non-whitelisted https hosts without mitm', async () => {
    const agent = new ProxyAgent({
      uri: `http://127.0.0.1:${proxy.port}`,
      requestTls: { ca: caPem, rejectUnauthorized: false },
    });
    // outside.test 不存在：白名单外走盲隧道，直连失败
    await expect(fetch('https://outside.test/x', { dispatcher: agent })).rejects.toThrow();
    expect(events.every((e) => !e.mocked)).toBe(true);
  });

  it('serves the onboarding guide and ca cert on the proxy host', async () => {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Mocker 设备接入');
    const certRes = await fetch(`http://127.0.0.1:${proxy.port}/ca.pem`);
    expect(await certRes.text()).toContain('BEGIN CERTIFICATE');
  });

  it('captures request and response bodies in traffic events', async () => {
    rules = [rule('http://api.example.test/echo', 'echo-back')];
    const agent = new ProxyAgent(`http://127.0.0.1:${proxy.port}`);
    await fetch('http://api.example.test/echo', {
      dispatcher: agent,
      method: 'POST',
      body: 'req-payload',
    });
    await waitFor(() => events.some((e) => e.mocked && e.responseBody === 'echo-back'));
    const ev = events.find((e) => e.mocked)!;
    expect(ev.requestBody).toBe('req-payload');
    expect(ev.method).toBe('POST');
  });

  it('whitelist matches subdomains', async () => {
    rules = [rule('https://api.mocked.test/sub', 'sub-mocked')];
    const agent = new ProxyAgent({
      uri: `http://127.0.0.1:${proxy.port}`,
      requestTls: { ca: caPem },
    });
    const res = await fetch('https://api.mocked.test/sub', { dispatcher: agent });
    expect(await res.text()).toBe('sub-mocked');
  });

  // Keep last within this block: exercises a full stop/restart of the shared
  // proxy instance. The 'enhanced mock rule behavior' describe below runs after
  // and rides the restarted proxy.
  it('stop then restart works', async () => {
    await proxy.stop();
    expect(proxy.running).toBe(false);
    await proxy.start();
    expect(proxy.running).toBe(true);

    rules = [rule('http://api.example.test/ping', 'restarted-body')];
    const agent = new ProxyAgent(`http://127.0.0.1:${proxy.port}`);
    const res = await fetch('http://api.example.test/ping', { dispatcher: agent });
    expect(await res.text()).toBe('restarted-body');
  });
});

describe('enhanced mock rule behavior', () => {
  it('applies a fixed delay before responding', async () => {
    rules = [{
      id: 'delay', name: 'delay', enabled: true, priority: 1,
      match: { urlType: 'exact', urlPattern: 'http://api.example.test/slow', method: 'ANY' },
      action: { status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok', delayMs: 250 },
    }];
    const agent = new ProxyAgent(`http://127.0.0.1:${proxy.port}`);
    const start = Date.now();
    const res = await fetch('http://api.example.test/slow', { dispatcher: agent });
    const elapsed = Date.now() - start;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(elapsed).toBeGreaterThanOrEqual(200);
  });

  it('renders {{uuid}} and {{req.path}} in the response body', async () => {
    rules = [{
      id: 'tpl', name: 'tpl', enabled: true, priority: 1,
      match: { urlType: 'exact', urlPattern: 'http://api.example.test/hello', method: 'ANY' },
      action: { status: 200, headers: { 'content-type': 'text/plain' }, body: 'path={{req.path}} uuid={{uuid}}' },
    }];
    const agent = new ProxyAgent(`http://127.0.0.1:${proxy.port}`);
    const res = await fetch('http://api.example.test/hello', { dispatcher: agent });
    expect(await res.text()).toMatch(/^path=\/hello uuid=[0-9a-f-]+$/i);
  });

  it('resets the connection when a network error fires at 100%', async () => {
    rules = [{
      id: 'err', name: 'err', enabled: true, priority: 1,
      match: { urlType: 'exact', urlPattern: 'http://api.example.test/boom', method: 'ANY' },
      action: { status: 200, headers: {}, body: '', networkError: { probability: 100, type: 'ECONNRESET' } },
    }];
    const agent = new ProxyAgent(`http://127.0.0.1:${proxy.port}`);
    const err = await fetch('http://api.example.test/boom', { dispatcher: agent }).then(
      () => null,
      (e) => e,
    );
    expect(err).not.toBeNull();
    expect((err as { cause?: { code?: string } })?.cause?.code).toBe('ECONNRESET');
    await waitFor(() => events.some((e) => e.errorTriggered));
    const ev = events.find((e) => e.errorTriggered)!;
    expect(ev.error).toBe('network-error:ECONNRESET');
  });

  it('returns the configured status for HTTP_STATUS network errors', async () => {
    rules = [{
      id: 'http-err', name: 'http-err', enabled: true, priority: 1,
      match: { urlType: 'exact', urlPattern: 'http://api.example.test/gateway', method: 'ANY' },
      action: { status: 200, headers: {}, body: '', networkError: { probability: 100, type: 'HTTP_STATUS', errorStatusCode: 504 } },
    }];
    const agent = new ProxyAgent(`http://127.0.0.1:${proxy.port}`);
    const res = await fetch('http://api.example.test/gateway', { dispatcher: agent });
    expect(res.status).toBe(504);
  });

  it('does not fire network errors at 0% probability', async () => {
    rules = [{
      id: 'never', name: 'never', enabled: true, priority: 1,
      match: { urlType: 'exact', urlPattern: 'http://api.example.test/safe', method: 'ANY' },
      action: { status: 200, headers: { 'content-type': 'text/plain' }, body: 'safe-ok', networkError: { probability: 0, type: 'ECONNRESET' } },
    }];
    const agent = new ProxyAgent(`http://127.0.0.1:${proxy.port}`);
    const res = await fetch('http://api.example.test/safe', { dispatcher: agent });
    expect(await res.text()).toBe('safe-ok');
  });
});

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}
