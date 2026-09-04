import { describe, expect, it } from 'vitest';
import {
  CUSTOM_TEMPLATE_ID,
  applyErrorTemplate,
  isConnectionTemplateId,
  mergeHeaderText,
  type ErrorTemplateFields,
} from '../src/renderer/src/lib/error-template-apply';
import { findById } from '../src/shared/error-templates';

/** The editor state of a hand-authored rule: 200 + a JSON body and one custom response header. */
function handAuthored(overrides: Partial<ErrorTemplateFields> = {}): ErrorTemplateFields {
  return {
    status: 200,
    body: '{"code":0}',
    respHeadersText: 'x-trace: abc',
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
    expect(next.respHeadersText).toBe('x-trace: abc\ncontent-type: application/json');
  });

  it('leaves an existing content-type untouched, whatever its casing', () => {
    const next = applyErrorTemplate(
      handAuthored({ respHeadersText: 'Content-Type: text/xml' }),
      template('http-404'),
    );
    expect(next.respHeadersText).toBe('Content-Type: text/xml');
  });

  it('merges the retry-after header of the throttling preset', () => {
    const next = applyErrorTemplate(handAuthored(), template('http-429'));
    expect(next.respHeadersText).toBe('x-trace: abc\nretry-after: 60\ncontent-type: application/json');
  });

  it('overwrites an existing retry-after value in place', () => {
    const next = applyErrorTemplate(
      handAuthored({ respHeadersText: 'Retry-After: 1\nx-trace: abc' }),
      template('http-503'),
    );
    expect(next.respHeadersText).toBe('Retry-After: 30\nx-trace: abc\ncontent-type: application/json');
  });

  it('writes a single header line when the response headers were empty', () => {
    const next = applyErrorTemplate(handAuthored({ respHeadersText: '' }), template('http-404'));
    expect(next.respHeadersText).toBe('content-type: application/json');
  });

  it('does not mutate the fields it was given', () => {
    const fields = handAuthored();
    const snapshot = { ...fields };
    applyErrorTemplate(fields, template('http-429'));
    expect(fields).toEqual(snapshot);
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
    expect(next.respHeadersText).toBe('x-trace: abc');
  });

  it('does not mutate the fields it was given', () => {
    const fields = handAuthored();
    const snapshot = { ...fields };
    applyErrorTemplate(fields, template('conn-econnreset'));
    expect(fields).toEqual(snapshot);
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

describe('mergeHeaderText', () => {
  it('appends overrides that are absent', () => {
    expect(mergeHeaderText('a: 1', { b: '2' })).toBe('a: 1\nb: 2');
  });

  it('updates a present header in place and keeps its original name casing', () => {
    expect(mergeHeaderText('A-Header: 1\nb: 2', { 'a-header': '9' })).toBe('A-Header: 9\nb: 2');
  });

  it('adds a fallback only when the header is absent', () => {
    expect(mergeHeaderText('a: 1', {}, { b: '2' })).toBe('a: 1\nb: 2');
    expect(mergeHeaderText('B: keep', {}, { b: '2' })).toBe('B: keep');
  });

  it('leaves lines the k: v convention cannot parse alone', () => {
    expect(mergeHeaderText('# note\na: 1', { b: '2' })).toBe('# note\na: 1\nb: 2');
  });

  it('does not append after a trailing blank line', () => {
    expect(mergeHeaderText('a: 1\n', { b: '2' })).toBe('a: 1\nb: 2');
  });

  it('returns the text unchanged when there is nothing to merge', () => {
    expect(mergeHeaderText('a: 1\n', {})).toBe('a: 1\n');
  });
});
