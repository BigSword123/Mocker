import type { HeaderRow, RuleBody, RuleMatch } from '../../shared/types';

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
    matchBody(match, req.body)
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

function matchHeaders(
  expected: Record<string, string> | HeaderRow[] | undefined,
  headers: Record<string, string>,
): boolean {
  if (!expected) return true;
  const actual = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (Array.isArray(expected)) {
    return expected
      .filter((row) => row.enabled === true)
      .every((row) => actual.get(row.name.toLowerCase()) === row.value);
  }
  return Object.entries(expected).every(([name, value]) => actual.get(name.toLowerCase()) === value);
}

function matchBody(match: RuleMatch, body: string): boolean {
  if (match.body) return matchBodyByRule(match.body, body);
  if (match.bodyContains) return body.includes(match.bodyContains);
  return true;
}

function matchBodyByRule(rule: RuleBody, body: string): boolean {
  switch (rule.mode) {
    case 'none':
      return true;
    case 'raw':
      return matchRawBody(rule, body);
    case 'form-data':
    case 'urlencoded':
      return matchFormBody(rule.form ?? [], body);
    default:
      return true;
  }
}

function matchRawBody(rule: RuleBody, body: string): boolean {
  const raw = rule.raw ?? '';
  switch (rule.matchStrategy ?? 'contains') {
    case 'equals':
      return body === raw;
    case 'json-deep':
      return matchJsonDeep(raw, body);
    case 'contains':
    default:
      return body.includes(raw);
  }
}

function matchJsonDeep(raw: string, body: string): boolean {
  const expected = parseJson(raw);
  const actual = parseJson(body);
  if (!expected.ok || !actual.ok) return false;
  return deepEqual(expected.value, actual.value);
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function deepEqual(expected: unknown, actual: unknown): boolean {
  if (expected === actual) return true;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return false;
    if (expected.length !== actual.length) return false;
    return expected.every((item, index) => deepEqual(item, actual[index]));
  }
  if (isJsonObject(expected) && isJsonObject(actual)) {
    const expectedKeys = Object.keys(expected);
    if (expectedKeys.length !== Object.keys(actual).length) return false;
    return expectedKeys.every(
      (key) => Object.prototype.hasOwnProperty.call(actual, key) && deepEqual(expected[key], actual[key]),
    );
  }
  return false;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function matchFormBody(form: HeaderRow[], body: string): boolean {
  const enabled = form.filter((row) => row.enabled === true);
  if (enabled.length === 0) return true;
  const params = new URLSearchParams(body);
  return enabled.every((row) => params.getAll(row.name).includes(row.value));
}
