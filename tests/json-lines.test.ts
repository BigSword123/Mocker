import { describe, expect, test } from 'vitest';
import { formatJson, tokenizeLines } from '../src/renderer/src/lib/json-format';

const textOf = (lines: ReturnType<typeof tokenizeLines>) =>
  lines.map((l) => l.map((t) => t.text).join('')).join('\n');

describe('tokenizeLines', () => {
  test('empty input is a single empty line', () => {
    const lines = tokenizeLines('');
    expect(lines).toEqual([[]]);
    expect(textOf(lines)).toBe('');
  });

  test('text without newlines stays on one line', () => {
    const lines = tokenizeLines('{"a":1}');
    expect(lines).toHaveLength(1);
    expect(textOf(lines)).toBe('{"a":1}');
  });

  test('formatted JSON splits into one entry per source line', () => {
    const formatted = formatJson('{"a":{"b":[1,2]}}');
    expect(formatted.ok).toBe(true);
    const text = (formatted as { formatted: string }).formatted;
    const lines = tokenizeLines(text);
    expect(lines).toHaveLength(text.split('\n').length);
    expect(textOf(lines)).toBe(text);
  });

  test('a trailing newline yields a final empty line', () => {
    const lines = tokenizeLines('a\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toEqual([]);
    expect(textOf(lines)).toBe('a\n');
  });

  test('round-trips arbitrary text that is not JSON', () => {
    const raw = 'line one\nline two\n\nline four';
    expect(textOf(tokenizeLines(raw))).toBe(raw);
  });

  test('a token spanning a newline is split across the two lines', () => {
    const lines = tokenizeLines('a\nb');
    expect(lines.map((l) => l.map((t) => t.text).join(''))).toEqual(['a', 'b']);
  });

  test('keeps kind and depth on every emitted token', () => {
    const lines = tokenizeLines('{\n  "a": 1\n}');
    const kinds = lines.flat().map((t) => t.kind);
    expect(kinds).toContain('punct');
    expect(kinds).toContain('string');
    expect(kinds).toContain('number');
    // 内层属性比外层括号深一级
    const key = lines[1].find((t) => t.kind === 'string')!;
    const open = lines[0].find((t) => t.text === '{')!;
    expect(key.depth).toBe(open.depth + 1);
  });

  test('does not drop whitespace-only lines inside formatted JSON', () => {
    const lines = tokenizeLines('{\n\n}');
    expect(lines).toHaveLength(3);
    expect(textOf(lines)).toBe('{\n\n}');
  });
});
