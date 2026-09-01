import type { NetworkError } from '../../shared/types';

/**
 * The action the proxy should take when a rule's network error fires.
 *
 * Only 'close' and 'reset' are reachable connection-level effects from the
 * proxy's single thenPassThrough({ beforeRequest }) master handler; mockttp's
 * callback result accepts `response: 'close' | 'reset'` for those. True idle
 * timeouts and byte-accurate mid-stream truncation would need per-rule
 * thenTimeout()/thenCallback() handlers, which the current single-handler
 * architecture does not register — so ETIMEDOUT degrades to 'close' and
 * TRUNCATE degrades to 'reset' (abrupt abort, the closest faithful signal).
 */
export type NetworkErrorResolution =
  | { kind: 'close' }
  | { kind: 'reset' }
  | { kind: 'respond'; statusCode: number };

export function resolveNetworkError(ne: NetworkError): NetworkErrorResolution {
  switch (ne.type) {
    case 'ECONNRESET':
    case 'TRUNCATE':
      return { kind: 'reset' };
    case 'ENOTFOUND':
    case 'ECONNREFUSED':
    case 'ETIMEDOUT':
      return { kind: 'close' };
    case 'HTTP_STATUS':
      return { kind: 'respond', statusCode: ne.errorStatusCode ?? 500 };
    default: {
      const exhaustive: never = ne.type;
      throw new Error(`未知 networkError.type: ${String(exhaustive)}`);
    }
  }
}
