import { describe, expect, it } from 'vitest';
import {
  buildRequestMatch,
  legacyRequestEditorText,
  type LegacyRequestEdit,
} from '../src/renderer/src/lib/rule-match-edit';
import type { HeaderRow, RuleMatch } from '../src/shared/types';

/** A rule as the storage migration writes it: HeaderRow[] headers and a RuleBody. */
function migratedMatch(overrides: Partial<RuleMatch> = {}): RuleMatch {
  return {
    urlType: 'wildcard',
    urlPattern: 'http://api.example.com/*',
    method: 'POST',
    headers: [
      { enabled: true, name: 'x-token', value: 'abc', description: '登录态' },
      { enabled: false, name: 'x-debug', value: '1', description: '临时开关' },
    ],
    body: { mode: 'raw', raw: '"id":7', matchStrategy: 'contains' },
    ...overrides,
  };
}

/** A rule still stored in the legacy shape: header record and bodyContains. */
function legacyMatch(overrides: Partial<RuleMatch> = {}): RuleMatch {
  return {
    urlType: 'exact',
    urlPattern: 'http://api.example.com/users',
    method: 'GET',
    headers: { 'x-token': 'abc' },
    bodyContains: '"id":7',
    ...overrides,
  };
}

/** Opening the editor on `match` and saving without touching request headers / body. */
function untouched(match: RuleMatch | undefined): LegacyRequestEdit {
  const opened = legacyRequestEditorText(match);
  return {
    source: match,
    initialHeadersText: opened.headersText,
    headersText: opened.headersText,
    initialBodyContainsText: opened.bodyContainsText,
    bodyContainsText: opened.bodyContainsText,
  };
}

describe('legacyRequestEditorText', () => {
  it('shows only enabled header rows of a migrated match as k: v lines', () => {
    expect(legacyRequestEditorText(migratedMatch()).headersText).toBe('x-token: abc');
  });

  it('shows a legacy header record as k: v lines', () => {
    const match = legacyMatch({ headers: { 'x-token': 'abc', accept: 'application/json' } });
    expect(legacyRequestEditorText(match).headersText).toBe('x-token: abc\naccept: application/json');
  });

  it('leaves the body input empty for a migrated match, which has no bodyContains', () => {
    expect(legacyRequestEditorText(migratedMatch()).bodyContainsText).toBe('');
  });

  it('shows the legacy bodyContains constraint', () => {
    expect(legacyRequestEditorText(legacyMatch()).bodyContainsText).toBe('"id":7');
  });

  it('returns empty text for a brand new rule', () => {
    expect(legacyRequestEditorText(undefined)).toEqual({ headersText: '', bodyContainsText: '' });
  });
});

describe('buildRequestMatch on an untouched editor', () => {
  it('preserves migrated header rows including disabled rows and descriptions', () => {
    const match = migratedMatch();
    expect(buildRequestMatch(untouched(match)).headers).toEqual([
      { enabled: true, name: 'x-token', value: 'abc', description: '登录态' },
      { enabled: false, name: 'x-debug', value: '1', description: '临时开关' },
    ]);
  });

  it('preserves extra fields stored on a header row', () => {
    const rows = [{ enabled: true, name: 'x-token', value: 'abc', note: 'kept' }] as unknown as HeaderRow[];
    const match = migratedMatch({ headers: rows });
    expect(buildRequestMatch(untouched(match)).headers).toEqual(rows);
  });

  it('preserves the modern body rule', () => {
    const match = migratedMatch({ body: { mode: 'form-data', form: [{ enabled: true, name: 'a', value: '1' }] } });
    const fields = buildRequestMatch(untouched(match));
    expect(fields.body).toEqual({ mode: 'form-data', form: [{ enabled: true, name: 'a', value: '1' }] });
    expect(fields.bodyContains).toBeUndefined();
  });

  it('preserves an empty header row array', () => {
    expect(buildRequestMatch(untouched(migratedMatch({ headers: [] }))).headers).toEqual([]);
  });

  it('keeps a legacy header record and bodyContains unchanged', () => {
    const match = legacyMatch();
    expect(buildRequestMatch(untouched(match))).toEqual({
      headers: { 'x-token': 'abc' },
      bodyContains: '"id":7',
    });
  });

  it('keeps a legacy header value that the k: v text form cannot round-trip', () => {
    const match = legacyMatch({ headers: { 'x-token': '  spaced  ' } });
    expect(buildRequestMatch(untouched(match)).headers).toEqual({ 'x-token': '  spaced  ' });
  });

  it('lets the modern body win over a stale bodyContains', () => {
    const match = migratedMatch({ bodyContains: 'stale' });
    const fields = buildRequestMatch(untouched(match));
    expect(fields.body).toEqual({ mode: 'raw', raw: '"id":7', matchStrategy: 'contains' });
    expect(fields.bodyContains).toBeUndefined();
  });

  it('omits absent constraints instead of writing empty ones', () => {
    const match: RuleMatch = { urlType: 'exact', urlPattern: 'http://x.test/p', method: 'ANY' };
    expect(buildRequestMatch(untouched(match))).toEqual({});
  });

  it('drops an empty legacy bodyContains', () => {
    expect(buildRequestMatch(untouched(legacyMatch({ bodyContains: '' })))).toEqual({
      headers: { 'x-token': 'abc' },
    });
  });

  it('does not mutate the source match', () => {
    const match = migratedMatch({ bodyContains: 'stale' });
    const snapshot = JSON.parse(JSON.stringify(match)) as RuleMatch;
    buildRequestMatch(untouched(match));
    expect(match).toEqual(snapshot);
  });
});

describe('buildRequestMatch when the header textarea was edited', () => {
  it('replaces migrated rows with the typed record and drops obsolete rows', () => {
    const match = migratedMatch();
    const fields = buildRequestMatch({
      ...untouched(match),
      headersText: 'x-token: def\naccept: application/json',
    });
    expect(fields.headers).toEqual({ 'x-token': 'def', accept: 'application/json' });
  });

  it('keeps the untouched body while headers change', () => {
    const match = migratedMatch();
    expect(buildRequestMatch({ ...untouched(match), headersText: 'x-token: def' }).body).toEqual(
      match.body,
    );
  });

  it('drops the header constraint when the textarea is cleared', () => {
    const fields = buildRequestMatch({ ...untouched(migratedMatch()), headersText: '' });
    expect(fields.headers).toBeUndefined();
  });

  it('treats any textual difference as an edit, including added whitespace', () => {
    const fields = buildRequestMatch({ ...untouched(migratedMatch()), headersText: 'x-token: abc\n' });
    expect(fields.headers).toEqual({ 'x-token': 'abc' });
  });

  it('still edits a legacy header record through the textarea', () => {
    const fields = buildRequestMatch({ ...untouched(legacyMatch()), headersText: 'accept: text/plain' });
    expect(fields).toEqual({ headers: { accept: 'text/plain' }, bodyContains: '"id":7' });
  });
});

describe('buildRequestMatch when the bodyContains input was edited', () => {
  it('switches a migrated rule to the typed legacy constraint', () => {
    const match = migratedMatch();
    const fields = buildRequestMatch({ ...untouched(match), bodyContainsText: '"id":8' });
    expect(fields.bodyContains).toBe('"id":8');
    expect(fields.body).toBeUndefined();
  });

  it('keeps the untouched headers while the body constraint changes', () => {
    const match = migratedMatch();
    expect(buildRequestMatch({ ...untouched(match), bodyContainsText: 'x' }).headers).toEqual(
      match.headers,
    );
  });

  it('drops the body constraint when the input is cleared', () => {
    const fields = buildRequestMatch({ ...untouched(legacyMatch()), bodyContainsText: '' });
    expect(fields.bodyContains).toBeUndefined();
    expect(fields.body).toBeUndefined();
  });

  it('still edits a legacy bodyContains', () => {
    const fields = buildRequestMatch({ ...untouched(legacyMatch()), bodyContainsText: 'other' });
    expect(fields).toEqual({ headers: { 'x-token': 'abc' }, bodyContains: 'other' });
  });
});

describe('buildRequestMatch for a new rule', () => {
  it('uses the typed values', () => {
    expect(
      buildRequestMatch({
        source: undefined,
        initialHeadersText: '',
        headersText: 'x-token: abc',
        initialBodyContainsText: '',
        bodyContainsText: '"id":7',
      }),
    ).toEqual({ headers: { 'x-token': 'abc' }, bodyContains: '"id":7' });
  });

  it('omits both constraints when nothing was typed', () => {
    expect(buildRequestMatch(untouched(undefined))).toEqual({});
  });
});
