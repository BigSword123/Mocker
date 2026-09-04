import { describe, expect, it } from 'vitest';
import { FAKER_CATALOG, findByPath } from '../src/shared/faker-catalog';

describe('FAKER_CATALOG', () => {
  it('has 13 categories', () => {
    expect(FAKER_CATALOG).toHaveLength(13);
  });

  it('has at least 40 entries total', () => {
    const total = FAKER_CATALOG.reduce((s, c) => s + c.entries.length, 0);
    expect(total).toBeGreaterThanOrEqual(40);
  });

  it('every entry has path starting with faker. and a non-empty snippet/example', () => {
    for (const c of FAKER_CATALOG) {
      for (const e of c.entries) {
        expect(e.path).toMatch(/^faker\.[a-z]+\.[a-zA-Z]+$/);
        expect(e.snippet).toMatch(/^\{\{faker\..*\}\}$/);
        expect(e.example.length).toBeGreaterThan(0);
        expect(e.label.length).toBeGreaterThan(0);
      }
    }
  });

  it('paths are unique', () => {
    const paths = FAKER_CATALOG.flatMap((c) => c.entries.map((e) => e.path));
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('findByPath works', () => {
    expect(findByPath('faker.person.firstName')?.label).toBeTruthy();
    expect(findByPath('faker.no.such')).toBeUndefined();
  });
});
