import { describe, expect, it } from 'vitest';
import { validateAction } from '../src/main/rules/validate';
import type { RuleAction } from '../src/shared/types';

const base: RuleAction = {
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: '{}',
};

describe('validateAction', () => {
  it('accepts a plain action', () => {
    expect(() => validateAction(base)).not.toThrow();
  });

  it('accepts delayMs within bounds', () => {
    expect(() => validateAction({ ...base, delayMs: 0 })).not.toThrow();
    expect(() => validateAction({ ...base, delayMs: 300_000 })).not.toThrow();
  });

  it('rejects delayMs over upper bound', () => {
    expect(() => validateAction({ ...base, delayMs: 300_001 })).toThrow(/delayMs/);
    expect(() => validateAction({ ...base, delayMs: -1 })).toThrow(/delayMs/);
  });

  it('rejects non-integer delayMs', () => {
    expect(() => validateAction({ ...base, delayMs: 1.5 })).toThrow(/delayMs/);
  });

  it('accepts a valid networkError', () => {
    expect(() =>
      validateAction({ ...base, networkError: { probability: 50, type: 'ECONNRESET' } }),
    ).not.toThrow();
  });

  it('rejects probability out of range', () => {
    expect(() =>
      validateAction({ ...base, networkError: { probability: -1, type: 'ECONNRESET' } }),
    ).toThrow(/probability/);
    expect(() =>
      validateAction({ ...base, networkError: { probability: 101, type: 'ECONNRESET' } }),
    ).toThrow(/probability/);
  });

  it('rejects HTTP_STATUS without errorStatusCode', () => {
    expect(() =>
      validateAction({ ...base, networkError: { probability: 50, type: 'HTTP_STATUS' } }),
    ).toThrow(/errorStatusCode/);
  });

  it('rejects invalid errorStatusCode', () => {
    expect(() =>
      validateAction({
        ...base,
        networkError: { probability: 50, type: 'HTTP_STATUS', errorStatusCode: 99 },
      }),
    ).toThrow(/errorStatusCode/);
  });

  it('accepts HTTP_STATUS with valid errorStatusCode', () => {
    expect(() =>
      validateAction({
        ...base,
        networkError: { probability: 100, type: 'HTTP_STATUS', errorStatusCode: 504 },
      }),
    ).not.toThrow();
  });

  it('rejects NaN probability', () => {
    expect(() =>
      validateAction({ ...base, networkError: { probability: Number.NaN, type: 'ECONNRESET' } }),
    ).toThrow(/probability/);
  });

  it('rejects unknown networkError.type', () => {
    expect(() =>
      validateAction({
        ...base,
        networkError: { probability: 50, type: 'BOGUS' as never },
      }),
    ).toThrow(/networkError\.type/);
  });

  it('rejects NaN delayMs', () => {
    expect(() => validateAction({ ...base, delayMs: Number.NaN })).toThrow(/delayMs/);
  });
});
