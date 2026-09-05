import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import type { MockRule, RenderContext, ReplayRequest, TrafficEvent } from '../../shared/types';
import { computeMockResult } from '../rules/apply-rule';
import { findMatchingRule } from '../rules/engine';
import type { RequestDescription } from '../rules/matcher';

export const REPLAY_TIMEOUT_MS = 30_000;

export interface ReplayDeps {
  getRules: () => MockRule[];
  onEvent: (event: TrafficEvent) => void;
}

export class ReplayService {
  constructor(private readonly deps: ReplayDeps) {}

  send(input: ReplayRequest, replayedFromId?: string): Promise<string> {
    return sendReplay(this.deps, input, replayedFromId);
  }
}

async function sendReplay(
  deps: ReplayDeps,
  input: ReplayRequest,
  replayedFromId?: string,
): Promise<string> {
  const url = new URL(input.url);
  const id = `replay-${randomUUID()}`;
  const description: RequestDescription = {
    method: input.method.toUpperCase(),
    url: input.url,
    query: url.searchParams,
    headers: input.headers,
    body: input.body,
  };
  const event: TrafficEvent = {
    id,
    startedAt: Date.now(),
    method: description.method,
    url: input.url,
    host: url.hostname,
    path: url.pathname + url.search,
    requestHeaders: input.headers,
    mocked: false,
    origin: 'replay',
    ...(replayedFromId !== undefined ? { replayedFromId } : {}),
  };

  const matched = findMatchingRule(deps.getRules(), description);
  if (matched) {
    await applyMock(deps, event, matched, description, url.host);
  } else {
    await sendUpstream(deps, event, input, url);
  }
  return id;
}

async function applyMock(
  deps: ReplayDeps,
  event: TrafficEvent,
  matched: MockRule,
  description: RequestDescription,
  host: string,
): Promise<void> {
  const result = await computeMockResult(matched, toRenderContext(description, host));
  event.mocked = true;
  event.matchedRuleId = matched.id;
  if (result.networkError) {
    event.errorTriggered = true;
    event.error = `network-error:${matched.action.networkError?.type ?? ''}`;
    if (result.networkError.kind === 'respond') {
      event.status = result.networkError.statusCode;
      event.responseHeaders = {};
      event.responseBody = '';
    }
  } else {
    event.status = result.status;
    event.responseHeaders = result.headers;
    event.responseBody = result.body;
    event.renderWarnings = result.warnings.length > 0 ? result.warnings : undefined;
  }
  event.completedAt = Date.now();
  deps.onEvent(event);
}

function toRenderContext(req: RequestDescription, host: string): RenderContext {
  const query: Record<string, string> = {};
  req.query.forEach((v, k) => {
    query[k] = v;
  });
  const url = new URL(req.url);
  return {
    method: req.method,
    url: req.url,
    host,
    path: url.pathname + url.search,
    query,
    headers: req.headers,
    body: req.body,
  };
}

async function sendUpstream(
  deps: ReplayDeps,
  event: TrafficEvent,
  input: ReplayRequest,
  url: URL,
): Promise<void> {
  const mod = url.protocol === 'https:' ? https : http;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) {
    if (SKIP.has(k.toLowerCase())) continue;
    headers[k] = v;
  }
  const body = input.body !== '' ? Buffer.from(input.body, 'utf8') : undefined;
  try {
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = mod.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || undefined,
          path: url.pathname + url.search,
          method: event.method,
          headers: body ? { ...headers, 'content-length': String(body.length) } : headers,
        },
        resolve,
      );
      req.on('error', reject);
      req.setTimeout(REPLAY_TIMEOUT_MS, () => req.destroy(new Error('replay-timeout')));
      if (body) req.write(body);
      req.end();
    });
    const chunks: Buffer[] = [];
    for await (const chunk of res) chunks.push(chunk as Buffer);
    event.status = res.statusCode;
    event.responseHeaders = flatten(res.headers);
    event.responseBody = Buffer.concat(chunks).toString('utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    event.error = e.code ?? e.message;
  }
  event.completedAt = Date.now();
  deps.onEvent(event);
}

const SKIP = new Set(['host', 'connection', 'content-length', 'accept-encoding']);

function flatten(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}
