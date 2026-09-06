import * as os from 'node:os';
import * as mockttp from 'mockttp';
import type { MockRule, RedirectRule, Scenario, Settings, TrafficEvent } from '../../shared/types';
import { findMatchingRedirect, findMatchingRule } from '../rules/engine';
import { type RequestDescription } from '../rules/matcher';
import { computeMockResult, type MockComputation } from '../rules/apply-rule';
import type { RenderContext } from '../rules/template';
import { resolveMapLocal, sendMapRemote } from '../rules/redirect';
import { ruleEffective } from '../rules/rule-effective';
import { applyThrottle } from './throttle';
import { certDownloadResponse, guidePageResponse, type OnboardingResponse } from './onboarding';

export interface ProxyServerOptions {
  caKey: string;
  caCert: string;
  getSettings: () => Settings;
  getRules: () => MockRule[];
  getRedirects?: () => RedirectRule[];
  getScenarios?: () => ReadonlyMap<string, Scenario>;
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
  private seqCounters = new Map<string, number>();

  constructor(private readonly opts: ProxyServerOptions) {}

  resetSequenceCounter(ruleId: string): void {
    this.seqCounters.delete(ruleId);
  }

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
      beforeResponse: async (resp) => {
        if (!this.opts.getSettings().throttle?.enabled) return;
        const text = await resp.body.getText();
        const slept = await applyThrottle(this.opts.getSettings, Buffer.byteLength(text), this.abort?.signal);
        if (slept > 0) {
          const ev = this.events.get(resp.id);
          if (ev) {
            ev.throttledMs = slept;
            this.emit(ev);
          }
        }
      },
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

    const scenarios = this.opts.getScenarios?.() ?? new Map<string, Scenario>();
    const description = describeRequest(req, bodyText);

    const redirectMatched = findMatchingRedirect(this.redirects(), scenarios, description);
    if (redirectMatched) {
      return await this.handleRedirect(redirectMatched, description, event, bodyText);
    }

    const matched = findMatchingRule(
      this.opts.getRules().filter((r) => ruleEffective(r, scenarios)),
      description,
    );
    if (matched) {
      return await this.handleMatched(matched, req, event, bodyText);
    }

    return undefined;
  }

  private redirects(): RedirectRule[] {
    return this.opts.getRedirects?.() ?? [];
  }

  private async handleRedirect(
    rule: RedirectRule,
    req: RequestDescription,
    event: TrafficEvent,
    bodyText: string,
  ): Promise<mockttp.requestSteps.CallbackRequestResult | void> {
    event.mocked = true;
    event.matchedRuleId = rule.id;

    if (rule.action === 'mapLocal') {
      const res = await resolveMapLocal(rule.target);
      let localThrottled: number;
      try {
        const bytes = res.ok ? res.content.length : Buffer.byteLength(event.responseBody ?? '');
        localThrottled = await applyThrottle(this.opts.getSettings, bytes, this.abort?.signal);
      } catch {
        return { response: 'close' as const };
      }
      if (localThrottled > 0) event.throttledMs = localThrottled;
      if (res.ok) {
        event.status = 200;
        event.responseHeaders = { 'content-type': res.mime };
        event.responseBody = res.content.toString('utf8');
      } else {
        event.status = 404;
        event.responseHeaders = { 'content-type': 'text/plain; charset=utf-8' };
        event.responseBody = `File not found: ${rule.target}`;
        event.error = `map-local: ${res.reason}`;
      }
      event.completedAt = Date.now();
      this.emit(event);
      return {
        response: toCallbackResponse({
          statusCode: event.status ?? 404,
          headers: event.responseHeaders ?? {},
          body: event.responseBody ?? '',
        }),
      };
    }

    const remote = await sendMapRemote(rule.target, req);
    if (remote.error !== undefined) {
      event.error = remote.error;
      event.completedAt = Date.now();
      this.emit(event);
      return { response: 'close' as const };
    }
    let remoteThrottled: number;
    try {
      remoteThrottled = await applyThrottle(this.opts.getSettings, Buffer.byteLength(remote.body ?? ''), this.abort?.signal);
    } catch {
      return { response: 'close' as const };
    }
    if (remoteThrottled > 0) event.throttledMs = remoteThrottled;
    event.status = remote.status;
    event.responseHeaders = remote.headers;
    event.responseBody = remote.body;
    event.completedAt = Date.now();
    this.emit(event);
    return {
      response: toCallbackResponse({
        statusCode: remote.status ?? 502,
        headers: remote.headers ?? {},
        body: remote.body ?? '',
      }),
    };
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

    let sequenceIndex: number | undefined;
    if ('responses' in matched.action) {
      const responses = matched.action.responses;
      sequenceIndex = Math.min(this.seqCounters.get(matched.id) ?? 0, responses.length - 1);
      event.sequenceIndex = sequenceIndex;
      this.seqCounters.set(matched.id, sequenceIndex + 1);
    }

    let result: MockComputation;
    try {
      result = await computeMockResult(matched, buildRenderContext(req, bodyText), {
        signal: this.abort?.signal,
        ...(sequenceIndex !== undefined ? { sequenceIndex } : {}),
      });
    } catch {
      if (sequenceIndex !== undefined) {
        this.seqCounters.set(matched.id, sequenceIndex);
      }
      return { response: 'close' };
    }

    if (result.networkError) {
      event.errorTriggered = true;
      let neType: string | undefined;
      if (!('responses' in matched.action)) {
        neType = matched.action.networkError?.type;
      }
      event.error = `network-error:${neType ?? ''}`;
      event.completedAt = Date.now();
      this.emit(event);
      const resolution = result.networkError;
      if (resolution.kind === 'reset') return { response: 'reset' };
      if (resolution.kind === 'close') return { response: 'close' };
      return {
        response: { statusCode: resolution.statusCode, headers: {}, body: '' },
      };
    }

    let throttledMs: number;
    try {
      throttledMs = await applyThrottle(this.opts.getSettings, Buffer.byteLength(result.body), this.abort?.signal);
    } catch {
      return { response: 'close' };
    }
    if (throttledMs > 0) event.throttledMs = throttledMs;

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
