import type { TrafficEvent, TrafficFilter } from '../../../shared/types';

export const EMPTY_FILTER: TrafficFilter = { text: '', method: '', status: '', host: '' };

export function matchesFilter(e: TrafficEvent, f: TrafficFilter): boolean {
  if (f.method !== '' && e.method.toUpperCase() !== f.method.toUpperCase()) return false;
  if (f.status !== '' && !matchStatus(e, f.status)) return false;
  if (f.host !== '' && !e.host.toLowerCase().includes(f.host.toLowerCase())) return false;
  if (f.text !== '' && !matchText(e, f.text.toLowerCase())) return false;
  return true;
}

function matchStatus(e: TrafficEvent, bucket: string): boolean {
  if (bucket === 'error') return e.error !== undefined;
  if (e.status === undefined) return false;
  return String(e.status).startsWith(bucket);
}

function matchText(e: TrafficEvent, needle: string): boolean {
  return (
    e.url.toLowerCase().includes(needle) ||
    JSON.stringify(e.requestHeaders).toLowerCase().includes(needle) ||
    (e.requestBody ?? '').toLowerCase().includes(needle) ||
    JSON.stringify(e.responseHeaders ?? {}).toLowerCase().includes(needle) ||
    (e.responseBody ?? '').toLowerCase().includes(needle)
  );
}
