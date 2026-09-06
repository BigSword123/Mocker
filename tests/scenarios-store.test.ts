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
  it('seeds builtin 默认 when no file', async () => {
    expect(store.list()).toEqual([{ name: '默认', enabled: true, builtin: true }]);
  });

  it('re-seeds 默认 when existing file lacks builtin', async () => {
    await fs.writeFile(path.join(dir, 'scenarios.json'), JSON.stringify([{ name: 'dev', enabled: true }]));
    const other = new ScenariosStore(dir);
    await other.load();
    expect(other.list().map((s) => s.name)).toEqual(['dev', '默认']);
    expect(other.list().find((s) => s.name === '默认')?.builtin).toBe(true);
  });

  it('keeps persisted order when 默认 exists', async () => {
    await store.add('dev');
    await store.reorder(['dev', '默认']);
    const other = new ScenariosStore(dir);
    await other.load();
    expect(other.list().map((s) => s.name)).toEqual(['dev', '默认']);
  });

  it('add persists and lists after builtin', async () => {
    await store.add('dev');
    await store.add('staging');
    expect(store.list().map((s) => s.name)).toEqual(['默认', 'dev', 'staging']);
  });

  it('add duplicate name throws', async () => {
    await store.add('dev');
    await expect(store.add('dev')).rejects.toThrow();
    await expect(store.add('默认')).rejects.toThrow();
  });

  it('rename updates name', async () => {
    await store.add('dev');
    await store.rename('dev', 'local');
    expect(store.list().map((s) => s.name)).toEqual(['默认', 'local']);
  });

  it('rename builtin throws', async () => {
    await expect(store.rename('默认', 'base')).rejects.toThrow('内置场景不可重命名');
  });

  it('rename to existing name throws', async () => {
    await store.add('dev');
    await expect(store.rename('dev', '默认')).rejects.toThrow();
  });

  it('setEnabled toggles builtin too', async () => {
    await store.setEnabled('默认', false);
    expect(store.list()[0]!.enabled).toBe(false);
  });

  it('remove clears non-builtin', async () => {
    await store.add('dev');
    await store.remove('dev');
    expect(store.list().map((s) => s.name)).toEqual(['默认']);
  });

  it('remove builtin throws', async () => {
    await expect(store.remove('默认')).rejects.toThrow('内置场景不可删除');
  });

  it('reorder reorders', async () => {
    await store.add('dev');
    await store.add('staging');
    await store.reorder(['staging', '默认', 'dev']);
    expect(store.list().map((s) => s.name)).toEqual(['staging', '默认', 'dev']);
  });

  it('reorder rejects partial / duplicated / unknown lists', async () => {
    await store.add('dev');
    await expect(store.reorder(['dev'])).rejects.toThrow();
    await expect(store.reorder(['默认', '默认'])).rejects.toThrow();
    await expect(store.reorder(['默认', 'dev', 'ghost'])).rejects.toThrow();
    expect(store.list().map((s) => s.name)).toEqual(['默认', 'dev']);
  });

  it('persists across instances', async () => {
    await store.add('dev');
    await store.setEnabled('dev', false);
    const other = new ScenariosStore(dir);
    await other.load();
    expect(other.list()).toEqual([
      { name: '默认', enabled: true, builtin: true },
      { name: 'dev', enabled: false },
    ]);
  });
});
