export type JsonTokenKind = 'string' | 'number' | 'literal' | 'punct' | 'plain';

export interface JsonToken {
  text: string;
  kind: JsonTokenKind;
  depth: number;
}

export type JsonFormatResult = { ok: true; formatted: string } | { ok: false; error: string };

export type JsonParseResult = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * 按嵌套深度给 JSON 文本分词，不要求输入是合法 JSON（允许 {{faker.*}} 等模板残留）。
 * 深度规则：{ 或 [ 按当前深度输出后 depth+1；} 或 ] 先 depth-1（不小于 0）再输出。
 */
export function tokenizeJson(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === '"') {
          j += 1;
          break;
        }
        j += 1;
      }
      const end = Math.min(j, text.length);
      tokens.push({ text: text.slice(i, end), kind: 'string', depth });
      i = end;
      continue;
    }
    if (/[0-9]/.test(ch) || ((ch === '-' || ch === '+' || ch === '.') && /[0-9]/.test(text[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < text.length && /[0-9eE+\-.]/.test(text[j])) j += 1;
      tokens.push({ text: text.slice(i, j), kind: 'number', depth });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j += 1;
      const word = text.slice(i, j);
      const kind: JsonTokenKind = word === 'true' || word === 'false' || word === 'null' ? 'literal' : 'plain';
      tokens.push({ text: word, kind, depth });
      i = j;
      continue;
    }
    if (ch === '{' || ch === '[') {
      tokens.push({ text: ch, kind: 'punct', depth });
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === '}' || ch === ']') {
      depth = Math.max(0, depth - 1);
      tokens.push({ text: ch, kind: 'punct', depth });
      i += 1;
      continue;
    }
    tokens.push({ text: ch, kind: /\s/.test(ch) ? 'plain' : 'punct', depth });
    i += 1;
  }
  return tokens;
}

export function formatJson(text: string): JsonFormatResult {
  if (!text.trim()) return { ok: false, error: '内容为空' };
  try {
    return { ok: true, formatted: JSON.stringify(JSON.parse(text), null, 2) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function parseJsonBody(text: string): JsonParseResult {
  if (!text.trim()) return { ok: false, error: '内容为空' };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
