import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsStore } from '../src/main/storage/settings-store';
import { DEFAULT_SETTINGS } from '../src/shared/types';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mocker-settings-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SettingsStore', () => {
  it('a throwing listener does not reject set', async () => {
    const store = new SettingsStore(dir);
    await store.load();
    store.onChange(() => {
      throw new Error('listener boom');
    });
    await expect(store.set({ proxyPort: 9000 })).resolves.toMatchObject({ proxyPort: 9000 });
    expect(store.get().proxyPort).toBe(9000);
  });

  it('get returns isolated whitelist copy', async () => {
    const store = new SettingsStore(dir);
    await store.load();
    store.get().whitelist.push('x');
    expect(store.get().whitelist).toEqual([]);
  });

  it('set persists patch over defaults', async () => {
    const store = new SettingsStore(dir);
    await store.load();
    await store.set({ proxyPort: 9999 });
    const store2 = new SettingsStore(dir);
    await store2.load();
    expect(store2.get().proxyPort).toBe(9999);
    expect(store2.get().wsPort).toBe(DEFAULT_SETTINGS.wsPort);
  });

  it('fills missing throttle field with defaults for legacy settings.json', async () => {
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ proxyPort: 9999 }), 'utf8');
    const store = new SettingsStore(dir);
    await store.load();
    const s = store.get();
    expect(s.proxyPort).toBe(9999);
    expect(s.throttle).toEqual(DEFAULT_SETTINGS.throttle);
  });
});
