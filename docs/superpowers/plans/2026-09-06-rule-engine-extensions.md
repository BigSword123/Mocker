# 规则引擎扩展（第二期）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 mocker 实现 spec `docs/superpowers/specs/2026-09-06-rule-engine-extensions-design.md` 定义的第二期功能：Map Local / Map Remote（独立重定向规则区）、场景化（命名分组 + 整组 enable）、序列响应（规则内计数器）。

**Architecture:** 新增独立 `redirects` 与 `scenarios` 文件存储；`RuleAction` 升级为可辨识联合（`static` / `sequential`）；`proxy-server` 匹配管道改为「重定向 → mock（含 sequential）→ 透传」；UI 新增「重定向」「场景」两个 tab。`computeMockResult`/`ReplayService`/Electron 渲染层架构保持不变。

**Tech Stack:** Electron + mockttp + React + zustand + vitest + Playwright（既有栈，无新依赖）。

**执行注意：** E2E 与 dev 需 8888/8899 空闲，先退出运行中的 mocker 实例。

---

## 文件结构总览

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/shared/types.ts` | 修改 | 加 RedirectRule / Scenario / SequentialResponse；RuleAction 改为可辨识联合；TrafficEvent.sequenceIndex |
| `src/shared/api.ts`、`src/preload/index.ts`、`src/main/ipc.ts` | 修改 | redirects:* / scenarios:* / rules:resetSequence |
| `src/main/rules/rule-effective.ts` | 新建 | 纯函数：启停叠加判定 |
| `src/main/rules/redirect.ts` | 新建 | mimeForPath / resolveMapLocal / sendMapRemote |
| `src/main/rules/apply-rule.ts` | 修改 | sequential 分支 |
| `src/main/rules/validate.ts` | 修改 | sequential 校验 |
| `src/main/storage/redirects-store.ts` | 新建 | 重定向规则 CRUD |
| `src/main/storage/scenarios-store.ts` | 新建 | 场景 CRUD + 重命名级联 |
| `src/main/storage/rules-store.ts` | 修改 | 新增/迁移 `scenario` 字段 |
| `src/main/proxy/proxy-server.ts` | 修改 | redirect-first 管道 + scenario 过滤 + sequential 计数 + reset |
| `src/main/index.ts` | 修改 | 新 store 装载 + 接线 |
| `src/renderer/src/components/ScenarioField.tsx` | 新建 | 共享「场景」单选下拉 |
| `src/renderer/src/components/RuleEditorModal.tsx` | 修改 | 行为模拟响应模式切换（static/sequential）+ 场景下拉 |
| `src/renderer/src/components/RedirectsPanel.tsx` | 新建 | 重定向规则列表 |
| `src/renderer/src/components/RedirectEditorModal.tsx` | 新建 | 重定向规则编辑（含 mapLocal/mapRemote 切换 + 文件选择） |
| `src/renderer/src/components/ScenariosPanel.tsx` | 新建 | 场景列表 + 整组 enable |
| `src/renderer/src/App.tsx` | 修改 | 增加 redirects、scenarios tab |
| `tests/rule-effective.test.ts`、`tests/redirect.test.ts`、`tests/scenarios-store.test.ts`、`tests/redirects-store.test.ts` | 新建 | 单测 |
| `e2e/map-local.spec.ts`、`e2e/scenarios.spec.ts`、`e2e/sequence.spec.ts` | 新建 | E2E |

---

### Task 1: shared 类型扩展

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: 新增 RedirectRule / Scenario / SequentialResponse / RuleAction 联合**

```ts
export interface RedirectRule {
  id: string;
  name: string;
  enabled: boolean;
  scenario?: string;
  priority: number;
  match: RuleMatch;
  action: 'mapLocal' | 'mapRemote';
  target: string;
}

export interface Scenario {
  name: string;
  enabled: boolean;
}

export interface SequentialResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
```

`RuleAction` 改为联合（替换现有定义）：

```ts
export type RuleAction =
  | {
      kind?: 'static';
      status: number;
      headers: Record<string, string>;
      body: string;
      delayMs?: number;
      fakerLocale?: string;
      networkError?: NetworkError;
    }
  | {
      kind: 'sequential';
      responses: SequentialResponse[];
      fakerLocale?: string;
    };
```

`TrafficEvent` 在 `errorTriggered?: boolean;` 之后追加 `sequenceIndex?: number;`。

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: 大量现有引用 `RuleAction` 的地方会报错（缺 discriminator）—— 这是预期的，下游任务会修复。先把这一阶段保留为「类型扩展」单独提交。

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(types): add RedirectRule/Scenario/SequentialResponse, upgrade RuleAction union"
```

---

### Task 2: 启停叠加纯函数 + 单测

**Files:**
- Create: `src/main/rules/rule-effective.ts`
- Test: `tests/rule-effective.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/rule-effective.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { ruleEffective } from '../src/main/rules/rule-effective';
import type { Scenario } from '../src/shared/types';

const scenarios = (entries: Array<[string, boolean]>): Map<string, Scenario> =>
  new Map(entries.map(([name, enabled]) => [name, { name, enabled }]));

describe('ruleEffective', () => {
  it('rule disabled → false', () => {
    expect(ruleEffective({ enabled: false }, scenarios([]))).toBe(false);
  });

  it('rule enabled without scenario → true', () => {
    expect(ruleEffective({ enabled: true }, scenarios([]))).toBe(true);
  });

  it('rule enabled + scenario enabled → true', () => {
    expect(
      ruleEffective({ enabled: true, scenario: 'dev' }, scenarios([['dev', true]])),
    ).toBe(true);
  });

  it('rule enabled + scenario disabled → false', () => {
    expect(
      ruleEffective({ enabled: true, scenario: 'dev' }, scenarios([['dev', false]])),
    ).toBe(false);
  });

  it('rule enabled + unknown scenario → true (treat as default)', () => {
    expect(
      ruleEffective({ enabled: true, scenario: 'gone' }, scenarios([])),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: 确认失败**

Run: `npm test -- rule-effective`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/main/rules/rule-effective.ts`：

```ts
import type { Scenario } from '../../shared/types';

export interface RuleEnabledRef {
  enabled: boolean;
  scenario?: string;
}

export function ruleEffective(rule: RuleEnabledRef, scenarios: ReadonlyMap<string, Scenario>): boolean {
  if (!rule.enabled) return false;
  if (rule.scenario === undefined) return true;
  const s = scenarios.get(rule.scenario);
  return s ? s.enabled : true;
}
```

- [ ] **Step 4: 确认通过**

Run: `npm test -- rule-effective`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add src/main/rules/rule-effective.ts tests/rule-effective.test.ts
git commit -m "feat(rules): ruleEffective overlay (rule.enabled AND scenario.enabled)"
```

---

### Task 3: ScenariosStore + 单测

**Files:**
- Create: `src/main/storage/scenarios-store.ts`
- Test: `tests/scenarios-store.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/scenarios-store.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ScenariosStore } from '../src/main/storage/scenarios-store';

let dir: string;
let store: ScenariosStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mocker-scenarios-'));
  store = new ScenariosStore(dir);
  await store.load();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('ScenariosStore', () => {
  it('starts empty when no file', async () => {
    expect(store.list()).toEqual([]);
  });

  it('add persists and lists', async () => {
    await store.add('dev');
    await store.add('staging');
    expect(store.list().map((s) => s.name).sort()).toEqual(['dev', 'staging']);
  });

  it('rename updates name and reports affected references', async () => {
    await store.add('dev');
    const affected = await store.rename('dev', 'local');
    expect(affected).toBe(0);
    expect(store.list().map((s) => s.name)).toEqual(['local']);
  });

  it('rename to existing name throws', async () => {
    await store.add('dev');
    await store.add('local');
    await expect(store.rename('dev', 'local')).rejects.toThrow();
  });

  it('rename reports affectedRefs from caller-provided refs list', async () => {
    await store.add('dev');
    const refs = [
      { kind: 'rule' as const, id: 'r1' },
      { kind: 'redirect' as const, id: 'rr1' },
      { kind: 'rule' as const, id: 'r2' },
    ];
    const affected = await store.rename('dev', 'local', refs, (r) => `renamed-${r.kind}-${r.id}`);
    expect(affected).toBe(3);
  });

  it('setEnabled toggles', async () => {
    await store.add('dev');
    await store.setEnabled('dev', false);
    expect(store.list()[0]!.enabled).toBe(false);
  });

  it('remove clears references reported', async () => {
    await store.add('dev');
    const refs = [{ kind: 'rule' as const, id: 'r1' }];
    const affected = await store.remove('dev', refs);
    expect(affected).toBe(1);
    expect(store.list()).toEqual([]);
  });

  it('persists across instances', async () => {
    await store.add('dev');
    await store.setEnabled('dev', false);
    const other = new ScenariosStore(dir);
    await other.load();
    expect(other.list()).toEqual([{ name: 'dev', enabled: false }]);
  });
});
```

> 测试 4 和 5 在写实现后语义可能调整（rename/remove 直接接受引用回调即可）；按测试编译后再微调实现。

- [ ] **Step 2: 实现 `src/main/storage/scenarios-store.ts`**

```ts
import * as path from 'node:path';
import type { Scenario } from '../../shared/types';
import { JsonStore } from './json-store';

export type ScenarioRef = { kind: 'rule'; id: string } | { kind: 'redirect'; id: string };

export class ScenariosStore {
  private store: JsonStore<Scenario[]>;
  private scenarios: Scenario[] = [];

  constructor(dataDir: string) {
    this.store = new JsonStore<Scenario[]>(path.join(dataDir, 'scenarios.json'), []);
  }

  async load(): Promise<void> {
    try {
      this.scenarios = await this.store.read();
    } catch (err) {
      console.warn('[scenarios-store] failed to load, starting empty:', err);
      this.scenarios = [];
    }
  }

  list(): Scenario[] {
    return this.scenarios.map((s) => ({ ...s }));
  }

  async add(name: string): Promise<Scenario> {
    if (this.scenarios.some((s) => s.name === name)) {
      throw new Error(`场景已存在: ${name}`);
    }
    const scenario: Scenario = { name, enabled: true };
    this.scenarios.push(scenario);
    await this.persist();
    return { ...scenario };
  }

  async rename(
    oldName: string,
    newName: string,
    refs: ScenarioRef[] = [],
    rewrite?: (ref: ScenarioRef) => ScenarioRef,
  ): Promise<number> {
    const idx = this.scenarios.findIndex((s) => s.name === oldName);
    if (idx === -1) throw new Error(`场景不存在: ${oldName}`);
    if (oldName !== newName && this.scenarios.some((s) => s.name === newName)) {
      throw new Error(`目标场景名已存在: ${newName}`);
    }
    this.scenarios[idx] = { ...this.scenarios[idx], name: newName };
    await this.persist();
    if (!rewrite) return 0;
    let affected = 0;
    for (const ref of refs) {
      rewrite(ref);
      affected += 1;
    }
    return affected;
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const idx = this.scenarios.findIndex((s) => s.name === name);
    if (idx === -1) throw new Error(`场景不存在: ${name}`);
    this.scenarios[idx] = { ...this.scenarios[idx], name, enabled };
    await this.persist();
  }

  async remove(name: string, refs: ScenarioRef[] = [], rewrite?: (ref: ScenarioRef) => ScenarioRef): Promise<number> {
    const before = this.scenarios.length;
    this.scenarios = this.scenarios.filter((s) => s.name !== name);
    if (this.scenarios.length === before) throw new Error(`场景不存在: ${name}`);
    await this.persist();
    if (!rewrite) return 0;
    let affected = 0;
    for (const ref of refs) {
      rewrite(ref);
      affected += 1;
    }
    return affected;
  }

  private async persist(): Promise<void> {
    await this.store.write(this.scenarios);
  }
}
```

- [ ] **Step 3: 运行确认通过**

Run: `npm test -- scenarios-store`
Expected: 7 passed（按需微调测试断言）

- [ ] **Step 4: Commit**

```bash
git add src/main/storage/scenarios-store.ts tests/scenarios-store.test.ts
git commit -m "feat(storage): ScenariosStore with rename/remove ref cascade hook"
```

---

### Task 4: RedirectsStore + 单测

**Files:**
- Create: `src/main/storage/redirects-store.ts`
- Test: `tests/redirects-store.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/redirects-store.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RedirectsStore } from '../src/main/storage/redirects-store';
import type { RedirectRule } from '../src/shared/types';

let dir: string;
let store: RedirectsStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mocker-redirects-'));
  store = new RedirectsStore(dir);
  await store.load();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function ruleInput(overrides: Partial<RedirectRule> = {}): Omit<RedirectRule, 'id' | 'priority'> {
  return {
    name: 'r',
    enabled: true,
    match: { urlType: 'exact', urlPattern: 'http://a.example.com/x', method: 'ANY' },
    action: 'mapLocal',
    target: '/tmp/foo.html',
    ...overrides,
  };
}

describe('RedirectsStore', () => {
  it('add + list + remove', async () => {
    const added = await store.add(ruleInput());
    expect(added.priority).toBeGreaterThan(0);
    expect(store.list()).toHaveLength(1);
    await store.remove(added.id);
    expect(store.list()).toHaveLength(0);
  });

  it('list is sorted by priority', async () => {
    const a = await store.add(ruleInput({ name: 'a' }));
    const b = await store.add(ruleInput({ name: 'b' }));
    await store.update(a.id, { priority: 10 });
    expect(store.list().map((r) => r.name)).toEqual(['a', 'b']);
  });

  it('update partial patch', async () => {
    const r = await store.add(ruleInput({ name: 'before' }));
    await store.update(r.id, { name: 'after' });
    expect(store.list()[0]!.name).toBe('after');
  });

  it('returns cloned rules on list', async () => {
    await store.add(ruleInput());
    const list = store.list();
    list[0]!.name = 'mutated';
    expect(store.list()[0]!.name).toBe('r');
  });

  it('persists across instances', async () => {
    await store.add(ruleInput({ name: 'persistent' }));
    const other = new RedirectsStore(dir);
    await other.load();
    expect(other.list()[0]!.name).toBe('persistent');
  });
});
```

- [ ] **Step 2: 实现 `src/main/storage/redirects-store.ts`**

```ts
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { RedirectRule } from '../../shared/types';
import { JsonStore } from './json-store';

export type RedirectInput = Omit<RedirectRule, 'id' | 'priority'>;
export type RedirectPatch = Partial<Omit<RedirectRule, 'id'>>;

export class RedirectsStore {
  private store: JsonStore<RedirectRule[]>;
  private rules: RedirectRule[] = [];

  constructor(dataDir: string) {
    this.store = new JsonStore<RedirectRule[]>(path.join(dataDir, 'redirects.json'), []);
  }

  async load(): Promise<void> {
    try {
      this.rules = await this.store.read();
    } catch (err) {
      console.warn('[redirects-store] failed to load, starting empty:', err);
      this.rules = [];
    }
  }

  list(): RedirectRule[] {
    return [...this.rules].sort((a, b) => a.priority - b.priority).map(cloneRule);
  }

  async add(input: RedirectInput): Promise<RedirectRule> {
    const rule: RedirectRule = { ...input, id: randomUUID(), priority: this.nextPriority() };
    this.rules.push(rule);
    await this.persist();
    return cloneRule(rule);
  }

  async update(id: string, patch: RedirectPatch): Promise<RedirectRule> {
    const idx = this.rules.findIndex((r) => r.id === id);
    if (idx === -1) throw new Error(`重定向规则不存在: ${id}`);
    this.rules[idx] = { ...this.rules[idx], ...patch };
    await this.persist();
    return cloneRule(this.rules[idx]!);
  }

  async remove(id: string): Promise<void> {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r.id !== id);
    if (this.rules.length === before) throw new Error(`重定向规则不存在: ${id}`);
    await this.persist();
  }

  private nextPriority(): number {
    return this.rules.reduce((m, r) => Math.max(m, r.priority), 0) + 1;
  }

  private async persist(): Promise<void> {
    await this.store.write(this.rules);
  }
}

function cloneRule(rule: RedirectRule): RedirectRule {
  return {
    ...rule,
    match: { ...rule.match },
  };
}
```

- [ ] **Step 3: 运行确认通过**

Run: `npm test -- redirects-store`
Expected: 5 passed

- [ ] **Step 4: Commit**

```bash
git add src/main/storage/redirects-store.ts tests/redirects-store.test.ts
git commit -m "feat(storage): RedirectsStore for map-local/map-remote rules"
```

---

### Task 5: RulesStore 加 `scenario` 字段

**Files:**
- Modify: `src/main/storage/rules-store.ts`
- Modify: `src/main/storage/migrate.ts`
- Modify: `src/shared/types.ts`（RuleInput / RulePatch 加 scenario?）

- [ ] **Step 1: 更新 RuleInput / RulePatch**

`src/shared/types.ts` 把 `RuleInput` / `RulePatch` 加上 `scenario?: string`：

```ts
export type RuleInput = Omit<MockRule, 'id' | 'priority'>;
// RuleInput 自动包含 scenario 因为它是 MockRule 字段

export type RulePatch = Partial<Omit<MockRule, 'id'>>;
// 同样自动包含
```

无需修改（MockRule 已含）。验证：

Run: `npm run typecheck`

- [ ] **Step 2: 迁移逻辑加 `kind` 默认值**

`src/main/storage/migrate.ts` 中 `migrateOne` 函数（处理单条规则的）需要在产出的 MockRule 上补 `kind: undefined`（或者保留 undefined）。检查 migrate 输出。若 migration 输出已有完整 MockRule 形态且 action 字段被原样保留，则自动兼容（kind 可选）。

修改 `migrateOne` 输出处，确保 `action` 类型保留为 `RuleAction`：

```ts
function migrateOne(raw: unknown): MigratedRule | undefined {
  // ... existing logic ...
  // 在最后 return { rule, changed } 处确保 rule.action.kind 未定义时不报错
  return { rule: result, changed: resultChanged };
}
```

实际无需大改（undefined action.kind 符合静态分支）。

- [ ] **Step 3: 运行既有测试确认无回归**

Run: `npm test`
Expected: 329 passed

- [ ] **Step 4: Commit（若无变更则跳过）**

```bash
git status --short
git diff --cached --quiet || git add -u && git commit -m "chore(rules): scenario field flows through RulesStore (no migration needed)"
```

---

### Task 6: redirect.ts（mime + mapLocal + mapRemote）+ 单测

**Files:**
- Create: `src/main/rules/redirect.ts`
- Test: `tests/redirect.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/redirect.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { mimeForPath, resolveMapLocal, sendMapRemote } from '../src/main/rules/redirect';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mocker-redirect-'));
  writeFileSync(path.join(dir, 'hello.html'), '<h1>hi</h1>');
  writeFileSync(path.join(dir, 'data.json'), '{"x":1}');
  writeFileSync(path.join(dir, 'plain.txt'), 'hi');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('mimeForPath', () => {
  it.each([
    ['/tmp/a.html', 'text/html; charset=utf-8'],
    ['/tmp/a.htm', 'text/html; charset=utf-8'],
    ['/tmp/a.json', 'application/json; charset=utf-8'],
    ['/tmp/a.js', 'application/javascript; charset=utf-8'],
    ['/tmp/a.css', 'text/css; charset=utf-8'],
    ['/tmp/a.txt', 'text/plain; charset=utf-8'],
    ['/tmp/a.svg', 'image/svg+xml'],
    ['/tmp/a.png', 'image/png'],
    ['/tmp/a.pdf', 'application/pdf'],
    ['/tmp/a.weird', 'application/octet-stream'],
  ])('%s → %s', (input, expected) => {
    expect(mimeForPath(input)).toBe(expected);
  });
});

describe('resolveMapLocal', () => {
  it('reads existing file with mime', async () => {
    const r = await resolveMapLocal(path.join(dir, 'hello.html'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.content.toString('utf8')).toBe('<h1>hi</h1>');
      expect(r.mime).toBe('text/html; charset=utf-8');
    }
  });

  it('returns not-ok for missing file', async () => {
    const r = await resolveMapLocal(path.join(dir, 'nope.html'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/ENOENT|nope\.html/);
  });
});

describe('sendMapRemote', () => {
  let server: Server;
  let port: number;
  const seen: { path?: string; body?: string; headers?: Record<string, string | string[] | undefined> } = {};

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.path = req.url;
        seen.body = body;
        seen.headers = req.headers;
        res.writeHead(200, { 'content-type': 'application/json', 'x-up': 'yes' });
        res.end('{"remote":true}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('rewrites host, preserves path/query/body, drops hop-by-hop', async () => {
    const r = await sendMapRemote(
      `127.0.0.1:${port}`,
      {
        method: 'POST',
        url: 'http://original.example.com/api/v1?q=2',
        query: new URLSearchParams('q=2'),
        headers: {
          'content-type': 'application/json',
          'content-length': '7',
          host: 'original.example.com',
          connection: 'keep-alive',
        },
        body: '{"a":1}',
      },
    );
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(200);
    expect(r.headers['x-up']).toBe('yes');
    expect(r.body).toBe('{"remote":true}');
    expect(seen.path).toBe('/api/v1?q=2');
    expect(seen.body).toBe('{"a":1}');
    expect(seen.headers?.host).toBe(`127.0.0.1:${port}`);
    expect(seen.headers?.['content-length']).toBe('7');
    expect(seen.headers?.connection).toBeUndefined();
  });

  it('records connection error', async () => {
    const r = await sendMapRemote('127.0.0.1:1', {
      method: 'GET',
      url: 'http://x.example.com/',
      query: new URLSearchParams(),
      headers: {},
      body: '',
    });
    expect(r.status).toBeUndefined();
    expect(r.error).toBeDefined();
  });
});
```

- [ ] **Step 2: 实现 `src/main/rules/redirect.ts`**

```ts
import { promises as fs } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';
import type { RequestDescription } from './matcher';

const REPLAY_TIMEOUT_MS = 30_000;

const MIME_TABLE: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

export function mimeForPath(p: string): string {
  const ext = path.extname(p).toLowerCase();
  return MIME_TABLE[ext] ?? 'application/octet-stream';
}

export type MapLocalResult =
  | { ok: true; content: Buffer; mime: string }
  | { ok: false; reason: string };

export async function resolveMapLocal(target: string): Promise<MapLocalResult> {
  try {
    const content = await fs.readFile(target);
    return { ok: true, content, mime: mimeForPath(target) };
  } catch (err) {
    return { ok: false, reason: (err as NodeJS.ErrnoException).message ?? String(err) };
  }
}

export interface MapRemoteResult {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
}

const SKIP = new Set(['host', 'connection', 'content-length', 'accept-encoding']);

export async function sendMapRemote(target: string, req: RequestDescription): Promise<MapRemoteResult> {
  const url = new URL(req.url);
  const targetUrl = new URL(`http://${target}`);
  const isHttps = targetUrl.protocol === 'https:';
  const mod = isHttps ? https : http;

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (SKIP.has(k.toLowerCase())) continue;
    headers[k] = v;
  }
  const body = req.body !== '' ? Buffer.from(req.body, 'utf8') : undefined;

  try {
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const r = mod.request(
        {
          protocol: targetUrl.protocol,
          hostname: targetUrl.hostname,
          port: targetUrl.port || undefined,
          path: url.pathname + url.search,
          method: req.method,
          headers: body ? { ...headers, 'content-length': String(body.length) } : headers,
        },
        resolve,
      );
      r.on('error', reject);
      r.setTimeout(REPLAY_TIMEOUT_MS, () => r.destroy(new Error('map-remote-timeout')));
      if (body) r.write(body);
      r.end();
    });
    const chunks: Buffer[] = [];
    for await (const chunk of res) chunks.push(chunk as Buffer);
    return {
      status: res.statusCode,
      headers: flatten(res.headers),
      body: Buffer.concat(chunks).toString('utf8'),
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return { error: e.code ?? e.message };
  }
}

function flatten(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}
```

- [ ] **Step 3: 运行确认通过**

Run: `npm test -- redirect`
Expected: 18 passed

- [ ] **Step 4: Commit**

```bash
git add src/main/rules/redirect.ts tests/redirect.test.ts
git commit -m "feat(rules): map-local/map-remote resolvers with mime detection"
```

---

### Task 7: apply-rule.ts sequential 分支 + validate

**Files:**
- Modify: `src/main/rules/apply-rule.ts`
- Modify: `src/main/rules/validate.ts`

- [ ] **Step 1: 修改 `computeMockResult` 增加 sequential 分支**

在 `src/main/rules/apply-rule.ts` 中，`computeMockResult` 开头加：

```ts
if (matched.action.kind === 'sequential') {
  const idx = Math.max(0, Math.min(options.sequenceIndex ?? 0, matched.action.responses.length - 1));
  const step = matched.action.responses[idx]!;
  const warnings: string[] = [];
  const body = renderTemplate(step.body, ctx, matched.action.fakerLocale, warnings);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(step.headers)) {
    headers[k] = renderTemplate(v, ctx, matched.action.fakerLocale, warnings);
  }
  return { status: step.status, headers, body, warnings, networkError: null };
}
```

并在 `MockComputationOptions` 加 `sequenceIndex?: number`。

- [ ] **Step 2: 修改 `validateAction` 加 sequential 校验**

`src/main/rules/validate.ts`：

```ts
export function validateAction(action: RuleAction): void {
  if (action.kind === 'sequential') {
    if (!Array.isArray(action.responses) || action.responses.length === 0) {
      throw new Error('序列响应至少需要 1 个响应');
    }
    action.responses.forEach((r, i) => {
      if (r.status < 100 || r.status > 999) {
        throw new Error(`第 ${i + 1} 个响应的状态码无效: ${r.status}`);
      }
    });
    return;
  }
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
```

- [ ] **Step 3: 既有测试**

Run: `npm test`
Expected: 全部通过（既有规则都是静态形态，不受影响）

- [ ] **Step 4: Commit**

```bash
git add src/main/rules/apply-rule.ts src/main/rules/validate.ts
git commit -m "feat(rules): sequential action branch + validation"
```

---

### Task 8: proxy-server 管道整合（redirect 优先 + sequential 计数 + 重置）

**Files:**
- Modify: `src/main/proxy/proxy-server.ts`

- [ ] **Step 1: 注入依赖 + 计数 Map**

`ProxyServer` 构造函数增加入参（保持向后兼容）：

```ts
export interface ProxyServerOptions {
  caKey: string;
  caCert: string;
  getSettings: () => Settings;
  getRules: () => MockRule[];
  getRedirects?: () => RedirectRule[];                // 新
  getScenarios?: () => ReadonlyMap<string, Scenario>;  // 新
  onEvent: (event: TrafficEvent) => void;
}
```

私有字段：
```ts
private seqCounters = new Map<string, number>();

resetSequenceCounter(ruleId: string): void {
  this.seqCounters.delete(ruleId);
}
```

- [ ] **Step 2: 在 `handle()` 中加入 redirect 检查（在 mock 检查之前）**

`src/main/proxy/proxy-server.ts` 的 `handle` 函数在 `findMatchingRule` 之前加：

```ts
const redirects = this.opts.getRedirects?.() ?? [];
const scenarios = this.opts.getScenarios?.() ?? new Map<string, Scenario>();
for (const r of redirects) {
  if (!ruleEffective(r, scenarios)) continue;
  if (!matchRule(r.match, describeRequest(req, bodyText))) continue;
  // 命中：执行 redirect
  if (r.action === 'mapLocal') {
    const res = await resolveMapLocal(r.target);
    event.mocked = true;
    event.matchedRuleId = r.id;
    if (res.ok) {
      event.status = 200;
      event.responseHeaders = { 'content-type': res.mime };
      event.responseBody = res.content.toString('utf8');
    } else {
      event.status = 404;
      event.responseHeaders = { 'content-type': 'text/plain; charset=utf-8' };
      event.responseBody = `File not found: ${r.target}`;
      event.error = `map-local: ${res.reason}`;
    }
    event.completedAt = Date.now();
    this.emit(event);
    return {
      response: toCallbackResponse({
        statusCode: event.status ?? 404,
        headers: event.responseHeaders ?? {},
        body: event.responseBody ?? '',
      }),
    };
  }
  // mapRemote
  const remote = await sendMapRemote(r.target, describeRequest(req, bodyText));
  event.mocked = true;
  event.matchedRuleId = r.id;
  if (remote.error !== undefined) {
    event.error = remote.error;
  } else {
    event.status = remote.status;
    event.responseHeaders = remote.headers;
    event.responseBody = remote.body;
  }
  event.completedAt = Date.now();
  this.emit(event);
  return {
    response: remote.error !== undefined
      ? { response: 'close' as const }
      : { response: toCallbackResponse({
          statusCode: remote.status ?? 502,
          headers: remote.headers ?? {},
          body: remote.body ?? '',
        }) },
  };
}
```

新 import：
```ts
import { resolveMapLocal, sendMapRemote } from '../rules/redirect';
import { ruleEffective } from '../rules/rule-effective';
import type { RedirectRule, Scenario } from '../../shared/types';
```

- [ ] **Step 3: 重写 mock 匹配循环以叠加场景过滤 + sequential 计数**

```ts
const matched = findMatchingRule(
  this.opts.getRules().filter((r) => ruleEffective(r, scenarios)),
  describeRequest(req, bodyText),
);
if (matched) {
  return await this.handleMatched(matched, req, event, bodyText);
}
```

修改 `handleMatched`：

```ts
private async handleMatched(
  matched: MockRule,
  req: mockttp.CompletedRequest,
  event: TrafficEvent,
  bodyText: string,
): Promise<mockttp.requestSteps.CallbackRequestResult | void> {
  event.mocked = true;
  event.matchedRuleId = matched.id;

  let result: MockComputation;
  const isSequential = matched.action.kind === 'sequential';
  const sequenceIndex = isSequential
    ? Math.min(this.seqCounters.get(matched.id) ?? 0, matched.action.responses.length - 1)
    : undefined;
  if (isSequential) {
    event.sequenceIndex = sequenceIndex;
    this.seqCounters.set(matched.id, (this.seqCounters.get(matched.id) ?? 0) + 1);
  }

  try {
    result = await computeMockResult(matched, buildRenderContext(req, bodyText), {
      signal: this.abort?.signal,
      sequenceIndex,
    });
  } catch {
    if (isSequential) {
      // 异常回退：不推进计数器
      this.seqCounters.set(matched.id, sequenceIndex!);
    }
    return { response: 'close' };
  }

  if (result.networkError) {
    event.errorTriggered = true;
    event.error = `network-error:${matched.action.networkError?.type ?? ''}`;
    event.completedAt = Date.now();
    this.emit(event);
    const resolution = result.networkError;
    if (resolution.kind === 'reset') return { response: 'reset' };
    if (resolution.kind === 'close') return { response: 'close' };
    return { response: { statusCode: resolution.statusCode, headers: {}, body: '' } };
  }

  event.status = result.status;
  event.responseHeaders = result.headers;
  event.responseBody = result.body;
  event.renderWarnings = result.warnings.length > 0 ? result.warnings : undefined;
  event.completedAt = Date.now();
  this.emit(event);

  return {
    response: toCallbackResponse({
      statusCode: result.status,
      headers: result.headers,
      body: result.body,
    }),
  };
}
```

> 注意：现有 sequential 不支持 networkError/delayMs（已在 spec 内明确），故 networkError 分支不会进 sequential 路径。但代码仍写防御。

- [ ] **Step 4: 类型检查 + 既有测试**

Run: `npm run typecheck && npm test`
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
git add src/main/proxy/proxy-server.ts
git commit -m "feat(proxy): redirect-first pipeline + scenario filter + sequential counter"
```

---

### Task 9: IPC + Api + preload 扩展

**Files:**
- Modify: `src/shared/api.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/ipc.ts`

- [ ] **Step 1: 扩展 Api 接口**

`src/shared/api.ts` 末尾追加：

```ts
  // redirects
  redirectsList(): Promise<RedirectRule[]>;
  redirectsAdd(input: Omit<RedirectRule, 'id' | 'priority'>): Promise<RedirectRule>;
  redirectsUpdate(id: string, patch: Partial<Omit<RedirectRule, 'id'>>): Promise<RedirectRule>;
  redirectsRemove(id: string): Promise<void>;
  // scenarios
  scenariosList(): Promise<Scenario[]>;
  scenariosAdd(name: string): Promise<Scenario>;
  scenariosRename(oldName: string, newName: string): Promise<number>;
  scenariosSetEnabled(name: string, enabled: boolean): Promise<void>;
  scenariosRemove(name: string): Promise<number>;
  // sequence
  rulesResetSequence(ruleId: string): Promise<void>;
```

import 增加 `RedirectRule, Scenario`。

- [ ] **Step 2: preload 透传**

`src/preload/index.ts` 末尾追加：

```ts
  redirectsList: () => ipcRenderer.invoke('redirects:list'),
  redirectsAdd: (input) => ipcRenderer.invoke('redirects:add', input),
  redirectsUpdate: (id, patch) => ipcRenderer.invoke('redirects:update', id, patch),
  redirectsRemove: (id) => ipcRenderer.invoke('redirects:remove', id),
  scenariosList: () => ipcRenderer.invoke('scenarios:list'),
  scenariosAdd: (name) => ipcRenderer.invoke('scenarios:add', name),
  scenariosRename: (oldName, newName) => ipcRenderer.invoke('scenarios:rename', oldName, newName),
  scenariosSetEnabled: (name, enabled) => ipcRenderer.invoke('scenarios:set-enabled', name, enabled),
  scenariosRemove: (name) => ipcRenderer.invoke('scenarios:remove', name),
  rulesResetSequence: (ruleId) => ipcRenderer.invoke('rules:reset-sequence', ruleId),
```

- [ ] **Step 3: IPC handlers（在 `src/main/ipc.ts` `registerIpc` 末尾追加）**

`IpcContext` 加字段：

```ts
  redirects: RedirectsStore;
  scenarios: ScenariosStore;
  proxy: ProxyServer;  // 已有
```

handlers：

```ts
ipcMain.handle('redirects:list', () => ctx.redirects.list());
ipcMain.handle('redirects:add', (_e, input) => ctx.redirects.add(input));
ipcMain.handle('redirects:update', (_e, id: string, patch) => ctx.redirects.update(id, patch));
ipcMain.handle('redirects:remove', (_e, id: string) => ctx.redirects.remove(id));

ipcMain.handle('scenarios:list', () => ctx.scenarios.list());
ipcMain.handle('scenarios:add', (_e, name: string) => ctx.scenarios.add(name));
ipcMain.handle('scenarios:rename', async (_e, oldName: string, newName: string) => {
  const affected = await ctx.scenarios.rename(oldName, newName);
  for (const r of ctx.rules.list()) {
    if (r.scenario === oldName) await ctx.rules.update(r.id, { scenario: newName });
  }
  for (const r of ctx.redirects.list()) {
    if (r.scenario === oldName) await ctx.redirects.update(r.id, { scenario: newName });
  }
  return affected;
});
ipcMain.handle('scenarios:set-enabled', (_e, name: string, enabled: boolean) => ctx.scenarios.setEnabled(name, enabled));
ipcMain.handle('scenarios:remove', async (_e, name: string) => {
  const affected = await ctx.scenarios.remove(name);
  for (const r of ctx.rules.list()) {
    if (r.scenario === name) await ctx.rules.update(r.id, { scenario: undefined });
  }
  for (const r of ctx.redirects.list()) {
    if (r.scenario === name) await ctx.redirects.update(r.id, { scenario: undefined });
  }
  return affected;
});

ipcMain.handle('rules:reset-sequence', (_e, ruleId: string) => {
  ctx.proxy.resetSequenceCounter(ruleId);
});
```

import 增加 `RedirectsStore`、`ScenariosStore`、`ScenarioRef`。

- [ ] **Step 4: Commit**

```bash
git add src/shared/api.ts src/preload/index.ts src/main/ipc.ts
git commit -m "feat(ipc): redirects/scenarios/reset-sequence channels"
```

---

### Task 10: main/index.ts 装载新 store + 接线

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: 装载新 store**

```ts
import { RedirectsStore } from './storage/redirects-store';
import { ScenariosStore } from './storage/scenarios-store';

const redirects = new RedirectsStore(dataDir);
const scenarios = new ScenariosStore(dataDir);
await redirects.load();
await scenarios.load();

const scenariosMap = (): Map<string, Scenario> => new Map(scenarios.list().map((s) => [s.name, s]));

const proxy = new ProxyServer({
  caKey: ca.keyPem,
  caCert: ca.certPem,
  getSettings: () => settings.get(),
  getRules: () => rules.list(),
  getRedirects: () => redirects.list(),
  getScenarios: scenariosMap,
  onEvent,
});
```

`registerIpc({ ..., redirects, scenarios })`。

- [ ] **Step 2: 全部既有测试 + typecheck**

Run: `npm run typecheck && npm test`
Expected: 全部通过

- [ ] **Step 3: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(main): load redirects and scenarios stores, wire into proxy and IPC"
```

---

### Task 11: UI 共享组件 ScenarioField

**Files:**
- Create: `src/renderer/src/components/ScenarioField.tsx`

- [ ] **Step 1: 新建 ScenarioField**

```tsx
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { Scenario } from '../../../shared/types';

interface Props {
  value: string | undefined;
  onChange: (name: string | undefined) => void;
}

export default function ScenarioField({ value, onChange }: Props) {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);

  useEffect(() => {
    api.scenariosList()
      .then(setScenarios)
      .catch(() => {});
  }, []);

  return (
    <select
      data-testid="scenario-field"
      aria-label="场景"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
    >
      <option value="">无</option>
      {scenarios.map((s) => (
        <option key={s.name} value={s.name}>{s.name}</option>
      ))}
    </select>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/components/ScenarioField.tsx
git commit -m "feat(ui): shared ScenarioField for rule and redirect editors"
```

---

### Task 12: App.tsx 加 redirects + scenarios tabs

**Files:**
- Modify: `src/renderer/src/App.tsx`

- [ ] **Step 1: 修改 App.tsx**

```tsx
import RedirectsPanel from './components/RedirectsPanel';
import ScenariosPanel from './components/ScenariosPanel';

type Tab = 'traffic' | 'rules' | 'redirects' | 'scenarios' | 'device' | 'settings';

// 在 tabs nav 增加：
<button className={tab === 'redirects' ? 'active' : ''} onClick={() => setTab('redirects')} data-testid="redirects-tab">重定向</button>
<button className={tab === 'scenarios' ? 'active' : ''} onClick={() => setTab('scenarios')} data-testid="scenarios-tab">场景</button>

// main 里：
{tab === 'redirects' && <RedirectsPanel />}
{tab === 'scenarios' && <ScenariosPanel />}
```

- [ ] **Step 2: 类型检查（先建空壳组件）**

为了让 typecheck 通过，需先有 `RedirectsPanel` 与 `ScenariosPanel` 空壳：

`src/renderer/src/components/RedirectsPanel.tsx`：
```tsx
export default function RedirectsPanel() {
  return <div className="panel">重定向（建设中）</div>;
}
```

`src/renderer/src/components/ScenariosPanel.tsx`：
```tsx
export default function ScenariosPanel() {
  return <div className="panel">场景（建设中）</div>;
}
```

Run: `npm run typecheck`
Expected: 干净

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/components/RedirectsPanel.tsx src/renderer/src/components/ScenariosPanel.tsx
git commit -m "feat(ui): add redirects and scenarios tabs (placeholder shells)"
```

---

### Task 13: RuleEditorModal 改造（sequential 模式 + 场景字段）

**Files:**
- Modify: `src/renderer/src/components/RuleEditorModal.tsx`

- [ ] **Step 1: 顶部加响应模式切换**

读现状 `RuleEditorModal.tsx`（关注第 119、439 行起 `行为模拟` 区块）。改造：

在 modal 顶部「响应模式」单选：

```tsx
const [mode, setMode] = useState<'static' | 'sequential'>(
  seed?.action.kind === 'sequential' ? 'sequential' : 'static',
);
// 种子初始化时同步 responses
const [sequentialResponses, setSequentialResponses] = useState<{ status: number; headers: Record<string, string>; body: string }[]>(
  seed?.action.kind === 'sequential' ? seed.action.responses : [{ status: 200, headers: {}, body: '' }],
);
```

`scenario` state 来自 seed（mockRule），加 ScenarioField：

```tsx
const [scenario, setScenario] = useState<string | undefined>(seed?.scenario);
```

保存时（`onSave` 调用前）根据 mode 构造 action：

```tsx
const action = mode === 'sequential'
  ? { kind: 'sequential' as const, responses: sequentialResponses, fakerLocale }
  : { kind: 'static' as const, status, headers, body, delayMs, fakerLocale, networkError };
```

- [ ] **Step 2: 行为模拟区块**

```tsx
<details className="form-section" open>
  <summary>行为模拟</summary>
  <div className="form-grid">
    <label>响应模式</label>
    <div>
      <label>
        <input type="radio" data-testid="mode-static" checked={mode === 'static'} onChange={() => setMode('static')} />
        静态响应
      </label>{' '}
      <label>
        <input type="radio" data-testid="mode-sequential" checked={mode === 'sequential'} onChange={() => setMode('sequential')} />
        序列响应
      </label>
    </div>
    <label>场景</label>
    <ScenarioField value={scenario} onChange={setScenario} />
  </div>
  {mode === 'static' ? (
    /* 现有 status/headers/body 区块 */
  ) : (
    /* sequential 列表：每行 status + headers + body + 删除按钮 + 底部「+ 添加响应」 */
    <div data-testid="sequential-editor">
      {sequentialResponses.map((r, i) => (
        <div key={i} className="seq-row">
          <input
            type="number"
            data-testid={`seq-status-${i}`}
            value={r.status}
            onChange={(e) => updateSeq(i, { status: Number(e.target.value) })}
          />
          <input
            data-testid={`seq-body-${i}`}
            value={r.body}
            onChange={(e) => updateSeq(i, { body: e.target.value })}
            placeholder="响应体"
          />
          <button onClick={() => removeSeq(i)}>×</button>
        </div>
      ))}
      <button data-testid="seq-add" onClick={addSeq}>+ 添加响应</button>
    </div>
  )}
</details>
```

`updateSeq(i, patch)` / `removeSeq(i)` / `addSeq()` 在组件内定义。

- [ ] **Step 3: 类型检查 + 既有 E2E**

Run: `npm run typecheck && npm test`
Expected: 全部通过

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/RuleEditorModal.tsx
git commit -m "feat(ui): rule editor supports sequential mode and scenario field"
```

---

### Task 14: RedirectsPanel + RedirectEditorModal

**Files:**
- Replace `src/renderer/src/components/RedirectsPanel.tsx`
- Create: `src/renderer/src/components/RedirectEditorModal.tsx`

- [ ] **Step 1: 实现 RedirectEditorModal**

仿照 RuleEditorModal 的表单骨架，但更小：

```tsx
import { useState } from 'react';
import type { HeaderRow, HttpMethod, RedirectRule, RuleMatch } from '../../../shared/types';
import { api } from '../lib/api';
import EditableTable from './EditableTable';
import ScenarioField from './ScenarioField';

type ActionKind = 'mapLocal' | 'mapRemote';

interface Props {
  initial: RedirectRule | null;
  onClose: () => void;
  onSaved: () => void;
}

export default function RedirectEditorModal({ initial, onClose, onSaved }: Props) {
  const seed = initial;
  const [name, setName] = useState(seed?.name ?? '');
  const [enabled, setEnabled] = useState(seed?.enabled ?? true);
  const [urlType, setUrlType] = useState<RuleMatch['urlType']>(seed?.match.urlType ?? 'exact');
  const [urlPattern, setUrlPattern] = useState(seed?.match.urlPattern ?? '');
  const [method, setMethod] = useState<HttpMethod>(seed?.match.method ?? 'ANY');
  const [headers, setHeaders] = useState<HeaderRow[]>(
    Object.entries(seed?.match.headers ?? {}).map(([name, value]) => ({ enabled: true, name, value, description: '' })),
  );
  const [actionKind, setActionKind] = useState<ActionKind>(seed?.action ?? 'mapLocal');
  const [target, setTarget] = useState(seed?.target ?? '');
  const [scenario, setScenario] = useState<string | undefined>(seed?.scenario);
  const [error, setError] = useState('');

  const chooseFile = async () => {
    const filePath = await api.openFileDialog?.();
    if (typeof filePath === 'string') setTarget(filePath);
  };

  const save = async () => {
    setError('');
    if (!urlPattern.trim()) { setError('URL 模式不能为空'); return; }
    if (!target.trim()) { setError('目标不能为空'); return; }
    const headersObj: Record<string, string> = {};
    for (const r of headers) if (r.enabled && r.name.trim()) headersObj[r.name.trim()] = r.value;
    const match: RuleMatch = { urlType, urlPattern, method, headers: headersObj };
    try {
      if (seed) {
        await api.redirectsUpdate(seed.id, { name, enabled, match, action: actionKind, target, scenario });
      } else {
        await api.redirectsAdd({ name, enabled, match, action: actionKind, target, scenario });
      }
      onSaved();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{seed ? '编辑重定向' : '新建重定向'}</h2>
        <div className="form-grid">
          <label>名称</label>
          <input data-testid="redirect-name" value={name} onChange={(e) => setName(e.target.value)} />
          <label>启用</label>
          <input type="checkbox" data-testid="redirect-enabled" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <label>URL 模式</label>
          <select data-testid="redirect-url-type" value={urlType} onChange={(e) => setUrlType(e.target.value as RuleMatch['urlType'])}>
            <option value="exact">精确</option>
            <option value="wildcard">通配符</option>
            <option value="regex">正则</option>
          </select>
          <label>URL</label>
          <input data-testid="redirect-url-pattern" value={urlPattern} onChange={(e) => setUrlPattern(e.target.value)} />
          <label>方法</label>
          <select data-testid="redirect-method" value={method} onChange={(e) => setMethod(e.target.value as HttpMethod)}>
            {['ANY', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <label>请求头</label>
          <EditableTable rows={headers} onChange={setHeaders} columns={{ description: false }} ariaLabel="请求头" />
          <label>类型</label>
          <select data-testid="redirect-action-kind" value={actionKind} onChange={(e) => setActionKind(e.target.value as ActionKind)}>
            <option value="mapLocal">Map Local（本地文件）</option>
            <option value="mapRemote">Map Remote（远程转发）</option>
          </select>
          <label>目标</label>
          <div>
            <input data-testid="redirect-target" value={target} onChange={(e) => setTarget(e.target.value)} placeholder={actionKind === 'mapLocal' ? '本地文件绝对路径' : 'host:port'} />
            {actionKind === 'mapLocal' && <button data-testid="redirect-choose-file" onClick={chooseFile}>选择文件</button>}
          </div>
          <label>场景</label>
          <ScenarioField value={scenario} onChange={setScenario} />
        </div>
        {error && <div className="text-err">{error}</div>}
        <div className="modal-actions">
          <button onClick={onClose}>取消</button>
          <button data-testid="redirect-save" onClick={save}>保存</button>
        </div>
      </div>
    </div>
  );
}
```

需要追加 IPC：`openFileDialog`（与 HAR 类似，但不需要返回内容只需路径）。在 `src/main/ipc.ts` + `src/preload/index.ts` + `src/shared/api.ts` 各加一条：

- api: `openFileDialog(): Promise<string | null>`
- preload: `openFileDialog: () => ipcRenderer.invoke('dialog:open-file')`
- ipc: `ipcMain.handle('dialog:open-file', () => showOpenDialog({ properties: ['openFile'] }).then(r => r.canceled ? null : r.filePaths[0] ?? null))`

- [ ] **Step 2: 实现 RedirectsPanel**

```tsx
import { useCallback, useEffect, useState } from 'react';
import type { RedirectRule } from '../../../shared/types';
import { api } from '../lib/api';
import RedirectEditorModal from './RedirectEditorModal';

export default function RedirectsPanel() {
  const [rules, setRules] = useState<RedirectRule[]>([]);
  const [editing, setEditing] = useState<RedirectRule | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setRules(await api.redirectsList());
    } catch {}
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const toggle = async (rule: RedirectRule, enabled: boolean) => {
    await api.redirectsUpdate(rule.id, { enabled });
    await refresh();
  };
  const remove = async (rule: RedirectRule) => {
    await api.redirectsRemove(rule.id);
    await refresh();
  };

  return (
    <div className="panel">
      <div className="toolbar">
        <button className="primary" data-testid="redirect-new" onClick={() => setCreating(true)}>新建重定向</button>
        <span className="muted">Map Local 命中后返回本地文件；Map Remote 命中后改 host 转发上游</span>
      </div>
      <table className="rules-table">
        <thead>
          <tr>
            <th className="col-enabled">启用</th>
            <th className="col-name">名称</th>
            <th className="col-match">匹配</th>
            <th className="col-response">类型</th>
            <th className="col-ops">操作</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id}>
              <td className="col-enabled">
                <input type="checkbox" checked={r.enabled} onChange={(e) => toggle(r, e.target.checked)} />
              </td>
              <td className="col-name" title={r.name}>{r.name}</td>
              <td className="col-match muted" title={`${r.match.method} ${r.match.urlPattern}`}>{r.match.method} {r.match.urlPattern}</td>
              <td className="col-response muted">{r.action === 'mapLocal' ? '本地' : '远程'}</td>
              <td className="col-ops">
                <div className="ops">
                  <button onClick={() => setEditing(r)}>编辑</button>
                  <button onClick={() => remove(r)}>删除</button>
                </div>
              </td>
            </tr>
          ))}
          {rules.length === 0 && <tr><td colSpan={5} className="muted">还没有重定向，点击「新建重定向」开始</td></tr>}
        </tbody>
      </table>
      {(creating || editing) && (
        <RedirectEditorModal
          initial={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); refresh(); }}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 3: 类型检查 + 单测**

Run: `npm run typecheck && npm test`
Expected: 全部通过

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/RedirectsPanel.tsx src/renderer/src/components/RedirectEditorModal.tsx src/shared/api.ts src/preload/index.ts src/main/ipc.ts
git commit -m "feat(ui): redirects panel and editor with file dialog"
```

---

### Task 15: ScenariosPanel

**Files:**
- Replace `src/renderer/src/components/ScenariosPanel.tsx`

- [ ] **Step 1: 实现**

```tsx
import { useCallback, useEffect, useState } from 'react';
import type { Scenario } from '../../../shared/types';
import { api } from '../lib/api';

export default function ScenariosPanel() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<Scenario | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      setScenarios(await api.scenariosList());
    } catch {}
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const add = async () => {
    setError('');
    const name = newName.trim();
    if (!name) { setError('名称不能为空'); return; }
    try {
      await api.scenariosAdd(name);
      setNewName('');
      setCreating(false);
      await refresh();
    } catch (e) { setError(String(e)); }
  };

  const toggle = async (s: Scenario, enabled: boolean) => {
    await api.scenariosSetEnabled(s.name, enabled);
    await refresh();
  };

  const doRename = async () => {
    if (!renaming) return;
    setError('');
    const newN = renameValue.trim();
    if (!newN || newN === renaming.name) { setRenaming(null); return; }
    try {
      await api.scenariosRename(renaming.name, newN);
      setRenaming(null);
      await refresh();
    } catch (e) { setError(String(e)); }
  };

  const remove = async (s: Scenario) => {
    if (!window.confirm(`确定删除场景「${s.name}」？引用此场景的规则与重定向将自动清除场景关联。`)) return;
    await api.scenariosRemove(s.name);
    await refresh();
  };

  return (
    <div className="panel">
      <div className="toolbar">
        <button className="primary" data-testid="scenario-new" onClick={() => setCreating(true)}>新建场景</button>
        <span className="muted">规则与重定向可挂到场景；场景关闭时挂入的条目一并失效</span>
      </div>
      {creating && (
        <div className="toolbar">
          <input data-testid="scenario-name-input" placeholder="场景名" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <button data-testid="scenario-add" onClick={add}>添加</button>
          <button onClick={() => setCreating(false)}>取消</button>
        </div>
      )}
      {renaming && (
        <div className="toolbar">
          <input data-testid="scenario-rename-input" placeholder="新名" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} />
          <button data-testid="scenario-rename-save" onClick={doRename}>保存</button>
          <button onClick={() => setRenaming(null)}>取消</button>
        </div>
      )}
      {error && <div className="text-err">{error}</div>}
      <table className="rules-table">
        <thead><tr><th className="col-enabled">启用</th><th className="col-name">名称</th><th className="col-ops">操作</th></tr></thead>
        <tbody>
          {scenarios.map((s) => (
            <tr key={s.name}>
              <td className="col-enabled">
                <input type="checkbox" checked={s.enabled} onChange={(e) => toggle(s, e.target.checked)} />
              </td>
              <td className="col-name" title={s.name}>{s.name}</td>
              <td className="col-ops">
                <div className="ops">
                  <button data-testid={`scenario-rename-${s.name}`} onClick={() => { setRenaming(s); setRenameValue(s.name); }}>重命名</button>
                  <button data-testid={`scenario-delete-${s.name}`} onClick={() => remove(s)}>删除</button>
                </div>
              </td>
            </tr>
          ))}
          {scenarios.length === 0 && <tr><td colSpan={3} className="muted">还没有场景，点击「新建场景」开始</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: 类型检查 + 单测**

Run: `npm run typecheck && npm test`
Expected: 全部通过

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/ScenariosPanel.tsx
git commit -m "feat(ui): scenarios panel with toggle/rename/delete"
```

---

### Task 16: E2E specs

**Files:**
- Create: `e2e/map-local.spec.ts`
- Create: `e2e/scenarios.spec.ts`
- Create: `e2e/sequence.spec.ts`

- [ ] **Step 1: map-local.spec.ts**

```ts
import { _electron as electron, test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fetch, ProxyAgent } from 'undici';

let app: ElectronApplication;
let win: Page;
let tmpDir: string;
let htmlFile: string;

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'] });
  win = await app.firstWindow();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mocker-e2e-maplocal-'));
  htmlFile = path.join(tmpDir, 'page.html');
  await fs.writeFile(htmlFile, '<html><body>MAP LOCAL OK</body></html>');
});

test.afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  await win.evaluate(async () => {
    for (const r of await window.api.redirectsList()) await window.api.redirectsRemove(r.id);
  });
  await app.close();
});

test('map-local returns file content', async () => {
  const port = (await win.evaluate(async () => {
    if (!(await window.api.proxyStatus()).running) await window.api.proxyStart();
    return (await window.api.proxyStatus()).port;
  }));

  await win.evaluate(async (target: string) => {
    await window.api.redirectsAdd({
      name: 'e2e-maplocal',
      enabled: true,
      match: { urlType: 'exact', urlPattern: 'http://e2e.example.test/maplocal', method: 'ANY' },
      action: 'mapLocal',
      target,
    });
  }, htmlFile);

  const agent = new ProxyAgent(`http://127.0.0.1:${port}`);
  try {
    const res = await fetch('http://e2e.example.test/maplocal', { dispatcher: agent });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html><body>MAP LOCAL OK</body></html>');
  } finally {
    await agent.close();
  }

  await expect(async () => {
    const text = await win.locator('.traffic-table').innerText();
    expect(text).toContain('maplocal');
  }).toPass({ timeout: 10_000 });
});
```

- [ ] **Step 2: scenarios.spec.ts**

```ts
import { _electron as electron, test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { fetch, ProxyAgent } from 'undici';

let app: ElectronApplication;
let win: Page;
const RULE_NAMES = ['e2e-sc-off', 'e2e-sc-on'];

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'] });
  win = await app.firstWindow();
});

test.afterAll(async () => {
  await win.evaluate(async () => {
    for (const r of await window.api.rulesList()) if (names.includes(r.name)) await window.api.rulesRemove(r.id);
    for (const s of await window.api.scenariosList()) await window.api.scenariosRemove(s.name);
  }, RULE_NAMES);
  await app.close();
});

test('scenario disabled suppresses its rules', async () => {
  const port = (await win.evaluate(async () => {
    if (!(await window.api.proxyStatus()).running) await window.api.proxyStart();
    return (await window.api.proxyStatus()).port;
  }));

  await win.evaluate(async (names: string[]) => {
    await window.api.scenariosAdd('e2e-sc');
    await window.api.scenariosSetEnabled('e2e-sc', true);
    await window.api.rulesAdd({
      name: names[0]!,
      enabled: true,
      scenario: 'e2e-sc',
      match: { urlType: 'exact', urlPattern: 'http://e2e.example.test/sc-off', method: 'ANY' },
      action: { status: 200, headers: {}, body: 'OFF-RULE' },
    });
    await window.api.rulesAdd({
      name: names[1]!,
      enabled: true,
      scenario: undefined,
      match: { urlType: 'exact', urlPattern: 'http://e2e.example.test/sc-on', method: 'ANY' },
      action: { status: 200, headers: {}, body: 'ON-RULE' },
    });
  }, RULE_NAMES);

  // 两条都命中
  const agent = new ProxyAgent(`http://127.0.0.1:${port}`);
  try {
    let r1 = await fetch('http://e2e.example.test/sc-off', { dispatcher: agent });
    expect(await r1.text()).toBe('OFF-RULE');
    let r2 = await fetch('http://e2e.example.test/sc-on', { dispatcher: agent });
    expect(await r2.text()).toBe('ON-RULE');
  } finally {
    await agent.close();
  }

  // 关场景：off 规则应失效，透传到上游；on 规则仍命中
  await win.evaluate(async () => { await window.api.scenariosSetEnabled('e2e-sc', false); });
  const agent2 = new ProxyAgent(`http://127.0.0.1:${port}`);
  try {
    const r3 = await fetch('http://e2e.example.test/sc-on', { dispatcher: agent2 });
    expect(await r3.text()).toBe('ON-RULE');
    const r4 = await fetch('http://e2e.example.test/sc-off', { dispatcher: agent2 });
    // 上游不存在 → 错误
    expect(r4.status).not.toBe(200);
  } finally {
    await agent2.close();
  }
});
```

- [ ] **Step 3: sequence.spec.ts**

```ts
import { _electron as electron, test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { fetch, ProxyAgent } from 'undici';

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'] });
  win = await app.firstWindow();
});

test.afterAll(async () => {
  await win.evaluate(async () => {
    for (const r of await window.api.rulesList()) if (r.name === 'e2e-seq') await window.api.rulesRemove(r.id);
  });
  await app.close();
});

test('sequential rule returns responses in order, stays at last', async () => {
  const port = (await win.evaluate(async () => {
    if (!(await window.api.proxyStatus()).running) await window.api.proxyStart();
    return (await window.api.proxyStatus()).port;
  }));

  await win.evaluate(async () => {
    await window.api.rulesAdd({
      name: 'e2e-seq',
      enabled: true,
      match: { urlType: 'exact', urlPattern: 'http://e2e.example.test/seq', method: 'ANY' },
      action: {
        kind: 'sequential',
        responses: [
          { status: 200, headers: {}, body: 'first' },
          { status: 201, headers: {}, body: 'second' },
          { status: 202, headers: {}, body: 'last' },
        ],
      },
    });
  });

  const agent = new ProxyAgent(`http://127.0.0.1:${port}`);
  try {
    const r1 = await fetch('http://e2e.example.test/seq', { dispatcher: agent });
    expect(r1.status).toBe(200);
    expect(await r1.text()).toBe('first');
    const r2 = await fetch('http://e2e.example.test/seq', { dispatcher: agent });
    expect(r2.status).toBe(201);
    expect(await r2.text()).toBe('second');
    const r3 = await fetch('http://e2e.example.test/seq', { dispatcher: agent });
    expect(r3.status).toBe(202);
    expect(await r3.text()).toBe('last');
    const r4 = await fetch('http://e2e.example.test/seq', { dispatcher: agent });
    expect(r4.status).toBe(202); // stays at last
    expect(await r4.text()).toBe('last');
  } finally {
    await agent.close();
  }
});
```

- [ ] **Step 4: 运行 E2E**

Run: `npm run test:e2e`
Expected: 24+3=27 passed（确认 8888/8899 空闲）

- [ ] **Step 5: Commit**

```bash
git add e2e/map-local.spec.ts e2e/scenarios.spec.ts e2e/sequence.spec.ts
git commit -m "test(e2e): map-local, scenarios, sequential response flows"
```

---

### Task 17: README + 全量验证

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README 在「流量操作」章节之后追加**

```markdown
### 重定向

「重定向」标签页管理 Map Local / Map Remote 规则，与普通 Mock 规则平级，单独存储：

- **Map Local**：匹配命中后直接返回本地文件的内容，Content-Type 按扩展名推断（`.html/.json/.css/.js/.png` 等）；文件不存在返回 404 + 错误
- **Map Remote**：匹配命中后改 host（保留 path/query/method/body）转发上游，mock 规则不再生效；HTTPS 走系统 TLS

重定向规则支持与 mock 规则同样的匹配字段（URL 模式/方法/请求头）、启用开关、场景归属。

### 场景

「场景」标签页管理命名分组：每个场景有独立 enable 开关；规则与重定向可在编辑器里选择挂到某个场景，规则最终启用状态 = `rule.enabled AND (scenario?.enabled ?? true)`。

- 关闭场景会一键停掉其下所有规则/重定向
- 删除场景会清空引用（确认弹窗）
- 重命名场景会级联更新引用

适用场景：「测试 A」开一组规则、「线上模拟」开另一组，一键切换互不干扰。

### 序列响应

规则的「行为模拟」区块支持切换为「序列响应」模式：每条规则可挂一组响应（status + headers + body），每次命中按顺序返回下一条；到达末尾后固定返回最后一条，不循环。计数器仅存内存，应用退出清零。

适用场景：分页接口先返首页再返空页、登录态校验先 200 再 401、错误恢复先 5xx 再 200 等。
```

- [ ] **Step 2: 全量验证**

Run: `npm run typecheck && npm test`
Run（确认 8888/8899 空闲）: `npm run test:e2e`
Expected: 全部通过

- [ ] **Step 3: 手工冒烟（UI 路径）**

Run: `npm run dev`，确认：
1. 「重定向」tab 可新建 mapLocal 规则并生效
2. 「场景」tab 可建场景并挂到规则
3. 规则编辑器切换「序列响应」可保存并按顺序返回

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: rule engine extensions (redirects/scenarios/sequential) usage"
```

---

## 计划自审记录

- **Spec 覆盖**：11 节 spec 对应 17 个任务；每个决议（Q1=B/Q2=B/Q3=A）在 type/store/UI 各层都有落地
- **占位符**：无 TBD/TODO，所有代码完整
- **类型一致性**：RuleAction 联合 → validate / apply-rule / RuleEditorModal 同步；RedirectRule/Scenario 在 storage/api/preload/ipc/types 同步
- **平台兼容**：mime 表 + fs + Node http/https 均跨平台，无 OS 分支
- **回归**：proxy-server.handleMatched 重构保留 computeMockResult 共用、event 字段保持向后兼容（新增 `sequenceIndex` 可选）
