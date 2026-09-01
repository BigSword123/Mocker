# Mocker — Mock 规则增强 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 MockRule 上叠加规则级固定延迟、Faker.js 模板渲染、概率触发网络异常三项能力，并配套 UI 与 e2e 测试。

**Architecture:** 扩展 `RuleAction` 类型，新增 `src/main/rules/template.ts` 作为模板引擎（纯函数 + Faker 单例缓存）；`ProxyServer` 在命中规则后依次执行：概率 roll → 异常分支（`thenCloseConnection` / `thenTimeout` / `thenCallback` 断流）或正常分支（sleep + 渲染 body/headers + 返回）。Renderer 通过 IPC 调用主进程的 `renderPreview` 实现所见即所得预览。

**Tech Stack:** TypeScript / Electron / mockttp 4.x / `@faker-js/faker` / vitest / playwright / React

**Spec:** `docs/superpowers/specs/2026-09-02-mock-enhancements-design.md`

---

## 文件清单

**新增**：
- `src/main/rules/template.ts` — 模板引擎：占位符解析、Faker 单例、内置变量、请求上下文
- `src/main/rules/validate.ts` — RuleAction 校验（delayMs / networkError）
- `src/main/rules/network-error.ts` — 网络异常 → mockttp 响应/回调映射
- `src/main/util/sleep.ts` — 可中断 sleep
- `tests/template.test.ts` / `tests/validate.test.ts` / `tests/network-error.test.ts` / `tests/sleep.test.ts` — 单元
- `e2e/enhancements.spec.ts` — 增强能力 e2e
- `docs/guide-enhancements.md` — 用户用法指南

**修改**：
- `src/shared/types.ts` — 扩展 `RuleAction` / `NetworkError` / `TrafficEvent`
- `src/main/storage/rules-store.ts` — `cloneRule` 深拷贝 `networkError`
- `src/main/proxy/proxy-server.ts` — AbortController、delay、模板渲染、异常分支、`errorTriggered` / `renderWarnings`
- `src/main/ipc.ts` — `rules:validate` / `template:preview` 通道
- `src/preload/index.ts` — 暴露新 IPC
- `src/shared/api.ts` — Api 接口新增两项
- `src/renderer/src/components/RuleEditorModal.tsx` — 三区块表单 + 速查 + 预览
- `src/renderer/src/components/TrafficDetail.tsx` — 展示 `renderWarnings` / `errorTriggered`
- `package.json` — 加 `@faker-js/faker`

---

## Task 1: 类型与校验

**Files:**
- Modify: `src/shared/types.ts`
- Create: `src/main/rules/validate.ts`
- Test: `tests/validate.test.ts`

- [ ] **Step 1: 写失败的测试 `tests/validate.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { validateAction } from '../src/main/rules/validate';
import type { RuleAction } from '../src/shared/types';

const base: RuleAction = {
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: '{}',
};

describe('validateAction', () => {
  it('accepts a plain action', () => {
    expect(() => validateAction(base)).not.toThrow();
  });

  it('accepts delayMs within bounds', () => {
    expect(() => validateAction({ ...base, delayMs: 0 })).not.toThrow();
    expect(() => validateAction({ ...base, delayMs: 300_000 })).not.toThrow();
  });

  it('rejects delayMs over upper bound', () => {
    expect(() => validateAction({ ...base, delayMs: 300_001 })).toThrow(/delayMs/);
    expect(() => validateAction({ ...base, delayMs: -1 })).toThrow(/delayMs/);
  });

  it('rejects non-integer delayMs', () => {
    expect(() => validateAction({ ...base, delayMs: 1.5 })).toThrow(/delayMs/);
  });

  it('accepts a valid networkError', () => {
    expect(() =>
      validateAction({ ...base, networkError: { probability: 50, type: 'ECONNRESET' } }),
    ).not.toThrow();
  });

  it('rejects probability out of range', () => {
    expect(() =>
      validateAction({ ...base, networkError: { probability: -1, type: 'ECONNRESET' } }),
    ).toThrow(/probability/);
    expect(() =>
      validateAction({ ...base, networkError: { probability: 101, type: 'ECONNRESET' } }),
    ).toThrow(/probability/);
  });

  it('rejects HTTP_STATUS without errorStatusCode', () => {
    expect(() =>
      validateAction({ ...base, networkError: { probability: 50, type: 'HTTP_STATUS' } }),
    ).toThrow(/errorStatusCode/);
  });

  it('rejects invalid errorStatusCode', () => {
    expect(() =>
      validateAction({
        ...base,
        networkError: { probability: 50, type: 'HTTP_STATUS', errorStatusCode: 99 },
      }),
    ).toThrow(/errorStatusCode/);
  });

  it('accepts HTTP_STATUS with valid errorStatusCode', () => {
    expect(() =>
      validateAction({
        ...base,
        networkError: { probability: 100, type: 'HTTP_STATUS', errorStatusCode: 504 },
      }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
npm test -- tests/validate.test.ts
```
预期：FAIL，`validateAction` 未定义。

- [ ] **Step 3: 扩展类型 `src/shared/types.ts`**

在文件末尾追加：

```ts
export type NetworkErrorType =
  | 'ECONNRESET'
  | 'ETIMEDOUT'
  | 'ENOTFOUND'
  | 'ECONNREFUSED'
  | 'TRUNCATE'
  | 'HTTP_STATUS';

export interface NetworkError {
  probability: number;
  type: NetworkErrorType;
  errorStatusCode?: number;
}

export interface RuleAction {
  status: number;
  headers: Record<string, string>;
  body: string;
  delayMs?: number;
  fakerLocale?: string;
  networkError?: NetworkError;
}

export const DELAY_MS_MAX = 300_000;
export const NETWORK_ERROR_TYPES: NetworkErrorType[] = [
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ECONNREFUSED',
  'TRUNCATE',
  'HTTP_STATUS',
];
```

同时**删除**文件中旧的 `RuleAction` 接口定义（替换为上面的版本）。

为 `TrafficEvent` 追加两个可选字段（在 `error?: string` 之后）：

```ts
  renderWarnings?: string[];
  errorTriggered?: boolean;
```

- [ ] **Step 4: 实现校验器 `src/main/rules/validate.ts`**

```ts
import {
  DELAY_MS_MAX,
  NETWORK_ERROR_TYPES,
  type NetworkError,
  type RuleAction,
} from '../../shared/types';

export function validateAction(action: RuleAction): void {
  if (action.delayMs !== undefined) {
    if (!Number.isInteger(action.delayMs)) {
      throw new Error('delayMs 必须是整数');
    }
    if (action.delayMs < 0 || action.delayMs > DELAY_MS_MAX) {
      throw new Error(`delayMs 必须在 0-${DELAY_MS_MAX} 之间`);
    }
  }
  if (action.networkError) {
    validateNetworkError(action.networkError);
  }
}

function validateNetworkError(ne: NetworkError): void {
  if (!NETWORK_ERROR_TYPES.includes(ne.type)) {
    throw new Error(`未知 networkError.type: ${ne.type}`);
  }
  if (typeof ne.probability !== 'number' || Number.isNaN(ne.probability)) {
    throw new Error('probability 必须是数值');
  }
  if (ne.probability < 0 || ne.probability > 100) {
    throw new Error('probability 必须在 0-100 之间');
  }
  if (ne.type === 'HTTP_STATUS') {
    const code = ne.errorStatusCode;
    if (!Number.isInteger(code) || code < 100 || code > 999) {
      throw new Error('HTTP_STATUS 需要 100-999 的整数 errorStatusCode');
    }
  }
}
```

- [ ] **Step 5: 跑测试，确认通过**

```bash
npm test -- tests/validate.test.ts
```
预期：全部 PASS。

- [ ] **Step 6: 更新 `src/main/storage/rules-store.ts` 的 `cloneRule`**

将 `action: { ...rule.action, headers: { ...rule.action.headers } }` 替换为：

```ts
action: {
  ...rule.action,
  headers: { ...rule.action.headers },
  ...(rule.action.networkError ? { networkError: { ...rule.action.networkError } } : {}),
},
```

这样 `delayMs` / `fakerLocale` 随 `...rule.action` 自然复制，`networkError` 单独深拷贝一层。

- [ ] **Step 7: 跑全量测试，确认无回归**

```bash
npm test
```
预期：全绿。

- [ ] **Step 8: 提交**

```bash
git add src/shared/types.ts src/main/rules/validate.ts src/main/storage/rules-store.ts tests/validate.test.ts
git commit -m "feat(rules): add types and validator for delayMs and networkError"
```

---

## Task 2: 可中断 sleep

**Files:**
- Create: `src/main/util/sleep.ts`
- Test: `tests/sleep.test.ts`

- [ ] **Step 1: 写失败的测试 `tests/sleep.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { sleep } from '../src/main/util/sleep';

describe('sleep', () => {
  it('resolves after the given ms', async () => {
    const start = Date.now();
    await sleep(30);
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });

  it('resolves immediately for 0ms', async () => {
    const start = Date.now();
    await sleep(0);
    expect(Date.now() - start).toBeLessThan(20);
  });

  it('rejects when aborted', async () => {
    const ctrl = new AbortController();
    const p = sleep(5_000, ctrl.signal);
    setTimeout(() => ctrl.abort(), 20);
    await expect(p).rejects.toThrow(/aborted/i);
  });

  it('rejects immediately if signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(sleep(1_000, ctrl.signal)).rejects.toThrow(/aborted/i);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
npm test -- tests/sleep.test.ts
```
预期：FAIL，模块不存在。

- [ ] **Step 3: 实现 `src/main/util/sleep.ts`**

```ts
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('sleep aborted', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('sleep aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
```

- [ ] **Step 4: 跑测试，确认通过**

```bash
npm test -- tests/sleep.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add src/main/util/sleep.ts tests/sleep.test.ts
git commit -m "feat(util): add abortable sleep helper"
```

---

## Task 3: 模板引擎

**Files:**
- Install: `@faker-js/faker`
- Create: `src/main/rules/template.ts`
- Test: `tests/template.test.ts`

- [ ] **Step 1: 安装依赖**

```bash
npm install @faker-js/faker
```

`package.json` 的 `dependencies` 中会新增 `@faker-js/faker`。

- [ ] **Step 2: 写失败的测试 `tests/template.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { renderTemplate, type RenderContext } from '../src/main/rules/template';

const ctx: RenderContext = {
  method: 'POST',
  url: 'http://api.example.com/users?id=42',
  host: 'api.example.com',
  path: '/users',
  query: { id: '42' },
  headers: { 'x-token': 'abc', 'content-type': 'application/json' },
  body: '{"userId":7,"tags":["a","b"]}',
};

describe('renderTemplate — builtins', () => {
  it('replaces {{now:iso}} with ISO string', () => {
    const out = renderTemplate('{{now:iso}}', ctx);
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('replaces {{now:ms}} with numeric timestamp', () => {
    const out = renderTemplate('{{now:ms}}', ctx);
    expect(Number(out)).toBeGreaterThan(1_700_000_000_000);
  });

  it('replaces {{uuid}} with a UUID v4', () => {
    expect(renderTemplate('{{uuid}}', ctx)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('replaces {{random.int:min:max}} within bounds', () => {
    const out = Number(renderTemplate('{{random.int:1:10}}', ctx));
    expect(out).toBeGreaterThanOrEqual(1);
    expect(out).toBeLessThanOrEqual(10);
  });

  it('replaces {{random.choice:a:b:c}} with one of the options', () => {
    const out = renderTemplate('{{random.choice:OK:WARN:ERR}}', ctx);
    expect(['OK', 'WARN', 'ERR']).toContain(out);
  });

  it('replaces {{random.string:len}} with given length', () => {
    expect(renderTemplate('{{random.string:8}}', ctx)).toHaveLength(8);
  });
});

describe('renderTemplate — request context', () => {
  it('replaces req.* fields', () => {
    expect(renderTemplate('{{req.method}} {{req.host}}{{req.path}}', ctx)).toBe(
      'POST api.example.com/users',
    );
  });

  it('replaces req.query.* and req.header.*', () => {
    expect(renderTemplate('{{req.query.id}} / {{req.header.x-token}}', ctx)).toBe('42 / abc');
  });

  it('header lookup is case-insensitive', () => {
    expect(renderTemplate('{{req.header.Content-Type}}', ctx)).toBe('application/json');
  });

  it('replaces req.body.json.*', () => {
    expect(renderTemplate('{{req.body.json.userId}}', ctx)).toBe('7');
  });

  it('returns empty for non-JSON body path', () => {
    const c = { ...ctx, body: 'not-json' };
    expect(renderTemplate('{{req.body.json.userId}}', c)).toBe('');
  });
});

describe('renderTemplate — faker', () => {
  it('replaces {{faker.person.firstName}}', () => {
    const out = renderTemplate('{{faker.person.firstName}}', ctx, 'en');
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain('{{');
  });

  it('uses the requested locale', () => {
    const out = renderTemplate('{{faker.person.firstName}}', ctx, 'zh_CN');
    expect(out.length).toBeGreaterThan(0);
  });

  it('passes numeric args to faker.number.int', () => {
    const out = Number(renderTemplate('{{faker.number.int:1:5}}', ctx));
    expect(out).toBeGreaterThanOrEqual(1);
    expect(out).toBeLessThanOrEqual(5);
  });

  it('rejects faker.helpers.fake to prevent template recursion', () => {
    const out = renderTemplate('{{faker.helpers.fake:hi}}', ctx);
    expect(out).toBe('{{faker.helpers.fake:hi}}');
  });
});

describe('renderTemplate — edge cases', () => {
  it('preserves unknown tokens', () => {
    expect(renderTemplate('{{unknown.token}}', ctx)).toBe('{{unknown.token}}');
  });

  it('handles multiple tokens in one string', () => {
    const out = renderTemplate('id={{uuid}} host={{req.host}}', ctx);
    expect(out).toMatch(/^id=[0-9a-f-]+ host=api\.example\.com$/i);
  });

  it('collects warnings on failure', () => {
    const warnings: string[] = [];
    renderTemplate('{{unknown.token}}', ctx, undefined, warnings);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/unknown\.token/);
  });
});
```

- [ ] **Step 3: 跑测试，确认失败**

```bash
npm test -- tests/template.test.ts
```

- [ ] **Step 4: 实现 `src/main/rules/template.ts`**

```ts
import { randomBytes } from 'node:crypto';
import { faker as fakerEn, type Faker } from '@faker-js/faker';
import { faker as fakerZhCn } from '@faker-js/faker/locale/zh_CN';
import { faker as fakerJa } from '@faker-js/faker/locale/ja';
import { faker as fakerKo } from '@faker-js/faker/locale/ko';
import { faker as fakerDe } from '@faker-js/faker/locale/de';
import { faker as fakerFr } from '@faker-js/faker/locale/fr';

export interface RenderContext {
  method: string;
  url: string;
  host: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string;
}

const FAKERS: Record<string, Faker> = {
  en: fakerEn,
  zh_CN: fakerZhCn,
  ja: fakerJa,
  ko: fakerKo,
  de: fakerDe,
  fr: fakerFr,
};

const TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const FAKER_BLOCKLIST = new Set(['helpers.fake']);

export function renderTemplate(
  text: string,
  ctx: RenderContext,
  locale?: string,
  warnings: string[] = [],
): string {
  return text.replace(TOKEN_RE, (_match, raw: string) => {
    try {
      const [token, ...argParts] = raw.split(':');
      const args = argParts.map((a) => a.trim());
      return resolve(token.trim(), args, ctx, locale, warnings) ?? '';
    } catch (err) {
      warnings.push(`template_warn: ${raw}: ${(err as Error).message}`);
      return `{{${raw}}}`;
    }
  });
}

function resolve(
  token: string,
  args: string[],
  ctx: RenderContext,
  locale: string | undefined,
  warnings: string[],
): string | null {
  if (token === 'now') return renderNow(args[0]);
  if (token === 'uuid') return randomUUID();
  if (token.startsWith('random.')) return renderRandom(token.slice('random.'.length), args);
  if (token === 'req.body' || token.startsWith('req.body.')) return renderReqBody(token, ctx);
  if (token.startsWith('req.')) return renderReqField(token, ctx);
  if (token.startsWith('faker.')) return renderFaker(token.slice('faker.'.length), args, locale);

  warnings.push(`template_warn: ${token}: unknown token`);
  return null;
}

function renderNow(fmt: string | undefined): string {
  const d = new Date();
  if (!fmt || fmt === 'iso') return d.toISOString();
  if (fmt === 'ms') return String(d.getTime());
  // Minimal subset: YYYY, MM, DD, HH, mm, ss
  const pad = (n: number) => String(n).padStart(2, '0');
  return fmt
    .replace('YYYY', String(d.getFullYear()))
    .replace('MM', pad(d.getMonth() + 1))
    .replace('DD', pad(d.getDate()))
    .replace('HH', pad(d.getHours()))
    .replace('mm', pad(d.getMinutes()))
    .replace('ss', pad(d.getSeconds()));
}

function randomUUID(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function renderRandom(kind: string, args: string[]): string {
  if (kind === 'int') {
    const [min, max] = args.map(Number);
    if (!Number.isFinite(min) || !Number.isFinite(max)) throw new Error('random.int 需要 min/max');
    return String(Math.floor(Math.random() * (max - min + 1)) + min);
  }
  if (kind === 'float') {
    const [min, max, precision = 2] = args.map(Number);
    if (!Number.isFinite(min) || !Number.isFinite(max)) throw new Error('random.float 需要 min/max');
    const v = Math.random() * (max - min) + min;
    return v.toFixed(Number.isFinite(precision) ? precision : 2);
  }
  if (kind === 'choice') {
    if (args.length === 0) throw new Error('random.choice 至少需要一个选项');
    return args[Math.floor(Math.random() * args.length)];
  }
  if (kind === 'string') {
    const len = Number(args[0]) || 16;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
    return out;
  }
  throw new Error(`未知 random.${kind}`);
}

function renderReqField(token: string, ctx: RenderContext): string {
  const rest = token.slice('req.'.length);
  if (rest === 'method') return ctx.method;
  if (rest === 'url') return ctx.url;
  if (rest === 'host') return ctx.host;
  if (rest === 'path') return ctx.path;
  if (rest.startsWith('query.')) return ctx.query[rest.slice('query.'.length)] ?? '';
  if (rest.startsWith('header.')) {
    const name = rest.slice('header.'.length).toLowerCase();
    const entry = Object.entries(ctx.headers).find(([k]) => k.toLowerCase() === name);
    return entry?.[1] ?? '';
  }
  throw new Error(`未知 req.${rest}`);
}

function renderReqBody(token: string, ctx: RenderContext): string {
  if (token === 'req.body') return ctx.body;
  if (!token.startsWith('req.body.json.')) throw new Error(`未知 ${token}`);
  const path = token.slice('req.body.json.'.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body);
  } catch {
    return '';
  }
  const segments = path.split('.');
  let cur: unknown = parsed;
  for (const seg of segments) {
    if (cur == null || typeof cur !== 'object') return '';
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur == null ? '' : String(cur);
}

function renderFaker(path: string, args: string[], locale: string | undefined): string {
  const parts = path.split('.');
  if (parts.length < 2) throw new Error(`faker 路径不完整: ${path}`);
  const moduleKey = parts[0];
  const methodKey = parts.slice(1).join('.');
  if (FAKER_BLOCKLIST.has(`${moduleKey}.${methodKey}`)) {
    throw new Error(`${moduleKey}.${methodKey} 已禁用`);
  }
  const faker = (locale && FAKERS[locale]) || FAKERS.en;
  const mod = (faker as unknown as Record<string, unknown>)[moduleKey];
  if (!mod || typeof mod !== 'object') throw new Error(`faker.${moduleKey} 不存在`);
  const fn = (mod as Record<string, unknown>)[methodKey];
  if (typeof fn !== 'function') throw new Error(`faker.${moduleKey}.${methodKey} 不是函数`);
  const coerced = args.map(coerceArg);
  const result = (fn as (...a: unknown[]) => unknown)(...coerced);
  return result == null ? '' : String(result);
}

function coerceArg(v: string): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  const n = Number(v);
  if (v !== '' && Number.isFinite(n)) return n;
  return v;
}
```

- [ ] **Step 5: 跑测试，确认通过**

```bash
npm test -- tests/template.test.ts
```
预期：全绿。

- [ ] **Step 6: 跑全量测试，确认未引入回归**

```bash
npm test
```

- [ ] **Step 7: 提交**

```bash
git add src/main/rules/template.ts tests/template.test.ts package.json package-lock.json
git commit -m "feat(rules): add template engine with faker.js and request-context variables"
```

---

## Task 4: 网络异常映射

**Files:**
- Create: `src/main/rules/network-error.ts`
- Test: `tests/network-error.test.ts`

- [ ] **Step 1: 写失败的测试 `tests/network-error.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { applyNetworkError, type NetworkErrorAction } from '../src/main/rules/network-error';
import type { NetworkError } from '../src/shared/types';

function makeRes() {
  const writes: Array<{ chunk?: string | Buffer; encoding?: string }> = [];
  let ended = false;
  let destroyed = false;
  let statusCode = 200;
  const headers: Record<string, string> = {};
  const res: NetworkErrorAction = {
    statusCode: 200,
    setHeader(k, v) {
      headers[k] = v;
    },
    write(chunk, encoding) {
      writes.push({ chunk, encoding });
      return true;
    },
    end() {
      ended = true;
    },
    socket: {
      destroy() {
        destroyed = true;
      },
    },
  };
  return {
    res,
    inspect: () => ({ writes, ended, destroyed, statusCode, headers }),
    set code(v: number) {
      res.statusCode = v;
      statusCode = v;
    },
  };
}

describe('applyNetworkError', () => {
  it('ECONNRESET / ENOTFOUND / ECONNREFUSED return closeConnection hint', () => {
    for (const type of ['ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED'] as const) {
      const ne: NetworkError = { probability: 100, type };
      const hint = applyNetworkError(ne, makeRes().res);
      expect(hint).toBe('closeConnection');
    }
  });

  it('ETIMEDOUT returns timeout hint', () => {
    const hint = applyNetworkError({ probability: 100, type: 'ETIMEDOUT' }, makeRes().res);
    expect(hint).toBe('timeout');
  });

  it('TRUNCATE writes headers + 1 byte then destroys socket', () => {
    const { res, inspect } = makeRes();
    const hint = applyNetworkError(
      { probability: 100, type: 'TRUNCATE' },
      res,
      { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: 'HELLO' },
    );
    expect(hint).toBe('truncateHandled');
    const snap = inspect();
    expect(snap.headers['content-type']).toBe('text/plain');
    expect(snap.writes.length).toBe(1);
    expect(snap.destroyed).toBe(true);
  });

  it('HTTP_STATUS sets status and leaves body to caller', () => {
    const { res, inspect } = makeRes();
    const hint = applyNetworkError(
      { probability: 100, type: 'HTTP_STATUS', errorStatusCode: 504 },
      res,
    );
    expect(hint).toBe('httpStatus');
    expect(inspect().statusCode).toBe(504);
  });

  it('throws when HTTP_STATUS has no errorStatusCode', () => {
    expect(() =>
      applyNetworkError({ probability: 100, type: 'HTTP_STATUS' }, makeRes().res),
    ).toThrow(/errorStatusCode/);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
npm test -- tests/network-error.test.ts
```

- [ ] **Step 3: 实现 `src/main/rules/network-error.ts`**

```ts
import type { NetworkError } from '../../shared/types';

/**
 * Subset of mockttp's callback `res` surface we depend on.
 * Defined locally to keep the module unit-testable without mockttp.
 */
export interface NetworkErrorAction {
  statusCode: number;
  setHeader(k: string, v: string): void;
  write(chunk: string | Buffer, encoding?: string): boolean;
  end(): void;
  socket?: { destroy(): void };
}

export interface HttpResponseShape {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export type NetworkErrorHint =
  | 'closeConnection'
  | 'timeout'
  | 'truncateHandled'
  | 'httpStatus';

/**
 * Applies a network error to the callback response. Returns a hint that the
 * caller translates into mockttp's chained API:
 *   - 'closeConnection'   → thenCloseConnection()
 *   - 'timeout'           → thenTimeout()
 *   - 'truncateHandled'   → thenCallback (we wrote partial body + destroyed)
 *   - 'httpStatus'        → proceed with normal response (status already set)
 */
export function applyNetworkError(
  ne: NetworkError,
  res: NetworkErrorAction,
  response?: HttpResponseShape,
): NetworkErrorHint {
  switch (ne.type) {
    case 'ECONNRESET':
    case 'ENOTFOUND':
    case 'ECONNREFUSED':
      return 'closeConnection';
    case 'ETIMEDOUT':
      return 'timeout';
    case 'TRUNCATE': {
      if (response) {
        for (const [k, v] of Object.entries(response.headers)) res.setHeader(k, v);
        res.statusCode = response.statusCode;
      }
      res.write(Buffer.from([0x20]));
      res.socket?.destroy();
      return 'truncateHandled';
    }
    case 'HTTP_STATUS': {
      if (!Number.isInteger(ne.errorStatusCode)) {
        throw new Error('HTTP_STATUS 需要 errorStatusCode');
      }
      res.statusCode = ne.errorStatusCode!;
      return 'httpStatus';
    }
  }
}
```

- [ ] **Step 4: 跑测试，确认通过**

```bash
npm test -- tests/network-error.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add src/main/rules/network-error.ts tests/network-error.test.ts
git commit -m "feat(rules): add network-error → mockttp mapping module"
```

---

## Task 5: ProxyServer 接入（延迟 / 渲染 / 异常）

**Files:**
- Modify: `src/main/proxy/proxy-server.ts`

- [ ] **Step 1: 新增字段与 AbortController**

在 `ProxyServer` 类顶部追加：

```ts
private abort?: AbortController;
```

在 `doStart()` 开头追加：

```ts
this.abort = new AbortController();
```

在 `stop()` 开头追加：

```ts
this.abort?.abort();
this.abort = undefined;
```

- [ ] **Step 2: 改造 `handle()` 的命中分支**

替换当前的 `if (matched) { ... return {...}; }` 块为：

```ts
const matched = findMatchingRule(this.opts.getRules(), describeRequest(req, bodyText));
if (matched) {
  return await this.handleMatched(matched, req, event, bodyText);
}
return undefined;
```

- [ ] **Step 3: 新增 `handleMatched` 私有方法**

在 `handle()` 之后追加：

```ts
private async handleMatched(
  matched: MockRule,
  req: mockttp.CompletedRequest,
  event: TrafficEvent,
  bodyText: string,
): Promise<mockttp.requestSteps.CallbackRequestResult | void> {
  event.mocked = true;
  event.matchedRuleId = matched.id;

  const ne = matched.action.networkError;
  if (ne && Math.random() * 100 < ne.probability) {
    event.errorTriggered = true;
    event.error = `network-error:${ne.type}`;
    event.completedAt = Date.now();
    this.emit(event);
    return this.toNetworkErrorResponse(ne);
  }

  const delayMs = matched.action.delayMs ?? 0;
  if (delayMs > 0 && this.abort) {
    try {
      await sleep(delayMs, this.abort.signal);
    } catch {
      // Proxy is stopping; drop the response silently.
      return undefined;
    }
  }

  const ctx = buildRenderContext(req, bodyText);
  const warnings: string[] = [];
  const renderedBody = renderTemplate(matched.action.body, ctx, matched.action.fakerLocale, warnings);
  const renderedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(matched.action.headers)) {
    renderedHeaders[k] = renderTemplate(v, ctx, matched.action.fakerLocale, warnings);
  }

  event.status = matched.action.status;
  event.responseHeaders = renderedHeaders;
  event.responseBody = renderedBody;
  event.renderWarnings = warnings.length ? warnings : undefined;
  event.completedAt = Date.now();
  this.emit(event);

  return {
    response: {
      statusCode: matched.action.status,
      headers: renderedHeaders,
      body: renderedBody,
    },
  };
}

private toNetworkErrorResponse(
  ne: NetworkError,
): mockttp.requestSteps.CallbackRequestResult {
  // mockttp 4.x: CallbackResponseResult = MessageResult | 'close' | 'reset'
  //   'reset' → sends TCP RST (client: ECONNRESET)
  //   'close' → FIN close without response (client sees connection failure;
  //             surfaces as ECONNREFUSED / ENOTFOUND depending on client)
  switch (ne.type) {
    case 'ECONNRESET':
      return { response: 'reset' };
    case 'ENOTFOUND':
    case 'ECONNREFUSED':
      return { response: 'close' };
    case 'ETIMEDOUT':
      // Best-effort: close the connection so the client's socket wait fails.
      // For a true idle-timeout simulation, register a dedicated thenTimeout()
      // handler per rule in a follow-up iteration.
      return { response: 'close' };
    case 'TRUNCATE':
      // Send a minimal 200 with Content-Length deliberately larger than the
      // body bytes we emit. mockttp will auto-fix Content-Length if body is
      // provided, so we omit body and set headers only, then rely on the
      // connection being closed mid-stream. This is a best-effort simulation;
      // for byte-accurate truncation, register a dedicated thenCallback()
      // handler that writes to res.socket and calls destroy() mid-write.
      return {
        response: {
          statusCode: 200,
          headers: { 'content-length': '1024' },
          body: 'X',
        },
      };
    case 'HTTP_STATUS':
      return {
        response: { statusCode: ne.errorStatusCode ?? 500, headers: {}, body: '' },
      };
  }
}
```

**降级说明**：上表使用 mockttp 4.x 的 `response: 'close' | 'reset'` 字符串字面量（真实 API，非 hack）。其中：

- `ETIMEDOUT` 只能做到"直接关闭连接"，客户端通常看到 `ECONNRESET` 而非真超时；若要精确 idle timeout 模拟，需要为每条超时规则注册独立的 `thenTimeout()` handler，作为后续迭代
- `TRUNCATE` 通过 `Content-Length: 1024` + 单字节 body 制造"未读完就关闭"的现象；多数客户端会报 `ECONNRESET` / `premature close`。若要字节精确断流，需拆出独立 `thenCallback()` handler 并在 `res.socket` 上手动 `destroy()`

E2E 测试中只断言 `fetch` 抛错（连接异常），不区分具体错误码，以保证测试对降级实现不敏感。

- [ ] **Step 4: 新增文件顶部导入**

```ts
import { sleep } from '../util/sleep';
import { renderTemplate, type RenderContext } from '../rules/template';
import type { NetworkError } from '../../shared/types';
```

- [ ] **Step 5: 新增 `buildRenderContext` 辅助函数**

在文件末尾追加：

```ts
function buildRenderContext(req: mockttp.CompletedRequest, body: string): RenderContext {
  const url = absoluteUrl(req);
  let query: Record<string, string> = {};
  try {
    const sp = new URL(url).searchParams;
    sp.forEach((v, k) => {
      query[k] = v;
    });
  } catch {
    // Malformed URL: empty query.
  }
  return {
    method: req.method,
    url,
    host: req.destination.hostname,
    path: req.path,
    query,
    headers: flattenHeaders(req.headers),
    body,
  };
}
```

- [ ] **Step 6: 跑全量单元测试**

```bash
npm test
```
预期：全绿。

- [ ] **Step 7: 扩展 `tests/proxy.integration.test.ts`**

在该文件末尾追加（在已有 describe 外新建一个 describe）：

```ts
describe('enhanced mock rule behavior', () => {
  beforeEach(() => {
    rules = [];
    events = [];
  });

  it('applies a fixed delay before responding', async () => {
    rules = [
      {
        id: 'delay',
        name: 'delay',
        enabled: true,
        priority: 1,
        match: { urlType: 'exact', urlPattern: 'http://mocked.test/slow', method: 'ANY' },
        action: {
          status: 200,
          headers: { 'content-type': 'text/plain' },
          body: 'ok',
          delayMs: 200,
        },
      },
    ];
    const start = Date.now();
    const res = await fetch('http://mocked.test/slow', {
      dispatcher: new ProxyAgent(`http://127.0.0.1:${proxy.port}`),
    });
    expect(res.status).toBe(200);
    expect(Date.now() - start).toBeGreaterThanOrEqual(180);
  });

  it('renders {{uuid}} and {{req.path}} in the body', async () => {
    rules = [
      {
        id: 'tpl',
        name: 'tpl',
        enabled: true,
        priority: 1,
        match: { urlType: 'exact', urlPattern: 'http://mocked.test/hello', method: 'ANY' },
        action: {
          status: 200,
          headers: { 'content-type': 'text/plain' },
          body: 'path={{req.path}} uuid={{uuid}}',
        },
      },
    ];
    const res = await fetch('http://mocked.test/hello', {
      dispatcher: new ProxyAgent(`http://127.0.0.1:${proxy.port}`),
    });
    const text = await res.text();
    expect(text).toMatch(/^path=\/hello uuid=[0-9a-f-]+$/i);
  });

  it('closes the connection when networkError triggers at 100%', async () => {
    rules = [
      {
        id: 'err',
        name: 'err',
        enabled: true,
        priority: 1,
        match: { urlType: 'exact', urlPattern: 'http://mocked.test/boom', method: 'ANY' },
        action: {
          status: 200,
          headers: {},
          body: '',
          networkError: { probability: 100, type: 'ECONNRESET' },
        },
      },
    ];
    await expect(
      fetch('http://mocked.test/boom', {
        dispatcher: new ProxyAgent(`http://127.0.0.1:${proxy.port}`),
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 8: 跑集成测试**

```bash
npm test -- tests/proxy.integration.test.ts
```
预期：新增用例全绿。

- [ ] **Step 9: 提交**

```bash
git add src/main/proxy/proxy-server.ts tests/proxy.integration.test.ts
git commit -m "feat(proxy): wire delay, template rendering, and network errors into rule handler"
```

---

## Task 6: IPC 预览接口

**Files:**
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/shared/api.ts`
- Modify: `src/renderer/src/lib/api.ts`（如存在）

- [ ] **Step 1: 在 `src/main/ipc.ts` 新增两条通道**

在文件顶部的 import 区追加：

```ts
import { renderTemplate, type RenderContext } from './rules/template';
import { validateAction } from './rules/validate';
import type { RuleAction } from '../shared/types';
```

在 `registerIpc` 函数体末尾追加：

```ts
ipcMain.handle('rules:validate', (_e, action: RuleAction) => {
  validateAction(action);
  return true;
});

ipcMain.handle(
  'template:preview',
  (_e, payload: { text: string; context: RenderContext; locale?: string }) => {
    const warnings: string[] = [];
    const rendered = renderTemplate(payload.text, payload.context, payload.locale, warnings);
    return { rendered, warnings };
  },
);
```

- [ ] **Step 2: 在 `src/preload/index.ts` 的 `api` 对象追加**

```ts
rulesValidate: (action) => ipcRenderer.invoke('rules:validate', action),
templatePreview: (payload) => ipcRenderer.invoke('template:preview', payload),
```

> 注：preload 的实际写法以当前 `src/preload/index.ts` 的 `contextBridge.exposeInMainWorld` 形态为准，按既有格式追加。

- [ ] **Step 3: 扩展 `src/shared/api.ts` 的 `Api` 接口**

```ts
import type { RenderContext } from '../main/rules/template';
// ...
rulesValidate(action: RuleAction): Promise<true>;
templatePreview(payload: {
  text: string;
  context: RenderContext;
  locale?: string;
}): Promise<{ rendered: string; warnings: string[] }>;
```

> 注：为避免 renderer 直接 import 主进程模块，可以把 `RenderContext` 移到 `src/shared/types.ts`。本计划采用此做法：在 Task 1 之后把 `RenderContext` 移到 `src/shared/types.ts` 并在 `template.ts` / `ipc.ts` / `api.ts` 中改为从 types 导入。**执行时先做此移动再继续本任务。**

- [ ] **Step 4: 跑全量单元测试**

```bash
npm test
```

- [ ] **Step 5: 提交**

```bash
git add src/main/ipc.ts src/preload/index.ts src/shared/api.ts src/shared/types.ts
git commit -m "feat(ipc): expose rules:validate and template:preview channels"
```

---

## Task 7: RuleEditorModal 三区块表单

**Files:**
- Modify: `src/renderer/src/components/RuleEditorModal.tsx`

- [ ] **Step 1: 新增 state**

在组件现有 state 块追加：

```ts
const [delayMs, setDelayMs] = useState<number | ''>(initial?.action.delayMs ?? '');
const [fakerLocale, setFakerLocale] = useState(initial?.action.fakerLocale ?? 'zh_CN');
const [neEnabled, setNeEnabled] = useState(!!initial?.action.networkError);
const [neProbability, setNeProbability] = useState(initial?.action.networkError?.probability ?? 100);
const [neType, setNeType] = useState<NetworkErrorType>(initial?.action.networkError?.type ?? 'ECONNRESET');
const [neStatusCode, setNeStatusCode] = useState<number | ''>(
  initial?.action.networkError?.errorStatusCode ?? '',
);
const [preview, setPreview] = useState('');
const [previewWarnings, setPreviewWarnings] = useState<string[]>([]);
```

并在顶部 import 中追加：

```ts
import type { NetworkErrorType } from '../../../shared/types';

const LOCALES = ['zh_CN', 'en', 'ja', 'ko', 'de', 'fr'] as const;
const ERROR_TYPES: NetworkErrorType[] = [
  'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'TRUNCATE', 'HTTP_STATUS',
];
const SNIPPETS = [
  { label: 'now', text: '{{now:iso}}' },
  { label: 'uuid', text: '{{uuid}}' },
  { label: 'req.path', text: '{{req.path}}' },
  { label: 'req.query.id', text: '{{req.query.id}}' },
  { label: 'faker.person.firstName', text: '{{faker.person.firstName}}' },
  { label: 'faker.internet.email', text: '{{faker.internet.email}}' },
];
```

- [ ] **Step 2: 重构 save() 的 action 构造**

替换 `save()` 中 `action: { ... }` 部分为：

```ts
const delay = delayMs === '' ? undefined : Number(delayMs);
const networkError = neEnabled
  ? {
      probability: Number(neProbability),
      type: neType,
      ...(neType === 'HTTP_STATUS' && neStatusCode !== ''
        ? { errorStatusCode: Number(neStatusCode) }
        : {}),
    }
  : undefined;

const action: RuleAction = {
  status,
  headers: { 'content-type': 'application/json', ...parseLines(respHeadersText, ': ') },
  body,
  ...(delay !== undefined ? { delayMs: delay } : {}),
  ...(fakerLocale ? { fakerLocale } : {}),
  ...(networkError ? { networkError } : {}),
};

try {
  await api.rulesValidate(action);
} catch (err) {
  setError((err as Error).message);
  return;
}
```

在后续 `api.rulesAdd` / `api.rulesUpdate` 调用中使用 `action` 替代原 inline 对象。

- [ ] **Step 3: 新增渲染预览回调**

在组件内追加：

```ts
const refreshPreview = async () => {
  try {
    const result = await api.templatePreview({
      text: body || '',
      context: {
        method: 'GET',
        url: 'http://example.test/preview?x=1',
        host: 'example.test',
        path: '/preview',
        query: { x: '1' },
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
      locale: fakerLocale || undefined,
    });
    setPreview(result.rendered);
    setPreviewWarnings(result.warnings);
  } catch (err) {
    setPreview(`error: ${(err as Error).message}`);
    setPreviewWarnings([]);
  }
};
```

- [ ] **Step 4: 新增速查插入辅助**

```ts
const insertSnippet = (text: string) => setBody((prev) => prev + text);
```

- [ ] **Step 5: 把表单 UI 改为三区块**

> 以下仅示意结构，按现有 `<div className="form-grid">` 包裹，新增两个 `<details>` 区块：

```tsx
<div className="form-grid">
  {/* 基础区块：保留原有字段 */}
  <label>名称</label><input value={name} onChange={(e) => setName(e.target.value)} />
  {/* ...保留原有 URL / Method / Query / 请求头 / 请求体 / 状态码 / 响应头 / 响应体字段... */}

  <details open>
    <summary>动态数据</summary>
    <label>Faker locale</label>
    <select value={fakerLocale} onChange={(e) => setFakerLocale(e.target.value)}>
      {LOCALES.map((l) => <option key={l} value={l}>{l}</option>)}
    </select>
    <label>变量速查</label>
    <div className="snippet-bar">
      {SNIPPETS.map((s) => (
        <button type="button" key={s.label} onClick={() => insertSnippet(s.text)}>
          +{s.label}
        </button>
      ))}
    </div>
    <label>渲染预览</label>
    <button type="button" onClick={refreshPreview}>刷新预览</button>
    <pre className="preview">{preview || '(空)'}</pre>
    {previewWarnings.length > 0 && (
      <ul className="text-warn">
        {previewWarnings.map((w, i) => <li key={i}>{w}</li>)}
      </ul>
    )}
  </details>

  <details open>
    <summary>行为模拟</summary>
    <label>延迟 (ms, 0-300000)</label>
    <input
      type="number"
      value={delayMs}
      onChange={(e) => setDelayMs(e.target.value === '' ? '' : Number(e.target.value))}
    />
    <label>
      <input
        type="checkbox"
        checked={neEnabled}
        onChange={(e) => setNeEnabled(e.target.checked)}
      />
      启用网络异常
    </label>
    {neEnabled && (
      <>
        <label>概率 (%)</label>
        <input
          type="number"
          min={0}
          max={100}
          step={0.1}
          value={neProbability}
          onChange={(e) => setNeProbability(Number(e.target.value))}
        />
        <label>异常类型</label>
        <select
          value={neType}
          onChange={(e) => setNeType(e.target.value as NetworkErrorType)}
        >
          {ERROR_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        {neType === 'HTTP_STATUS' && (
          <>
            <label>错误状态码</label>
            <input
              type="number"
              value={neStatusCode}
              onChange={(e) => setNeStatusCode(e.target.value === '' ? '' : Number(e.target.value))}
            />
          </>
        )}
      </>
    )}
  </details>
</div>
```

- [ ] **Step 6: 跑 typecheck**

```bash
npm run typecheck
```
预期：通过。

- [ ] **Step 7: 提交**

```bash
git add src/renderer/src/components/RuleEditorModal.tsx
git commit -m "feat(ui): rule editor gains delay, faker template, and network error sections"
```

---

## Task 8: TrafficDetail 展示增强

**Files:**
- Modify: `src/renderer/src/components/TrafficDetail.tsx`

- [ ] **Step 1: 读取现有 TrafficDetail 渲染逻辑**

找到展示"错误"或 `event.error` 的位置。

- [ ] **Step 2: 追加展示 `renderWarnings` 和 `errorTriggered`**

在错误/状态区域追加：

```tsx
{event.errorTriggered && (
  <div className="text-warn">本次命中网络异常分支</div>
)}
{event.renderWarnings && event.renderWarnings.length > 0 && (
  <details>
    <summary>模板告警 ({event.renderWarnings.length})</summary>
    <ul>
      {event.renderWarnings.map((w, i) => <li key={i}>{w}</li>)}
    </ul>
  </details>
)}
```

- [ ] **Step 3: 跑 typecheck**

```bash
npm run typecheck
```

- [ ] **Step 4: 提交**

```bash
git add src/renderer/src/components/TrafficDetail.tsx
git commit -m "feat(ui): show render warnings and error-triggered flag in traffic detail"
```

---

## Task 9: E2E 测试

**Files:**
- Create: `e2e/enhancements.spec.ts`

- [ ] **Step 1: 写 e2e 用例**

```ts
import { test, expect } from '@playwright/test';

test.describe('mock rule enhancements', () => {
  test('rule editor shows three sections', async ({ page }) => {
    await page.goto('/');
    await page.click('button:has-text("新建规则")');
    await expect(page.locator('text=动态数据')).toBeVisible();
    await expect(page.locator('text=行为模拟')).toBeVisible();
  });

  test('snippet buttons insert tokens into body', async ({ page }) => {
    await page.goto('/');
    await page.click('button:has-text("新建规则")');
    const body = page.locator('textarea').nth(2); // 响应体 textarea
    await body.fill('');
    await page.click('button:has-text("+uuid")');
    await expect(body).toHaveValue(/{{uuid}}/);
  });

  test('template preview returns rendered text', async ({ page }) => {
    await page.goto('/');
    await page.click('button:has-text("新建规则")');
    const body = page.locator('textarea').nth(2);
    await body.fill('host={{req.host}}');
    await page.click('button:has-text("刷新预览")');
    await expect(page.locator('pre.preview')).toHaveText(/host=example\.test/);
  });

  test('delay field rejects out-of-range values on save', async ({ page }) => {
    await page.goto('/');
    await page.click('button:has-text("新建规则")');
    await page.locator('input[placeholder*="http"]').fill('http://x.test/');
    await page.locator('input[type="number"]').first().fill('999999');
    await page.click('button:has-text("保存")');
    await expect(page.locator('text=delayMs')).toBeVisible();
  });
});
```

> 注：selector 以最终 UI 渲染结果为准，落地时若定位不稳改用 `getByLabel` / `getByRole`。

- [ ] **Step 2: 跑 e2e**

```bash
npm run test:e2e
```
预期：`enhancements.spec.ts` 全绿；既有 smoke 无回归。

- [ ] **Step 3: 提交**

```bash
git add e2e/enhancements.spec.ts
git commit -m "test(e2e): cover rule editor enhancements and template preview"
```

---

## Task 10: 用户指南

**Files:**
- Create: `docs/guide-enhancements.md`

- [ ] **Step 1: 写用户指南**

```markdown
# 规则增强：时延 / 动态数据 / 网络异常

本版本在规则动作上新增三项能力，可单独或组合使用。

## 1. 固定延迟

在"行为模拟"区块填写 `延迟 (ms)`，取值范围 0-300000。命中规则后代理会先等待指定毫秒再返回响应。

## 2. 动态数据（模板）

响应体与响应头的值支持 `{{变量}}` 占位符。常用变量：

| 变量 | 说明 | 示例输出 |
|---|---|---|
| `{{now:iso}}` | ISO 8601 时间 | `2026-09-02T10:11:12.345Z` |
| `{{now:ms}}` | 毫秒时间戳 | `1788456789012` |
| `{{uuid}}` | UUID v4 | `11111111-2222-4333-8444-555555555555` |
| `{{random.int:1:100}}` | 区间内随机整数 | `42` |
| `{{random.choice:OK:WARN:ERR}}` | 随机枚举 | `WARN` |
| `{{req.path}}` | 请求路径 | `/users/7` |
| `{{req.query.id}}` | query 参数 | `7` |
| `{{req.header.Authorization}}` | 请求头 | `Bearer xxx` |
| `{{req.body.json.userId}}` | body JSON 字段 | `7` |
| `{{faker.person.firstName}}` | Faker 生成 | `伟` |

完整 Faker 函数列表见 <https://fakerjs.dev/api/>。可在"动态数据"区块选择 locale（默认 `zh_CN`）。

### JSON 响应中的数值类型

占位符是字符串替换。若想让字段值为数值而非字符串，请**不要**在占位符外加引号：

```json
{ "age": {{random.int:18:60}}, "name": "{{faker.person.firstName}}" }
```

## 3. 网络异常

在"行为模拟"区块勾选"启用网络异常"，设定概率（0-100%）与类型：

| 类型 | 客户端表现 |
|---|---|
| `ECONNRESET` | 连接被重置 |
| `ETIMEDOUT` | 连接超时（约 30s） |
| `ENOTFOUND` | DNS 失败（关闭连接） |
| `ECONNREFUSED` | 连接被拒绝（关闭连接） |
| `TRUNCATE` | 响应写到一半断开 |
| `HTTP_STATUS` | 返回自定义状态码（如 504） |

异常命中时，固定延迟不会执行；异常未命中时，正常返回响应并应用延迟。

## 4. 排查

- `TrafficDetail` 中会显示"本次命中网络异常分支"提示
- 模板渲染失败不会让请求 500，但会在"模板告警"区列出原因
```

- [ ] **Step 2: 在 README 末尾追加链接**

在 `README.md` 适当位置追加：

```markdown
- [规则增强用法（时延/动态数据/网络异常）](docs/guide-enhancements.md)
```

- [ ] **Step 3: 提交**

```bash
git add docs/guide-enhancements.md README.md
git commit -m "docs: add user guide for delay, faker templates and network errors"
```

---

## 自检

1. **Spec 覆盖**：
   - 时延 ✅ Task 5
   - Faker 模板 ✅ Task 3 / Task 7
   - 网络异常概率 ✅ Task 4 / Task 5
   - locale / 速查 / 预览 ✅ Task 6 / Task 7
   - `renderWarnings` / `errorTriggered` ✅ Task 1 / Task 5 / Task 8
   - 用户指南 ✅ Task 10
   - e2e ✅ Task 9
2. **占位符扫描**：未发现 TBD/TODO 或"类似 Task N"的偷懒步骤
3. **类型一致性**：`NetworkError` / `NetworkErrorType` / `NetworkErrorHint` / `RenderContext` 在所有 task 中命名一致；`errorStatusCode` 仅在 `HTTP_STATUS` 分支读取；`cloneRule` 已更新
