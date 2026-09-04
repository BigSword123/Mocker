import { describe, expect, it } from 'vitest';
import {
  ERROR_TEMPLATES,
  findById,
  type ErrorTemplate,
  type ErrorTemplateCategory,
} from '../src/shared/error-templates';

const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const CONNECTION_TYPES = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'TRUNCATE'];

function byCategory(category: ErrorTemplateCategory): ErrorTemplate[] {
  return ERROR_TEMPLATES.filter((t) => t.category === category);
}

describe('ERROR_TEMPLATES', () => {
  it('has exactly 19 entries', () => {
    expect(ERROR_TEMPLATES).toHaveLength(19);
  });

  it('splits entries 9/5/5 across the three categories', () => {
    expect(byCategory('http-4xx')).toHaveLength(9);
    expect(byCategory('http-5xx')).toHaveLength(5);
    expect(byCategory('connection')).toHaveLength(5);
  });

  it('uses unique kebab-case ids', () => {
    const ids = ERROR_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id, `id ${id} should be kebab-case`).toMatch(KEBAB_CASE);
    }
  });

  it('gives every entry a non-empty label and description', () => {
    for (const t of ERROR_TEMPLATES) {
      expect(t.label.length, `${t.id} label`).toBeGreaterThan(0);
      expect(t.description.length, `${t.id} description`).toBeGreaterThan(0);
    }
  });

  it('keeps http statuses inside their category range', () => {
    for (const t of byCategory('http-4xx')) {
      expect(t.payload.kind).toBe('http');
      if (t.payload.kind !== 'http') throw new Error('unreachable');
      expect(t.payload.status, t.id).toBeGreaterThanOrEqual(400);
      expect(t.payload.status, t.id).toBeLessThan(500);
    }
    for (const t of byCategory('http-5xx')) {
      expect(t.payload.kind).toBe('http');
      if (t.payload.kind !== 'http') throw new Error('unreachable');
      expect(t.payload.status, t.id).toBeGreaterThanOrEqual(500);
      expect(t.payload.status, t.id).toBeLessThan(600);
    }
  });

  it('ships http bodies as JSON with an { error: { code, message } } shape', () => {
    const httpTemplates = [...byCategory('http-4xx'), ...byCategory('http-5xx')];
    expect(httpTemplates).toHaveLength(14);
    for (const t of httpTemplates) {
      if (t.payload.kind !== 'http') throw new Error(`${t.id} should be an http payload`);
      const parsed = JSON.parse(t.payload.body) as { error?: { code?: unknown; message?: unknown } };
      expect(parsed.error, t.id).toBeTruthy();
      expect(typeof parsed.error?.code, `${t.id} code`).toBe('string');
      expect(typeof parsed.error?.message, `${t.id} message`).toBe('string');
      expect((parsed.error?.code as string).length, `${t.id} code`).toBeGreaterThan(0);
      expect((parsed.error?.message as string).length, `${t.id} message`).toBeGreaterThan(0);
    }
  });

  it('restricts connection templates to the five supported types at probability 100', () => {
    for (const t of byCategory('connection')) {
      if (t.payload.kind !== 'connection') throw new Error(`${t.id} should be a connection payload`);
      expect(CONNECTION_TYPES, t.id).toContain(t.payload.networkError.type);
      expect(t.payload.networkError.probability, t.id).toBe(100);
    }
    const types = byCategory('connection').map((t) =>
      t.payload.kind === 'connection' ? t.payload.networkError.type : null,
    );
    expect(new Set(types).size).toBe(5);
  });

  it('sets retry-after headers on the throttling and unavailable presets', () => {
    const rateLimit = findById('http-429');
    expect(rateLimit?.payload.kind === 'http' && rateLimit.payload.headers).toEqual({
      'retry-after': '60',
    });
    const unavailable = findById('http-503');
    expect(unavailable?.payload.kind === 'http' && unavailable.payload.headers).toEqual({
      'retry-after': '30',
    });
  });
});

describe('findById', () => {
  it('finds the 404 preset by id', () => {
    const found = findById('http-404');
    expect(found?.label).toBe('404 Not Found');
    expect(found?.category).toBe('http-4xx');
    expect(found?.payload.kind === 'http' && found.payload.status).toBe(404);
  });

  it('finds a connection preset by id', () => {
    const found = findById('conn-econnreset');
    expect(found?.category).toBe('connection');
    expect(found?.payload.kind === 'connection' && found.payload.networkError.type).toBe(
      'ECONNRESET',
    );
  });

  it('returns undefined for an unknown id', () => {
    expect(findById('nope-does-not-exist')).toBeUndefined();
  });
});
