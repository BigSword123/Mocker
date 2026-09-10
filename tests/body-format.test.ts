import { describe, expect, it } from 'vitest';
import { pretty } from '../src/renderer/src/lib/body-format';

describe('pretty', () => {
  it('合法 JSON 美化为两空格缩进', () => {
    expect(pretty('{"a":1,"b":[2]}')).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
  });

  it('非法 JSON 原样返回', () => {
    expect(pretty('not json')).toBe('not json');
  });

  it('undefined 与空串都返回空串', () => {
    expect(pretty(undefined)).toBe('');
    expect(pretty('')).toBe('');
  });

  it('超过 500_000 字符截断并追加提示行', () => {
    const out = pretty('x'.repeat(500_001));
    expect(out.endsWith('\n…（内容过长已截断）')).toBe(true);
    expect(out.length).toBe(500_000 + '\n…（内容过长已截断）'.length);
  });

  it('恰好 500_000 字符不截断', () => {
    expect(pretty('x'.repeat(500_000)).length).toBe(500_000);
  });
});
