import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { mimeForPath, resolveMapLocal, sendMapRemote } from '../src/main/rules/redirect';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mocker-redirect-'));
  writeFileSync(path.join(dir, 'hello.html'), '<h1>hi</h1>');
  writeFileSync(path.join(dir, 'data.json'), '{"x":1}');
  writeFileSync(path.join(dir, 'plain.txt'), 'hi');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('mimeForPath', () => {
  it.each([
    ['/tmp/a.html', 'text/html; charset=utf-8'],
    ['/tmp/a.htm', 'text/html; charset=utf-8'],
    ['/tmp/a.json', 'application/json; charset=utf-8'],
    ['/tmp/a.js', 'application/javascript; charset=utf-8'],
    ['/tmp/a.css', 'text/css; charset=utf-8'],
    ['/tmp/a.txt', 'text/plain; charset=utf-8'],
    ['/tmp/a.svg', 'image/svg+xml'],
    ['/tmp/a.png', 'image/png'],
    ['/tmp/a.pdf', 'application/pdf'],
    ['/tmp/a.weird', 'application/octet-stream'],
  ])('%s → %s', (input, expected) => {
    expect(mimeForPath(input)).toBe(expected);
  });
});

describe('resolveMapLocal', () => {
  it('reads existing file with mime', async () => {
    const r = await resolveMapLocal(path.join(dir, 'hello.html'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.content.toString('utf8')).toBe('<h1>hi</h1>');
      expect(r.mime).toBe('text/html; charset=utf-8');
    }
  });

  it('returns not-ok for missing file', async () => {
    const r = await resolveMapLocal(path.join(dir, 'nope.html'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/ENOENT|nope\.html/);
  });
});

describe('sendMapRemote', () => {
  let server: Server;
  let port: number;
  const seen: { path?: string; body?: string; headers?: Record<string, string | string[] | undefined> } = {};

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.path = req.url;
        seen.body = body;
        seen.headers = req.headers;
        res.writeHead(200, { 'content-type': 'application/json', 'x-up': 'yes' });
        res.end('{"remote":true}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('rewrites host, preserves path/query/body, drops hop-by-hop', async () => {
    const r = await sendMapRemote(
      `127.0.0.1:${port}`,
      {
        method: 'POST',
        url: 'http://original.example.com/api/v1?q=2',
        query: new URLSearchParams('q=2'),
        headers: {
          'content-type': 'application/json',
          'content-length': '7',
          host: 'original.example.com',
          connection: 'keep-alive',
        },
        body: '{"a":1}',
      },
    );
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(200);
    expect(r.headers?.['x-up']).toBe('yes');
    expect(r.body).toBe('{"remote":true}');
    expect(seen.path).toBe('/api/v1?q=2');
    expect(seen.body).toBe('{"a":1}');
    expect(seen.headers?.host).toBe(`127.0.0.1:${port}`);
    expect(seen.headers?.['content-length']).toBe('7');
    expect(seen.headers?.connection).toBeUndefined();
  });

  it('records connection error', async () => {
    const r = await sendMapRemote('127.0.0.1:1', {
      method: 'GET',
      url: 'http://x.example.com/',
      query: new URLSearchParams(),
      headers: {},
      body: '',
    });
    expect(r.status).toBeUndefined();
    expect(r.error).toBeDefined();
  });
});
