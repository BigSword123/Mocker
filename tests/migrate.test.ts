import { describe, expect, it } from 'vitest';
import { migrateRule, migrateRules } from '../src/main/storage/migrate';
import type { HeaderRow, MockRule } from '../src/shared/types';

/** A rule as persisted by the pre-table release: record headers + string bodyContains. */
function legacyRule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'legacy-1',
    name: 'legacy',
    enabled: true,
    priority: 3,
    match: {
      urlType: 'exact',
      urlPattern: 'http://x.com/legacy',
      method: 'ANY',
      headers: { 'X-A': 'a', 'X-B': 'b' },
      bodyContains: 'hello',
    },
    action: { status: 200, headers: { 'Content-Type': 'application/json' }, body: 'ok' },
    ...overrides,
  };
}

/** A rule already stored in the current HeaderRow[] / RuleBody representation. */
function modernRule(overrides: Record<string, unknown> = {}): MockRule {
  return {
    id: 'modern-1',
    name: 'modern',
    enabled: true,
    priority: 1,
    match: {
      urlType: 'wildcard',
      urlPattern: 'http://x.com/*',
      method: 'POST',
      headers: [{ enabled: true, name: 'X-A', value: 'a', description: 'note' }],
      body: { mode: 'raw', raw: '{"a":1}', matchStrategy: 'json-deep' },
    },
    action: { status: 201, headers: {}, body: 'created' },
    ...overrides,
  } as MockRule;
}

describe('migrateRule headers', () => {
  it('converts a record of headers into enabled HeaderRow entries in input order', () => {
    const out = migrateRule(legacyRule())!;
    expect(out.match.headers).toEqual([
      { enabled: true, name: 'X-A', value: 'a', description: '' },
      { enabled: true, name: 'X-B', value: 'b', description: '' },
    ]);
  });

  it('stringifies non-string and nullish record header values', () => {
    const raw = legacyRule();
    (raw.match as Record<string, unknown>).headers = { 'X-Num': 7, 'X-Nil': null, 'X-Undef': undefined };
    const rows = migrateRule(raw)!.match.headers as HeaderRow[];
    expect(rows).toEqual([
      { enabled: true, name: 'X-Num', value: '7', description: '' },
      { enabled: true, name: 'X-Nil', value: '', description: '' },
      { enabled: true, name: 'X-Undef', value: '', description: '' },
    ]);
  });

  it('keeps an existing HeaderRow array as rows without changing its meaning', () => {
    const out = migrateRule(modernRule())!;
    expect(out.match.headers).toEqual([{ enabled: true, name: 'X-A', value: 'a', description: 'note' }]);
  });

  it('does not mutate the input and leaks no references into the output', () => {
    const raw = legacyRule();
    const before = JSON.stringify(raw);
    const out = migrateRule(raw)!;

    expect(JSON.stringify(raw)).toBe(before);
    expect(out.match).not.toBe(raw.match);
    expect(out.match.headers).not.toBe((raw.match as Record<string, unknown>).headers);

    (out.match.headers as HeaderRow[])[0].value = 'mutated';
    out.action.headers['Content-Type'] = 'mutated';
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('does not leak references out of an already-modern rule', () => {
    const raw = modernRule();
    const out = migrateRule(raw)!;
    expect(out.match.headers).not.toBe(raw.match.headers);
    expect((out.match.headers as HeaderRow[])[0]).not.toBe((raw.match.headers as HeaderRow[])[0]);
    expect(out.match.body).not.toBe(raw.match.body);
  });
});

describe('migrateRule body', () => {
  it('turns a legacy bodyContains into a raw/contains body and drops the legacy field', () => {
    const out = migrateRule(legacyRule())!;
    expect(out.match.body).toEqual({ mode: 'raw', raw: 'hello', matchStrategy: 'contains' });
    expect('bodyContains' in out.match).toBe(false);
    expect(out.match.bodyContains).toBeUndefined();
  });

  it('lets an existing modern body win and removes the stale bodyContains', () => {
    const raw = legacyRule();
    (raw.match as Record<string, unknown>).body = { mode: 'urlencoded', form: [{ enabled: true, name: 'f', value: '1' }] };
    const out = migrateRule(raw)!;
    expect(out.match.body).toEqual({ mode: 'urlencoded', form: [{ enabled: true, name: 'f', value: '1' }] });
    expect('bodyContains' in out.match).toBe(false);
  });

  it('drops a non-string bodyContains instead of inventing a body', () => {
    const raw = legacyRule();
    (raw.match as Record<string, unknown>).bodyContains = 42;
    const out = migrateRule(raw)!;
    expect('bodyContains' in out.match).toBe(false);
    expect(out.match.body).toBeUndefined();
  });

  it('is idempotent: migrating a migrated rule changes nothing further', () => {
    const once = migrateRule(legacyRule())!;
    const twice = migrateRule(once)!;
    expect(twice).toEqual(once);
    expect(migrateRules([once]).changed).toBe(false);
  });

  it('reports an already-modern rule as unchanged', () => {
    expect(migrateRules([modernRule()]).changed).toBe(false);
  });
});

describe('migrateRule tolerance', () => {
  it('accepts a rule without optional query, headers and body', () => {
    const raw = {
      id: 'min',
      name: 'minimal',
      enabled: false,
      priority: 0,
      match: { urlType: 'regex', urlPattern: '.*', method: 'GET' },
      action: { status: 404, headers: {}, body: '' },
    };
    const out = migrateRule(raw)!;
    expect(out).toEqual(raw);
    expect(migrateRules([raw]).changed).toBe(false);
  });

  it('keeps a query record as a cloned record', () => {
    const raw = legacyRule();
    (raw.match as Record<string, unknown>).query = { a: '1' };
    const out = migrateRule(raw)!;
    expect(out.match.query).toEqual({ a: '1' });
    expect(out.match.query).not.toBe((raw.match as Record<string, unknown>).query);
  });

  it('returns undefined for fundamentally invalid records', () => {
    expect(migrateRule(null)).toBeUndefined();
    expect(migrateRule(undefined)).toBeUndefined();
    expect(migrateRule('a rule')).toBeUndefined();
    expect(migrateRule(7)).toBeUndefined();
    expect(migrateRule([legacyRule()])).toBeUndefined();
    expect(migrateRule({ not: 'a rule' })).toBeUndefined();
    expect(migrateRule(legacyRule({ match: 'string' }))).toBeUndefined();
    expect(migrateRule(legacyRule({ match: [] }))).toBeUndefined();
    expect(migrateRule(legacyRule({ match: null }))).toBeUndefined();
    expect(migrateRule(legacyRule({ action: 'string' }))).toBeUndefined();
    expect(migrateRule(legacyRule({ action: [] }))).toBeUndefined();
    expect(migrateRule(legacyRule({ id: 1 }))).toBeUndefined();
    expect(migrateRule(legacyRule({ id: undefined }))).toBeUndefined();
    expect(migrateRule(legacyRule({ name: null }))).toBeUndefined();
  });

  it('normalises a missing enabled flag and priority so the store can sort and toggle', () => {
    const raw = legacyRule();
    delete raw.enabled;
    delete raw.priority;
    const out = migrateRule(raw)!;
    expect(out.enabled).toBe(false);
    expect(out.priority).toBe(0);
    expect(migrateRules([raw]).changed).toBe(true);
  });
});

describe('migrateRules', () => {
  it('keeps good input order and counts skipped invalid entries', () => {
    const first = legacyRule({ id: 'a', name: 'a' });
    const second = modernRule({ id: 'b', name: 'b' });
    const result = migrateRules([first, 'broken', second, null]);

    expect(result.rules.map((r) => r.id)).toEqual(['a', 'b']);
    expect(result.skipped).toBe(2);
    expect(result.changed).toBe(true);
    expect(result.rules[0].match.body).toEqual({ mode: 'raw', raw: 'hello', matchStrategy: 'contains' });
    expect(result.rules[1].match.headers).toEqual([
      { enabled: true, name: 'X-A', value: 'a', description: 'note' },
    ]);
  });

  it('never mutates the input array or its items', () => {
    const items = [legacyRule(), modernRule()];
    const before = JSON.stringify(items);
    migrateRules(items);
    expect(JSON.stringify(items)).toBe(before);
    expect(items).toHaveLength(2);
  });

  it('returns an empty unchanged result for an empty array', () => {
    expect(migrateRules([])).toEqual({ rules: [], skipped: 0, changed: false });
  });
});
