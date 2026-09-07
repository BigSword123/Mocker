import { describe, expect, it } from 'vitest';
import { parseNoProxyList, validateUpstreamProxyUrl } from '../src/shared/upstream';

describe('parseNoProxyList', () => {
  it('splits on comma, semicolon and newline', () => {
    expect(parseNoProxyList('a.com, b.com;c.com\nd.com')).toEqual(['a.com', 'b.com', 'c.com', 'd.com']);
  });
  it('drops empty entries', () => {
    expect(parseNoProxyList(' , a.com;;\n')).toEqual(['a.com']);
  });
  it('returns empty array for empty input', () => {
    expect(parseNoProxyList('')).toEqual([]);
  });
});

describe('validateUpstreamProxyUrl', () => {
  it('accepts empty (feature disabled)', () => {
    expect(validateUpstreamProxyUrl('')).toBeNull();
  });
  it('accepts supported protocols', () => {
    for (const url of [
      'http://127.0.0.1:7890',
      'https://proxy.corp:8443',
      'socks5://127.0.0.1:7892',
      'pac+http://127.0.0.1:8080/proxy.pac',
    ]) {
      expect(validateUpstreamProxyUrl(url)).toBeNull();
    }
  });
  it('accepts credentials in URL', () => {
    expect(validateUpstreamProxyUrl('http://user:pass@proxy.corp:8080')).toBeNull();
  });
  it('rejects unsupported protocol and garbage', () => {
    expect(validateUpstreamProxyUrl('ftp://x')).toMatch(/无效/);
    expect(validateUpstreamProxyUrl('not a url')).toMatch(/无效/);
  });
});
