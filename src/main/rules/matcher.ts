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

function matchQuery(
  expected: Record<string, string> | HeaderRow[] | undefined,
  query: URLSearchParams,
): boolean {
  if (!expected) return true;
  if (Array.isArray(expected)) {
    return expected
      .filter((row) => row.enabled === true)
      .every((row) => query.getAll(row.name).includes(row.value));
  }
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
      return matchMultipartBody(rule.form ?? [], body);
    case 'urlencoded':
      return matchUrlencodedBody(rule.form ?? [], body);
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

interface FormFields {
  getAll(name: string): readonly string[];
}

/** Shared "every enabled row must be present as name=value" evaluation. */
function matchEnabledFormRows(form: HeaderRow[], parseFields: () => FormFields | null): boolean {
  const enabled = form.filter((row) => row.enabled === true);
  if (enabled.length === 0) return true;
  const fields = parseFields();
  if (fields === null) return false;
  return enabled.every((row) => fields.getAll(row.name).includes(row.value));
}

function matchUrlencodedBody(form: HeaderRow[], body: string): boolean {
  return matchEnabledFormRows(form, () => new URLSearchParams(body));
}

function matchMultipartBody(form: HeaderRow[], body: string): boolean {
  return matchEnabledFormRows(form, () => parseMultipartTextFields(body));
}

const CRLF = '\r\n';
const DASHES = '--';

/**
 * Parses the textual fields of a multipart/form-data body. File parts (parts whose
 * Content-Disposition carries a filename) are intentionally skipped: matching uploads is
 * out of scope. Returns null when the body is not a parseable multipart payload.
 */
function parseMultipartTextFields(body: string): FormFields | null {
  const delimiter = readMultipartDelimiter(body);
  if (delimiter === null) return null;
  const fields = new Map<string, string[]>();
  let cursor = delimiter.length;
  while (cursor < body.length) {
    if (body.startsWith(DASHES, cursor)) return toFormFields(fields);
    if (!body.startsWith(CRLF, cursor)) return null;
    const partStart = cursor + CRLF.length;
    const partEnd = body.indexOf(CRLF + delimiter, partStart);
    if (partEnd === -1) return null;
    if (!collectMultipartPart(body.slice(partStart, partEnd), fields)) return null;
    cursor = partEnd + CRLF.length + delimiter.length;
  }
  return null;
}

/** Reads the leading `--<boundary>` delimiter, tolerating a body that is only a terminator. */
function readMultipartDelimiter(body: string): string | null {
  if (!body.startsWith(DASHES)) return null;
  const lineEnd = body.indexOf(CRLF);
  if (lineEnd === -1) return null;
  const firstLine = body.slice(0, lineEnd);
  const delimiter = firstLine.endsWith(DASHES) ? firstLine.slice(0, firstLine.length - DASHES.length) : firstLine;
  return delimiter.length > DASHES.length ? delimiter : null;
}

function collectMultipartPart(part: string, fields: Map<string, string[]>): boolean {
  const split = splitMultipartPart(part);
  if (split === null) return false;
  const disposition = readContentDisposition(split.headers);
  if (disposition === null) return true;
  if (disposition.filename !== undefined) return true;
  if (disposition.name === undefined) return true;
  const previous = fields.get(disposition.name);
  fields.set(disposition.name, previous === undefined ? [split.content] : [...previous, split.content]);
  return true;
}

function splitMultipartPart(part: string): { headers: string; content: string } | null {
  if (part.startsWith(CRLF)) return { headers: '', content: part.slice(CRLF.length) };
  const blankLine = part.indexOf(CRLF + CRLF);
  if (blankLine === -1) return null;
  return { headers: part.slice(0, blankLine), content: part.slice(blankLine + 2 * CRLF.length) };
}

function readContentDisposition(headers: string): { name: string | undefined; filename: string | undefined } | null {
  if (headers.length === 0) return null;
  const line = headers.split(CRLF).find((header) => header.toLowerCase().startsWith('content-disposition:'));
  if (line === undefined) return null;
  const params = parseHeaderParams(line.slice(line.indexOf(':') + 1));
  return { name: params.get('name'), filename: params.get('filename') };
}

/** Parses `; key=value` / `; key="value"` parameters of a single header value. */
function parseHeaderParams(value: string): Map<string, string> {
  const params = new Map<string, string>();
  let cursor = value.indexOf(';');
  while (cursor !== -1) {
    const equals = value.indexOf('=', cursor + 1);
    if (equals === -1) break;
    const key = value.slice(cursor + 1, equals).trim().toLowerCase();
    const parsed = readHeaderParamValue(value, equals + 1);
    if (key.length > 0 && !params.has(key)) params.set(key, parsed.value);
    cursor = value.indexOf(';', parsed.end);
  }
  return params;
}

function readHeaderParamValue(value: string, start: number): { value: string; end: number } {
  let index = start;
  while (index < value.length && (value[index] === ' ' || value[index] === '\t')) index += 1;
  if (value[index] !== '"') {
    const semicolon = value.indexOf(';', index);
    const end = semicolon === -1 ? value.length : semicolon;
    return { value: value.slice(index, end).trim(), end };
  }
  index += 1;
  const chars: string[] = [];
  while (index < value.length && value[index] !== '"') {
    if (value[index] === '\\' && index + 1 < value.length) {
      chars.push(value[index + 1] as string);
      index += 2;
      continue;
    }
    chars.push(value[index] as string);
    index += 1;
  }
  return { value: chars.join(''), end: index < value.length ? index + 1 : value.length };
}

function toFormFields(fields: ReadonlyMap<string, readonly string[]>): FormFields {
  return { getAll: (name) => fields.get(name) ?? [] };
}
