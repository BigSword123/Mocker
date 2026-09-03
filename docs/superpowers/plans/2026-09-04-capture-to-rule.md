# 抓包转规则（Capture → Rule）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在流量详情区选中一条已录制请求后，一键把它转成预填好的 Mock 规则草稿，进入现有规则编辑弹窗修改并保存。

**Architecture:** 纯渲染层转换，零 IPC、零主进程改动。新增纯函数 `captureToRuleInput(event)` 把 `TrafficEvent` 映射为 `RuleInput`；`TrafficDetail` 加「转为规则」按钮；`TrafficPanel` 持有 `draft` 并在流量页直接渲染 `RuleEditorModal`（不切 tab）；`RuleEditorModal` 增加可选 `draft` prop，在 `initial === null` 时以其字段为 `useState` 种子。

**Tech Stack:** React 19 + TypeScript（strict）、Vitest（node 环境，纯函数单测）、Playwright（`electron.launch` E2E）。无新增依赖。

**分支与前置：** 在 `feat/capture-to-rule` 上工作（已从 master 切出）。注意：本分支的 `RuleEditorModal` 响应体仍是 `<textarea placeholder='{"code":0}'>`（模板补全的 CodeMirror 版本在未合并的 `feat/template-autocomplete` 分支上），本计划与 E2E 选择器均按 textarea 版本编写。

**规格来源：** `docs/superpowers/specs/2026-09-04-capture-to-rule-design.md`

---

## 文件结构

- **Create** `src/renderer/src/lib/capture-to-rule.ts` — 纯函数 `captureToRuleInput(event: TrafficEvent): RuleInput`，无副作用、可单测。
- **Create** `tests/capture-to-rule.test.ts` — 上述纯函数的 Vitest 单测。
- **Create** `e2e/capture-to-rule.spec.ts` — 端到端：建种子规则 → 经代理产生 mocked 流量 → 选中 → 转为规则 → 断言预填 → 保存 → 规则页可见。
- **Modify** `src/renderer/src/components/RuleEditorModal.tsx` — 增加 `draft?: RuleInput` prop，用 `seed = initial ?? draft ?? null` 作为各 `useState` 种子；update/add 分支与标题仍以 `initial` 为准。
- **Modify** `src/renderer/src/components/TrafficDetail.tsx` — 增加 `onCaptureToRule?` prop，标题行加「转为规则」按钮。
- **Modify** `src/renderer/src/components/TrafficPanel.tsx` — 持有 `draft`，传回调给 `TrafficDetail`，`draft` 非空时渲染 `RuleEditorModal`。
- **Modify** `src/renderer/src/styles.css` — 新增 `.detail-head` flex 布局规则。
- **Modify** `README.md` — 「使用」下新增「抓包转规则」小节。

> **测试约定：** 本项目无 React 组件单测框架（Vitest 为 node 环境，仅测纯函数），UI 行为一律由 Playwright E2E 覆盖。因此 Task 2/3 的组件改动以 `npm run typecheck` + `npm run build` 验证可编译，行为在 Task 4 的 E2E 中验证——这是项目既有做法，不引入 RTL/jsdom。

---

## Task 1: capture-to-rule 纯函数（TDD）

**Files:**
- Create: `src/renderer/src/lib/capture-to-rule.ts`
- Test: `tests/capture-to-rule.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/capture-to-rule.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { captureToRuleInput } from '../src/renderer/src/lib/capture-to-rule';
import type { TrafficEvent } from '../src/shared/types';

function event(overrides: Partial<TrafficEvent> = {}): TrafficEvent {
  return {
    id: 'evt-1',
    startedAt: 0,
    method: 'GET',
    url: 'http://api.example.com/users/7?page=2',
    host: 'api.example.com',
    path: '/users/7',
    status: 200,
    requestHeaders: { 'x-token': 'abc' },
    responseBody: '{"id":7}',
    responseHeaders: { 'content-type': 'application/json' },
    mocked: false,
    ...overrides,
  };
}

describe('captureToRuleInput', () => {
  it('maps a full event to a prefilled rule input', () => {
    expect(captureToRuleInput(event())).toEqual({
      name: 'GET /users/7',
      enabled: true,
      match: {
        urlType: 'exact',
        urlPattern: 'http://api.example.com/users/7?page=2',
        method: 'GET',
      },
      action: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"id":7}',
      },
    });
  });

  it('keeps the full url including query for exact match', () => {
    const input = captureToRuleInput(event({ url: 'http://x.test/p?a=1&b=2', path: '/p' }));
    expect(input.match.urlPattern).toBe('http://x.test/p?a=1&b=2');
    expect(input.name).toBe('GET /p');
  });

  it('falls back to 200 and empty body for an errored request', () => {
    const input = captureToRuleInput(
      event({ status: undefined, responseBody: undefined, responseHeaders: undefined, error: 'ECONNRESET' }),
    );
    expect(input.action.status).toBe(200);
    expect(input.action.body).toBe('');
    expect(input.action.headers).toEqual({});
  });

  it('omits headers when response has no content-type', () => {
    const input = captureToRuleInput(event({ responseHeaders: { 'x-other': '1' } }));
    expect(input.action.headers).toEqual({});
  });

  it('finds content-type case-insensitively', () => {
    const input = captureToRuleInput(event({ responseHeaders: { 'Content-Type': 'text/plain' } }));
    expect(input.action.headers).toEqual({ 'content-type': 'text/plain' });
  });

  it('maps a non-standard method to ANY', () => {
    expect(captureToRuleInput(event({ method: 'CONNECT' })).match.method).toBe('ANY');
  });

  it('uppercases a lowercase method', () => {
    expect(captureToRuleInput(event({ method: 'post' })).match.method).toBe('POST');
  });

  it('converts a mocked event without special handling', () => {
    const input = captureToRuleInput(event({ mocked: true, matchedRuleId: 'r1' }));
    expect(input.match.urlPattern).toBe('http://api.example.com/users/7?page=2');
    expect(input.enabled).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试，确认 RED**

Run: `npx vitest run tests/capture-to-rule.test.ts`
Expected: FAIL —— 无法解析 `../src/renderer/src/lib/capture-to-rule`（模块不存在）。

- [ ] **Step 3: 写最小实现**

创建 `src/renderer/src/lib/capture-to-rule.ts`：

```ts
import type { HttpMethod, RuleInput, TrafficEvent } from '../../../shared/types';

const KNOWN_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

export function captureToRuleInput(event: TrafficEvent): RuleInput {
  const upper = event.method.toUpperCase();
  const method: HttpMethod = KNOWN_METHODS.includes(upper as HttpMethod)
    ? (upper as HttpMethod)
    : 'ANY';

  const headers: Record<string, string> = {};
  if (event.responseHeaders) {
    for (const [k, v] of Object.entries(event.responseHeaders)) {
      if (k.toLowerCase() === 'content-type') {
        headers['content-type'] = v;
        break;
      }
    }
  }

  return {
    name: `${event.method} ${event.path}`,
    enabled: true,
    match: {
      urlType: 'exact',
      urlPattern: event.url,
      method,
    },
    action: {
      status: event.status ?? 200,
      headers,
      body: event.responseBody ?? '',
    },
  };
}
```

- [ ] **Step 4: 运行测试，确认 GREEN**

Run: `npx vitest run tests/capture-to-rule.test.ts`
Expected: PASS（8 个用例全绿）。

- [ ] **Step 5: 类型检查**

Run: `npm run typecheck`
Expected: 无错误退出（`tsc -p tsconfig.node.json` 与 `tsconfig.web.json` 均通过）。

- [ ] **Step 6: 提交**

```bash
git add src/renderer/src/lib/capture-to-rule.ts tests/capture-to-rule.test.ts
git commit -m "feat(renderer): add captureToRuleInput pure mapping"
```

---

## Task 2: RuleEditorModal 接受 draft 预填

**Files:**
- Modify: `src/renderer/src/components/RuleEditorModal.tsx:46-73`

> 行为由 Task 4 的 E2E 验证；本任务以 `typecheck` 确认可编译。`RuleInput` 已在文件顶部导入（无需新增 import）。

- [ ] **Step 1: Props 增加 draft**

把（约 46-50 行）：

```tsx
interface Props {
  initial: MockRule | null;
  onClose: () => void;
  onSaved: () => void;
}
```

改为：

```tsx
interface Props {
  initial: MockRule | null;
  draft?: RuleInput;
  onClose: () => void;
  onSaved: () => void;
}
```

- [ ] **Step 2: 用 seed 作为 useState 种子**

把（约 52-73 行，函数签名到 `neStatusCode` 这个 useState 为止）：

```tsx
export default function RuleEditorModal({ initial, onClose, onSaved }: Props) {
  const [name, setName] = useState(initial?.name ?? '');
  const [urlType, setUrlType] = useState<UrlPatternType>(initial?.match.urlType ?? 'wildcard');
  const [urlPattern, setUrlPattern] = useState(initial?.match.urlPattern ?? '');
  const [method, setMethod] = useState<HttpMethod>(initial?.match.method ?? 'ANY');
  const [queryText, setQueryText] = useState(formatLines(initial?.match.query, '='));
  const [headersText, setHeadersText] = useState(formatLines(initial?.match.headers, ': '));
  const [bodyContains, setBodyContains] = useState(initial?.match.bodyContains ?? '');
  const [status, setStatus] = useState(initial?.action.status ?? 200);
  const [respHeadersText, setRespHeadersText] = useState(formatLines(initial?.action.headers, ': '));
  const [body, setBody] = useState(initial?.action.body ?? '');

  const [delayMs, setDelayMs] = useState<number | ''>(initial?.action.delayMs ?? '');
  const [fakerLocale, setFakerLocale] = useState(initial?.action.fakerLocale ?? 'zh_CN');
  const [neEnabled, setNeEnabled] = useState(Boolean(initial?.action.networkError));
  const [neProbability, setNeProbability] = useState<number | ''>(
    initial?.action.networkError?.probability ?? 100,
  );
  const [neType, setNeType] = useState<NetworkErrorType>(initial?.action.networkError?.type ?? 'ECONNRESET');
  const [neStatusCode, setNeStatusCode] = useState<number | ''>(
    initial?.action.networkError?.errorStatusCode ?? '',
  );
```

改为：

```tsx
export default function RuleEditorModal({ initial, draft, onClose, onSaved }: Props) {
  // initial（编辑现有规则）优先；新建时可由 draft（抓包转规则）预填。两者不会同时出现。
  const seed = initial ?? draft ?? null;
  const [name, setName] = useState(seed?.name ?? '');
  const [urlType, setUrlType] = useState<UrlPatternType>(seed?.match.urlType ?? 'wildcard');
  const [urlPattern, setUrlPattern] = useState(seed?.match.urlPattern ?? '');
  const [method, setMethod] = useState<HttpMethod>(seed?.match.method ?? 'ANY');
  const [queryText, setQueryText] = useState(formatLines(seed?.match.query, '='));
  const [headersText, setHeadersText] = useState(formatLines(seed?.match.headers, ': '));
  const [bodyContains, setBodyContains] = useState(seed?.match.bodyContains ?? '');
  const [status, setStatus] = useState(seed?.action.status ?? 200);
  const [respHeadersText, setRespHeadersText] = useState(formatLines(seed?.action.headers, ': '));
  const [body, setBody] = useState(seed?.action.body ?? '');

  const [delayMs, setDelayMs] = useState<number | ''>(seed?.action.delayMs ?? '');
  const [fakerLocale, setFakerLocale] = useState(seed?.action.fakerLocale ?? 'zh_CN');
  const [neEnabled, setNeEnabled] = useState(Boolean(seed?.action.networkError));
  const [neProbability, setNeProbability] = useState<number | ''>(
    seed?.action.networkError?.probability ?? 100,
  );
  const [neType, setNeType] = useState<NetworkErrorType>(seed?.action.networkError?.type ?? 'ECONNRESET');
  const [neStatusCode, setNeStatusCode] = useState<number | ''>(
    seed?.action.networkError?.errorStatusCode ?? '',
  );
```

> **不要改** `save()` 里的 `enabled: initial?.enabled ?? true`（约 118 行）、`if (initial) await api.rulesUpdate(initial.id, input); else await api.rulesAdd(input);`（约 130 行）和标题 `{initial ? '编辑规则' : '新建规则'}`（约 167 行）——这三处必须继续以 `initial` 为准：draft 没有 `id`，永远走新增；标题应显示「新建规则」。

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck`
Expected: 无错误退出。`seed` 推断为 `MockRule | RuleInput | null`，两者都含 `match: RuleMatch` 与 `action: RuleAction`，访问 `.match.urlType` / `.action.status` 等合法。

- [ ] **Step 4: 提交**

```bash
git add src/renderer/src/components/RuleEditorModal.tsx
git commit -m "feat(ui): RuleEditorModal accepts draft prefill for capture-to-rule"
```

---

## Task 3: TrafficDetail 按钮 + TrafficPanel 接线 + 样式

**Files:**
- Modify: `src/renderer/src/components/TrafficDetail.tsx:31-35`
- Modify: `src/renderer/src/components/TrafficPanel.tsx:1-33`
- Modify: `src/renderer/src/styles.css:37`

- [ ] **Step 1: TrafficDetail 加 Props 与按钮**

把（约 31-35 行）：

```tsx
export default function TrafficDetail({ event }: { event: TrafficEvent | null }) {
  if (!event) return <div className="detail empty">选择一个请求查看详情</div>;
  return (
    <div className="detail">
      <h3>{event.method} {event.url}</h3>
```

改为：

```tsx
interface Props {
  event: TrafficEvent | null;
  onCaptureToRule?: (event: TrafficEvent) => void;
}

export default function TrafficDetail({ event, onCaptureToRule }: Props) {
  if (!event) return <div className="detail empty">选择一个请求查看详情</div>;
  return (
    <div className="detail">
      <div className="detail-head">
        <h3>{event.method} {event.url}</h3>
        {onCaptureToRule && (
          <button data-testid="capture-to-rule" onClick={() => onCaptureToRule(event)}>
            转为规则
          </button>
        )}
      </div>
```

> 其余部分（错误横幅、请求头/体表等）保持不变；只是把原 `<h3>` 包进 `.detail-head` 并在其右侧加按钮。

- [ ] **Step 2: TrafficPanel 持有 draft 并渲染弹窗**

把整个 `src/renderer/src/components/TrafficPanel.tsx` 改为：

```tsx
import { useMemo, useState } from 'react';
import type { RuleInput } from '../../../shared/types';
import { captureToRuleInput } from '../lib/capture-to-rule';
import { useTrafficStore } from '../stores/traffic';
import RuleEditorModal from './RuleEditorModal';
import TrafficDetail from './TrafficDetail';
import TrafficTable from './TrafficTable';

export default function TrafficPanel() {
  const { list, filter, paused, setFilter, togglePause, clear } = useTrafficStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RuleInput | null>(null);

  const filtered = useMemo(
    () => (filter ? list.filter((e) => e.url.includes(filter)) : list),
    [list, filter],
  );

  const selected = useMemo(
    () => list.find((e) => e.id === selectedId) ?? null,
    [list, selectedId],
  );

  return (
    <div className="traffic-panel">
      <div className="toolbar">
        <input placeholder="过滤 URL…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button onClick={togglePause}>{paused ? '继续' : '暂停'}</button>
        <button onClick={() => { clear(); setSelectedId(null); }}>清空</button>
        <span className="muted">{filtered.length} 条</span>
      </div>
      <div className="split">
        <TrafficTable events={filtered} selectedId={selectedId} onSelect={(e) => setSelectedId(e.id)} />
        <TrafficDetail event={selected} onCaptureToRule={(e) => setDraft(captureToRuleInput(e))} />
      </div>
      {draft && (
        <RuleEditorModal
          initial={null}
          draft={draft}
          onClose={() => setDraft(null)}
          onSaved={() => setDraft(null)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 3: styles.css 加 .detail-head 布局**

把（约 37-38 行）：

```css
.detail h3 { font-size: 13px; margin-bottom: 8px; word-break: break-all; }
.detail h4 { margin: 12px 0 4px; color: #8a8b96; font-size: 12px; }
```

改为：

```css
.detail h3 { font-size: 13px; margin-bottom: 8px; word-break: break-all; }
.detail-head { display: flex; align-items: center; gap: 8px; }
.detail-head h3 { flex: 1; min-width: 0; }
.detail h4 { margin: 12px 0 4px; color: #8a8b96; font-size: 12px; }
```

- [ ] **Step 4: 类型检查 + 构建**

Run: `npm run typecheck && npm run build`
Expected: 两者均无错误退出（构建产物落到 `out/`）。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/src/components/TrafficDetail.tsx src/renderer/src/components/TrafficPanel.tsx src/renderer/src/styles.css
git commit -m "feat(ui): add 转为规则 button in traffic detail, wire draft into rule modal"
```

---

## Task 4: E2E 抓包转规则

**Files:**
- Create: `e2e/capture-to-rule.spec.ts`

> **前置：** 运行 E2E 前必须确保没有其它 mocker 实例占用 `8888` / `8899` 端口（开发用的 `npm run dev` 实例要先退出），否则 `electron.launch` 会因端口冲突失败。Playwright 配置为 `workers: 1`、`testDir: 'e2e'`。

- [ ] **Step 1: 写 E2E**

创建 `e2e/capture-to-rule.spec.ts`：

```ts
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { fetch, ProxyAgent } from 'undici';

let app: ElectronApplication;
let win: Page;
const TARGET = 'http://capture.example.test/api?x=1';
const BODY = '{"hello":"capture"}';

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'] });
  win = await app.firstWindow();
});

test.afterAll(async () => {
  // 只清理本用例创建的规则（种子规则 + 转换出的规则），避免误删开发者真实规则
  await win.evaluate(async () => {
    for (const r of await window.api.rulesList()) {
      if (r.match.urlPattern.includes('capture.example.test')) await window.api.rulesRemove(r.id);
    }
  });
  await app.close();
});

test('converts a captured request into a prefilled rule', async () => {
  await win.waitForSelector('[data-testid="traffic-tab"]');

  // 确保代理在运行
  await win.evaluate(async () => {
    const status = await window.api.proxyStatus();
    if (!status.running) await window.api.proxyStart();
  });
  const status = await win.evaluate(() => window.api.proxyStatus());
  expect(status.running).toBe(true);

  // 建一条种子规则，让目标请求被 mock，从而产生一条带响应体的流量
  await win.evaluate(
    async ({ url, body }) => {
      await window.api.rulesAdd({
        name: 'capture-seed',
        enabled: true,
        match: { urlType: 'exact', urlPattern: url, method: 'ANY' },
        action: { status: 200, headers: { 'content-type': 'application/json' }, body },
      });
    },
    { url: TARGET, body: BODY },
  );

  // 经代理发请求，命中种子规则
  const agent = new ProxyAgent(`http://127.0.0.1:${status.port}`);
  const res = await fetch(TARGET, { dispatcher: agent });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe(BODY);
  await agent.close();

  // 流量表出现该请求并选中
  const row = win.locator('.traffic-table .row', { hasText: 'capture.example.test' }).first();
  await expect(row).toBeVisible({ timeout: 10000 });
  await row.click();

  // 详情区出现「转为规则」按钮，点击打开预填弹窗
  await win.locator('[data-testid="capture-to-rule"]').click();
  await expect(win.locator('.modal h2')).toHaveText('新建规则');

  // URL 模式 = 完整 URL（含 query）
  await expect(win.getByPlaceholder('http://api.example.com/*')).toHaveValue(TARGET);
  // 响应体原样预填
  await expect(win.locator('textarea[placeholder=\'{"code":0}\']')).toHaveValue(BODY);
  // content-type 预填一行
  await expect(win.locator('.form-grid label:has-text("响应头") + textarea')).toHaveValue(/content-type/);

  // 保存
  await win.getByRole('button', { name: '保存', exact: true }).click();
  await expect(win.locator('.modal')).toHaveCount(0);

  // 规则页出现新规则
  await win.locator('nav.tabs').getByRole('button', { name: '规则', exact: true }).click();
  await expect(win.locator('.rules-table')).toContainText('capture.example.test');
});
```

- [ ] **Step 2: 构建并运行该 E2E，确认 PASS**

Run: `npm run build && npx playwright test e2e/capture-to-rule.spec.ts`
Expected: 1 passed。若失败，优先排查：① 端口被占用（退出 dev 实例）；② 响应体 textarea 选择器是否命中（本分支为 `textarea[placeholder='{"code":0}']`）；③ mocked 流量的 `responseBody` 是否非空（决定响应体断言）。

- [ ] **Step 3: 提交**

```bash
git add e2e/capture-to-rule.spec.ts
git commit -m "test(e2e): cover capture-to-rule prefill and save flow"
```

---

## Task 5: 文档 + 全量验证

**Files:**
- Modify: `README.md:20-26`（「使用」区块内）

- [ ] **Step 1: README 增加「抓包转规则」小节**

把（约 19-26 行）：

```markdown
4. 「规则」页新建 Mock 规则，保存即生效，无需重启

### 规则匹配要点
```

改为：

```markdown
4. 「规则」页新建 Mock 规则，保存即生效，无需重启

### 抓包转规则

在「流量」页选中一条请求，详情区点「转为规则」，即可用该请求的 URL、状态码、`content-type` 与响应体预填一个新建规则窗，改完保存即生效。URL 默认按**精确全 URL（含 query）**匹配；响应体原样拷贝、不截断。

### 规则匹配要点
```

- [ ] **Step 2: 全量单元测试**

Run: `npm test`
Expected: 全绿（在原有 124 个用例基础上新增 8 个 capture-to-rule 用例）。

- [ ] **Step 3: 类型检查 + 构建**

Run: `npm run typecheck && npm run build`
Expected: 均无错误退出。

- [ ] **Step 4: 全量 E2E（回归）**

> 先确保 `8888` / `8899` 端口空闲（退出 dev 实例）。

Run: `npm run test:e2e`
Expected: `smoke`、`enhancements`、`capture-to-rule` 三个 spec 全部通过。

- [ ] **Step 5: 提交**

```bash
git add README.md
git commit -m "docs: describe capture-to-rule in README usage section"
```

---

## Self-Review

**1. Spec coverage（逐节对照设计文档）：**

- §1 目标 / 非目标 → 整体范围；非目标（重放、录制开关、勾选向导）未纳入任何任务 ✓
- §2 现状与约束（exact 全 URL 比较、事件仅在渲染层）→ Task 1 实现据此用 `urlType:'exact'` + `urlPattern:event.url`，并被 `keeps the full url including query` 用例锁定 ✓
- §3 架构与数据流：
  - 纯函数 `capture-to-rule.ts` → Task 1 ✓
  - `TrafficDetail` 回调 prop + 标题旁按钮 → Task 3 Step 1 ✓
  - `TrafficPanel` 持有 `draft`、流量页直接渲染弹窗、不切 tab → Task 3 Step 2 ✓
  - `RuleEditorModal` `draft?` prop + `initial===null` 时种子 + `initial` 非空忽略 draft → Task 2（`seed = initial ?? draft ?? null`，update/add 与标题仍用 `initial`）✓
  - `RulesPanel`/主进程/IPC/shared 不改动 → 计划未触碰这些文件 ✓
- §4 字段映射与边界 → Task 1 实现 + 单测逐条覆盖：name `${method} ${path}`、enabled true、exact 全 URL、method 归一化、query/headers/bodyContains 不设、status `?? 200`、仅 content-type 行、body 原样不截断、delay/locale/networkError 不设；边界（mocked 可转、error→200+空体且按钮不禁用、不截断）→ 单测 + Task 3 按钮恒显（仅依赖 `onCaptureToRule` 是否存在，不依赖 error）✓
- §5 错误处理（纯函数无失败路径、保存失败复用弹窗 error 横幅、不新增 IPC）→ Task 1 纯函数不抛错；保存路径未改，沿用 `RuleEditorModal.save()` 既有 error 横幅 ✓
- §6 测试策略：单元 `tests/capture-to-rule.test.ts` → Task 1；E2E `e2e/capture-to-rule.spec.ts`（建规则→代理 fetch→点行→转为规则→断言预填→保存→规则页可见→afterAll 只删本用例规则）→ Task 4；手工（无选中不渲染按钮、预填后可改并保存）→ Task 3 Step 1 的 `if (!event) return …` 空状态先于按钮 + E2E 的保存流程覆盖 ✓
- §7 无新增依赖 → 计划未改 `package.json` ✓

**2. Placeholder scan：** 无 TBD/TODO；每个改代码的步骤都给了完整 old/new 代码或整文件内容；每条命令都带预期输出 ✓

**3. Type consistency：**
- `captureToRuleInput(event: TrafficEvent): RuleInput` —— Task 1 定义，Task 3 `TrafficPanel` 以 `(e) => setDraft(captureToRuleInput(e))` 调用，`e` 由 `TrafficDetail` 的 `onCaptureToRule?: (event: TrafficEvent) => void` 推断为 `TrafficEvent`，返回 `RuleInput` 存入 `useState<RuleInput | null>` ✓
- `draft?: RuleInput` —— Task 2 在 `RuleEditorModal` 定义，Task 3 `TrafficPanel` 传 `draft={draft}`（`RuleInput`）✓
- `RuleInput` / `TrafficEvent` / `HttpMethod` 均来自 `src/shared/types.ts`，导入路径：`lib/` 与 `components/` 用 `../../../shared/types`，`tests/` 用 `../src/shared/types` ✓
- 选择器一致性：`data-testid="capture-to-rule"`（Task 3 定义 / Task 4 使用）、`textarea[placeholder='{"code":0}']`（本分支既有 / Task 4 使用）、`getByPlaceholder('http://api.example.com/*')`（既有 URL 模式输入 / Task 4 使用）、`.rules-table`（`RulesPanel` 既有 / Task 4 使用）、`[data-testid="traffic-tab"]`（`App.tsx` 既有 / Task 4 使用）✓

无缺口，无需补任务。
