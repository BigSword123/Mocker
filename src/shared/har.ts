import type { TrafficEvent } from './types';

export interface HarNameValuePair {
  name: string;
  value: string;
}

export interface HarHeader extends HarNameValuePair {}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    headers: HarHeader[];
    queryString: HarNameValuePair[];
    cookies: unknown[];
    headersSize: number;
    bodySize: number;
    postData?: { mimeType: string; text: string };
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    headers: HarHeader[];
    content: { size: number; mimeType: string; text: string };
    redirectURL: string;
    headersSize: number;
    bodySize: number;
  };
  cache: Record<string, unknown>;
  timings: { send: number; wait: number; receive: number };
  _mocked?: boolean;
  _matchedRuleId?: string;
  _origin?: string;
}

export interface HarLog {
  log: {
    version: string;
    creator: { name: string };
    entries: HarEntry[];
  };
}

export function toHar(events: TrafficEvent[]): HarLog {
  return {
    log: {
      version: '1.2',
      creator: { name: 'Mocker' },
      entries: events.filter((e) => e.completedAt !== undefined).map(toEntry),
    },
  };
}

export function fromHar(text: string): TrafficEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('文件不是合法 JSON');
  }
  const entries = (parsed as { log?: { entries?: unknown } })?.log?.entries;
  if (!Array.isArray(entries)) throw new Error('HAR 缺少 log.entries');
  const now = Date.now();
  return entries.map((raw, index) => entryToEvent(raw, now, index));
}

function toEntry(e: TrafficEvent): HarEntry {
  const time = e.completedAt! - e.startedAt;
  const body = e.requestBody ?? '';
  const queryString: HarNameValuePair[] = [];
  try {
    new URL(e.url).searchParams.forEach((v, k) => queryString.push({ name: k, value: v }));
  } catch {
    // 非法 URL 时 queryString 留空
  }
  return {
    startedDateTime: new Date(e.startedAt).toISOString(),
    time,
    request: {
      method: e.method,
      url: e.url,
      httpVersion: 'HTTP/1.1',
      headers: toHeaderList(e.requestHeaders),
      queryString,
      cookies: [],
      headersSize: -1,
      bodySize: body.length,
      ...(body !== ''
        ? { postData: { mimeType: headerValue(e.requestHeaders, 'content-type') ?? 'unknown', text: body } }
        : {}),
    },
    response: {
      status: e.status ?? 0,
      statusText: '',
      httpVersion: 'HTTP/1.1',
      headers: toHeaderList(e.responseHeaders),
      content: {
        size: (e.responseBody ?? '').length,
        mimeType: headerValue(e.responseHeaders, 'content-type') ?? 'unknown',
        text: e.responseBody ?? '',
      },
      redirectURL: '',
      headersSize: -1,
      bodySize: -1,
    },
    cache: {},
    timings: { send: 0, wait: time, receive: 0 },
    _mocked: e.mocked,
    ...(e.matchedRuleId !== undefined ? { _matchedRuleId: e.matchedRuleId } : {}),
    ...(e.origin !== undefined ? { _origin: e.origin } : {}),
  };
}

function entryToEvent(raw: unknown, now: number, index: number): TrafficEvent {
  const entry = (raw ?? {}) as Partial<HarEntry> & Record<string, unknown>;
  const request = (entry.request ?? {}) as Partial<HarEntry['request']>;
  const response = (entry.response ?? {}) as Partial<HarEntry['response']>;
  const url = String(request.url ?? '');
  let host = '';
  let path = url;
  try {
    const u = new URL(url);
    host = u.hostname;
    path = u.pathname + u.search;
  } catch {
    // 非法 URL 保留原样
  }
  const startedAt = Date.parse(String(entry.startedDateTime ?? '')) || now;
  return {
    id: `import-${now.toString(36)}-${index}`,
    startedAt,
    completedAt: startedAt + (typeof entry.time === 'number' ? entry.time : 0),
    method: String(request.method ?? 'GET').toUpperCase(),
    url,
    host,
    path,
    status: typeof response.status === 'number' && response.status > 0 ? response.status : undefined,
    requestHeaders: fromHeaderList(request.headers),
    requestBody: request.postData?.text ?? '',
    responseHeaders: fromHeaderList(response.headers),
    responseBody: response.content?.text ?? '',
    mocked: entry._mocked === true,
    matchedRuleId: typeof entry._matchedRuleId === 'string' ? entry._matchedRuleId : undefined,
    origin: 'imported',
  };
}

function toHeaderList(headers?: Record<string, string>): HarHeader[] {
  return Object.entries(headers ?? {}).map(([name, value]) => ({ name, value }));
}

function fromHeaderList(list: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    const h = item as Partial<HarHeader>;
    if (typeof h.name === 'string' && h.name !== '') out[h.name] = String(h.value ?? '');
  }
  return out;
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}
