import { describe, expect, it } from 'vitest';
import { renderTemplate, type RenderContext } from '../src/main/rules/template';

const ctx: RenderContext = {
  method: 'POST',
  url: 'http://api.example.com/users?id=42',
  host: 'api.example.com',
  path: '/users',
  query: { id: '42' },
  headers: { 'x-token': 'abc', 'content-type': 'application/json' },
  body: '{"userId":7,"tags":["a","b"]}',
};

describe('renderTemplate — builtins', () => {
  it('replaces {{now:iso}} with ISO string', () => {
    const out = renderTemplate('{{now:iso}}', ctx);
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('replaces {{now:ms}} with numeric timestamp', () => {
    const out = renderTemplate('{{now:ms}}', ctx);
    expect(Number(out)).toBeGreaterThan(1_700_000_000_000);
  });

  it('replaces {{uuid}} with a UUID v4', () => {
    expect(renderTemplate('{{uuid}}', ctx)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('replaces {{random.int:min:max}} within bounds', () => {
    const out = Number(renderTemplate('{{random.int:1:10}}', ctx));
    expect(out).toBeGreaterThanOrEqual(1);
    expect(out).toBeLessThanOrEqual(10);
  });

  it('replaces {{random.choice:a:b:c}} with one of the options', () => {
    const out = renderTemplate('{{random.choice:OK:WARN:ERR}}', ctx);
    expect(['OK', 'WARN', 'ERR']).toContain(out);
  });

  it('replaces {{random.string:len}} with given length', () => {
    expect(renderTemplate('{{random.string:8}}', ctx)).toHaveLength(8);
  });
});

describe('renderTemplate — request context', () => {
  it('replaces req.* fields', () => {
    expect(renderTemplate('{{req.method}} {{req.host}}{{req.path}}', ctx)).toBe(
      'POST api.example.com/users',
    );
  });

  it('replaces req.query.* and req.header.*', () => {
    expect(renderTemplate('{{req.query.id}} / {{req.header.x-token}}', ctx)).toBe('42 / abc');
  });

  it('header lookup is case-insensitive', () => {
    expect(renderTemplate('{{req.header.Content-Type}}', ctx)).toBe('application/json');
  });

  it('replaces req.body.json.*', () => {
    expect(renderTemplate('{{req.body.json.userId}}', ctx)).toBe('7');
  });

  it('returns empty for non-JSON body path', () => {
    const c = { ...ctx, body: 'not-json' };
    expect(renderTemplate('{{req.body.json.userId}}', c)).toBe('');
  });
});

describe('renderTemplate — faker', () => {
  it('replaces {{faker.person.firstName}}', () => {
    const out = renderTemplate('{{faker.person.firstName}}', ctx, 'en');
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain('{{');
  });

  it('uses the requested locale', () => {
    const out = renderTemplate('{{faker.person.firstName}}', ctx, 'zh_CN');
    expect(out.length).toBeGreaterThan(0);
  });

  it('passes numeric args to faker.number.int', () => {
    const out = Number(renderTemplate('{{faker.number.int:1:5}}', ctx));
    expect(out).toBeGreaterThanOrEqual(1);
    expect(out).toBeLessThanOrEqual(5);
  });

  it('rejects faker.helpers.fake to prevent template recursion', () => {
    const out = renderTemplate('{{faker.helpers.fake:hi}}', ctx);
    expect(out).toBe('{{faker.helpers.fake:hi}}');
  });
});

describe('renderTemplate — edge cases', () => {
  it('preserves unknown tokens', () => {
    expect(renderTemplate('{{unknown.token}}', ctx)).toBe('{{unknown.token}}');
  });

  it('handles multiple tokens in one string', () => {
    const out = renderTemplate('id={{uuid}} host={{req.host}}', ctx);
    expect(out).toMatch(/^id=[0-9a-f-]+ host=api\.example\.com$/i);
  });

  it('collects warnings on failure', () => {
    const warnings: string[] = [];
    renderTemplate('{{unknown.token}}', ctx, undefined, warnings);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/unknown\.token/);
  });
});
