# Mock 增强三件套 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一次性交付三项 UX 增强：① 行为模拟区块新增硬编码的 HTTP 4XX/5XX + 连接级错误模板下拉；② Faker 速查 Modal（13 分类、~45 方法、链接 fakerjs.dev）；③ 请求头/响应头/请求体升级为 Postman 风格表格 + Tabs。

**Architecture:** 数据层扩展 + 渲染层 UI 升级 + proxy 引擎零改动。新增 `HeaderRow` / `RuleBody` 类型，`RuleMatch` 保留旧字段做兼容层；新增 `error-templates.ts` / `faker-catalog.ts` 共享常量；`matcher.ts` 增加双格式分支；`rules-store.ts` 加载时按条迁移；渲染层新增 `EditableTable` / `FakerCatalogModal` 组件，`RuleEditorModal` 加错误模板下拉 + 表格化 + 请求体 tabs。

**Tech Stack:** React 19 + TypeScript（strict）、Vitest（node 环境，纯函数单测）、Playwright（E2E）、mockttp 4（不改动）。不引入新依赖（Faker / TanStack Virtual / mockttp 均已在 `package.json`）。

**分支与前置：** 每个 PR 在独立 feature 分支工作，按顺序合入 master：
- PR1: `feat/error-templates`（从 master 切出）
- PR2: `feat/faker-and-tables`（从 PR1 合入后的 master 切出）
- PR3: `docs/mock-enhancements`（从 PR2 合入后的 master 切出）

注意：`feat/template-autocomplete` 分支（CodeMirror 模板补全）尚未合入 master，本计划所有「响应体 textarea」均指 master 上的 textarea 版本。

**规格来源：** `docs/superpowers/specs/2026-09-04-mock-enhancements-design.md`

**测试约定：** 本项目无 React 组件单测框架，UI 行为由 Playwright E2E 覆盖。纯函数（migrate / matcher / templates / catalog）用 Vitest 单测。

---

## 文件结构

### PR1（数据模型 + 错误模板）

- **Modify** `src/shared/types.ts` — 新增 `HeaderRow` / `BodyMode` / `BodyMatchStrategy` / `RuleBody` 类型；`RuleMatch.headers` 放宽为 `Record | HeaderRow[]`，新增 `body?: RuleBody`。
- **Create** `src/shared/error-templates.ts` — 硬编码 19 条错误模板常量 `ERROR_TEMPLATES` 与类型 `ErrorTemplate` / `ErrorTemplateCategory`。
- **Modify** `src/main/rules/matcher.ts` — `matchHeaders` 双格式分支；`matchBody` 按 `body` / `bodyContains` 分发；新增 `jsonDeepEqual` 辅助。
- **Test** `tests/matcher.test.ts` — 新增 HeaderRow / RuleBody / json-deep 断言。
- **Modify** `src/main/storage/rules-store.ts` — `load()` 时调用 `migrateRules`，首次迁移写 `.bak` 备份；`cloneRule` 适配 HeaderRow 数组。
- **Create** `src/main/storage/migrate.ts` — `migrateRule` / `migrateRules` 纯函数。
- **Test** `tests/migrate.test.ts` — 旧→新、幂等、字段缺失容错、单条失败跳过。
- **Modify** `src/renderer/src/components/RuleEditorModal.tsx` — 新增错误模板下拉 + 应用/回写逻辑。
- **Modify** `src/renderer/src/styles.css` — 错误模板 `<optgroup>` 分隔符样式（可选）。
- **Modify** `e2e/enhancements.spec.ts` — E2E 覆盖模板选中→字段回填→命中→流量事件显示 404。

### PR2（Faker + 表格）

- **Create** `src/shared/faker-catalog.ts` — 13 分类、~45 方法、每条含 `path`/`label`/`snippet`/`example`/`args?`。
- **Create** `src/renderer/src/components/FakerCatalogModal.tsx` — Modal + 搜索（150ms 防抖）+ tabs + 插入到光标。
- **Modify** `src/renderer/src/components/RuleEditorModal.tsx` — 动态数据区块加「Faker 速查…」按钮 + 响应体 `<textarea ref>`。
- **Create** `src/renderer/src/components/EditableTable.tsx` — 通用可编辑键值表格，4 列（enabled/name/value/description/×）。
- **Modify** `src/renderer/src/components/RuleEditorModal.tsx` — 请求头 / 响应头替换为 EditableTable；请求体替换为 Tabs。
- **Modify** `src/renderer/src/styles.css` — `.editable-table` / `.body-tabs` 样式。
- **Modify** `src/renderer/src/lib/capture-to-rule.ts` — draft 预填升级到 HeaderRow 数组。
- **Modify** `e2e/capture-to-rule.spec.ts` — 跟进 HeaderRow 断言。
- **Modify** `e2e/enhancements.spec.ts` — Faker 插入 + 表格完整编辑流程。

### PR3（文档）

- **Modify** `README.md` — 「使用」下新增「错误模板」「Faker 速查」「表格编辑」三节。

---

## Phase 1: 数据模型 + 错误模板（PR1）

### Task 1: 扩展共享类型

**Files:**
- Modify: `src/shared/types.ts:1-116`

- [ ] **Step 1: 编辑 `src/shared/types.ts`，在 `RuleMatch` 之前插入新类型**

```ts
// 在 export type UrlPatternType = 'exact' | 'wildcard' | 'regex'; 之后插入：

export interface HeaderRow {
  enabled: boolean;
  name: string;
  value: string;
  description?: string;
}

export type BodyMode = 'none' | 'raw' | 'form-data' | 'urlencoded';
export type BodyMatchStrategy = 'contains' | 'equals' | 'json-deep';

export interface RuleBody {
  mode: BodyMode;
  raw?: string;
  rawContentType?: string;
  form?: HeaderRow[];
  matchStrategy?: BodyMatchStrategy;
}
```

- [ ] **Step 2: 修改 `RuleMatch` 接口放宽字段类型**

```ts
export interface RuleMatch {
  urlType: UrlPatternType;
  urlPattern: string;
  method: HttpMethod;
  query?: Record<string, string>;
  headers?: Record<string, string> | HeaderRow[];
  bodyContains?: string;
  body?: RuleBody;
}
```

- [ ] **Step 3: 运行 typecheck 验证**

Run: `npm run typecheck`
Expected: PASS（`matcher.ts` / `rules-store.ts` / `RuleEditorModal.tsx` 暂时不需要改动即可通过，因为旧代码只读 `headers` 为 Record，TS 接受 `Record | HeaderRow[]` 的 union）

- [ ] **Step 4: 提交**

```bash
git add src/shared/types.ts
git commit -m "feat(types): add HeaderRow, RuleBody and widen RuleMatch for table-based editing"
```

---

### Task 2: 错误模板常量表（TDD）

**Files:**
- Create: `src/shared/error-templates.ts`
- Test: `tests/error-templates.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/error-templates.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { ERROR_TEMPLATES, findById, type ErrorTemplate } from '../src/shared/error-templates';

describe('ERROR_TEMPLATES', () => {
  it('contains exactly 19 entries', () => {
    expect(ERROR_TEMPLATES).toHaveLength(19);
  });

  it('has 9 http-4xx, 5 http-5xx and 5 connection templates', () => {
    const counts = { 'http-4xx': 0, 'http-5xx': 0, connection: 0 };
    for (const t of ERROR_TEMPLATES) counts[t.category]++;
    expect(counts).toEqual({ 'http-4xx': 9, 'http-5xx': 5, connection: 5 });
  });

  it('every id is unique and kebab-case', () => {
    const ids = ERROR_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('http templates carry 4xx or 5xx status', () => {
    for (const t of ERROR_TEMPLATES.filter((x) => x.category.startsWith('http-'))) {
      if (t.payload.kind !== 'http') throw new Error('expected http payload');
      const s = t.payload.status;
      if (t.category === 'http-4xx') expect(s).toBeGreaterThanOrEqual(400);
      if (t.category === 'http-4xx') expect(s).toBeLessThan(500);
      if (t.category === 'http-5xx') expect(s).toBeGreaterThanOrEqual(500);
      if (t.category === 'http-5xx') expect(s).toBeLessThan(600);
      expect(t.payload.body).toMatch(/^\{.*"error".*\}$/s);
    }
  });

  it('connection templates use only valid NetworkError types', () => {
    const valid = new Set(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'TRUNCATE']);
    for (const t of ERROR_TEMPLATES.filter((x) => x.category === 'connection')) {
      if (t.payload.kind !== 'connection') throw new Error('expected connection payload');
      expect(valid.has(t.payload.networkError.type)).toBe(true);
      expect(t.payload.networkError.probability).toBe(100);
    }
  });

  it('findById returns the right template', () => {
    expect(findById('http-404')?.label).toContain('Not Found');
    expect(findById('conn-econnreset')?.category).toBe('connection');
    expect(findById('does-not-exist')).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run tests/error-templates.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/shared/error-templates.ts`**

```ts
import type { NetworkError } from './types';

export type ErrorTemplateCategory = 'http-4xx' | 'http-5xx' | 'connection';

export type ErrorTemplatePayload =
  | { kind: 'http'; status: number; body: string; headers?: Record<string, string> }
  | { kind: 'connection'; networkError: NetworkError };

export interface ErrorTemplate {
  id: string;
  category: ErrorTemplateCategory;
  label: string;
  description: string;
  payload: ErrorTemplatePayload;
}

const httpErr = (code: string, message: string, headers?: Record<string, string>): string =>
  JSON.stringify({ error: { code, message } });

export const ERROR_TEMPLATES: ErrorTemplate[] = [
  // ── 4XX ──
  { id: 'http-400', category: 'http-4xx', label: '400 Bad Request',
    description: '请求参数错误',
    payload: { kind: 'http', status: 400, body: httpErr('BAD_REQUEST', '请求参数错误') } },
  { id: 'http-401', category: 'http-4xx', label: '401 Unauthorized',
    description: '未授权',
    payload: { kind: 'http', status: 401, body: httpErr('UNAUTHORIZED', '未授权，请重新登录') } },
  { id: 'http-403', category: 'http-4xx', label: '403 Forbidden',
    description: '无权访问',
    payload: { kind: 'http', status: 403, body: httpErr('FORBIDDEN', '无权访问该资源') } },
  { id: 'http-404', category: 'http-4xx', label: '404 Not Found',
    description: '资源不存在',
    payload: { kind: 'http', status: 404, body: httpErr('NOT_FOUND', '请求的资源不存在') } },
  { id: 'http-405', category: 'http-4xx', label: '405 Method Not Allowed',
    description: '方法不允许',
    payload: { kind: 'http', status: 405, body: httpErr('METHOD_NOT_ALLOWED', '请求方法不允许') } },
  { id: 'http-408', category: 'http-4xx', label: '408 Request Timeout',
    description: '请求超时',
    payload: { kind: 'http', status: 408, body: httpErr('REQUEST_TIMEOUT', '请求超时') } },
  { id: 'http-409', category: 'http-4xx', label: '409 Conflict',
    description: '资源冲突',
    payload: { kind: 'http', status: 409, body: httpErr('CONFLICT', '资源冲突') } },
  { id: 'http-422', category: 'http-4xx', label: '422 Unprocessable Entity',
    description: '无法处理',
    payload: { kind: 'http', status: 422, body: httpErr('UNPROCESSABLE', '请求数据无法处理') } },
  { id: 'http-429', category: 'http-4xx', label: '429 Too Many Requests',
    description: '限流',
    payload: { kind: 'http', status: 429, body: httpErr('RATE_LIMIT', '请求过于频繁，请稍后重试'),
      headers: { 'retry-after': '60' } } },
  // ── 5XX ──
  { id: 'http-500', category: 'http-5xx', label: '500 Internal Server Error',
    description: '服务端错误',
    payload: { kind: 'http', status: 500, body: httpErr('INTERNAL_ERROR', '服务器内部错误') } },
  { id: 'http-501', category: 'http-5xx', label: '501 Not Implemented',
    description: '未实现',
    payload: { kind: 'http', status: 501, body: httpErr('NOT_IMPLEMENTED', '功能未实现') } },
  { id: 'http-502', category: 'http-5xx', label: '502 Bad Gateway',
    description: '网关错误',
    payload: { kind: 'http', status: 502, body: httpErr('BAD_GATEWAY', '网关错误') } },
  { id: 'http-503', category: 'http-5xx', label: '503 Service Unavailable',
    description: '服务不可用',
    payload: { kind: 'http', status: 503, body: httpErr('SERVICE_UNAVAILABLE', '服务暂不可用'),
      headers: { 'retry-after': '30' } } },
  { id: 'http-504', category: 'http-5xx', label: '504 Gateway Timeout',
    description: '网关超时',
    payload: { kind: 'http', status: 504, body: httpErr('GATEWAY_TIMEOUT', '网关超时') } },
  // ── connection ──
  { id: 'conn-econnreset', category: 'connection', label: 'Connection reset',
    description: '连接被重置',
    payload: { kind: 'connection', networkError: { probability: 100, type: 'ECONNRESET' } } },
  { id: 'conn-etimedout', category: 'connection', label: 'Connection timed out',
    description: '连接超时',
    payload: { kind: 'connection', networkError: { probability: 100, type: 'ETIMEDOUT' } } },
  { id: 'conn-enotfound', category: 'connection', label: 'Host not found',
    description: '域名解析失败',
    payload: { kind: 'connection', networkError: { probability: 100, type: 'ENOTFOUND' } } },
  { id: 'conn-econnrefused', category: 'connection', label: 'Connection refused',
    description: '连接被拒绝',
    payload: { kind: 'connection', networkError: { probability: 100, type: 'ECONNREFUSED' } } },
  { id: 'conn-truncate', category: 'connection', label: 'Response truncated',
    description: '响应被截断',
    payload: { kind: 'connection', networkError: { probability: 100, type: 'TRUNCATE' } } },
];

export function findById(id: string): ErrorTemplate | undefined {
  return ERROR_TEMPLATES.find((t) => t.id === id);
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run tests/error-templates.test.ts`
Expected: 6 passed

- [ ] **Step 5: 提交**

```bash
git add src/shared/error-templates.ts tests/error-templates.test.ts
git commit -m "feat(templates): hardcode 19 HTTP/connection error template presets"
```

---

### Task 3: matcher 升级（TDD）

**Files:**
- Modify: `src/main/rules/matcher.ts`
- Modify: `tests/matcher.test.ts`

- [ ] **Step 1: 在 `tests/matcher.test.ts` 末尾追加 HeaderRow / RuleBody 测试**

```ts
describe('matchRule with HeaderRow[]', () => {
  it('matches when all enabled rows match actual headers', () => {
    const m: RuleMatch = {
      ...base,
      headers: [
        { enabled: true, name: 'X-Token', value: 'abc' },
        { enabled: true, name: 'Content-Type', value: 'application/json' },
      ],
    };
    expect(matchRule(m, req())).toBe(true);
  });

  it('ignores disabled rows', () => {
    const m: RuleMatch = {
      ...base,
      headers: [
        { enabled: false, name: 'X-Token', value: 'wrong' },
        { enabled: true, name: 'Content-Type', value: 'application/json' },
      ],
    };
    expect(matchRule(m, req())).toBe(true);
  });

  it('is case-insensitive by name', () => {
    const m: RuleMatch = {
      ...base,
      headers: [{ enabled: true, name: 'x-token', value: 'abc' }],
    };
    expect(matchRule(m, req())).toBe(true);
  });

  it('rejects when enabled row value mismatches', () => {
    const m: RuleMatch = {
      ...base,
      headers: [{ enabled: true, name: 'X-Token', value: 'zzz' }],
    };
    expect(matchRule(m, req())).toBe(false);
  });
});

describe('matchRule with RuleBody', () => {
  const jsonBody = '{"id":1,"name":"x"}';

  it('none: skips body matching', () => {
    const m: RuleMatch = { ...base, body: { mode: 'none' } };
    expect(matchRule(m, req({ body: 'anything' }))).toBe(true);
    expect(matchRule(m, req({ body: '' }))).toBe(true);
  });

  it('raw + contains (default) behaves like bodyContains', () => {
    const m: RuleMatch = { ...base, body: { mode: 'raw', raw: '"id":1' } };
    expect(matchRule(m, req({ body: jsonBody }))).toBe(true);
    expect(matchRule(m, req({ body: '{}' }))).toBe(false);
  });

  it('raw + equals requires full text equality', () => {
    const m: RuleMatch = { ...base, body: { mode: 'raw', raw: jsonBody, matchStrategy: 'equals' } };
    expect(matchRule(m, req({ body: jsonBody }))).toBe(true);
    expect(matchRule(m, req({ body: jsonBody + ' ' }))).toBe(false);
  });

  it('raw + json-deep compares parsed objects key-order-insensitively', () => {
    const m: RuleMatch = {
      ...base,
      body: { mode: 'raw', raw: '{"name":"x","id":1}', matchStrategy: 'json-deep' },
    };
    expect(matchRule(m, req({ body: jsonBody }))).toBe(true);
    expect(matchRule(m, req({ body: '{"id":2,"name":"x"}' }))).toBe(false);
  });

  it('raw + json-deep falls back to false on invalid JSON', () => {
    const m: RuleMatch = {
      ...base,
      body: { mode: 'raw', raw: '{"id":1}', matchStrategy: 'json-deep' },
    };
    expect(matchRule(m, req({ body: 'not json' }))).toBe(false);
  });

  it('form-data requires all enabled form fields to be present', () => {
    const m: RuleMatch = {
      ...base,
      body: {
        mode: 'form-data',
        form: [
          { enabled: true, name: 'user', value: 'alice' },
          { enabled: false, name: 'ignored', value: 'x' },
        ],
      },
    };
    expect(matchRule(m, req({ body: 'user=alice&token=abc' }))).toBe(true);
    expect(matchRule(m, req({ body: 'user=bob&token=abc' }))).toBe(false);
  });

  it('urlencoded behaves like form-data but parses urlencoded body', () => {
    const m: RuleMatch = {
      ...base,
      body: { mode: 'urlencoded', form: [{ enabled: true, name: 'q', value: '测试' }] },
    };
    expect(matchRule(m, req({ body: 'q=%E6%B5%8B%E8%AF%95' }))).toBe(true);
    expect(matchRule(m, req({ body: 'q=other' }))).toBe(false);
  });

  it('bodyContains still works (back-compat)', () => {
    const m: RuleMatch = { ...base, bodyContains: '"id":1' };
    expect(matchRule(m, req({ body: jsonBody }))).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试，确认新增用例失败**

Run: `npx vitest run tests/matcher.test.ts`
Expected: FAIL（新断言失败）

- [ ] **Step 3: 修改 `src/main/rules/matcher.ts`**

```ts
import type { HeaderRow, RuleBody, RuleMatch } from '../../shared/types';

export interface RequestDescription {
  method: string;
  url: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: string;
}

export function matchRule(match: RuleMatch, req: RequestDescription): boolean {
  return (
    matchUrl(match, req.url) &&
    matchMethod(match.method, req.method) &&
    matchQuery(match.query, req.query) &&
    matchHeaders(match.headers, req.headers) &&
    matchBodyField(match, req.body)
  );
}

// ...matchUrl / matchMethod / matchQuery 保留原实现...

function matchHeaders(
  expected: Record<string, string> | HeaderRow[] | undefined,
  actual: Record<string, string>,
): boolean {
  if (!expected) return true;
  if (Array.isArray(expected)) {
    const lower = new Map(Object.entries(actual).map(([k, v]) => [k.toLowerCase(), v]));
    return expected
      .filter((r) => r.enabled)
      .every((r) => lower.get(r.name.toLowerCase()) === r.value);
  }
  const lower = new Map(Object.entries(actual).map(([k, v]) => [k.toLowerCase(), v]));
  return Object.entries(expected).every(([k, v]) => lower.get(k.toLowerCase()) === v);
}

function matchBodyField(match: RuleMatch, body: string): boolean {
  if (match.body) return matchBodyByRule(match.body, body);
  if (match.bodyContains) return body.includes(match.bodyContains);
  return true;
}

function matchBodyByRule(rule: RuleBody, body: string): boolean {
  if (rule.mode === 'none') return true;
  if (rule.mode === 'raw') {
    const needle = rule.raw ?? '';
    const strategy = rule.matchStrategy ?? 'contains';
    if (strategy === 'contains') return body.includes(needle);
    if (strategy === 'equals') return body === needle;
    // json-deep
    try {
      return jsonDeepEqual(JSON.parse(body), JSON.parse(needle));
    } catch {
      return false;
    }
  }
  // form-data / urlencoded
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(body);
  } catch {
    return false;
  }
  const required = (rule.form ?? []).filter((r) => r.enabled);
  return required.every((r) => params.getAll(r.name).includes(r.value));
}

function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => jsonDeepEqual(v, (b as unknown[])[i]));
  }
  if (typeof a === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && jsonDeepEqual(ao[k], bo[k]));
  }
  return false;
}
```

- [ ] **Step 4: 运行测试，确认全部通过**

Run: `npx vitest run tests/matcher.test.ts`
Expected: 全部 PASS（旧 11 + 新增 12 = 23）

- [ ] **Step 5: 提交**

```bash
git add src/main/rules/matcher.ts tests/matcher.test.ts
git commit -m "feat(matcher): support HeaderRow[] and RuleBody with json-deep strategy"
```

---

### Task 4: 数据迁移 + 备份（TDD）

**Files:**
- Create: `src/main/storage/migrate.ts`
- Modify: `src/main/storage/rules-store.ts`
- Test: `tests/migrate.test.ts`
- Modify: `tests/rules-store.test.ts`

- [ ] **Step 1: 写失败测试 `tests/migrate.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { migrateRule } from '../src/main/storage/migrate';
import type { MockRule, HeaderRow } from '../src/shared/types';

function baseRule(): any {
  return {
    id: 'r1',
    name: 'r1',
    enabled: true,
    priority: 1,
    match: { urlType: 'exact', urlPattern: 'http://x.com/r1', method: 'ANY' },
    action: { status: 200, headers: {}, body: '' },
  };
}

describe('migrateRule', () => {
  it('passes through an already-migrated rule unchanged', () => {
    const rule = baseRule();
    rule.match.headers = [{ enabled: true, name: 'X', value: '1', description: '' }];
    rule.match.body = { mode: 'raw', raw: '' };
    const out = migrateRule(rule) as MockRule;
    expect(Array.isArray(out.match.headers)).toBe(true);
    expect((out.match.headers as HeaderRow[])[0].name).toBe('X');
    expect(out.match.body?.mode).toBe('raw');
  });

  it('converts Record headers to HeaderRow[]', () => {
    const rule = baseRule();
    rule.match.headers = { 'Content-Type': 'application/json', 'X-Token': 'abc' };
    const out = migrateRule(rule) as MockRule;
    expect(Array.isArray(out.match.headers)).toBe(true);
    const rows = out.match.headers as HeaderRow[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.enabled)).toBe(true);
    expect(rows.map((r) => r.name).sort()).toEqual(['Content-Type', 'X-Token']);
  });

  it('converts bodyContains to body.mode=raw with contains strategy', () => {
    const rule = baseRule();
    rule.match.bodyContains = '"id":1';
    const out = migrateRule(rule) as MockRule;
    expect(out.match.body).toEqual({ mode: 'raw', raw: '"id":1', matchStrategy: 'contains' });
    expect((out.match as any).bodyContains).toBeUndefined();
  });

  it('returns undefined for a fundamentally broken rule', () => {
    expect(migrateRule(null)).toBeUndefined();
    expect(migrateRule({ not: 'a rule' })).toBeUndefined();
    expect(migrateRule({ match: 'string' })).toBeUndefined();
  });

  it('tolerates missing optional fields', () => {
    const rule = baseRule();
    delete rule.match.query;
    delete rule.match.headers;
    const out = migrateRule(rule) as MockRule;
    expect(out.match.headers).toBeUndefined();
    expect(out.match.body).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run tests/migrate.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `src/main/storage/migrate.ts`**

```ts
import type { HeaderRow, MockRule, RuleBody } from '../../shared/types';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function migrateRule(raw: unknown): MockRule | undefined {
  if (!isPlainObject(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (!isPlainObject(r.match)) return undefined;
  if (typeof r.id !== 'string' || typeof r.name !== 'string') return undefined;
  if (!isPlainObject(r.action)) return undefined;

  const match = r.match as Record<string, unknown>;

  // headers: Record → HeaderRow[]
  if (match.headers && isPlainObject(match.headers)) {
    const rows: HeaderRow[] = Object.entries(match.headers as Record<string, unknown>).map(
      ([name, value]) => ({
        enabled: true,
        name,
        value: String(value ?? ''),
        description: '',
      }),
    );
    match.headers = rows;
  }

  // bodyContains → body
  if (typeof match.bodyContains === 'string' && !match.body) {
    const body: RuleBody = {
      mode: 'raw',
      raw: match.bodyContains,
      matchStrategy: 'contains',
    };
    match.body = body;
    delete match.bodyContains;
  }

  return raw as unknown as MockRule;
}

export function migrateRules(raw: unknown[]): { rules: MockRule[]; skipped: number } {
  const rules: MockRule[] = [];
  let skipped = 0;
  for (const r of raw) {
    const m = migrateRule(r);
    if (m) rules.push(m);
    else skipped++;
  }
  return { rules, skipped };
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run tests/migrate.test.ts`
Expected: 5 passed

- [ ] **Step 5: 接入 `rules-store.ts` 并在首次迁移时备份**

修改 `src/main/storage/rules-store.ts`：

```ts
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonStore } from './json-store';
import { migrateRules } from './migrate';
import type { MockRule, RuleInput, RulePatch, HeaderRow } from '../../shared/types';

const MAX_SNAPSHOTS = 50;
const SCHEMA_VERSION = 2;

function cloneRule(rule: MockRule): MockRule {
  return {
    ...rule,
    match: {
      ...rule.match,
      ...(rule.match.query ? { query: { ...rule.match.query } } : {}),
      ...(Array.isArray(rule.match.headers)
        ? { headers: rule.match.headers.map((r) => ({ ...r })) }
        : rule.match.headers
          ? { headers: { ...rule.match.headers } }
          : {}),
      ...(rule.match.body
        ? {
            body: {
              ...rule.match.body,
              ...(rule.match.body.form ? { form: rule.match.body.form.map((r) => ({ ...r })) } : {}),
            },
          }
        : {}),
    },
    action: {
      ...rule.action,
      headers: { ...rule.action.headers },
      ...(rule.action.networkError ? { networkError: { ...rule.action.networkError } } : {}),
    },
  };
}

export class RulesStore {
  private rules: MockRule[] = [];
  private readonly store: JsonStore<MockRule[]>;
  private readonly snapshotsDir: string;
  private readonly dataDir: string;
  private listeners = new Set<() => void>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.store = new JsonStore<MockRule[]>(path.join(dataDir, 'rules.json'), []);
    this.snapshotsDir = path.join(dataDir, 'snapshots');
  }

  async load(): Promise<void> {
    const raw = await this.store.read();
    const rawPath = path.join(this.dataDir, 'rules.json');
    const bakPath = `${rawPath}.v1-bak`;

    const { rules, skipped } = migrateRules(raw);
    const needsBackup = skipped === 0 && rules.length > 0 && !hasSchemaV2Marker(rules);
    if (needsBackup) {
      try {
        await fs.access(bakPath);
      } catch {
        try {
          const content = await fs.readFile(rawPath, 'utf8');
          await fs.writeFile(bakPath, content, 'utf8');
        } catch {
          // file missing or unreadable — fine, nothing to back up
        }
      }
    }
    this.rules = rules;
    if (skipped > 0 || needsBackup) {
      await this.store.write(this.rules);
    }
  }

  // ...list / onChange / add / update / remove / persist / snapshot 保持原实现...
}

function hasSchemaV2Marker(rules: MockRule[]): boolean {
  // 只要任何一条规则已使用 HeaderRow 数组 或 RuleBody，视为已迁移
  return rules.some(
    (r) => Array.isArray(r.match.headers) || r.match.body !== undefined,
  );
}
```

- [ ] **Step 6: 在 `tests/rules-store.test.ts` 追加迁移测试**

```ts
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

it('migrates legacy rules.json on first load and creates .v1-bak', async () => {
  const legacy = [
    {
      id: 'r1', name: 'r1', enabled: true, priority: 1,
      match: {
        urlType: 'exact', urlPattern: 'http://x.com/r1', method: 'ANY',
        headers: { 'X-Token': 'abc' }, bodyContains: 'needle',
      },
      action: { status: 200, headers: {}, body: '' },
    },
  ];
  await writeFile(join(dir, 'rules.json'), JSON.stringify(legacy), 'utf8');

  const store = new RulesStore(dir);
  await store.load();
  const [rule] = store.list();
  expect(Array.isArray(rule.match.headers)).toBe(true);
  expect(rule.match.body).toEqual({ mode: 'raw', raw: 'needle', matchStrategy: 'contains' });
  expect((rule.match as any).bodyContains).toBeUndefined();

  const bak = await readdir(dir);
  expect(bak.some((f) => f.endsWith('.v1-bak'))).toBe(true);
});

it('skips broken rules and keeps good ones', async () => {
  const mixed = [
    { id: 'good', name: 'g', enabled: true, priority: 1,
      match: { urlType: 'exact', urlPattern: 'x', method: 'ANY' },
      action: { status: 200, headers: {}, body: '' } },
    { broken: true },
  ];
  await writeFile(join(dir, 'rules.json'), JSON.stringify(mixed), 'utf8');
  const store = new RulesStore(dir);
  await store.load();
  expect(store.list().map((r) => r.id)).toEqual(['good']);
});
```

- [ ] **Step 7: 运行全部 store 与迁移测试**

Run: `npx vitest run tests/rules-store.test.ts tests/migrate.test.ts`
Expected: 全部 PASS

- [ ] **Step 8: 提交**

```bash
git add src/main/storage/migrate.ts src/main/storage/rules-store.ts tests/migrate.test.ts tests/rules-store.test.ts
git commit -m "feat(storage): migrate legacy rules on load with .v1-bak backup"
```

---

### Task 5: RuleEditorModal 错误模板 UI

**Files:**
- Modify: `src/renderer/src/components/RuleEditorModal.tsx`
- Modify: `src/renderer/src/styles.css`

- [ ] **Step 1: 新增 `selectedTemplateId` state 与预填函数**

在 `RuleEditorModal.tsx` 顶部引入：

```ts
import { ERROR_TEMPLATES, findById } from '../../../shared/error-templates';
```

新增 state（与现有 useState 同位置）：

```ts
const [selectedTemplateId, setSelectedTemplateId] = useState<string>('custom');
```

新增预填函数（组件内部）：

```ts
const applyTemplate = (id: string) => {
  setSelectedTemplateId(id);
  if (id === 'custom') return;
  const tpl = findById(id);
  if (!tpl) return;
  if (tpl.payload.kind === 'http') {
    setNeEnabled(false);
    setStatus(tpl.payload.status);
    setBody(tpl.payload.body);
    setRespHeadersText((prev) => {
      const merged = parseLines(prev, ': ');
      for (const [k, v] of Object.entries(tpl.payload.headers ?? {})) merged[k] = v;
      merged['content-type'] ??= 'application/json';
      return formatLines(merged, ': ');
    });
  } else {
    setNeEnabled(true);
    setNeProbability(100);
    setNeType(tpl.payload.networkError.type);
  }
};
```

- [ ] **Step 2: 在「行为模拟」区块置顶加入模板下拉**

在 `<details className="form-section" open><summary>行为模拟</summary>` 内的 `<div className="form-grid">` 顶部插入：

```tsx
<label>错误模板</label>
<select
  value={selectedTemplateId}
  onChange={(e) => applyTemplate(e.target.value)}
>
  <option value="custom">无（自定义）</option>
  <optgroup label="── 4XX 客户端错误 ──">
    {ERROR_TEMPLATES.filter((t) => t.category === 'http-4xx').map((t) => (
      <option key={t.id} value={t.id}>{t.label}</option>
    ))}
  </optgroup>
  <optgroup label="── 5XX 服务端错误 ──">
    {ERROR_TEMPLATES.filter((t) => t.category === 'http-5xx').map((t) => (
      <option key={t.id} value={t.id}>{t.label}</option>
    ))}
  </optgroup>
  <optgroup label="── 连接异常 ──">
    {ERROR_TEMPLATES.filter((t) => t.category === 'connection').map((t) => (
      <option key={t.id} value={t.id}>{t.label}</option>
    ))}
  </optgroup>
</select>
```

- [ ] **Step 3: 连接级模板选中时禁用响应字段**

在「响应状态码」「响应体」两个 input/textarea 上加 `disabled={neEnabled && neType !== 'HTTP_STATUS'}`：

```tsx
<input
  type="number"
  value={status}
  disabled={neEnabled && selectedTemplateId !== 'custom'}
  onChange={(e) => { setStatus(Number(e.target.value)); setSelectedTemplateId('custom'); }}
/>
```

- [ ] **Step 4: 手工编辑时回落到 `custom`**

对 `status` / `body` / `neType` / `neProbability` 的每个 `onChange` 追加 `setSelectedTemplateId('custom')`。例如：

```tsx
<textarea
  rows={8}
  value={body}
  onChange={(e) => { setBody(e.target.value); setSelectedTemplateId('custom'); }}
/>
```

`applyTemplate` 触发的写入不会再次触发回落（因为它先 setSelectedTemplateId 到非 custom，后写字段；React 按 batch 处理，状态一致）。

- [ ] **Step 5: 编译验证**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/renderer/src/components/RuleEditorModal.tsx
git commit -m "feat(ui): add error template dropdown in behavior simulation block"
```

---

### Task 6: E2E 覆盖错误模板 + 集成验证

**Files:**
- Modify: `e2e/enhancements.spec.ts`

- [ ] **Step 1: 阅读现有 `e2e/enhancements.spec.ts` 了解约定**

Run: `cat e2e/enhancements.spec.ts`

- [ ] **Step 2: 追加错误模板 E2E**

```ts
test('error template 404 prefills status and body, and the rule fires the mock', async ({ page }) => {
  await page.getByRole('button', { name: /新建规则/ }).click();
  await page.getByLabel('错误模板').selectOption('http-404');
  await expect(page.getByLabel('响应状态码')).toHaveValue('404');
  await expect(page.getByLabel('响应体')).toHaveValue(/NOT_FOUND/);
  await page.getByRole('button', { name: '保存' }).click();

  // 触发匹配，断言流量事件显示 404
  // ... 沿用现有 enhancements.spec.ts 的代理请求 + 选中行 + 断言逻辑 ...
});

test('connection template enables network error and disables response fields', async ({ page }) => {
  await page.getByRole('button', { name: /新建规则/ }).click();
  await page.getByLabel('错误模板').selectOption('conn-econnreset');
  await expect(page.getByLabel(/命中时按概率触发网络异常/)).toBeChecked();
  await expect(page.getByLabel('响应状态码')).toBeDisabled();
});

test('manual edit resets template selector to custom', async ({ page }) => {
  await page.getByRole('button', { name: /新建规则/ }).click();
  await page.getByLabel('错误模板').selectOption('http-404');
  await page.getByLabel('响应状态码').fill('418');
  await expect(page.getByLabel('错误模板')).toHaveValue('custom');
});
```

- [ ] **Step 3: 运行 E2E**

Run: `npm run test:e2e`
Expected: 新增用例 PASS，原有套件（含 capture-to-rule）PASS

- [ ] **Step 4: 全量 typecheck + vitest**

Run: `npm run typecheck && npm run test`
Expected: 全部 PASS

- [ ] **Step 5: 合入 master 并推送**

```bash
git log --oneline master..HEAD   # 确认本分支 5 个 commit
git checkout master
git merge --no-ff feat/error-templates -m "Merge branch 'feat/error-templates'"
git push
```

（PR 可选：如需走 PR 流程，改用 `gh pr create --base master --head feat/error-templates --title "feat: error templates for behavior simulation" --body "..."`。）

---

## Phase 2: Faker + 表格（PR2）

### Task 7: Faker 速查目录常量（TDD）

**Files:**
- Create: `src/shared/faker-catalog.ts`
- Test: `tests/faker-catalog.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { FAKER_CATALOG, findByPath } from '../src/shared/faker-catalog';

describe('FAKER_CATALOG', () => {
  it('has 13 categories', () => {
    expect(FAKER_CATALOG).toHaveLength(13);
  });

  it('has at least 40 entries total', () => {
    const total = FAKER_CATALOG.reduce((s, c) => s + c.entries.length, 0);
    expect(total).toBeGreaterThanOrEqual(40);
  });

  it('every entry has path starting with faker. and a non-empty snippet/example', () => {
    for (const c of FAKER_CATALOG) {
      for (const e of c.entries) {
        expect(e.path).toMatch(/^faker\.[a-z]+\.[a-zA-Z]+$/);
        expect(e.snippet).toMatch(/^\{\{faker\..*\}\}$/);
        expect(e.example.length).toBeGreaterThan(0);
        expect(e.label.length).toBeGreaterThan(0);
      }
    }
  });

  it('paths are unique', () => {
    const paths = FAKER_CATALOG.flatMap((c) => c.entries.map((e) => e.path));
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('findByPath works', () => {
    expect(findByPath('faker.person.firstName')?.label).toBeTruthy();
    expect(findByPath('faker.no.such')).toBeUndefined();
  });
});
```

- [ ] **Step 2: 实现 `src/shared/faker-catalog.ts`**

完整内容见 spec 附录 B。此处列出骨架 + 每分类至少 1 条代表：

```ts
export interface FakerEntry {
  path: string;
  label: string;
  snippet: string;
  example: string;
  args?: string;
}
export interface FakerCategory { id: string; label: string; entries: FakerEntry[] }

const entry = (path: string, label: string, example: string, args?: string): FakerEntry => ({
  path, label, example, args,
  snippet: `{{${path}}}`,
});

export const FAKER_CATALOG: FakerCategory[] = [
  { id: 'person', label: '人员', entries: [
    entry('faker.person.firstName', '名（中文 locale 下为中文姓名）', '张伟'),
    entry('faker.person.lastName', '姓', '李'),
    entry('faker.person.fullName', '全名', '张伟'),
    entry('faker.person.sex', '性别', 'male'),
    entry('faker.person.jobTitle', '职位', '高级软件工程师'),
    entry('faker.person.avatar', '头像 URL', 'https://avatars.githubusercontent.com/...'),
  ] },
  { id: 'internet', label: '网络', entries: [
    entry('faker.internet.email', '邮箱', 'zhangwei@example.org'),
    entry('faker.internet.userName', '用户名', 'zhangwei99'),
    entry('faker.internet.password', '密码（默认 15 位）', 'aB3$kL9!mN2@pQ7'),
    entry('faker.internet.url', 'URL', 'https://wonderful-lake.name'),
    entry('faker.internet.ip', 'IPv4 地址', '203.0.113.42'),
    entry('faker.internet.domainName', '域名', 'example.com'),
  ] },
  { id: 'location', label: '位置', entries: [
    entry('faker.location.city', '城市', '北京市'),
    entry('faker.location.country', '国家', '中国'),
    entry('faker.location.zipCode', '邮编', '100000'),
    entry('faker.location.streetAddress', '街道地址', '长安街 1 号'),
    entry('faker.location.latitude', '纬度', '39.9042'),
    entry('faker.location.longitude', '经度', '116.4074'),
  ] },
  { id: 'date', label: '日期', entries: [
    entry('faker.date.past', '过去日期', '2024-03-15T08:30:00.000Z'),
    entry('faker.date.future', '未来日期', '2027-11-22T14:20:00.000Z'),
    entry('faker.date.recent', '最近几天', '2026-09-03T19:10:00.000Z'),
    entry('faker.date.birthdate', '出生日期', '1990-06-18T00:00:00.000Z'),
  ] },
  { id: 'number', label: '数字', entries: [
    entry('faker.number.int', '整数', '42', 'min, max'),
    entry('faker.number.float', '浮点数', '3.14', 'min, max, fractionDigits'),
    entry('faker.number.bigint', '大整数', '9007199254740991n', 'min, max'),
  ] },
  { id: 'string', label: '字符串', entries: [
    entry('faker.string.uuid', 'UUID', '123e4567-e89b-12d3-a456-426614174000'),
    entry('faker.string.nanoid', 'Nano ID', 'a1B2_c3D4'),
    entry('faker.string.alpha', '字母串', 'abcXYZ'),
    entry('faker.string.alphanumeric', '字母数字串', 'aB3cD4'),
  ] },
  { id: 'finance', label: '金融', entries: [
    entry('faker.finance.amount', '金额', '1234.56'),
    entry('faker.finance.currencyCode', '货币代码', 'CNY'),
    entry('faker.finance.creditCardNumber', '信用卡号', '4111-1111-1111-1111'),
    entry('faker.finance.iban', 'IBAN', 'DE89370400440532013000'),
  ] },
  { id: 'company', label: '公司', entries: [
    entry('faker.company.name', '公司名', '腾讯科技有限公司'),
    entry('faker.company.catchPhrase', '口号', 'Innovative holistic synergy'),
    entry('faker.company.bs', '商业描述', 'leverage scalable platforms'),
  ] },
  { id: 'phone', label: '电话', entries: [
    entry('faker.phone.number', '电话号码', '138-1234-5678'),
  ] },
  { id: 'commerce', label: '商业', entries: [
    entry('faker.commerce.productName', '商品名', '智能无线鼠标'),
    entry('faker.commerce.price', '价格', '299.99'),
    entry('faker.commerce.productDescription', '商品描述', '高性能低功耗'),
  ] },
  { id: 'image', label: '图片', entries: [
    entry('faker.image.url', '随机图片 URL', 'https://loremflickr.com/640/480'),
    entry('faker.image.avatar', '头像', 'https://avatars.githubusercontent.com/...'),
  ] },
  { id: 'color', label: '颜色', entries: [
    entry('faker.color.human', '人可读颜色名', 'teal'),
    entry('faker.color.rgb', 'RGB 十六进制', '#3a7b9c'),
    entry('faker.color.hex', 'Hex 颜色', '#ff5733'),
  ] },
  { id: 'lorem', label: '文本', entries: [
    entry('faker.lorem.word', '单词', 'lorem'),
    entry('faker.lorem.words', '多个单词', 'lorem ipsum dolor'),
    entry('faker.lorem.sentence', '句子', 'Lorem ipsum dolor sit amet.'),
    entry('faker.lorem.paragraph', '段落', 'Lorem ipsum dolor sit amet, consectetur...'),
  ] },
];

export function findByPath(path: string): FakerEntry | undefined {
  for (const c of FAKER_CATALOG) {
    const e = c.entries.find((x) => x.path === path);
    if (e) return e;
  }
  return undefined;
}
```

- [ ] **Step 3: 运行测试，确认通过**

Run: `npx vitest run tests/faker-catalog.test.ts`
Expected: 5 passed

- [ ] **Step 4: 提交**

```bash
git add src/shared/faker-catalog.ts tests/faker-catalog.test.ts
git commit -m "feat(catalog): faker speed-reference with 13 categories and ~45 entries"
```

---

### Task 8: Faker 速查 Modal

**Files:**
- Create: `src/renderer/src/components/FakerCatalogModal.tsx`
- Modify: `src/renderer/src/components/RuleEditorModal.tsx`
- Modify: `src/renderer/src/styles.css`

- [ ] **Step 1: 实现 `FakerCatalogModal.tsx`**

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { FAKER_CATALOG, type FakerEntry } from '../../../shared/faker-catalog';

interface Props {
  open: boolean;
  onClose: () => void;
  onInsert: (snippet: string) => void;
}

export default function FakerCatalogModal({ open, onClose, onInsert }: Props) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [activeTab, setActiveTab] = useState(FAKER_CATALOG[0].id);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => setDebounced(query), 150);
    return () => clearTimeout(t);
  }, [query, open]);

  useEffect(() => {
    if (open) setTimeout(() => searchRef.current?.focus(), 0);
    else { setQuery(''); setDebounced(''); }
  }, [open]);

  const filtered = useMemo(() => {
    if (!debounced) return null;
    const q = debounced.toLowerCase();
    return FAKER_CATALOG.flatMap((c) =>
      c.entries.filter(
        (e) => e.path.toLowerCase().includes(q) || e.label.toLowerCase().includes(q) || e.example.toLowerCase().includes(q),
      ),
    );
  }, [debounced]);

  if (!open) return null;

  const visibleEntries: FakerEntry[] = filtered ?? FAKER_CATALOG.find((c) => c.id === activeTab)!.entries;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal faker-modal" onClick={(e) => e.stopPropagation()}>
        <div className="faker-head">
          <h2>Faker 速查</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">✕</button>
        </div>
        <input
          ref={searchRef}
          className="faker-search"
          placeholder="搜索方法或关键词…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {!filtered && (
          <div className="faker-tabs">
            {FAKER_CATALOG.map((c) => (
              <button
                key={c.id}
                className={activeTab === c.id ? 'tab active' : 'tab'}
                onClick={() => setActiveTab(c.id)}
              >{c.label}</button>
            ))}
          </div>
        )}
        <div className="faker-body">
          {visibleEntries.length === 0 && <div className="empty">无匹配</div>}
          {visibleEntries.map((e) => (
            <div key={e.path} className="faker-row">
              <div className="faker-path">{e.path}</div>
              <div className="faker-label">{e.label}</div>
              <div className="faker-example">示例: {e.example}</div>
              {e.args && <div className="faker-args">参数: {e.args}</div>}
              <button className="primary" onClick={() => onInsert(e.snippet)}>插入</button>
            </div>
          ))}
        </div>
        <div className="faker-foot">
          语法：<code>{'{{faker.<模块>.<方法>[:参数]}}'}</code>
          <a href="https://fakerjs.dev/api/" target="_blank" rel="noreferrer">完整文档 ↗</a>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 在 RuleEditorModal 中接入**

新增 state：

```ts
const [fakerOpen, setFakerOpen] = useState(false);
const bodyRef = useRef<HTMLTextAreaElement>(null);
```

响应体 textarea 加 ref：`<textarea ref={bodyRef} ... />`

在「变量速查」行末尾加按钮：

```tsx
<button type="button" onClick={() => setFakerOpen(true)}>Faker 速查…</button>
```

插入回调：

```ts
const insertSnippet = (snippet: string) => {
  setBody((prev) => {
    const ta = bodyRef.current;
    if (!ta) return prev + snippet;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    return prev.slice(0, s) + snippet + prev.slice(e);
  });
};
```

Modal 渲染（组件最外层，`</div>` 关闭 mask 之前）：

```tsx
<FakerCatalogModal open={fakerOpen} onClose={() => setFakerOpen(false)} onInsert={insertSnippet} />
```

- [ ] **Step 3: 增加 Faker Modal 样式**

在 `src/renderer/src/styles.css` 末尾追加：

```css
.faker-modal { width: 680px; max-height: 80vh; display: flex; flex-direction: column; }
.faker-head { display: flex; justify-content: space-between; align-items: center; }
.faker-search { padding: 6px 8px; margin: 8px 0; }
.faker-tabs { display: flex; flex-wrap: wrap; gap: 4px; padding-bottom: 8px; border-bottom: 1px solid #ddd; }
.faker-tabs .tab { padding: 4px 10px; border: 1px solid #ccc; border-radius: 12px; background: #f5f5f5; cursor: pointer; }
.faker-tabs .tab.active { background: #2563eb; color: white; border-color: #2563eb; }
.faker-body { overflow: auto; flex: 1; padding: 8px 0; }
.faker-row { padding: 8px; border-bottom: 1px solid #eee; display: grid; grid-template-columns: 1fr auto; row-gap: 2px; }
.faker-path { font-family: monospace; font-size: 12px; color: #555; }
.faker-label { font-weight: 500; }
.faker-example { font-size: 12px; color: #666; }
.faker-args { font-size: 12px; color: #888; }
.faker-foot { padding-top: 8px; border-top: 1px solid #ddd; font-size: 12px; display: flex; justify-content: space-between; }
```

- [ ] **Step 4: 编译验证**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/renderer/src/components/FakerCatalogModal.tsx src/renderer/src/components/RuleEditorModal.tsx src/renderer/src/styles.css
git commit -m "feat(ui): add searchable faker catalog modal with click-to-insert"
```

---

### Task 9: EditableTable 通用组件

**Files:**
- Create: `src/renderer/src/components/EditableTable.tsx`
- Modify: `src/renderer/src/styles.css`

- [ ] **Step 1: 实现 `EditableTable.tsx`**

```tsx
import type { HeaderRow } from '../../../shared/types';

interface Columns {
  enabled?: boolean;
  namePlaceholder?: string;
  valuePlaceholder?: string;
  description?: boolean;
}

interface Props {
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
  columns?: Columns;
  ariaLabel?: string;
}

const EMPTY_ROW: HeaderRow = { enabled: true, name: '', value: '', description: '' };

export default function EditableTable({ rows, onChange, columns = {}, ariaLabel }: Props) {
  const showEnabled = columns.enabled !== false;
  const showDescription = columns.description !== false;

  const effective: HeaderRow[] = rows.length === 0 ? [EMPTY_ROW] : rows;
  const lastRow = effective[effective.length - 1];
  const needsTrailingEmpty =
    lastRow.name !== '' || lastRow.value !== '' || (lastRow.description ?? '') !== '';
  const visible = needsTrailingEmpty ? [...effective, { ...EMPTY_ROW }] : effective;

  const update = (idx: number, patch: Partial<HeaderRow>) => {
    const next = visible.map((r, i) => (i === idx ? { ...r, ...patch } : r));
    // 去除全为空的尾行（保留至少一行）
    while (
      next.length > 1 &&
      next[next.length - 1].name === '' &&
      next[next.length - 1].value === '' &&
      (next[next.length - 1].description ?? '') === ''
    ) {
      next.pop();
    }
    onChange(next);
  };

  const remove = (idx: number) => {
    const next = visible.filter((_, i) => i !== idx);
    onChange(next.length === 0 ? [{ ...EMPTY_ROW }] : next);
  };

  return (
    <table className="editable-table" aria-label={ariaLabel}>
      <thead>
        <tr>
          {showEnabled && <th className="col-enabled"></th>}
          <th>名称</th>
          <th>值</th>
          {showDescription && <th>描述</th>}
          <th className="col-action"></th>
        </tr>
      </thead>
      <tbody>
        {visible.map((row, i) => (
          <tr key={i} className={!row.enabled ? 'disabled' : ''}>
            {showEnabled && (
              <td className="col-enabled">
                <input
                  type="checkbox"
                  checked={row.enabled}
                  onChange={(e) => update(i, { enabled: e.target.checked })}
                />
              </td>
            )}
            <td>
              <input
                value={row.name}
                placeholder={columns.namePlaceholder ?? 'Name'}
                onChange={(e) => update(i, { name: e.target.value })}
              />
            </td>
            <td>
              <input
                value={row.value}
                placeholder={columns.valuePlaceholder ?? 'Value'}
                onChange={(e) => update(i, { value: e.target.value })}
              />
            </td>
            {showDescription && (
              <td>
                <input
                  value={row.description ?? ''}
                  placeholder="Description"
                  onChange={(e) => update(i, { description: e.target.value })}
                />
              </td>
            )}
            <td className="col-action">
              <button type="button" aria-label="删除行" onClick={() => remove(i)}>✕</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 2: 增加样式**

```css
.editable-table { width: 100%; border-collapse: collapse; }
.editable-table th, .editable-table td { padding: 4px; border: 1px solid #ddd; }
.editable-table th { background: #f5f5f5; font-weight: 500; font-size: 12px; }
.editable-table td input { width: 100%; padding: 4px; border: 0; background: transparent; }
.editable-table .col-enabled { width: 32px; text-align: center; }
.editable-table .col-action { width: 32px; text-align: center; }
.editable-table .col-action button { background: transparent; border: 0; cursor: pointer; color: #999; }
.editable-table tr.disabled td { opacity: 0.5; }
.editable-table tr.disabled td input[type='text'],
.editable-table tr.disabled td input:not([type]) { text-decoration: line-through; }
```

- [ ] **Step 3: 编译验证**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/renderer/src/components/EditableTable.tsx src/renderer/src/styles.css
git commit -m "feat(ui): add reusable EditableTable component (enabled/name/value/description)"
```

---

### Task 10: 请求头 / 响应头表格化

**Files:**
- Modify: `src/renderer/src/components/RuleEditorModal.tsx`

- [ ] **Step 1: 引入 EditableTable 与 HeaderRow 类型**

```ts
import EditableTable from './EditableTable';
import type { HeaderRow } from '../../../shared/types';
```

- [ ] **Step 2: 替换 state：`headersText` → `headersRows`，`respHeadersText` → `respHeadersRows`**

```ts
const [headersRows, setHeadersRows] = useState<HeaderRow[]>(() => {
  if (Array.isArray(seed?.match.headers)) return seed.match.headers;
  if (seed?.match.headers && typeof seed.match.headers === 'object') {
    return Object.entries(seed.match.headers).map(([name, value]) => ({
      enabled: true, name, value, description: '',
    }));
  }
  return [{ enabled: true, name: '', value: '', description: '' }];
});

const [respHeadersRows, setRespHeadersRows] = useState<HeaderRow[]>(() => {
  if (seed?.action.headers) {
    return Object.entries(seed.action.headers).map(([name, value]) => ({
      enabled: true, name, value, description: '',
    }));
  }
  return [{ enabled: true, name: '', value: '', description: '' }];
});
```

删除旧 state `headersText` / `respHeadersText` 及 `parseLines` / `formatLines` 中用于 headers 的部分（保留 body 相关）。

- [ ] **Step 3: 替换 JSX 中两处 `<textarea rows={2}>`**

```tsx
<label>请求头</label>
<EditableTable rows={headersRows} onChange={setHeadersRows} ariaLabel="请求头" />

<label>响应头</label>
<EditableTable rows={respHeadersRows} onChange={setRespHeadersRows} ariaLabel="响应头" />
```

- [ ] **Step 4: 更新 `save()` 中的序列化**

```ts
const headers: Record<string, string> = {};
for (const r of headersRows.filter((r) => r.enabled && r.name)) headers[r.name] = r.value;
const respHeaders: Record<string, string> = { 'content-type': 'application/json' };
for (const r of respHeadersRows.filter((r) => r.enabled && r.name)) respHeaders[r.name] = r.value;

const input: RuleInput = {
  ...
  match: {
    urlType, urlPattern, method,
    query: Object.keys(queryObj).length ? queryObj : undefined,
    headers: headersRows.filter((r) => r.name || r.value).length ? headersRows.filter((r) => r.name || r.value) : undefined,
    bodyContains: bodyContains || undefined,
  },
  action: { ...actionBase, headers: respHeaders },
};
```

- [ ] **Step 5: 编译验证 + E2E smoke**

Run: `npm run typecheck && npm run test:e2e -- e2e/capture-to-rule.spec.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/renderer/src/components/RuleEditorModal.tsx
git commit -m "feat(ui): convert request/response headers to editable table"
```

---

### Task 11: 请求体 Tabs

**Files:**
- Modify: `src/renderer/src/components/RuleEditorModal.tsx`
- Modify: `src/renderer/src/styles.css`
- Modify: `src/main/rules/matcher.ts`（如 Task 3 未覆盖 form 解析的某些边界）

- [ ] **Step 1: 新增 `body: RuleBody` state**

```ts
import type { BodyMode, BodyMatchStrategy, RuleBody } from '../../../shared/types';

const seedBody: RuleBody = seed?.match.body ?? {
  mode: seed?.match.bodyContains ? 'raw' : 'none',
  raw: seed?.match.bodyContains ?? '',
  matchStrategy: 'contains',
};
const [bodyRule, setBodyRule] = useState<RuleBody>(seedBody);
```

- [ ] **Step 2: 替换「请求体包含」input 为 Tabs**

```tsx
<label>请求体</label>
<div className="body-tabs">
  {(['none', 'raw', 'form-data', 'urlencoded'] as BodyMode[]).map((m) => (
    <button
      key={m}
      type="button"
      className={`tab ${bodyRule.mode === m ? 'active' : ''}`}
      onClick={() => setBodyRule({ ...bodyRule, mode: m, form: bodyRule.form ?? [{ enabled: true, name: '', value: '', description: '' }] })}
    >{m === 'none' ? '无' : m === 'raw' ? 'raw' : m === 'form-data' ? 'form-data' : 'x-www-form'}</button>
  ))}
</div>
{bodyRule.mode === 'none' && <div className="hint">此规则不匹配请求体</div>}
{bodyRule.mode === 'raw' && (
  <>
    <div className="body-options">
      <label>内容类型
        <input value={bodyRule.rawContentType ?? 'application/json'}
          onChange={(e) => setBodyRule({ ...bodyRule, rawContentType: e.target.value })} />
      </label>
      <label>匹配策略
        <select value={bodyRule.matchStrategy ?? 'contains'}
          onChange={(e) => setBodyRule({ ...bodyRule, matchStrategy: e.target.value as BodyMatchStrategy })}>
          <option value="contains">包含</option>
          <option value="equals">完全相等</option>
          <option value="json-deep">JSON 深度相等</option>
        </select>
      </label>
    </div>
    <textarea rows={8} value={bodyRule.raw ?? ''}
      onChange={(e) => setBodyRule({ ...bodyRule, raw: e.target.value })}
      placeholder='{"keyword": "test"}' />
  </>
)}
{(bodyRule.mode === 'form-data' || bodyRule.mode === 'urlencoded') && (
  <EditableTable
    rows={bodyRule.form ?? [{ enabled: true, name: '', value: '', description: '' }]}
    onChange={(form) => setBodyRule({ ...bodyRule, form })}
    columns={{ description: false }}
    ariaLabel="请求体表单"
  />
)}
```

- [ ] **Step 3: 更新 `save()` 中的序列化**

```ts
const matchBody: RuleBody | undefined =
  bodyRule.mode === 'none'
    ? undefined
    : bodyRule.mode === 'raw'
      ? { mode: 'raw', raw: bodyRule.raw, rawContentType: bodyRule.rawContentType, matchStrategy: bodyRule.matchStrategy }
      : { mode: bodyRule.mode, form: bodyRule.form?.filter((r) => r.name || r.value) };

const input: RuleInput = {
  ...
  match: {
    urlType, urlPattern, method,
    query: ..., headers: ...,
    body: matchBody,
  },
  ...
};
```

- [ ] **Step 4: 增加 tabs 样式**

```css
.body-tabs { display: flex; gap: 4px; margin-bottom: 6px; }
.body-tabs .tab { padding: 4px 12px; border: 1px solid #ccc; border-radius: 4px; background: #f5f5f5; cursor: pointer; }
.body-tabs .tab.active { background: #2563eb; color: white; border-color: #2563eb; }
.body-options { display: flex; gap: 16px; margin-bottom: 6px; font-size: 12px; }
.body-options label { display: flex; gap: 6px; align-items: center; }
.hint { color: #888; font-size: 12px; padding: 8px; }
```

- [ ] **Step 5: 编译验证 + 跑 matcher + E2E**

Run: `npm run typecheck && npx vitest run tests/matcher.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/renderer/src/components/RuleEditorModal.tsx src/renderer/src/styles.css
git commit -m "feat(ui): replace bodyContains input with tabbed body editor (none/raw/form/urlencoded)"
```

---

### Task 12: 升级 capture-to-rule 预填

**Files:**
- Modify: `src/renderer/src/lib/capture-to-rule.ts`
- Modify: `tests/capture-to-rule.test.ts`
- Modify: `e2e/capture-to-rule.spec.ts`

- [ ] **Step 1: 更新纯函数产出 HeaderRow[]**

```ts
import type { HttpMethod, HeaderRow, RuleInput, TrafficEvent } from '../../../shared/types';

const KNOWN_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

export function captureToRuleInput(event: TrafficEvent): RuleInput {
  const upper = event.method.toUpperCase();
  const method: HttpMethod = KNOWN_METHODS.includes(upper as HttpMethod) ? (upper as HttpMethod) : 'ANY';

  const headers: HeaderRow[] = [];
  if (event.responseHeaders) {
    for (const [k, v] of Object.entries(event.responseHeaders)) {
      if (k.toLowerCase() === 'content-type') {
        headers.push({ enabled: true, name: 'content-type', value: v, description: '' });
        break;
      }
    }
  }

  return {
    name: `${event.method} ${event.path}`,
    enabled: true,
    match: { urlType: 'exact', urlPattern: event.url, method },
    action: {
      status: event.status ?? 200,
      headers: Object.fromEntries(headers.map((r) => [r.name, r.value])),
      body: event.responseBody ?? '',
    },
  };
}
```

> 注意：`action.headers` 仍是 `Record<string,string>`（RuleAction 未改），但 `match.headers` 在新版 RuleEditorModal 里读为 `HeaderRow[]` 时会做类型检测，预填逻辑不再触发旧格式路径。

- [ ] **Step 2: 在 `tests/capture-to-rule.test.ts` 加断言**

```ts
it('match.headers is undefined (no prefill on the match side)', () => {
  const out = captureToRuleInput(event());
  expect(out.match.headers).toBeUndefined();
});
```

（capture-to-rule 不在 match 侧预填 headers，所以 match.headers 保持 undefined 符合既有语义。）

- [ ] **Step 3: 更新 `e2e/capture-to-rule.spec.ts` 的选择器**

如有依赖旧 textarea「请求头（每行 k: v）」的选择器，替换为 `getByRole('table', { name: '请求头' })` / `getByRole('textbox', { name: /Name/i })` 等。

- [ ] **Step 4: 运行相关测试**

Run: `npx vitest run tests/capture-to-rule.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/renderer/src/lib/capture-to-rule.ts tests/capture-to-rule.test.ts e2e/capture-to-rule.spec.ts
git commit -m "refactor(capture-to-rule): align with HeaderRow/RuleBody structures"
```

---

### Task 13: E2E 覆盖 Faker 速查 + 表格 + 请求体 Tabs

**Files:**
- Modify: `e2e/enhancements.spec.ts`

- [ ] **Step 1: Faker Modal E2E**

```ts
test('faker catalog modal inserts snippet at cursor', async ({ page }) => {
  await page.getByRole('button', { name: /新建规则/ }).click();
  await page.getByRole('button', { name: 'Faker 速查…' }).click();
  await page.getByPlaceholder('搜索方法或关键词').fill('email');
  await page.getByRole('button', { name: '插入' }).first().click();
  await expect(page.getByLabel('响应体')).toHaveValue(/faker\.internet\.email/);
  await page.getByRole('button', { name: '✕' }).click();
});

test('faker catalog links to fakerjs.dev', async ({ page, context }) => {
  await page.getByRole('button', { name: /新建规则/ }).click();
  await page.getByRole('button', { name: 'Faker 速查…' }).click();
  const [newPage] = await Promise.all([
    context.waitForEvent('page'),
    page.getByRole('link', { name: '完整文档' }).click(),
  ]);
  expect(newPage.url()).toContain('fakerjs.dev/api');
  await newPage.close();
});
```

- [ ] **Step 2: 请求头表格 E2E**

```ts
test('editable header table adds and deletes rows', async ({ page }) => {
  await page.getByRole('button', { name: /新建规则/ }).click();
  const table = page.getByRole('table', { name: '请求头' });
  await table.getByPlaceholder('Name').first().fill('X-Foo');
  await table.getByPlaceholder('Value').first().fill('bar');
  // 自动追加空行
  await expect(table.getByPlaceholder('Name')).toHaveCount(2);
  // 删除首行
  await table.locator('tr').first().getByRole('button', { name: '删除行' }).click();
  await expect(table.getByPlaceholder('Name').first()).toHaveValue('');
});
```

- [ ] **Step 3: 请求体 Tabs E2E**

```ts
test('body tabs switch modes and form-data uses editable table', async ({ page }) => {
  await page.getByRole('button', { name: /新建规则/ }).click();
  await page.getByRole('button', { name: 'form-data' }).click();
  const table = page.getByRole('table', { name: '请求体表单' });
  await table.getByPlaceholder('Name').first().fill('user');
  await table.getByPlaceholder('Value').first().fill('alice');
  await page.getByRole('button', { name: '保存' }).click();
  // 规则列表显示，可再次打开编辑检查 state
});

test('body tab json-deep strategy is preserved', async ({ page }) => {
  await page.getByRole('button', { name: /新建规则/ }).click();
  await page.getByRole('button', { name: 'raw' }).click();
  await page.getByLabel('匹配策略').selectOption('json-deep');
  await page.getByRole('textbox').fill('{"id":1}');
  await page.getByRole('button', { name: '保存' }).click();
  // 重新打开编辑，断言策略保持 json-deep
});
```

- [ ] **Step 4: 运行全量 E2E + vitest + typecheck**

Run: `npm run typecheck && npm run test && npm run test:e2e`
Expected: 全部 PASS

- [ ] **Step 5: 合入 master 并推送**

```bash
git checkout master
git merge --no-ff feat/faker-and-tables -m "Merge branch 'feat/faker-and-tables'"
git push
```

---

## Phase 3: 文档（PR3）

### Task 14: 更新 README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 在「使用」节下追加三小节**

```md
### 错误模板

在规则编辑器的「行为模拟」区块里，从「错误模板」下拉选择一个预设（9 个 4XX + 5 个 5XX + 5 个连接级异常），编辑器会自动填入对应的 status / 响应体 / networkError。选中模板后手工修改任意字段，下拉会自动回到「无（自定义）」但保留已填入值。

### Faker 速查

在「动态数据」区块的「变量速查」行，点击「Faker 速查…」打开分类化、可搜索的速查对话框。点击任意方法右侧的「插入」按钮即可把 `{{faker.<模块>.<方法>}}` 插入到响应体光标位置。完整文档见 https://fakerjs.dev/api/ 。

### 表格编辑

请求头、响应头与请求体（form-data / x-www-form-urlencoded）均改为 Postman 风格的可编辑表格：每行含 ✓ / 名称 / 值 / 描述 / ×，未勾选的行不参与匹配；请求体额外支持 `none / raw / form-data / x-www-form-urlencoded` 四种模式 tabs，raw 模式可选「包含 / 完全相等 / JSON 深度相等」三种匹配策略。
```

- [ ] **Step 2: 编译验证 + typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: 提交并推送**

```bash
git add README.md
git commit -m "docs: describe error templates, faker catalog, and table-based editing"
git checkout master
git merge --no-ff docs/mock-enhancements -m "Merge branch 'docs/mock-enhancements'"
git push
```

---

### Task 15: 最终集成验证与交付收尾

- [ ] **Step 1: 在 master 上跑全量验证**

Run: `npm run typecheck && npm run test && npm run test:e2e`
Expected: 全部 PASS

- [ ] **Step 2: 人工检查**

- `npm run dev` 启动，UI 上手动：
  - 新建规则 → 选 `http-404` → 保存 → 命中 → 流量显示 404
  - 新建规则 → 选 `conn-econnreset` → 网络异常复选框勾选
  - Faker 速查 → 搜索 email → 插入 → 渲染预览显示真实邮箱
  - 请求头表格 → 加 3 行 → 禁用中间行 → 保存 → 重新打开保持原样
  - 请求体 form-data → 加 2 行 → 命中 → 流量显示 matched

- [ ] **Step 3: 更新项目内存（`MEMORY.md`）**

在 `/Users/mabelkisskiss/.qoder/projects/-Users-mabelkisskiss-personal-mocker/memory/MEMORY.md` 的 mocker-charles-style-proxy-tool.md 行尾把「待实施」改为「2026-09-XX 合入 master」（实际日期由执行人填写）。

- [ ] **Step 4: 告知用户交付结果**

报告：
- 三个 PR 的 commit 列表
- 全量测试 / E2E 通过情况
- 任何需要人工回归的注意点
