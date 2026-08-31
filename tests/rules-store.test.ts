import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RulesStore } from '../src/main/storage/rules-store';
import type { RuleInput } from '../src/shared/types';

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
});
