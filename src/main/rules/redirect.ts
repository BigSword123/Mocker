import { promises as fs } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';
import type { RequestDescription } from './matcher';

const REPLAY_TIMEOUT_MS = 30_000;

const MIME_TABLE: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

export function mimeForPath(p: string): string {
  const ext = path.extname(p).toLowerCase();
  return MIME_TABLE[ext] ?? 'application/octet-stream';
}

export type MapLocalResult =
  | { ok: true; content: Buffer; mime: string }
  | { ok: false; reason: string };

export async function resolveMapLocal(target: string): Promise<MapLocalResult> {
  try {
    const content = await fs.readFile(target);
    return { ok: true, content, mime: mimeForPath(target) };
  } catch (err) {
    return { ok: false, reason: (err as NodeJS.ErrnoException).message ?? String(err) };
  }
}

export interface MapRemoteResult {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
}

const SKIP = new Set(['host', 'connection', 'content-length', 'accept-encoding']);

export async function sendMapRemote(target: string, req: RequestDescription): Promise<MapRemoteResult> {
  const url = new URL(req.url);
  const targetUrl = new URL(`http://${target}`);
  const isHttps = targetUrl.protocol === 'https:';
  const mod = isHttps ? https : http;

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (SKIP.has(k.toLowerCase())) continue;
    headers[k] = v;
  }
  const body = req.body !== '' ? Buffer.from(req.body, 'utf8') : undefined;

  try {
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const r = mod.request(
        {
          protocol: targetUrl.protocol,
          hostname: targetUrl.hostname,
          port: targetUrl.port || undefined,
          path: url.pathname + url.search,
          method: req.method,
          headers: body ? { ...headers, 'content-length': String(body.length) } : headers,
        },
        resolve,
      );
      r.on('error', reject);
      r.setTimeout(REPLAY_TIMEOUT_MS, () => r.destroy(new Error('map-remote-timeout')));
      if (body) r.write(body);
      r.end();
    });
    const chunks: Buffer[] = [];
    for await (const chunk of res) chunks.push(chunk as Buffer);
    return {
      status: res.statusCode,
      headers: flatten(res.headers),
      body: Buffer.concat(chunks).toString('utf8'),
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return { error: e.code ?? e.message };
  }
}

function flatten(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}
