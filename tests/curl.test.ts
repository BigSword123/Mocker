import { describe, expect, it } from 'vitest';
import { buildCurl, defaultDialectFor } from '../src/renderer/src/lib/curl';
import type { TrafficEvent } from '../src/shared/types';

function event(overrides: Partial<TrafficEvent> = {}): TrafficEvent {
  return {
    id: 'e1',
    startedAt: 0,
    method: 'POST',
    url: 'http://api.example.com/orders',
    host: 'api.example.com',
    path: '/orders',
    status: 201,
    requestHeaders: {
      host: 'api.example.com',
      'content-type': 'application/json',
      'content-length': '15',
      connection: 'keep-alive',
      'x-token': "it's",
    },
    requestBody: '{"amount":100}',
    mocked: false,
    ...overrides,
  };
}

describe('buildCurl', () => {
  it('bash: quotes url/headers/body, escapes single quotes, skips hop-by-hop headers', () => {
    const cmd = buildCurl(event(), 'bash');
    expect(cmd.startsWith('curl -X POST ')).toBe(true);
    expect(cmd).toContain("'http://api.example.com/orders'");
    expect(cmd).toContain("-H 'content-type: application/json'");
    expect(cmd).toContain("-H 'x-token: it'\\''s'");
    expect(cmd).not.toContain('host:');
    expect(cmd).not.toContain('content-length');
    expect(cmd).not.toContain('connection');
    expect(cmd).toContain("--data-binary '{\"amount\":100}'");
  });

  it('bash: continues lines with backslash', () => {
    expect(buildCurl(event(), 'bash')).toContain(' \\\n  -H ');
  });

  it('cmd: double quotes, backslash-slash escape, caret continuation', () => {
    const cmd = buildCurl(event(), 'cmd');
    expect(cmd).toContain('"http://api.example.com/orders"');
    expect(cmd).toContain('-H "x-token: it\\"s"');
    expect(cmd).toContain(' ^\n  ');
  });

  it('powershell: backtick escape and backtick continuation', () => {
    const cmd = buildCurl(event(), 'powershell');
    expect(cmd).toContain(' `\n  ');
    expect(cmd).toContain('-H "x-token: it`s"');
  });

  it('binary body becomes a comment instead of data (bash)', () => {
    const cmd = buildCurl(event({ requestBody: '\u0000\u0001binary' }), 'bash');
    expect(cmd).not.toContain('--data-binary');
    expect(cmd).toContain('# 请求体含二进制');
  });

  it('binary body comment uses REM in cmd', () => {
    const cmd = buildCurl(event({ requestBody: '\u0000' }), 'cmd');
    expect(cmd).toContain('REM 请求体含二进制');
  });

  it('no body means no data flag', () => {
    expect(buildCurl(event({ requestBody: undefined }), 'bash')).not.toContain('--data-binary');
  });

  it('defaultDialectFor maps platform', () => {
    expect(defaultDialectFor('macos')).toBe('bash');
    expect(defaultDialectFor('windows')).toBe('cmd');
    expect(defaultDialectFor('other')).toBe('bash');
  });
});
