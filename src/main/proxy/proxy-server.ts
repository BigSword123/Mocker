import * as os from 'node:os';
import * as mockttp from 'mockttp';
import type { MockRule, Settings, TrafficEvent } from '../../shared/types';
import { findMatchingRule } from '../rules/engine';
import type { RequestDescription } from '../rules/matcher';
import { computeMockResult, type MockComputation } from '../rules/apply-rule';
import type { RenderContext } from '../rules/template';
import { certDownloadResponse, guidePageResponse, type OnboardingResponse } from './onboarding';

export interface ProxyServerOptions {
  caKey: string;
  caCert: string;
  getSettings: () => Settings;
  getRules: () => MockRule[];
  onEvent: (event: TrafficEvent) => void;
}

/**
 * Wraps a mockttp proxy server with Mocker's rule matching, whitelist MITM and
 * traffic capture.
 *
 * Notes on the mockttp 4.x API used here:
 * - CONNECT requests never reach rule handlers; mockttp answers them internally.
 *   Whitelist blind-tunnelling is therefore configured natively at start time via
 *   the `https.tlsInterceptOnly` option (only whitelisted hosts get MITM'd).
 * - There is no `thenHandle`; the single master rule is
 *   `forAnyRequest().always().thenPassThrough({ beforeRequest })`. Returning
 *   `{ response }` from `beforeRequest` short-circuits with a mock; returning
 *   nothing forwards the request upstream.
 */
export class ProxyServer {
  private server?: mockttp.Mockttp;
  private abort?: AbortController;
  private events = new Map<string, TrafficEvent>();
  private startPromise?: Promise<void>;
  private proxyHosts: Set<string> = new Set(['localhost', '127.0.0.1']);

  constructor(private readonly opts: ProxyServerOptions) {}

  get running(): boolean {
    return this.server !== undefined;
  }

  get port(): number {
    return this.server?.port ?? this.opts.getSettings().proxyPort;
  }

  async start(): Promise<void> {
    if (this.server) return;
    if (this.startPromise) return this.startPromise;
    const promise = this.doStart();
    this.startPromise = promise;
    try {
      await promise;
    } finally {
      this.startPromise = undefined;
    }
  }

  private async doStart(): Promise<void> {
    const settings = this.opts.getSettings();
    this.abort = new AbortController();

    // Addresses this proxy is actually reachable on: the machine's non-internal
    // IPv4s plus loopback. The onboarding endpoints must only answer for the
    // proxy's own hosts, never for arbitrary IPs a client might request.
    const hosts = new Set<string>(['localhost', '127.0.0.1']);
    for (const ifaces of Object.values(os.networkInterfaces())) {
      for (const iface of ifaces ?? []) {
        if (!iface.internal && iface.family === 'IPv4') hosts.add(iface.address);
      }
    }
    this.proxyHosts = hosts;

    const https: mockttp.MockttpHttpsOptions = {
      key: this.opts.caKey,
      cert: this.opts.caCert,
    };
    if (settings.httpsMode === 'whitelist') {
      // Intercept (MITM) only whitelisted hosts; everything else is blindly
      // tunnelled at the TLS layer without touching the handshake.
      https.tlsInterceptOnly = settings.whitelist.flatMap((domain) => [
        { hostname: domain },
        { hostname: `*.${domain}` },
      ]);
    }

    const server = mockttp.getLocal({ https, recordTraffic: false });
    await server.start(settings.proxyPort);

    await server.on('request', (req) => {
      const event = this.upsertEvent(req);
      this.emit(event);
    });

    await server.on('response', async (resp) => {
      const event = this.events.get(resp.id);
      if (!event) return;
      event.status = resp.statusCode;
      event.responseHeaders = flattenHeaders(resp.headers);
      event.responseBody = await extractText(resp.body);
      event.completedAt = Date.now();
      this.emit(event);
    });

    await server.on('client-error', (err) => {
      const existing = err.request?.id ? this.events.get(err.request.id) : undefined;
      if (existing) {
        existing.error = err.errorCode ?? 'client-error';
        existing.completedAt = Date.now();
        this.emit(existing);
        return;
      }
      const event: TrafficEvent = {
        id: err.request?.id ?? `err-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        startedAt: Date.now(),
        completedAt: Date.now(),
        method: err.request?.method ?? '?',
        url: err.request?.url ?? `connection error: ${err.errorCode ?? 'unknown'}`,
        host: err.request?.destination?.hostname ?? '',
        path: err.request?.path ?? '',
        requestHeaders: flattenHeaders(err.request?.headers ?? {}),
        mocked: false,
        error: err.errorCode,
      };
      this.emit(event);
    });

    // Single master handler: onboarding endpoints, rule matching, passthrough.
    // The whitelist CONNECT blind tunnel is handled by mockttp itself via
    // tlsInterceptOnly (CONNECT never reaches this handler in mockttp 4.x).
    await server.forAnyRequest().always().thenPassThrough({
      beforeRequest: (req) => this.handle(req),
    });

    this.server = server;
  }

  async stop(): Promise<void> {
    // Abort but keep the controller: a handler that reaches its delay after
    // stop() began must still see an aborted signal, not undefined. doStart()
    // replaces it on the next start.
    this.abort?.abort();
    await this.server?.stop();
    this.server = undefined;
    this.events.clear();
  }

  /**
   * Master request handler. Returns a mock response definition when a rule
   * matches (or for onboarding endpoints); returns undefined to pass through.
   */
  private async handle(
    req: mockttp.CompletedRequest,
  ): Promise<mockttp.requestSteps.CallbackRequestResult | void> {
    // The 'request' subscription event and this callback race each other; both
    // upsert the same tracked event keyed by request id.
    const event = this.upsertEvent(req);

    const bodyText = await requestText(req);
    event.requestBody = bodyText;
    this.emit(event);

    if (req.method === 'GET' && this.isProxyHost(req.destination.hostname)) {
      if (req.path === '/ca.pem') {
        return { response: toCallbackResponse(certDownloadResponse(this.opts.caCert)) };
      }
      if (req.path === '/') {
        return { response: toCallbackResponse(guidePageResponse(req.destination.hostname, this.port)) };
      }
    }

    const matched = findMatchingRule(this.opts.getRules(), describeRequest(req, bodyText));
    if (matched) {
      return await this.handleMatched(matched, req, event, bodyText);
    }

    return undefined;
  }

  /**
   * Handles a matched rule: either fires a probabilistic network error, or
   * applies the optional delay, renders the templated body/headers, and returns
   * the mocked response.
   */
  private async handleMatched(
    matched: MockRule,
    req: mockttp.CompletedRequest,
    event: TrafficEvent,
    bodyText: string,
  ): Promise<mockttp.requestSteps.CallbackRequestResult | void> {
    event.mocked = true;
    event.matchedRuleId = matched.id;

    let result: MockComputation;
    try {
      result = await computeMockResult(matched, buildRenderContext(req, bodyText), {
        signal: this.abort?.signal,
      });
    } catch {
      // Proxy is stopping; drop the request rather than forward it.
      return { response: 'close' };
    }

    if (result.networkError) {
      event.errorTriggered = true;
      event.error = `network-error:${matched.action.networkError?.type ?? ''}`;
      event.completedAt = Date.now();
      this.emit(event);
      const resolution = result.networkError;
      if (resolution.kind === 'reset') return { response: 'reset' };
      if (resolution.kind === 'close') return { response: 'close' };
      return {
        response: { statusCode: resolution.statusCode, headers: {}, body: '' },
      };
    }

    event.status = result.status;
    event.responseHeaders = result.headers;
    event.responseBody = result.body;
    event.renderWarnings = result.warnings.length > 0 ? result.warnings : undefined;
    event.completedAt = Date.now();
    this.emit(event);

    return {
      response: toCallbackResponse({
        statusCode: result.status,
        headers: result.headers,
        body: result.body,
      }),
    };
  }

  private isProxyHost(hostname: string): boolean {
    return this.proxyHosts.has(hostname);
  }

  private upsertEvent(req: mockttp.CompletedRequest): TrafficEvent {
    const existing = this.events.get(req.id);
    if (existing) return existing;
    const event: TrafficEvent = {
      id: req.id,
      startedAt: Date.now(),
      method: req.method,
      url: absoluteUrl(req),
      host: req.destination.hostname,
      path: req.path,
      requestHeaders: flattenHeaders(req.headers),
      mocked: false,
    };
    this.events.set(req.id, event);
    if (this.events.size > 2000) this.evictOldest();
    return event;
  }

  /**
   * Evicts the oldest *settled* event (completed or errored). Falls back to
   * the oldest entry of any state only while every tracked event is still
   * in flight, so normal eviction never drops pending events.
   */
  private evictOldest(): void {
    let fallback: string | undefined;
    for (const [id, ev] of this.events) {
      fallback ??= id;
      if (ev.completedAt !== undefined || ev.error !== undefined) {
        this.events.delete(id);
        return;
      }
    }
    if (fallback !== undefined) this.events.delete(fallback);
  }

  private emit(event: TrafficEvent): void {
    try {
      this.opts.onEvent({ ...event });
    } catch {
      // Capture consumers (WS bridge, history writer) must never be able to
      // break or 500 real traffic; swallow and keep proxying.
    }
  }
}

function toCallbackResponse(res: OnboardingResponse): mockttp.requestSteps.CallbackResponseResult {
  return { statusCode: res.statusCode, headers: res.headers, body: res.body };
}

function absoluteUrl(req: mockttp.CompletedRequest): string {
  if (/^https?:\/\//.test(req.url)) return req.url;
  return `http://${req.destination.hostname}${req.path}`;
}

function describeRequest(req: mockttp.CompletedRequest, body: string): RequestDescription {
  const url = absoluteUrl(req);
  let query = new URLSearchParams();
  try {
    query = new URL(url).searchParams;
  } catch {
    // Malformed URL: match with an empty query.
  }
  return {
    method: req.method,
    url,
    query,
    headers: flattenHeaders(req.headers),
    body,
  };
}

function buildRenderContext(req: mockttp.CompletedRequest, body: string): RenderContext {
  const url = absoluteUrl(req);
  const query: Record<string, string> = {};
  try {
    new URL(url).searchParams.forEach((v, k) => {
      query[k] = v;
    });
  } catch {
    // Malformed URL: render with an empty query.
  }
  return {
    method: req.method,
    url,
    host: req.destination.hostname,
    path: req.path,
    query,
    headers: flattenHeaders(req.headers),
    body,
  };
}

function flattenHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

async function requestText(req: mockttp.CompletedRequest): Promise<string> {
  try {
    return (await req.body.getText()) ?? '';
  } catch {
    return '';
  }
}

/**
 * Defensively normalizes the response body shape across mockttp versions into
 * plain text. In mockttp 4.x this is a CompletedBody with an async getText(),
 * but strings/buffers are tolerated too.
 */
async function extractText(body: unknown): Promise<string> {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  const b = body as { getText?: () => string | Promise<string | undefined>; text?: string };
  if (typeof b.getText === 'function') {
    try {
      return (await b.getText()) ?? '';
    } catch {
      return '';
    }
  }
  if (typeof b.text === 'string') return b.text;
  return '';
}
