export type JsonValueKind = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';

export type JsonPath = Array<string | number>;

export function kindOf(value: unknown): JsonValueKind {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'object';
    default:
      return 'null';
  }
}

export function coerceValue(kind: JsonValueKind): unknown {
  switch (kind) {
    case 'string':
      return '';
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'object':
      return {};
    case 'array':
      return [];
    case 'null':
      return null;
  }
}

export function setIn(root: unknown, path: JsonPath, value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  if (Array.isArray(root)) {
    const copy = root.slice();
    copy[head as number] = setIn(copy[head as number], rest, value);
    return copy;
  }
  if (root && typeof root === 'object') {
    const key = String(head);
    const copy = { ...(root as Record<string, unknown>) };
    copy[key] = setIn(copy[key], rest, value);
    return copy;
  }
  return root;
}

export function removeIn(root: unknown, path: JsonPath): unknown {
  if (path.length === 0) return root;
  const [head, ...rest] = path;
  if (Array.isArray(root)) {
    const idx = head as number;
    if (rest.length === 0) return root.filter((_, i) => i !== idx);
    const copy = root.slice();
    copy[idx] = removeIn(copy[idx], rest);
    return copy;
  }
  if (root && typeof root === 'object') {
    const key = String(head);
    if (rest.length === 0) {
      const copy = { ...(root as Record<string, unknown>) };
      delete copy[key];
      return copy;
    }
    const copy = { ...(root as Record<string, unknown>) };
    copy[key] = removeIn(copy[key], rest);
    return copy;
  }
  return root;
}

/** 重命名对象属性键，保持键顺序；路径指向属性所在的父对象。 */
export function renameIn(
  root: unknown,
  parentPath: JsonPath,
  key: string,
  nextKey: string,
): unknown {
  if (!nextKey || nextKey === key) return root;
  const rebuild = (node: unknown, path: JsonPath): unknown => {
    if (path.length === 0) {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
      const src = node as Record<string, unknown>;
      if (!(key in src)) return node;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(src)) out[k === key ? nextKey : k] = v;
      return out;
    }
    const [head, ...rest] = path;
    if (Array.isArray(node)) {
      const copy = node.slice();
      copy[head as number] = rebuild(copy[head as number], rest);
      return copy;
    }
    if (node && typeof node === 'object') {
      const copy = { ...(node as Record<string, unknown>) };
      copy[String(head)] = rebuild(copy[String(head)], rest);
      return copy;
    }
    return node;
  };
  return rebuild(root, parentPath);
}
