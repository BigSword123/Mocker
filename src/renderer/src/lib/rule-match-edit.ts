import type { HeaderRow, RuleMatch } from '../../../shared/types';

/** Separator of the `请求头 / 响应头` textareas (`name: value` per line). */
export const HEADER_LINE_SEP = ': ';

/** Parses a `k<sep>v` per line textarea into a record; lines without a separator are ignored. */
export function parseLines(text: string, sep: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf(sep);
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + sep.length).trim();
  }
  return out;
}

/** Renders a record as `k<sep>v` lines for a textarea. */
export function formatLines(map: Record<string, string> | undefined, sep: string): string {
  return Object.entries(map ?? {})
    .map(([k, v]) => `${k}${sep}${v}`)
    .join('\n');
}

/**
 * The request-side constraints of a {@link RuleMatch}: the fields the plain-text editor can touch.
 */
export type RequestMatchFields = Pick<RuleMatch, 'headers' | 'bodyContains' | 'body'>;

/** The two request constraints the plain-text editor exposes, as shown when it opened. */
export interface LegacyRequestEditorText {
  headersText: string;
  bodyContainsText: string;
}

export interface LegacyRequestEdit extends LegacyRequestEditorText {
  /** The match the editor was seeded with; undefined when creating a rule from scratch. */
  source: RuleMatch | undefined;
  /** The values {@link legacyRequestEditorText} produced when the editor opened. */
  initialHeadersText: string;
  initialBodyContainsText: string;
}

/**
 * The initial values of the plain-text request-header / request-body inputs for `match`.
 *
 * Both are lossy views of the current representation: only enabled header rows are shown (a record
 * cannot express a disabled row or a description) and a {@link RuleMatch.body} rule has no plain-text
 * form at all, so the body input starts empty unless the rule still carries a legacy `bodyContains`.
 * {@link buildRequestMatch} therefore needs these values to tell an untouched input from an edited one.
 */
export function legacyRequestEditorText(match: RuleMatch | undefined): LegacyRequestEditorText {
  return {
    headersText: formatLines(headerRowsToRecord(match?.headers), HEADER_LINE_SEP),
    bodyContainsText: match?.bodyContains ?? '',
  };
}

/**
 * Builds the request-side match fields for a save from the plain-text editor.
 *
 * An input the user did not touch must not degrade the stored rule, so its original value is carried
 * over verbatim: header rows keep their disabled rows, descriptions and any other stored field, and a
 * modern `body` rule survives (it also wins over a stale `bodyContains`, exactly as the matcher does).
 * An edited input is the user's new intent, so its text is authoritative: obsolete header rows are
 * dropped, and typing a body constraint deliberately replaces a `body` rule with legacy
 * `bodyContains` — the only body constraint this editor can express.
 *
 * Pure: `source` is never mutated, though preserved values are returned by reference.
 */
export function buildRequestMatch(edit: LegacyRequestEdit): RequestMatchFields {
  const fields: RequestMatchFields = {};

  if (edit.headersText === edit.initialHeadersText) {
    if (edit.source?.headers !== undefined) fields.headers = edit.source.headers;
  } else {
    const headers = parseLines(edit.headersText, HEADER_LINE_SEP);
    if (Object.keys(headers).length > 0) fields.headers = headers;
  }

  if (edit.bodyContainsText === edit.initialBodyContainsText) {
    if (edit.source?.body !== undefined) fields.body = edit.source.body;
    else if (edit.source?.bodyContains) fields.bodyContains = edit.source.bodyContains;
  } else if (edit.bodyContainsText !== '') {
    fields.bodyContains = edit.bodyContainsText;
  }

  return fields;
}

/** Enabled rows of a header constraint as a record; a legacy record is already in that form. */
function headerRowsToRecord(
  headers: Record<string, string> | HeaderRow[] | undefined,
): Record<string, string> | undefined {
  if (!headers || !Array.isArray(headers)) return headers;
  return Object.fromEntries(headers.filter((h) => h.enabled).map((h) => [h.name, h.value]));
}
