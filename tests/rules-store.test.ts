import { promises as nodeFs } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JsonStore } from '../src/main/storage/json-store';
import { RulesStore } from '../src/main/storage/rules-store';
import type { HeaderRow, MockRule, RuleInput } from '../src/shared/types';

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
  vi.restoreAllMocks();
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

  it('lists malformed in-memory rules without throwing', async () => {
    const store = new RulesStore(dir);
    await store.load();
    // Defence in depth: migration normalises these shapes, but cloning must not throw even if
    // unexpected data ever reaches the store.
    (store as unknown as { rules: unknown[] }).rules = [
      {
        id: 'x',
        name: 'x',
        enabled: true,
        priority: 1,
        match: {
          urlType: 'exact',
          urlPattern: 'http://x.com/x',
          method: 'ANY',
          query: 'garbage',
          headers: 'garbage',
          body: { mode: 'form-data', form: 'garbage' },
        },
        action: { status: 200, body: 'x' },
      },
    ];

    expect(() => store.list()).not.toThrow();
    expect(store.list()).toHaveLength(1);
  });
});

describe('RulesStore migration on load', () => {
  const rulesPath = () => join(dir, 'rules.json');
  const backupPath = () => join(dir, 'rules.json.v1-bak');

  const legacyPersisted = (id: string): Record<string, unknown> => ({
    id,
    name: id,
    enabled: true,
    priority: 1,
    match: {
      urlType: 'exact',
      urlPattern: `http://x.com/${id}`,
      method: 'ANY',
      headers: { 'X-Legacy': 'yes' },
      bodyContains: 'needle',
    },
    action: { status: 200, headers: {}, body: id },
  });

  const modernPersisted = (id: string): MockRule => ({
    id,
    name: id,
    enabled: true,
    priority: 2,
    match: {
      urlType: 'wildcard',
      urlPattern: `http://x.com/${id}/*`,
      method: 'POST',
      headers: [{ enabled: false, name: 'X-Modern', value: 'row' }],
      body: { mode: 'raw', raw: '{"a":1}', matchStrategy: 'json-deep' },
    },
    action: { status: 202, headers: {}, body: id },
  });

  async function seed(rules: unknown[], indent?: number): Promise<string> {
    const text = JSON.stringify(rules, null, indent);
    await writeFile(rulesPath(), text, 'utf8');
    return text;
  }

  it('converts legacy headers and bodyContains and backs up the original byte-for-byte', async () => {
    const original = await seed([legacyPersisted('a')]);

    const store = new RulesStore(dir);
    await store.load();

    const listed = store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].match.headers).toEqual([
      { enabled: true, name: 'X-Legacy', value: 'yes', description: '' },
    ]);
    expect(listed[0].match.body).toEqual({ mode: 'raw', raw: 'needle', matchStrategy: 'contains' });
    expect(listed[0].match.bodyContains).toBeUndefined();

    expect(await readFile(backupPath(), 'utf8')).toBe(original);

    const persisted = JSON.parse(await readFile(rulesPath(), 'utf8')) as MockRule[];
    expect(persisted).toHaveLength(1);
    expect(Array.isArray(persisted[0].match.headers)).toBe(true);
    expect((persisted[0].match.headers as HeaderRow[])[0].name).toBe('X-Legacy');
    expect(persisted[0].match.body).toEqual({ mode: 'raw', raw: 'needle', matchStrategy: 'contains' });
    expect('bodyContains' in persisted[0].match).toBe(false);
  });

  it('does not overwrite a pre-existing .v1-bak backup', async () => {
    await seed([legacyPersisted('a')]);
    await writeFile(backupPath(), 'earlier backup', 'utf8');

    const store = new RulesStore(dir);
    await store.load();

    expect(await readFile(backupPath(), 'utf8')).toBe('earlier backup');
    expect(store.list()[0].match.body).toEqual({ mode: 'raw', raw: 'needle', matchStrategy: 'contains' });
    const persisted = JSON.parse(await readFile(rulesPath(), 'utf8')) as MockRule[];
    expect(persisted[0].match.headers).toEqual([
      { enabled: true, name: 'X-Legacy', value: 'yes', description: '' },
    ]);
  });

  it('migrates legacy entries in a mixed file while keeping modern ones', async () => {
    await seed([legacyPersisted('legacy'), modernPersisted('modern')], 2);

    const store = new RulesStore(dir);
    await store.load();

    const persisted = JSON.parse(await readFile(rulesPath(), 'utf8')) as MockRule[];
    expect(persisted.map((r) => r.id)).toEqual(['legacy', 'modern']);
    expect(persisted[0].match.headers).toEqual([
      { enabled: true, name: 'X-Legacy', value: 'yes', description: '' },
    ]);
    expect(persisted[0].match.body).toEqual({ mode: 'raw', raw: 'needle', matchStrategy: 'contains' });
    expect(persisted[1].match.headers).toEqual([{ enabled: false, name: 'X-Modern', value: 'row' }]);
    expect(persisted[1].match.body).toEqual({ mode: 'raw', raw: '{"a":1}', matchStrategy: 'json-deep' });
    expect(await readFile(backupPath(), 'utf8')).toBeTruthy();
  });

  it('skips broken entries, keeps the good ones and persists the filtered array', async () => {
    const original = await seed(['broken', legacyPersisted('good'), { id: 5 }, modernPersisted('ok')]);

    const store = new RulesStore(dir);
    await store.load();

    expect(store.list().map((r) => r.id)).toEqual(['good', 'ok']);
    const persisted = JSON.parse(await readFile(rulesPath(), 'utf8')) as MockRule[];
    expect(persisted.map((r) => r.id)).toEqual(['good', 'ok']);
    expect(await readFile(backupPath(), 'utf8')).toBe(original);
  });

  it('is idempotent across loads: a second load rewrites nothing', async () => {
    await seed([legacyPersisted('a')], 2);

    await new RulesStore(dir).load();
    const migrated = await readFile(rulesPath(), 'utf8');
    const backup = await readFile(backupPath(), 'utf8');

    const second = new RulesStore(dir);
    await second.load();

    expect(await readFile(rulesPath(), 'utf8')).toBe(migrated);
    expect(await readFile(backupPath(), 'utf8')).toBe(backup);
    expect(second.list()[0].match.body).toEqual({ mode: 'raw', raw: 'needle', matchStrategy: 'contains' });
  });

  it('does not rewrite or back up a rules.json that needs no migration', async () => {
    const original = await seed([modernPersisted('modern')], 2);

    const store = new RulesStore(dir);
    await store.load();

    expect(store.list().map((r) => r.id)).toEqual(['modern']);
    expect(await readFile(rulesPath(), 'utf8')).toBe(original);
    expect(await readdir(dir)).toEqual(['rules.json']);
  });

  it('loads normally when rules.json does not exist and creates no backup', async () => {
    const store = new RulesStore(dir);
    await store.load();

    expect(store.list()).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
    await store.add(input('a'));
    expect(store.list().map((r) => r.name)).toEqual(['a']);
  });

  it('normalises malformed nested match data so listing a migrated rule cannot throw', async () => {
    await seed([
      {
        id: 'nested',
        name: 'nested',
        enabled: true,
        priority: 1,
        match: {
          urlType: 'exact',
          urlPattern: 'http://x.com/nested',
          method: 'ANY',
          headers: [{ enabled: true, name: 7, value: 'a' }, null],
          body: { mode: 'form-data', form: {} },
        },
        action: { status: 200, headers: {}, body: 'nested' },
      },
    ]);

    const store = new RulesStore(dir);
    await store.load();

    expect(() => store.list()).not.toThrow();
    const listed = store.list()[0];
    expect(listed.match.headers).toEqual([{ enabled: true, name: '7', value: 'a' }]);
    expect(listed.match.body).toEqual({ mode: 'form-data' });

    const persisted = JSON.parse(await readFile(rulesPath(), 'utf8')) as MockRule[];
    expect(persisted[0].match.headers).toEqual([{ enabled: true, name: '7', value: 'a' }]);
    expect(persisted[0].match.body).toEqual({ mode: 'form-data' });
  });

  it('warns about the rules it skipped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seed(['broken', legacyPersisted('good'), { id: 5 }]);

    const store = new RulesStore(dir);
    await store.load();

    expect(store.list().map((r) => r.id)).toEqual(['good']);
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('2');
    expect(logged.toLowerCase()).toContain('skip');
  });

  it('does not rewrite rules.json and warns when the backup cannot be written', async () => {
    const original = await seed([legacyPersisted('a')]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const copyFile = vi
      .spyOn(nodeFs, 'copyFile')
      .mockRejectedValue(Object.assign(new Error('copy refused'), { code: 'EACCES' }));

    const store = new RulesStore(dir);
    await expect(store.load()).resolves.toBeUndefined();

    expect(copyFile).toHaveBeenCalled();
    expect(await readFile(rulesPath(), 'utf8')).toBe(original);
    await expect(readFile(backupPath(), 'utf8')).rejects.toThrow();
    // The in-memory rules are still migrated so the app keeps working.
    expect(store.list()[0].match.body).toEqual({
      mode: 'raw',
      raw: 'needle',
      matchStrategy: 'contains',
    });
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged.toLowerCase()).toContain('backup');
    expect(logged).toContain('copy refused');
  });

  it('keeps the migrated rules and warns when the migration rewrite fails', async () => {
    const original = await seed([legacyPersisted('a')]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(JsonStore.prototype, 'write').mockRejectedValue(new Error('write refused'));

    const store = new RulesStore(dir);
    await expect(store.load()).resolves.toBeUndefined();

    expect(await readFile(rulesPath(), 'utf8')).toBe(original);
    expect(await readFile(backupPath(), 'utf8')).toBe(original);
    expect(store.list()[0].match.body).toEqual({
      mode: 'raw',
      raw: 'needle',
      matchStrategy: 'contains',
    });
    expect(warn.mock.calls.flat().join(' ')).toContain('write refused');
  });
});
