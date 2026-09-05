import type { TrafficEvent } from '../../../shared/types';

export type CurlDialect = 'bash' | 'cmd' | 'powershell';

/** 重放/复现时无意义或由 curl 自动处理的头，不进命令行。 */
export const SKIP_HEADERS = new Set(['host', 'content-length', 'connection', 'accept-encoding']);

const CONTINUATION: Record<CurlDialect, string> = {
  bash: ' \\',
  cmd: ' ^',
  powershell: ' `',
};

export function defaultDialectFor(platform: 'macos' | 'windows' | 'other'): CurlDialect {
  if (platform === 'windows') return 'cmd';
  return 'bash';
}

export function buildCurl(event: TrafficEvent, dialect: CurlDialect): string {
  const args: string[] = [`-X ${event.method}`, quote(event.url, dialect)];
  for (const [k, v] of Object.entries(event.requestHeaders)) {
    if (SKIP_HEADERS.has(k.toLowerCase())) continue;
    args.push(`-H ${quote(`${k}: ${v}`, dialect)}`);
  }

  const notes: string[] = [];
  const body = event.requestBody ?? '';
  if (hasBinary(body)) {
    notes.push(comment(dialect, '请求体含二进制字符，请自行处理'));
  } else if (body !== '') {
    args.push(`--data-binary ${quote(body, dialect)}`);
  }

  const head = `curl ${args[0]}`;
  const tail = args.slice(1);
  const cmd = tail.length === 0 ? head : [head, ...tail].join(`${CONTINUATION[dialect]}\n  `);
  return notes.length > 0 ? `${cmd}\n${notes.join('\n')}` : cmd;
}

function quote(s: string, dialect: CurlDialect): string {
  if (dialect === 'bash') return `'${s.replace(/'/g, `'\\''`)}'`;
  const escaped = dialect === 'cmd' ? s.replace(/"/g, '\\"') : s.replace(/"/g, '`"');
  return `"${escaped}"`;
}

function comment(dialect: CurlDialect, text: string): string {
  return dialect === 'cmd' ? `REM ${text}` : `# ${text}`;
}

function hasBinary(s: string): boolean {
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
