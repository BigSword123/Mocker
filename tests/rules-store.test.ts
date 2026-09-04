import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RulesStore } from '../src/main/storage/rules-store';
import type { HeaderRow, RuleInput } from '../src/shared/types';

let dir: string;

const input = (name: string): RuleInput => ({
  name,
  enabled: true,
  match: { urlType: 'exact', urlPattern: `http://x.com/${name}`, method: 'ANY' },
  action: { status: 200, headers: {}, body: name },
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mocker-rules-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('RulesStore', () => {
  it('adds rules with generated id and increasing priority', async () => {
    const store = new RulesStore(dir);
    await store.load();
    const a = await store.add(input('a'));
    const b = await store.add(input('b'));
    expect(a.id).toBeTruthy();
    expect(b.priority).toBeGreaterThan(a.priority);
  });

  it('lists rules sorted by priority', async () => {
    const store = new RulesStore(dir);
    await store.load();
    await store.add(input('a'));
    await store.add(input('b'));
    const list = store.list();
    expect(list.map((r) => r.name)).toEqual(['a', 'b']);
  });

  it('updates and removes rules', async () => {
    const store = new RulesStore(dir);
    await store.load();
    const a = await store.add(input('a'));
    await store.update(a.id, { enabled: false });
    expect(store.list()[0].enabled).toBe(false);
    await store.remove(a.id);
    expect(store.list()).toHaveLength(0);
  });

  it('persists across instances', async () => {
    const store = new RulesStore(dir);
    await store.load();
    await store.add(input('a'));
    const store2 = new RulesStore(dir);
    await store2.load();
    expect(store2.list().map((r) => r.name)).toEqual(['a']);
  });

  it('writes a snapshot on every change', async () => {
    const store = new RulesStore(dir);
    await store.load();
    await store.add(input('a'));
    await store.add(input('b'));
    const snapshots = await readdir(join(dir, 'snapshots'));
    expect(snapshots.length).toBe(2);
  });

  it('notifies change listeners', async () => {
    const store = new RulesStore(dir);
    await store.load();
    let calls = 0;
    store.onChange(() => calls++);
    await store.add(input('a'));
    expect(calls).toBe(1);
  });

  it('prunes snapshots beyond the limit', async () => {
    const store = new RulesStore(dir);
    await store.load();
    const a = await store.add(input('a'));
    for (let i = 0; i < 54; i++) {
      await store.update(a.id, { name: `x${i}` });
    }
    const snapshots = await readdir(join(dir, 'snapshots'));
    expect(snapshots.length).toBeLessThanOrEqual(50);
  });

  it('a throwing listener does not break other listeners or persist', async () => {
    const store = new RulesStore(dir);
    await store.load();
    let bCalls = 0;
    store.onChange(() => {
      throw new Error('listener boom');
    });
    store.onChange(() => bCalls++);
    await expect(store.add(input('a'))).resolves.toBeTruthy();
    expect(bCalls).toBe(1);
  });

  it('update of unknown id rejects', async () => {
    const store = new RulesStore(dir);
    await store.load();
    await expect(store.update('nope', {})).rejects.toThrow('rule not found');
  });

  it('remove of unknown id is a no-op', async () => {
    const store = new RulesStore(dir);
    await store.load();
    await store.add(input('a'));
    await expect(store.remove('nope')).resolves.toBeUndefined();
    expect(store.list().map((r) => r.name)).toEqual(['a']);
  });

  it('priorities stay unique after removes', async () => {
    const store = new RulesStore(dir);
    await store.load();
    await store.add(input('a'));
    const b = await store.add(input('b'));
    await store.add(input('c'));
    await store.remove(b.id);
    await store.add(input('d'));
    const priorities = store.list().map((r) => r.priority);
    expect(new Set(priorities).size).toBe(priorities.length);
  });

  it('clones networkError so mutating a listed rule cannot affect the store', async () => {
    const store = new RulesStore(dir);
    await store.load();
    const withError: RuleInput = {
      name: 'net',
      enabled: true,
      match: { urlType: 'exact', urlPattern: 'http://x.com/net', method: 'ANY' },
      action: {
        status: 200,
        headers: {},
        body: 'net',
        networkError: { probability: 50, type: 'ECONNRESET' },
      },
    };
    await store.add(withError);
    const listed = store.list()[0];
    listed.action.networkError!.probability = 0;
    expect(store.list()[0].action.networkError!.probability).toBe(50);
  });

  it('clones HeaderRow arrays and body form rows so mutating a listed rule cannot affect the store', async () => {
    const store = new RulesStore(dir);
    await store.load();
    const withTables: RuleInput = {
      name: 'tables',
      enabled: true,
      match: {
        urlType: 'exact',
        urlPattern: 'http://x.com/tables',
        method: 'ANY',
        headers: [{ enabled: true, name: 'X', value: 'a' }],
        body: { mode: 'form-data', form: [{ enabled: true, name: 'f', value: '1' }] },
      },
      action: { status: 200, headers: {}, body: 'tables' },
    };
    await store.add(withTables);

    const listed = store.list()[0];
    expect(Array.isArray(listed.match.headers)).toBe(true);
    expect(listed.match.headers).toEqual([{ enabled: true, name: 'X', value: 'a' }]);
    expect(listed.match.body).toEqual({
      mode: 'form-data',
      form: [{ enabled: true, name: 'f', value: '1' }],
    });

    const listedHeaders = listed.match.headers as HeaderRow[];
    listedHeaders[0].value = 'mutated';
    listed.match.body!.mode = 'raw';
    listed.match.body!.form![0].value = 'mutated';

    const again = store.list()[0];
    expect(again.match.headers).toEqual([{ enabled: true, name: 'X', value: 'a' }]);
    expect(again.match.body).toEqual({
      mode: 'form-data',
      form: [{ enabled: true, name: 'f', value: '1' }],
    });
  });
});
