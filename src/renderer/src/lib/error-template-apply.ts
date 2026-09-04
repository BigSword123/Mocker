import { findById, type ErrorTemplate } from '../../../shared/error-templates';
import type { NetworkErrorType } from '../../../shared/types';
import { DEFAULT_RESPONSE_CONTENT_TYPE, HEADER_LINE_SEP } from './rule-match-edit';

/** Selector value of the `错误模板` dropdown when the response is hand-authored. */
export const CUSTOM_TEMPLATE_ID = 'custom';

/** The response header an http error template guarantees, unless the user already set one. */
const JSON_CONTENT_TYPE: Record<string, string> = { 'content-type': DEFAULT_RESPONSE_CONTENT_TYPE };

/** The rule-editor fields an error template prefills. */
export interface ErrorTemplateFields {
  status: number;
  body: string;
  /** The `响应头` textarea text (`name: value` per line). */
  respHeadersText: string;
  neEnabled: boolean;
  neProbability: number | '';
  neType: NetworkErrorType;
}

/**
 * The editor fields after applying `template`, leaving every other field alone.
 *
 * An http template describes a response, so it writes `status` / `body` and turns the network error
 * off — a dropped connection would replace the very response the template wants to return. The
 * network-error type and probability survive so re-enabling the checkbox is not lossy.
 *
 * A connection template describes a failure *instead of* a response, so it only switches the network
 * error on. The ordinary response values stay: they remain stored on the rule and become visible
 * again as soon as the user turns the network error off.
 *
 * Pure: `fields` is never mutated.
 */
export function applyErrorTemplate(
  fields: ErrorTemplateFields,
  template: ErrorTemplate,
): ErrorTemplateFields {
  if (template.payload.kind === 'connection') {
    const { probability, type } = template.payload.networkError;
    return { ...fields, neEnabled: true, neProbability: probability, neType: type };
  }
  const { status, body, headers } = template.payload;
  return {
    ...fields,
    status,
    body,
    respHeadersText: mergeHeaderText(fields.respHeadersText, headers ?? {}, JSON_CONTENT_TYPE),
    neEnabled: false,
  };
}

/** Whether `id` names a connection template, which suppresses the ordinary response. */
export function isConnectionTemplateId(id: string): boolean {
  return findById(id)?.category === 'connection';
}

/** Rejection shown when the `响应状态码` input does not hold an HTTP status code. */
export const RESPONSE_STATUS_MESSAGE = '响应状态码必须是 100-999 的整数';

/**
 * The save-time complaint about `status`, or null when the save may proceed.
 *
 * `responseDisabled` is the connection-template state, where the status input is read-only: the
 * response is replaced by a connection failure at 100% probability, so an out-of-range value is both
 * unreachable and impossible for the user to correct — blocking the save would trap them. Every other
 * state, including a hand-authored or probabilistic network error whose response can still be sent,
 * keeps the check.
 */
export function responseStatusError(status: number, responseDisabled: boolean): string | null {
  if (responseDisabled) return null;
  const valid = Number.isInteger(status) && status >= 100 && status <= 999;
  return valid ? null : RESPONSE_STATUS_MESSAGE;
}

/**
 * Merges header updates into a `name: value` per line textarea.
 *
 * A header already in the text is updated in place, keeping its position and name casing; anything
 * else in the text — including lines the `name: value` convention cannot parse — is left untouched,
 * so a template never discards headers the user wrote. Every duplicate line of an overridden header is
 * rewritten, not just the first: the text is later parsed last-wins, so a leftover duplicate would
 * silently override the value the template just wrote. `fallbacks` are appended only when the header
 * is absent, which is how an http template guarantees a JSON content type without overruling a
 * deliberate one.
 */
export function mergeHeaderText(
  text: string,
  overrides: Record<string, string>,
  fallbacks: Record<string, string> = {},
): string {
  const pending = new Map(
    Object.entries(overrides).map(([name, value]) => [name.toLowerCase(), { name, value }]),
  );
  const present = new Set<string>();
  const rewritten = new Set<string>();
  const lines = text === '' ? [] : text.split('\n');
  const merged = lines.map((line) => {
    const idx = line.indexOf(HEADER_LINE_SEP);
    if (idx <= 0) return line;
    const name = line.slice(0, idx).trim();
    const key = name.toLowerCase();
    present.add(key);
    const update = pending.get(key);
    if (!update) return line;
    rewritten.add(key);
    return `${name}${HEADER_LINE_SEP}${update.value}`;
  });
  for (const key of rewritten) pending.delete(key);

  const appended = [...pending.values()];
  for (const [name, value] of Object.entries(fallbacks)) {
    const key = name.toLowerCase();
    if (present.has(key) || appended.some((h) => h.name.toLowerCase() === key)) continue;
    appended.push({ name, value });
  }
  if (appended.length === 0) return rewritten.size > 0 ? merged.join('\n') : text;

  while (merged.length > 0 && merged[merged.length - 1].trim() === '') merged.pop();
  return [...merged, ...appended.map((h) => `${h.name}${HEADER_LINE_SEP}${h.value}`)].join('\n');
}
