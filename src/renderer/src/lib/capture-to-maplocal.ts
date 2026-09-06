import type { HttpMethod, RedirectRule, TrafficEvent } from '../../../shared/types';

const KNOWN_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

export function captureToRedirectDraft(
  event: TrafficEvent,
  target: string,
): Omit<RedirectRule, 'id' | 'priority'> {
  const upper = event.method.toUpperCase();
  const method: HttpMethod = KNOWN_METHODS.includes(upper as HttpMethod) ? (upper as HttpMethod) : 'ANY';

  return {
    name: `${event.method} ${event.path}`,
    enabled: true,
    match: { urlType: 'exact', urlPattern: event.url, method },
    action: 'mapLocal',
    target,
  };
}
