import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { AddressInfo } from 'node:net';
import { fetch, ProxyAgent } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureCa } from '../src/main/certs/ca';
import { ProxyServer } from '../src/main/proxy/proxy-server';
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/types';

let proxy: ProxyServer;
let fakeUpstream: Server; // 充当电脑上已有的那层代理
let upstreamHits = 0;
let directServer: Server; // noProxy 命中时直连的目标
let directHits = 0;
let settings: Settings;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'mocker-upstream-'));
  const ca = await ensureCa(tmpDir);

  const VIA_UPSTREAM = 'via-upstream';
  fakeUpstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    upstreamHits += 1;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(VIA_UPSTREAM);
  });
  // mockttp 经上游代理时会发 CONNECT；计数并回固定应答模拟隧道打通
  fakeUpstream.on('connect', (req: IncomingMessage, socket: Duplex) => {
    upstreamHits += 1;
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const body = Buffer.from(VIA_UPSTREAM);
    const respond = () => {
      socket.write(`HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: ${body.length}\r\n\r\n`);
      socket.write(body);
      socket.end();
    };
    if (socket.readableLength > 0) respond();
    else socket.once('readable', respond);
  });
  fakeUpstream.listen(0);
  await once(fakeUpstream, 'listening');
  const upstreamPort = (fakeUpstream.address() as AddressInfo).port;

  directServer = createServer((_req, res) => {
    directHits += 1;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('direct-ok');
  });
  directServer.listen(0);
  await once(directServer, 'listening');

  settings = {
    ...DEFAULT_SETTINGS,
    proxyPort: 0,
    upstreamProxyUrl: `http://127.0.0.1:${upstreamPort}`,
    upstreamNoProxy: '127.0.0.1',
  };
  proxy = new ProxyServer({
    caKey: ca.keyPem,
    caCert: ca.certPem,
    getSettings: () => settings,
    getRules: () => [],
    onEvent: () => {},
  });
  await proxy.start();
});

afterAll(async () => {
  await proxy.stop();
  fakeUpstream.close();
  directServer.close();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('upstream proxy', () => {
  it('forwards unmatched requests through the configured upstream proxy', async () => {
    const agent = new ProxyAgent(`http://127.0.0.1:${proxy.port}`);
    const res = await fetch('http://api.example.test/ping', { dispatcher: agent });
    expect(await res.text()).toBe('via-upstream');
    expect(upstreamHits).toBe(1);
  });

  it('sends noProxy-matched hosts direct, bypassing the upstream', async () => {
    const directPort = (directServer.address() as AddressInfo).port;
    const agent = new ProxyAgent(`http://127.0.0.1:${proxy.port}`);
    const res = await fetch(`http://127.0.0.1:${directPort}/x`, { dispatcher: agent });
    expect(await res.text()).toBe('direct-ok');
    expect(directHits).toBe(1);
    expect(upstreamHits).toBe(1); // 未新增，证明没走上游
  });
});
