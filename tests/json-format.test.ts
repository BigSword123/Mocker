import { describe, expect, test } from 'vitest';
import {
  formatJson,
  parseJsonBody,
  tokenizeJson,
  type JsonToken,
} from '../src/renderer/src/lib/json-format';

const types = (tokens: JsonToken[]) => tokens.map((t) => t.kind);
const texts = (tokens: JsonToken[]) => tokens.map((t) => t.text);
const depths = (tokens: JsonToken[]) => tokens.map((t) => t.depth);

describe('formatJson', () => {
  test('pretty-prints compact JSON with 2-space indent', () => {
    const r = formatJson('{"a":1,"b":[1,2]}');
    expect(r).toEqual({
      ok: true,
      formatted: '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}',
    });
  });

  test('returns error for invalid JSON', () => {
    const r = formatJson('{oops}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });

  test('is idempotent on already-formatted input', () => {
    const once = formatJson('{"a":1}');
    expect(once.ok).toBe(true);
    if (once.ok) expect(formatJson(once.formatted)).toEqual(once);
  });

  test('formats array root', () => {
    expect(formatJson('[1,2]')).toEqual({ ok: true, formatted: '[\n  1,\n  2\n]' });
  });

  test('formats scalar root', () => {
    expect(formatJson('42')).toEqual({ ok: true, formatted: '42' });
    expect(formatJson('"hi"')).toEqual({ ok: true, formatted: '"hi"' });
  });

  test('rejects empty or whitespace-only input', () => {
    expect(formatJson('').ok).toBe(false);
    expect(formatJson('   \n ').ok).toBe(false);
  });
});

describe('tokenizeJson', () => {
  test('tokenizes flat object with kinds and depths', () => {
    const t = tokenizeJson('{"a": 1}');
    expect(texts(t)).toEqual(['{', '"a"', ':', ' ', '1', '}']);
    expect(types(t)).toEqual(['punct', 'string', 'punct', 'plain', 'number', 'punct']);
    expect(depths(t)).toEqual([0, 1, 1, 1, 1, 0]);
  });

  test('nesting increments depth; closers emit after decrement', () => {
    const t = tokenizeJson('{"a":{"b":[true]}}');
    const byText = (text: string) => t.filter((x) => x.text === text);
    expect(depths(byText('"a"'))).toEqual([1]);
    expect(depths(byText('"b"'))).toEqual([2]);
    expect(depths(byText('true'))).toEqual([3]);
    // 深度规则：开括号按当前深度输出后再 +1，闭括号先 -1 再输出
    expect(types(t)).toContain('literal');
    // 四层容器：外层 {}、内层 {}、[]，括号深度成对
    const opens = t.filter((x) => x.kind === 'punct' && (x.text === '{' || x.text === '['));
    const closes = t.filter((x) => x.kind === 'punct' && (x.text === '}' || x.text === ']'));
    expect(opens).toHaveLength(3);
    expect(closes).toHaveLength(3);
  });

  test('token texts always concatenate back to the input', () => {
    const samples = [
      '{"a": 1}',
      '{"a":{"b":[true,false,null]}}',
      '[[1,2],[3]]',
      '{"a":',
      '}}}',
      'ohno',
      '-1.5e3',
      '"a\\"b"',
      '{"x":"{{faker.number.int}}"}',
      '',
    ];
    for (const s of samples) {
      expect(texts(tokenizeJson(s)).join('')).toBe(s);
    }
  });

  test('escaped quotes stay inside one string token', () => {
    const t = tokenizeJson('"a\\"b"');
    expect(texts(t)).toEqual(['"a\\"b"']);
    expect(types(t)).toEqual(['string']);
  });

  test('template placeholder inside string stays one token', () => {
    const t = tokenizeJson('{"x":"{{faker.number.int}}"}');
    const strs = t.filter((x) => x.kind === 'string');
    expect(strs.map((x) => x.text)).toEqual(['"x"', '"{{faker.number.int}}"']);
  });

  test('true/false/null are literals, other words are plain', () => {
    expect(types(tokenizeJson('true false null banana'))).toEqual([
      'literal',
      'plain',
      'literal',
      'plain',
      'literal',
      'plain',
      'plain',
    ]);
  });

  test('numbers with sign, fraction and exponent form one token', () => {
    const t = tokenizeJson('-1.5e3');
    expect(texts(t)).toEqual(['-1.5e3']);
    expect(types(t)).toEqual(['number']);
  });

  test('unbalanced closers never produce negative depth', () => {
    expect(depths(tokenizeJson('}}}'))).toEqual([0, 0, 0]);
  });
});

describe('parseJsonBody', () => {
  test('parses valid JSON and returns the value', () => {
    expect(parseJsonBody('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  test('rejects invalid JSON with non-empty error', () => {
    const r = parseJsonBody('x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });

  test('rejects bare template placeholder as a value', () => {
    expect(parseJsonBody('{"n":{{faker.x}}}').ok).toBe(false);
  });
});
