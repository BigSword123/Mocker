import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { MapLocalSaveInput } from '../../shared/types';

const EXT_TABLE: Record<string, string> = {
  'application/json': '.json',
  'text/html': '.html',
  'text/css': '.css',
  'application/javascript': '.js',
  'text/javascript': '.js',
  'text/plain': '.txt',
  'application/xml': '.xml',
  'text/xml': '.xml',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
};

export function mapLocalFileName(url: string, contentType?: string): string {
  const parsed = new URL(url);
  const base = `${parsed.host}${parsed.pathname}`
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 80);
  const hash = createHash('sha1').update(url).digest('hex').slice(0, 8);
  const mime = contentType?.split(';')[0]?.trim().toLowerCase();
  const ext = (mime && EXT_TABLE[mime]) || '.bin';
  return `${base}__${hash}${ext}`;
}

export class MapLocalStore {
  constructor(private readonly dir: string) {}

  async saveFromCapture(input: MapLocalSaveInput): Promise<string> {
    const contentType = Object.entries(input.responseHeaders ?? {}).find(
      ([k]) => k.toLowerCase() === 'content-type',
    )?.[1];
    const name = mapLocalFileName(input.url, contentType);
    await mkdir(this.dir, { recursive: true });
    const target = path.join(this.dir, name);
    await writeFile(target, input.responseBody ?? '', 'utf8');
    return target;
  }
}
