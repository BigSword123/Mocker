export const UPSTREAM_PROXY_PROTOCOLS = ['http:', 'https:', 'socks5:', 'pac+http:'];

export function parseNoProxyList(raw: string): string[] {
  return raw
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function validateUpstreamProxyUrl(raw: string): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (UPSTREAM_PROXY_PROTOCOLS.includes(parsed.protocol)) return null;
  } catch {
    // 落到下面的错误返回
  }
  return '上游代理 URL 无效：支持 http:// https:// socks5:// pac+http://';
}
