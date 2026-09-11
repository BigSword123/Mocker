import { describe, expect, test } from 'vitest';
import { flattenJson, PREVIEW_MAX_LENGTH } from '../src/renderer/src/lib/json-flatten';

describe('flattenJson', () => {
  test('scalar root yields a single $ row', () => {
    const r = flattenJson('hi');
    expect(r.truncated).toBe(false);
    expect(r.rows).toEqual([
      { path: '$', kind: 'string', preview: 'hi', value: 'hi', depth: 0 },
    ]);
  });

  test('walks objects pre-order, parent row before children', () => {
    const r = flattenJson({ a: 1, b: { c: 2 } });
    expect(r.rows.map((x) => x.path)).toEqual(['$', '$.a', '$.b', '$.b.c']);
    expect(r.rows.map((x) => x.depth)).toEqual([0, 1, 1, 2]);
    expect(r.rows.map((x) => x.kind)).toEqual(['object', 'number', 'object', 'number']);
  });

  test('container rows report their child count in the preview', () => {
    const r = flattenJson({ list: [1, 2, 3], obj: { k: 1 } });
    expect(r.rows.find((x) => x.path === '$.list')?.preview).toBe('[ ] 3 项');
    expect(r.rows.find((x) => x.path === '$.obj')?.preview).toBe('{ } 1 项');
  });

  test('array indices use bracket notation', () => {
    const r = flattenJson({ items: [10, { x: 1 }] });
    expect(r.rows.map((x) => x.path)).toEqual([
      '$',
      '$.items',
      '$.items[0]',
      '$.items[1]',
      '$.items[1].x',
    ]);
  });

  test('keys that are not plain identifiers fall back to quoted brackets', () => {
    const r = flattenJson({ 'weird.key': 1, '': 2, '0lead': 3, 'a b': 4, ok_1: 5 });
    expect(r.rows.map((x) => x.path)).toEqual([
      '$',
      '$["weird.key"]',
      '$[""]',
      '$["0lead"]',
      '$["a b"]',
      '$.ok_1',
    ]);
  });

  test('leaf previews render null and booleans literally', () => {
    const r = flattenJson({ n: null, t: true, f: false });
    expect(r.rows.map((x) => x.preview)).toEqual(['{ } 3 项', 'null', 'true', 'false']);
    expect(r.rows.map((x) => x.kind)).toEqual(['object', 'null', 'boolean', 'boolean']);
  });

  test('long string values keep the full value but cap the preview', () => {
    const long = 'x'.repeat(PREVIEW_MAX_LENGTH + 50);
    const r = flattenJson({ s: long });
    const row = r.rows.find((x) => x.path === '$.s')!;
    expect(row.preview).toBe(`${'x'.repeat(PREVIEW_MAX_LENGTH)}…`);
    expect(row.preview.length).toBe(PREVIEW_MAX_LENGTH + 1);
    expect(row.value).toBe(long);
  });

  test('empty containers still produce their own row', () => {
    const r = flattenJson({ a: {}, b: [] });
    expect(r.rows.map((x) => [x.path, x.preview])).toEqual([
      ['$', '{ } 2 项'],
      ['$.a', '{ } 0 项'],
      ['$.b', '[ ] 0 项'],
    ]);
  });

  test('maxRows stops the walk and reports truncation', () => {
    const r = flattenJson({ a: 1, b: 2, c: 3 }, { maxRows: 3 });
    expect(r.rows.map((x) => x.path)).toEqual(['$', '$.a', '$.b']);
    expect(r.truncated).toBe(true);
  });

  test('does not truncate when maxRows is not reached', () => {
    expect(flattenJson({ a: 1 }, { maxRows: 100 }).truncated).toBe(false);
  });

  test('deep nesting does not blow the stack', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 20_000; i += 1) deep = { d: deep };
    const r = flattenJson(deep);
    expect(r.rows.length).toBe(20_001);
    expect(r.rows[r.rows.length - 1].preview).toBe('leaf');
    expect(r.rows[r.rows.length - 1].depth).toBe(20_000);
  });
});
