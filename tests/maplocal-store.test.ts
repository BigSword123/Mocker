import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MapLocalStore, mapLocalFileName } from '../src/main/storage/maplocal-store';

describe('mapLocalFileName', () => {
  it('builds host__path with ext from json content-type', () => {
    const name = mapLocalFileName('http://api.example.com/users/7?page=2', 'application/json; charset=utf-8');
    expect(name).toMatch(/^api\.example\.com_users_7__[0-9a-f]{8}\.json$/);
  });

  it('same url yields the same name (stable overwrite)', () => {
    const a = mapLocalFileName('http://x.test/p', 'application/json');
    const b = mapLocalFileName('http://x.test/p', 'application/json');
    expect(a).toBe(b);
  });

  it('different query produces a different file name', () => {
    const a = mapLocalFileName('http://x.test/p?a=1', 'application/json');
    const b = mapLocalFileName('http://x.test/p?a=2', 'application/json');
    expect(a).not.toBe(b);
  });

  it('unknown content-type falls back to .bin', () => {
    expect(mapLocalFileName('http://x.test/p', 'application/octet-stream')).toMatch(/\.bin$/);
  });

  it('missing content-type falls back to .bin', () => {
    expect(mapLocalFileName('http://x.test/p')).toMatch(/\.bin$/);
  });

  it('maps common content types to their extensions', () => {
    expect(mapLocalFileName('http://x.test/p', 'text/html')).toMatch(/\.html$/);
    expect(mapLocalFileName('http://x.test/p', 'image/png')).toMatch(/\.png$/);
    expect(mapLocalFileName('http://x.test/p', 'text/javascript')).toMatch(/\.js$/);
  });

  it('truncates long urls to a bounded file name', () => {
    const long = 'http://x.test/' + 'a'.repeat(300);
    const name = mapLocalFileName(long, 'text/html');
    expect(name.length).toBeLessThanOrEqual(100);
  });
});

describe('MapLocalStore', () => {
  async function tempStore() {
    const dir = await mkdtemp(path.join(tmpdir(), 'mocker-maplocal-'));
    return { dir, store: new MapLocalStore(dir) };
  }

  it('saves the response body and returns the absolute path', async () => {
    const { dir, store } = await tempStore();
    const target = await store.saveFromCapture({
      url: 'http://api.example.com/users/7',
      responseHeaders: { 'content-type': 'application/json' },
      responseBody: '{"id":7}',
    });
    expect(target.startsWith(dir)).toBe(true);
    expect(await readFile(target, 'utf8')).toBe('{"id":7}');
  });

  it('saves an empty file when the response body is missing', async () => {
    const { dir, store } = await tempStore();
    const target = await store.saveFromCapture({ url: 'http://x.test/empty' });
    expect(target.startsWith(dir)).toBe(true);
    expect(await readFile(target, 'utf8')).toBe('');
  });

  it('finds content-type case-insensitively and overwrites same-url files', async () => {
    const { dir, store } = await tempStore();
    const first = await store.saveFromCapture({
      url: 'http://x.test/a',
      responseHeaders: { 'Content-Type': 'text/plain' },
      responseBody: 'one',
    });
    const second = await store.saveFromCapture({
      url: 'http://x.test/a',
      responseHeaders: { 'content-type': 'text/plain' },
      responseBody: 'two',
    });
    expect(path.basename(first)).toMatch(/\.txt$/);
    expect(second).toBe(first);
    expect(await readFile(second, 'utf8')).toBe('two');
  });
});
