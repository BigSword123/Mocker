import { describe, expect, it } from 'vitest';
import {
  CUSTOM_TEMPLATE_ID,
  RESPONSE_STATUS_MESSAGE,
  applyErrorTemplate,
  isConnectionTemplateId,
  mergeHeaderRows,
  responseStatusError,
  type ErrorTemplateFields,
} from '../src/renderer/src/lib/error-template-apply';
import type { HeaderRow } from '../src/shared/types';
import { findById } from '../src/shared/error-templates';

function row(name: string, value: string, enabled = true): HeaderRow {
  return { enabled, name, value, description: '' };
}

function textFromRows(rows: HeaderRow[]): string {
  return rows.map((r) => `${r.name}: ${r.value}`).join('\n');
}

/** The editor state of a hand-authored rule: 200 + a JSON body and one custom response header. */
function handAuthored(overrides: Partial<ErrorTemplateFields> = {}): ErrorTemplateFields {
  return {
    status: 200,
    body: '{"code":0}',
    respHeadersRows: [row('x-trace', 'abc')],
    neEnabled: false,
    neProbability: 100,
    neType: 'ECONNRESET',
    ...overrides,
  };
}

function template(id: string) {
  const found = findById(id);
  if (!found) throw new Error(`unknown template ${id}`);
  return found;
}

describe('applyErrorTemplate on an http template', () => {
  it('writes the template status and body', () => {
    const next = applyErrorTemplate(handAuthored(), template('http-404'));
    expect(next.status).toBe(404);
    expect(JSON.parse(next.body)).toEqual({ error: { code: 'NOT_FOUND', message: '请求的资源不存在' } });
  });

  it('disables the network error because an http response excludes a connection failure', () => {
    const next = applyErrorTemplate(
      handAuthored({ neEnabled: true, neType: 'ETIMEDOUT', neProbability: 40 }),
      template('http-500'),
    );
    expect(next.neEnabled).toBe(false);
  });

  it('keeps the previous network-error type and probability so unchecking is not lossy', () => {
    const next = applyErrorTemplate(
      handAuthored({ neEnabled: true, neType: 'ETIMEDOUT', neProbability: 40 }),
      template('http-500'),
    );
    expect(next.neType).toBe('ETIMEDOUT');
    expect(next.neProbability).toBe(40);
  });

  it('adds content-type: application/json while keeping unrelated response headers', () => {
    const next = applyErrorTemplate(handAuthored(), template('http-404'));
    expect(textFromRows(next.respHeadersRows)).toBe('x-trace: abc\ncontent-type: application/json');
  });

  it('leaves an existing content-type untouched, whatever its casing', () => {
    const next = applyErrorTemplate(
      handAuthored({ respHeadersRows: [row('Content-Type', 'text/xml')] }),
      template('http-404'),
    );
    expect(textFromRows(next.respHeadersRows)).toBe('Content-Type: text/xml');
  });

  it('merges the retry-after header of the throttling preset', () => {
    const next = applyErrorTemplate(handAuthored(), template('http-429'));
    expect(textFromRows(next.respHeadersRows)).toBe('x-trace: abc\nretry-after: 60\ncontent-type: application/json');
  });

  it('overwrites an existing retry-after value in place', () => {
    const next = applyErrorTemplate(
      handAuthored({ respHeadersRows: [row('Retry-After', '1'), row('x-trace', 'abc')] }),
      template('http-503'),
    );
    expect(textFromRows(next.respHeadersRows)).toBe('Retry-After: 30\nx-trace: abc\ncontent-type: application/json');
  });

  it('writes a single header when the response headers were empty', () => {
    const next = applyErrorTemplate(handAuthored({ respHeadersRows: [] }), template('http-404'));
    expect(textFromRows(next.respHeadersRows)).toBe('content-type: application/json');
  });

  it('does not mutate the fields it was given', () => {
    const fields = handAuthored();
    const snapshot = { ...fields, respHeadersRows: [...fields.respHeadersRows] };
    applyErrorTemplate(fields, template('http-429'));
    expect(fields.respHeadersRows).toEqual(snapshot.respHeadersRows);
  });
});

describe('an applied http template through the action-header serialisation', () => {
  /** The `action.headers` a save would store after applying `id` to respHeadersRows. */
  function savedHeaders(inputRows: HeaderRow[], id: string): Record<string, string> {
    const next = applyErrorTemplate(handAuthored({ respHeadersRows: inputRows }), template(id));
    const headers: Record<string, string> = {};
    const hasContentType = next.respHeadersRows.some(
      (r) => r.enabled && r.name && r.name.toLowerCase() === 'content-type',
    );
    if (!hasContentType) headers['content-type'] = 'application/json';
    for (const r of next.respHeadersRows.filter((r) => r.enabled && r.name)) {
      headers[r.name] = r.value;
    }
    return headers;
  }

  it('stores the json content type the template guarantees', () => {
    expect(savedHeaders([row('x-trace', 'abc')], 'http-404')).toEqual({
      'x-trace': 'abc',
      'content-type': 'application/json',
    });
  });

  it('stores a user content-type once, without a lowercase duplicate', () => {
    expect(savedHeaders([row('Content-Type', 'text/xml')], 'http-404')).toEqual({ 'Content-Type': 'text/xml' });
  });

  it('stores a user content-type once whatever its casing', () => {
    expect(savedHeaders([row('CONTENT-TYPE', 'text/xml'), row('x-trace', 'abc')], 'http-500')).toEqual({
      'CONTENT-TYPE': 'text/xml',
      'x-trace': 'abc',
    });
  });

  it('stores the template retry-after next to the default content type', () => {
    expect(savedHeaders([], 'http-429')).toEqual({
      'retry-after': '60',
      'content-type': 'application/json',
    });
  });
});

describe('an applied http template over duplicate header rows', () => {
  it('updates every duplicate row so the serialised value is the template one', () => {
    const next = applyErrorTemplate(
      handAuthored({ respHeadersRows: [row('Retry-After', '1'), row('retry-after', '2')] }),
      template('http-503'),
    );
    expect(textFromRows(next.respHeadersRows)).toBe('Retry-After: 30\nretry-after: 30\ncontent-type: application/json');
  });

  it('updates duplicates of the same spelling too', () => {
    const result = mergeHeaderRows(
      [row('a', '1'), row('b', '2'), row('a', '3')],
      { a: '9' },
    );
    expect(textFromRows(result)).toBe('a: 9\nb: 2\na: 9');
  });

  it('updates every row that carries the overridden name', () => {
    const result = mergeHeaderRows(
      [row('a', '1'), row('a', '2')],
      { a: '9' },
    );
    expect(textFromRows(result)).toBe('a: 9\na: 9');
  });
});

describe('applyErrorTemplate on a connection template', () => {
  it('enables the network error at probability 100 with the template type', () => {
    const next = applyErrorTemplate(handAuthored(), template('conn-etimedout'));
    expect(next.neEnabled).toBe(true);
    expect(next.neProbability).toBe(100);
    expect(next.neType).toBe('ETIMEDOUT');
  });

  it('preserves the ordinary response, which stays stored on the rule', () => {
    const fields = handAuthored({ status: 201, body: '{"ok":true}' });
    const next = applyErrorTemplate(fields, template('conn-truncate'));
    expect(next.status).toBe(201);
    expect(next.body).toBe('{"ok":true}');
    expect(textFromRows(next.respHeadersRows)).toBe('x-trace: abc');
  });

  it('does not mutate the fields it was given', () => {
    const fields = handAuthored();
    const snapshot = { ...fields, respHeadersRows: [...fields.respHeadersRows] };
    applyErrorTemplate(fields, template('conn-econnreset'));
    expect(fields.respHeadersRows).toEqual(snapshot.respHeadersRows);
  });
});

describe('isConnectionTemplateId', () => {
  it('is true for every connection preset', () => {
    for (const id of ['conn-econnreset', 'conn-etimedout', 'conn-enotfound', 'conn-econnrefused', 'conn-truncate']) {
      expect(isConnectionTemplateId(id), id).toBe(true);
    }
  });

  it('is false for http presets, the custom entry and unknown ids', () => {
    expect(isConnectionTemplateId('http-404')).toBe(false);
    expect(isConnectionTemplateId(CUSTOM_TEMPLATE_ID)).toBe(false);
    expect(isConnectionTemplateId('nope')).toBe(false);
  });
});

describe('responseStatusError', () => {
  it('accepts any status in the 100-999 range', () => {
    for (const status of [100, 404, 999]) expect(responseStatusError(status, false), String(status)).toBeNull();
  });

  it('rejects a status outside the range or not an integer', () => {
    for (const status of [0, 99, 1000, 404.5, Number.NaN]) {
      expect(responseStatusError(status, false), String(status)).toBe(RESPONSE_STATUS_MESSAGE);
    }
  });

  it('skips the check while a connection template disables the status input', () => {
    for (const status of [0, 99, Number.NaN]) {
      expect(responseStatusError(status, true), String(status)).toBeNull();
    }
  });
});

describe('mergeHeaderRows', () => {
  it('appends overrides that are absent', () => {
    const result = mergeHeaderRows([row('a', '1')], { b: '2' });
    expect(textFromRows(result)).toBe('a: 1\nb: 2');
  });

  it('updates a present header in place and keeps its original name casing', () => {
    const result = mergeHeaderRows([row('A-Header', '1'), row('b', '2')], { 'a-header': '9' });
    expect(textFromRows(result)).toBe('A-Header: 9\nb: 2');
  });

  it('adds a fallback only when the header is absent', () => {
    expect(textFromRows(mergeHeaderRows([row('a', '1')], {}, { b: '2' }))).toBe('a: 1\nb: 2');
    expect(textFromRows(mergeHeaderRows([row('B', 'keep')], {}, { b: '2' }))).toBe('B: keep');
  });

  it('returns the rows unchanged when there is nothing to merge', () => {
    const result = mergeHeaderRows([row('a', '1')], {});
    expect(textFromRows(result)).toBe('a: 1');
  });
});
