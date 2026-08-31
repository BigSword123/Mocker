import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonStore } from '../src/main/storage/json-store';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mocker-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('JsonStore', () => {
  it('returns defaults when file missing', async () => {
    const store = new JsonStore<{ a: number }>(join(dir, 'x.json'), { a: 1 });
    expect(await store.read()).toEqual({ a: 1 });
  });

  it('round-trips write then read', async () => {
    const store = new JsonStore<{ a: number }>(join(dir, 'x.json'), { a: 1 });
    await store.write({ a: 2 });
    expect(await store.read()).toEqual({ a: 2 });
  });

  it('creates parent directories', async () => {
    const store = new JsonStore<{ a: number }>(join(dir, 'deep/nested/x.json'), { a: 1 });
    await store.write({ a: 3 });
    expect(JSON.parse(await readFile(join(dir, 'deep/nested/x.json'), 'utf8'))).toEqual({ a: 3 });
  });

  it('quarantines corrupt file and returns defaults', async () => {
    const file = join(dir, 'x.json');
    await writeFile(file, '{not json');
    const store = new JsonStore<{ a: number }>(file, { a: 1 });
    expect(await store.read()).toEqual({ a: 1 });
    const original = await readFile(file, 'utf8').catch(() => null);
    expect(original).toBeNull();
  });

  it('stores and reads arrays', async () => {
    const store = new JsonStore<string[]>(join(dir, 'x.json'), []);
    await store.write(['a', 'b']);
    expect(await store.read()).toEqual(['a', 'b']);
  });

  it('serializes concurrent writes', async () => {
    const file = join(dir, 'x.json');
    const store = new JsonStore<{ n: number }>(file, { n: -1 });
    await Promise.all([0, 1, 2, 3, 4].map((n) => store.write({ n })));
    expect(await store.read()).toEqual({ n: 4 });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ n: 4 });
  });
});
