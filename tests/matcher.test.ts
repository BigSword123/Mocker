import { describe, expect, it } from 'vitest';
import { matchRule, type RequestDescription } from '../src/main/rules/matcher';
import type { RuleMatch } from '../src/shared/types';

function req(overrides: Partial<RequestDescription> = {}): RequestDescription {
  return {
    method: 'GET',
    url: 'http://api.example.com/users?page=2',
    query: new URL('http://api.example.com/users?page=2').searchParams,
    headers: { 'content-type': 'application/json', 'x-token': 'abc' },
    body: '',
    ...overrides,
  };
}

const base: RuleMatch = { urlType: 'exact', urlPattern: 'http://api.example.com/users?page=2', method: 'ANY' };

const multipart = [
  '--BoundaryX',
  'Content-Disposition: form-data; name="user"',
  '',
  'ada',
  '--BoundaryX',
  'Content-Disposition: form-data; name="role"',
  '',
  'guest',
  '--BoundaryX',
  'Content-Disposition: form-data; name="upload"; filename="a.txt"',
  'Content-Type: text/plain',
  '',
  'file content',
  '--BoundaryX--',
  '',
].join('\r\n');

describe('matchRule', () => {
  it('matches exact url', () => {
    expect(matchRule(base, req())).toBe(true);
    expect(matchRule(base, req({ url: 'http://api.example.com/other' }))).toBe(false);
  });

  it('matches wildcard url (* and ?)', () => {
    const m: RuleMatch = { ...base, urlType: 'wildcard', urlPattern: 'http://api.example.com/*page=?' };
    expect(matchRule(m, req())).toBe(true);
    expect(matchRule({ ...m, urlPattern: 'http://other.com/*' }, req())).toBe(false);
  });

  it('wildcard without * is fully anchored and misses trailing slash', () => {
    const m: RuleMatch = { ...base, urlType: 'wildcard', urlPattern: 'http://www.baidu.com' };
    expect(matchRule(m, req({ url: 'http://www.baidu.com/' }))).toBe(false);
    const withStar: RuleMatch = { ...m, urlPattern: 'http://www.baidu.com*' };
    expect(matchRule(withStar, req({ url: 'http://www.baidu.com/' }))).toBe(true);
    expect(matchRule(withStar, req({ url: 'http://www.baidu.com/s?wd=x' }))).toBe(true);
  });

  it('matches regex url', () => {
    const m: RuleMatch = { ...base, urlType: 'regex', urlPattern: '^http://api\\.example\\.com/users.*$' };
    expect(matchRule(m, req())).toBe(true);
    expect(matchRule({ ...m, urlPattern: '[invalid' }, req())).toBe(false);
  });

  it('matches method with ANY support', () => {
    expect(matchRule({ ...base, method: 'GET' }, req())).toBe(true);
    expect(matchRule({ ...base, method: 'POST' }, req())).toBe(false);
    expect(matchRule({ ...base, method: 'ANY' }, req({ method: 'DELETE' }))).toBe(true);
  });

  it('matches all query entries', () => {
    const m: RuleMatch = { ...base, query: { page: '2' } };
    expect(matchRule(m, req())).toBe(true);
    expect(matchRule({ ...m, query: { page: '3' } }, req())).toBe(false);
  });

  it('matches repeated query keys when any value equals', () => {
    const url = 'http://x.com/?tag=b&tag=a';
    const r = req({ url, query: new URL(url).searchParams });
    const m: RuleMatch = { ...base, urlPattern: url, query: { tag: 'a' } };
    expect(matchRule(m, r)).toBe(true);
    expect(matchRule({ ...m, query: { tag: 'c' } }, r)).toBe(false);
  });

  it('matches query rows and ignores disabled ones', () => {
    const m: RuleMatch = {
      ...base,
      query: [
        { enabled: true, name: 'page', value: '2', description: '' },
        { enabled: false, name: 'page', value: '9', description: '过期条件' },
      ],
    };
    expect(matchRule(m, req())).toBe(true);

    const allDisabled: RuleMatch = {
      ...base,
      query: [{ enabled: false, name: 'page', value: '2', description: '' }],
    };
    // 与 headers 一致：行全部停用后 query 条件视为空，不再参与匹配
    expect(matchRule(allDisabled, req())).toBe(true);
  });

  it('treats wildcard special characters literally', () => {
    const m: RuleMatch = { ...base, urlType: 'wildcard', urlPattern: 'http://api.example.com/users.json' };
    expect(matchRule(m, req({ url: 'http://api.example.com/usersXjson' }))).toBe(false);
  });

  it('matches headers case-insensitively by name', () => {
    const m: RuleMatch = { ...base, headers: { 'X-Token': 'abc' } };
    expect(matchRule(m, req())).toBe(true);
    expect(matchRule({ ...m, headers: { 'X-Token': 'zzz' } }, req())).toBe(false);
  });

  it('matches headers given as HeaderRow[] and ignores disabled rows', () => {
    const enabledMatch: RuleMatch = { ...base, headers: [{ enabled: true, name: 'X-Token', value: 'abc' }] };
    expect(matchRule(enabledMatch, req())).toBe(true);

    const disabledMismatch: RuleMatch = {
      ...base,
      headers: [
        { enabled: true, name: 'X-Token', value: 'abc' },
        { enabled: false, name: 'X-Token', value: 'zzz' },
      ],
    };
    expect(matchRule(disabledMismatch, req())).toBe(true);

    const enabledMismatch: RuleMatch = { ...base, headers: [{ enabled: true, name: 'X-Token', value: 'zzz' }] };
    expect(matchRule(enabledMismatch, req())).toBe(false);
  });

  it('requires every enabled HeaderRow to match', () => {
    const allMatch: RuleMatch = {
      ...base,
      headers: [
        { enabled: true, name: 'X-Token', value: 'abc' },
        { enabled: true, name: 'Content-Type', value: 'application/json' },
      ],
    };
    expect(matchRule(allMatch, req())).toBe(true);

    const oneMissing: RuleMatch = {
      ...base,
      headers: [
        { enabled: true, name: 'X-Token', value: 'abc' },
        { enabled: true, name: 'X-Absent', value: 'v' },
      ],
    };
    expect(matchRule(oneMissing, req())).toBe(false);
  });

  it('matches when HeaderRow[] is empty or fully disabled', () => {
    expect(matchRule({ ...base, headers: [] }, req())).toBe(true);
    expect(matchRule({ ...base, headers: [{ enabled: false, name: 'X-Absent', value: 'v' }] }, req())).toBe(true);
  });

  it('matches body substring', () => {
    const m: RuleMatch = { ...base, bodyContains: '"id":1' };
    expect(matchRule(m, req({ body: '{"id":1,"x":2}' }))).toBe(true);
    expect(matchRule(m, req({ body: '{}' }))).toBe(false);
  });

  it('combines conditions with AND', () => {
    const m: RuleMatch = { ...base, method: 'GET', query: { page: '2' }, bodyContains: 'nomatch' };
    expect(matchRule(m, req())).toBe(false);
  });
});

describe('matchRule body matching', () => {
  it('mode none matches any body', () => {
    const m: RuleMatch = { ...base, body: { mode: 'none' } };
    expect(matchRule(m, req({ body: '' }))).toBe(true);
    expect(matchRule(m, req({ body: 'anything at all' }))).toBe(true);
  });

  it('mode raw defaults to contains strategy', () => {
    const m: RuleMatch = { ...base, body: { mode: 'raw', raw: '"id":1' } };
    expect(matchRule(m, req({ body: '{"id":1,"x":2}' }))).toBe(true);
    expect(matchRule(m, req({ body: '{"id":2}' }))).toBe(false);
  });

  it('mode raw with empty raw matches any body', () => {
    const m: RuleMatch = { ...base, body: { mode: 'raw' } };
    expect(matchRule(m, req({ body: 'whatever' }))).toBe(true);
  });

  it('mode raw equals requires exact body equality', () => {
    const m: RuleMatch = { ...base, body: { mode: 'raw', raw: '{"id":1}', matchStrategy: 'equals' } };
    expect(matchRule(m, req({ body: '{"id":1}' }))).toBe(true);
    expect(matchRule(m, req({ body: '{"id":1} ' }))).toBe(false);
    expect(matchRule(m, req({ body: '{"id":1,"x":2}' }))).toBe(false);
  });

  it('mode raw json-deep ignores object key order', () => {
    const m: RuleMatch = {
      ...base,
      body: { mode: 'raw', raw: '{"a":1,"b":{"c":[1,2],"d":"x"}}', matchStrategy: 'json-deep' },
    };
    expect(matchRule(m, req({ body: '{"b":{"d":"x","c":[1,2]},"a":1}' }))).toBe(true);
  });

  it('mode raw json-deep fails on mismatched value, array order, or extra keys', () => {
    const m: RuleMatch = { ...base, body: { mode: 'raw', raw: '{"a":1,"b":[1,2]}', matchStrategy: 'json-deep' } };
    expect(matchRule(m, req({ body: '{"a":2,"b":[1,2]}' }))).toBe(false);
    expect(matchRule(m, req({ body: '{"a":1,"b":[2,1]}' }))).toBe(false);
    expect(matchRule(m, req({ body: '{"a":1,"b":[1,2],"c":3}' }))).toBe(false);
    expect(matchRule(m, req({ body: '{"a":"1","b":[1,2]}' }))).toBe(false);
  });

  it('mode raw json-deep returns false for invalid json instead of throwing', () => {
    const m: RuleMatch = { ...base, body: { mode: 'raw', raw: '{"a":1}', matchStrategy: 'json-deep' } };
    expect(matchRule(m, req({ body: 'not json' }))).toBe(false);

    const badRule: RuleMatch = { ...base, body: { mode: 'raw', raw: '{oops', matchStrategy: 'json-deep' } };
    expect(matchRule(badRule, req({ body: '{"a":1}' }))).toBe(false);
  });

  it('mode urlencoded requires every enabled field and ignores disabled rows', () => {
    const m: RuleMatch = {
      ...base,
      body: {
        mode: 'urlencoded',
        form: [
          { enabled: true, name: 'user', value: 'ada' },
          { enabled: false, name: 'role', value: 'admin' },
        ],
      },
    };
    expect(matchRule(m, req({ body: 'user=ada&role=guest' }))).toBe(true);
    expect(matchRule(m, req({ body: 'user=bob' }))).toBe(false);
    expect(matchRule(m, req({ body: '' }))).toBe(false);
  });

  it('mode form-data with no enabled rows matches', () => {
    const m: RuleMatch = { ...base, body: { mode: 'form-data', form: [] } };
    expect(matchRule(m, req({ body: '' }))).toBe(true);
    const noForm: RuleMatch = { ...base, body: { mode: 'form-data' } };
    expect(matchRule(noForm, req({ body: 'x=1' }))).toBe(true);
  });

  it('mode form-data matches text fields of a real multipart body', () => {
    const m: RuleMatch = {
      ...base,
      body: { mode: 'form-data', form: [{ enabled: true, name: 'user', value: 'ada' }] },
    };
    expect(matchRule(m, req({ body: multipart }))).toBe(true);

    const both: RuleMatch = {
      ...base,
      body: {
        mode: 'form-data',
        form: [
          { enabled: true, name: 'user', value: 'ada' },
          { enabled: true, name: 'role', value: 'guest' },
        ],
      },
    };
    expect(matchRule(both, req({ body: multipart }))).toBe(true);
  });

  it('mode form-data fails when an enabled text field mismatches', () => {
    const m: RuleMatch = {
      ...base,
      body: { mode: 'form-data', form: [{ enabled: true, name: 'user', value: 'bob' }] },
    };
    expect(matchRule(m, req({ body: multipart }))).toBe(false);
  });

  it('mode form-data ignores file parts so matching them fails', () => {
    const m: RuleMatch = {
      ...base,
      body: { mode: 'form-data', form: [{ enabled: true, name: 'upload', value: 'file content' }] },
    };
    expect(matchRule(m, req({ body: multipart }))).toBe(false);
  });

  it('mode form-data ignores disabled rows that would not match', () => {
    const m: RuleMatch = {
      ...base,
      body: {
        mode: 'form-data',
        form: [
          { enabled: true, name: 'user', value: 'ada' },
          { enabled: false, name: 'role', value: 'admin' },
          { enabled: false, name: 'upload', value: 'file content' },
        ],
      },
    };
    expect(matchRule(m, req({ body: multipart }))).toBe(true);
  });

  it('mode form-data does not match urlencoded, empty or malformed bodies', () => {
    const m: RuleMatch = {
      ...base,
      body: { mode: 'form-data', form: [{ enabled: true, name: 'user', value: 'ada' }] },
    };
    expect(matchRule(m, req({ body: 'user=ada&role=guest' }))).toBe(false);
    expect(matchRule(m, req({ body: '' }))).toBe(false);
    expect(matchRule(m, req({ body: '--BoundaryX' }))).toBe(false);
    expect(matchRule(m, req({ body: '--BoundaryX\r\nContent-Disposition: form-data; name="user"' }))).toBe(false);
    const missingTerminator = ['--BoundaryX', 'Content-Disposition: form-data; name="user"', '', 'ada', ''].join(
      '\r\n',
    );
    expect(matchRule(m, req({ body: missingTerminator }))).toBe(false);
  });

  it('mode form-data handles repeated field names and empty values', () => {
    const repeated = [
      '--B',
      'Content-Disposition: form-data; name="tag"',
      '',
      'a',
      '--B',
      'Content-Disposition: form-data; name="tag"',
      '',
      'b',
      '--B',
      'Content-Disposition: form-data; name="note"',
      '',
      '',
      '--B--',
      '',
    ].join('\r\n');
    const tagB: RuleMatch = {
      ...base,
      body: { mode: 'form-data', form: [{ enabled: true, name: 'tag', value: 'b' }] },
    };
    expect(matchRule(tagB, req({ body: repeated }))).toBe(true);

    const tagC: RuleMatch = {
      ...base,
      body: { mode: 'form-data', form: [{ enabled: true, name: 'tag', value: 'c' }] },
    };
    expect(matchRule(tagC, req({ body: repeated }))).toBe(false);

    const emptyNote: RuleMatch = {
      ...base,
      body: { mode: 'form-data', form: [{ enabled: true, name: 'note', value: '' }] },
    };
    expect(matchRule(emptyNote, req({ body: repeated }))).toBe(true);
  });

  it('mode form-data keeps multi-line and CRLF-containing text values intact', () => {
    const multiline = [
      '--B',
      'Content-Disposition: form-data; name="bio"',
      'Content-Type: text/plain',
      '',
      'line one',
      'line two',
      '--B--',
      '',
    ].join('\r\n');
    const m: RuleMatch = {
      ...base,
      body: { mode: 'form-data', form: [{ enabled: true, name: 'bio', value: 'line one\r\nline two' }] },
    };
    expect(matchRule(m, req({ body: multiline }))).toBe(true);
  });

  it('mode urlencoded compares percent-decoded values', () => {
    const m: RuleMatch = {
      ...base,
      body: { mode: 'urlencoded', form: [{ enabled: true, name: 'q', value: 'hello world' }] },
    };
    expect(matchRule(m, req({ body: 'q=hello%20world' }))).toBe(true);
    expect(matchRule(m, req({ body: 'q=hello+world' }))).toBe(true);
    expect(matchRule(m, req({ body: 'q=hello' }))).toBe(false);
  });

  it('mode urlencoded matches repeated field names when any value equals', () => {
    const m: RuleMatch = {
      ...base,
      body: { mode: 'urlencoded', form: [{ enabled: true, name: 'tag', value: 'b' }] },
    };
    expect(matchRule(m, req({ body: 'tag=a&tag=b' }))).toBe(true);
    expect(matchRule(m, req({ body: 'tag=a&tag=c' }))).toBe(false);
  });

  it('prefers body over legacy bodyContains when both exist', () => {
    const m: RuleMatch = { ...base, bodyContains: 'legacy', body: { mode: 'none' } };
    expect(matchRule(m, req({ body: 'modern' }))).toBe(true);

    const strict: RuleMatch = { ...base, bodyContains: 'legacy', body: { mode: 'raw', raw: 'modern' } };
    expect(matchRule(strict, req({ body: 'legacy' }))).toBe(false);
  });
});
