import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RedirectsStore } from '../src/main/storage/redirects-store';
import type { RedirectRule } from '../src/shared/types';

let dir: string;
let store: RedirectsStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mocker-redirects-'));
  store = new RedirectsStore(dir);
  await store.load();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function ruleInput(overrides: Partial<RedirectRule> = {}): Omit<RedirectRule, 'id' | 'priority'> {
  return {
    name: 'r',
    enabled: true,
    match: { urlType: 'exact', urlPattern: 'http://a.example.com/x', method: 'ANY' },
    action: 'mapLocal',
    target: '/tmp/foo.html',
    ...overrides,
  };
}

describe('RedirectsStore', () => {
  it('add + list + remove', async () => {
    const added = await store.add(ruleInput());
    expect(added.priority).toBeGreaterThan(0);
    expect(store.list()).toHaveLength(1);
    await store.remove(added.id);
    expect(store.list()).toHaveLength(0);
  });

  it('list is sorted by priority ascending', async () => {
    const a = await store.add(ruleInput({ name: 'a' }));
    await store.add(ruleInput({ name: 'b' }));
    await store.update(a.id, { priority: 10 });
    expect(store.list().map((r) => r.name)).toEqual(['b', 'a']);
  });

  it('update partial patch', async () => {
    const r = await store.add(ruleInput({ name: 'before' }));
    await store.update(r.id, { name: 'after' });
    expect(store.list()[0]!.name).toBe('after');
  });

  it('returns cloned rules on list', async () => {
    await store.add(ruleInput());
    const list = store.list();
    list[0]!.name = 'mutated';
    expect(store.list()[0]!.name).toBe('r');
  });

  it('persists across instances', async () => {
    await store.add(ruleInput({ name: 'persistent' }));
    const other = new RedirectsStore(dir);
    await other.load();
    expect(other.list()[0]!.name).toBe('persistent');
  });
});
