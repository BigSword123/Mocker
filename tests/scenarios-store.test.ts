import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ScenariosStore } from '../src/main/storage/scenarios-store';

let dir: string;
let store: ScenariosStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mocker-scenarios-'));
  store = new ScenariosStore(dir);
  await store.load();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('ScenariosStore', () => {
  it('starts empty when no file', async () => {
    expect(store.list()).toEqual([]);
  });

  it('add persists and lists', async () => {
    await store.add('dev');
    await store.add('staging');
    expect(store.list().map((s) => s.name).sort()).toEqual(['dev', 'staging']);
  });

  it('add duplicate name throws', async () => {
    await store.add('dev');
    await expect(store.add('dev')).rejects.toThrow();
  });

  it('rename updates name', async () => {
    await store.add('dev');
    await store.rename('dev', 'local');
    expect(store.list().map((s) => s.name)).toEqual(['local']);
  });

  it('rename to existing name throws', async () => {
    await store.add('dev');
    await store.add('local');
    await expect(store.rename('dev', 'local')).rejects.toThrow();
  });

  it('setEnabled toggles', async () => {
    await store.add('dev');
    await store.setEnabled('dev', false);
    expect(store.list()[0]!.enabled).toBe(false);
  });

  it('remove clears', async () => {
    await store.add('dev');
    await store.add('local');
    await store.remove('dev');
    expect(store.list().map((s) => s.name)).toEqual(['local']);
  });

  it('persists across instances', async () => {
    await store.add('dev');
    await store.setEnabled('dev', false);
    const other = new ScenariosStore(dir);
    await other.load();
    expect(other.list()).toEqual([{ name: 'dev', enabled: false }]);
  });
});
