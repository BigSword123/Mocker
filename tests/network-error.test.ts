import { describe, expect, it } from 'vitest';
import { resolveNetworkError, type NetworkErrorResolution } from '../src/main/rules/network-error';
import type { NetworkError } from '../src/shared/types';

describe('resolveNetworkError', () => {
  it('maps ECONNRESET to reset', () => {
    expect(resolveNetworkError({ probability: 100, type: 'ECONNRESET' })).toEqual({
      kind: 'reset',
    });
  });

  it('maps ENOTFOUND and ECONNREFUSED to close', () => {
    expect(resolveNetworkError({ probability: 100, type: 'ENOTFOUND' })).toEqual({ kind: 'close' });
    expect(resolveNetworkError({ probability: 100, type: 'ECONNREFUSED' })).toEqual({ kind: 'close' });
  });

  it('maps ETIMEDOUT to close (best-effort, documented)', () => {
    expect(resolveNetworkError({ probability: 100, type: 'ETIMEDOUT' })).toEqual({ kind: 'close' });
  });

  it('maps TRUNCATE to reset (closest reachable simulation)', () => {
    expect(resolveNetworkError({ probability: 100, type: 'TRUNCATE' })).toEqual({ kind: 'reset' });
  });

  it('maps HTTP_STATUS to respond with errorStatusCode', () => {
    expect(
      resolveNetworkError({ probability: 100, type: 'HTTP_STATUS', errorStatusCode: 504 }),
    ).toEqual({ kind: 'respond', statusCode: 504 });
  });

  it('defaults HTTP_STATUS without errorStatusCode to 500', () => {
    expect(resolveNetworkError({ probability: 100, type: 'HTTP_STATUS' })).toEqual({
      kind: 'respond',
      statusCode: 500,
    });
  });

  it('throws on unknown type (defensive)', () => {
    expect(() =>
      resolveNetworkError({ probability: 100, type: 'BOGUS' as never }),
    ).toThrow(/networkError/);
  });

  it('ignores probability (decision is per-invocation; roll happens in the caller)', () => {
    expect(resolveNetworkError({ probability: 0, type: 'ECONNRESET' })).toEqual({ kind: 'reset' });
  });
});
