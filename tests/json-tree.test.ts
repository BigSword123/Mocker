import { describe, expect, test } from 'vitest';
import {
  AUTO_OPEN_MAX_DEPTH,
  AUTO_OPEN_MAX_ENTRIES,
  coerceValue,
  kindOf,
  removeIn,
  renameIn,
  setIn,
  shouldAutoOpen,
} from '../src/renderer/src/lib/json-tree';

describe('kindOf', () => {
  test('classifies JSON values', () => {
    expect(kindOf('x')).toBe('string');
    expect(kindOf(1.5)).toBe('number');
    expect(kindOf(true)).toBe('boolean');
    expect(kindOf(null)).toBe('null');
    expect(kindOf({})).toBe('object');
    expect(kindOf([])).toBe('array');
  });
});

describe('coerceValue', () => {
  test('returns empty defaults per kind', () => {
    expect(coerceValue('string')).toBe('');
    expect(coerceValue('number')).toBe(0);
    expect(coerceValue('boolean')).toBe(false);
    expect(coerceValue('null')).toBeNull();
    expect(coerceValue('object')).toEqual({});
    expect(coerceValue('array')).toEqual([]);
  });
});

describe('setIn', () => {
  test('sets nested value without mutating root', () => {
    const root = { a: { b: 1 } };
    const next = setIn(root, ['a', 'b'], 2);
    expect(next).toEqual({ a: { b: 2 } });
    expect(root).toEqual({ a: { b: 1 } });
  });

  test('sets array item by index', () => {
    expect(setIn([1, 2, 3], [1], 9)).toEqual([1, 9, 3]);
  });

  test('adds missing object key', () => {
    expect(setIn({ a: 1 }, ['b'], 'x')).toEqual({ a: 1, b: 'x' });
  });
});

describe('removeIn', () => {
  test('removes object key without mutating root', () => {
    const root = { a: 1, b: 2 };
    const next = removeIn(root, ['a']);
    expect(next).toEqual({ b: 2 });
    expect(root).toEqual({ a: 1, b: 2 });
  });

  test('removes array item by index', () => {
    expect(removeIn([1, 2, 3], [1])).toEqual([1, 3]);
  });

  test('removes nested array element', () => {
    expect(removeIn({ list: [{ x: 1 }, { x: 2 }] }, ['list', 0])).toEqual({
      list: [{ x: 2 }],
    });
  });
});

describe('renameIn', () => {
  test('renames key preserving position and other keys', () => {
    const root = { a: 1, b: 2, c: 3 };
    const next = renameIn(root, [], 'b', 'x');
    expect(Object.keys(next as object)).toEqual(['a', 'x', 'c']);
    expect(next).toEqual({ a: 1, x: 2, c: 3 });
    expect(root).toEqual({ a: 1, b: 2, c: 3 });
  });

  test('renames key inside nested container', () => {
    expect(renameIn({ list: [{ old: 1 }] }, ['list', 0], 'old', 'new')).toEqual({
      list: [{ new: 1 }],
    });
  });

  test('ignores empty or identical next key', () => {
    expect(renameIn({ a: 1 }, [], 'a', '')).toEqual({ a: 1 });
    expect(renameIn({ a: 1 }, [], 'a', 'a')).toEqual({ a: 1 });
  });
});

// depth 用 JsonTree 自己的编号：根节点是 1，它的子节点是 2，依此类推。
describe('shouldAutoOpen', () => {
  test('opens a shallow, narrow container', () => {
    expect(shouldAutoOpen(1, 5)).toBe(true);
  });

  test('depth limit is inclusive', () => {
    expect(AUTO_OPEN_MAX_DEPTH).toBe(2);
    expect(shouldAutoOpen(AUTO_OPEN_MAX_DEPTH, 1)).toBe(true);
    expect(shouldAutoOpen(AUTO_OPEN_MAX_DEPTH + 1, 1)).toBe(false);
  });

  test('entry-count limit is inclusive', () => {
    expect(AUTO_OPEN_MAX_ENTRIES).toBe(50);
    expect(shouldAutoOpen(1, AUTO_OPEN_MAX_ENTRIES)).toBe(true);
    expect(shouldAutoOpen(1, AUTO_OPEN_MAX_ENTRIES + 1)).toBe(false);
  });

  test('either limit on its own collapses the node', () => {
    expect(shouldAutoOpen(1, 500)).toBe(false);
    expect(shouldAutoOpen(9, 2)).toBe(false);
  });

  test('an empty container still counts as shallow and narrow', () => {
    expect(shouldAutoOpen(1, 0)).toBe(true);
  });
});
