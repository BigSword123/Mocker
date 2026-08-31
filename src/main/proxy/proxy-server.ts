import * as mockttp from 'mockttp';
import type { MockRule, Settings, TrafficEvent } from '../../shared/types';
import { findMatchingRule } from '../rules/engine';
import type { RequestDescription } from '../rules/matcher';
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
  private events = new Map<string, TrafficEvent>();

  constructor(private readonly opts: ProxyServerOptions) {}

  get running(): boolean {
    return this.server !== undefined;
  }

  get port(): number {
    return this.server?.port ?? this.opts.getSettings().proxyPort;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const settings = this.opts.getSettings();

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
      event.mocked = true;
      event.matchedRuleId = matched.id;
      event.status = matched.action.status;
      event.responseHeaders = matched.action.headers;
      event.responseBody = matched.action.body;
      event.completedAt = Date.now();
      this.emit(event);
      return {
        response: toCallbackResponse({
          statusCode: matched.action.status,
          headers: matched.action.headers,
          body: matched.action.body,
        }),
      };
    }

    return undefined;
  }

  private isProxyHost(hostname: string): boolean {
    return hostname === 'localhost' || hostname === '127.0.0.1' || /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
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
    if (this.events.size > 2000) {
      const oldest = this.events.keys().next().value;
      if (oldest) this.events.delete(oldest);
    }
    return event;
  }

  private emit(event: TrafficEvent): void {
    this.opts.onEvent({ ...event });
  }
}

export function isWhitelisted(whitelist: string[], host: string): boolean {
  return whitelist.some((d) => host === d || host.endsWith(`.${d}`));
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
