import type { RuleMatch } from '../../shared/types';

export interface RequestDescription {
  method: string;
  url: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: string;
}

export function matchRule(match: RuleMatch, req: RequestDescription): boolean {
  return (
    matchUrl(match, req.url) &&
    matchMethod(match.method, req.method) &&
    matchQuery(match.query, req.query) &&
    matchHeaders(match.headers, req.headers) &&
    matchBody(match.bodyContains, req.body)
  );
}

const regexCache = new Map<string, RegExp | null>();

function getCachedRegex(pattern: string): RegExp | null {
  if (!regexCache.has(pattern)) {
    try {
      regexCache.set(pattern, new RegExp(pattern));
    } catch {
      regexCache.set(pattern, null);
    }
  }
  return regexCache.get(pattern) ?? null;
}

function matchUrl(match: RuleMatch, url: string): boolean {
  switch (match.urlType) {
    case 'exact':
      return url === match.urlPattern;
    case 'wildcard':
      return wildcardToRegExp(match.urlPattern).test(url);
    case 'regex': {
      const re = getCachedRegex(match.urlPattern);
      return re ? re.test(url) : false;
    }
    default:
      return false;
  }
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + escaped.replace(/\?/g, '.').replace(/\*/g, '.*') + '$');
}

function matchMethod(ruleMethod: string, actual: string): boolean {
  return ruleMethod === 'ANY' || ruleMethod === actual.toUpperCase();
}

function matchQuery(expected: Record<string, string> | undefined, query: URLSearchParams): boolean {
  if (!expected) return true;
  return Object.entries(expected).every(([k, v]) => query.getAll(k).includes(v));
}

function matchHeaders(expected: Record<string, string> | undefined, headers: Record<string, string>): boolean {
  if (!expected) return true;
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return Object.entries(expected).every(([k, v]) => lower.get(k.toLowerCase()) === v);
}

function matchBody(needle: string | undefined, body: string): boolean {
  if (!needle) return true;
  return body.includes(needle);
}
