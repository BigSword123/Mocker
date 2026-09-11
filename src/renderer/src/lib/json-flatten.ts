import { kindOf, type JsonValueKind } from './json-tree';

export const PREVIEW_MAX_LENGTH = 200;
export const FLATTEN_MAX_ROWS = 200_000;

export interface JsonPathRow {
  path: string;
  kind: JsonValueKind;
  preview: string;
  /** 完整值。preview 会截断长字符串，要原文走这里。 */
  value: unknown;
  depth: number;
}

export interface FlattenOptions {
  maxRows?: number;
}

export interface FlattenResult {
  rows: JsonPathRow[];
  truncated: boolean;
}

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function appendKey(parent: string, key: string): string {
  return IDENTIFIER_PATTERN.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function previewOf(value: unknown, kind: JsonValueKind): string {
  if (kind === 'object') return `{ } ${Object.keys(value as object).length} 项`;
  if (kind === 'array') return `[ ] ${(value as unknown[]).length} 项`;
  if (kind === 'string') {
    const s = value as string;
    return s.length > PREVIEW_MAX_LENGTH ? `${s.slice(0, PREVIEW_MAX_LENGTH)}…` : s;
  }
  return String(value);
}

interface Frame {
  value: unknown;
  path: string;
  depth: number;
}

/**
 * 前序拍平成「路径 → 类型 → 值」行。用显式栈而非递归：万级深度的 JSON 会爆调用栈。
 * 子节点逆序入栈，出栈即恢复父先于子、键原序的前序遍历。
 */
export function flattenJson(value: unknown, options: FlattenOptions = {}): FlattenResult {
  const maxRows = options.maxRows ?? FLATTEN_MAX_ROWS;
  const rows: JsonPathRow[] = [];
  const stack: Frame[] = [{ value, path: '$', depth: 0 }];
  let truncated = false;

  while (stack.length > 0) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    const frame = stack.pop()!;
    const kind = kindOf(frame.value);
    rows.push({
      path: frame.path,
      kind,
      preview: previewOf(frame.value, kind),
      value: frame.value,
      depth: frame.depth,
    });
    if (kind === 'object') {
      const entries = Object.entries(frame.value as Record<string, unknown>);
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        stack.push({
          value: entries[i][1],
          path: appendKey(frame.path, entries[i][0]),
          depth: frame.depth + 1,
        });
      }
    } else if (kind === 'array') {
      const arr = frame.value as unknown[];
      for (let i = arr.length - 1; i >= 0; i -= 1) {
        stack.push({ value: arr[i], path: `${frame.path}[${i}]`, depth: frame.depth + 1 });
      }
    }
  }

  return { rows, truncated };
}
