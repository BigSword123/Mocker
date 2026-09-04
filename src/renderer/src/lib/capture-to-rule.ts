import type { HttpMethod, HeaderRow, RuleInput, TrafficEvent } from '../../../shared/types';

const KNOWN_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

export function captureToRuleInput(event: TrafficEvent): RuleInput {
  const upper = event.method.toUpperCase();
  const method: HttpMethod = KNOWN_METHODS.includes(upper as HttpMethod) ? (upper as HttpMethod) : 'ANY';

  const headers: HeaderRow[] = [];
  if (event.responseHeaders) {
    for (const [k, v] of Object.entries(event.responseHeaders)) {
      if (k.toLowerCase() === 'content-type') {
        headers.push({ enabled: true, name: 'content-type', value: v, description: '' });
        break;
      }
    }
  }

  return {
    name: `${event.method} ${event.path}`,
    enabled: true,
    match: { urlType: 'exact', urlPattern: event.url, method },
    action: {
      status: event.status ?? 200,
      headers: Object.fromEntries(headers.map((r) => [r.name, r.value])),
      body: event.responseBody ?? '',
    },
  };
}
