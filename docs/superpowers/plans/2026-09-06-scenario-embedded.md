# 场景内嵌重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除独立「场景」标签页，把场景变成规则页/重定向页内的分组小节：默认组 builtin 不可删改、组内新建预挂场景、组头拖拽排序、条目跨场景拖拽（+「移动到…」兜底）。

**Architecture:** 分组视图是纯前端重组（`groupByScenario` 纯函数把条目列表 + 场景列表折叠成分组视图），`ScenariosStore` 增加 builtin 语义与 `reorder`，`scenarios:remove` IPC 升级为「转移+删除」原子操作。管道命中语义零改动（重定向 → 全局优先级首个命中的 mock → 透传）。

**Tech Stack:** Electron + React 19 + TypeScript + vitest + Playwright（原生 HTML5 DnD，不引拖拽库）。

**Spec:** `docs/superpowers/specs/2026-09-06-scenario-embedded-design.md`

**验证基线命令**（每个任务收尾都会用到）：

```bash
npm run typecheck   # tsc -p tsconfig.node.json + tsconfig.web.json，期望无输出
npm test            # vitest run，当前基线 361 passed（S2/S4 后数量增加）
npm run build       # electron-vite build，E2E 前必须执行（否则跑旧 out/）
npm run test:e2e    # build + playwright，需 8888/8899 空闲；若被占先让用户退出 mocker
```

---

### Task 0: 提交本会话遗留改动

工作区有三处已验证但未提交的改动（序列响应编辑器增强 + 弹窗加宽，30 E2E + 361 单测通过）。后续任务会改其中两个文件，先落库避免混入。

- [ ] **Step 1: 确认只含这三个文件**

```bash
git status --short
```

Expected: 仅 `M e2e/json-editor.spec.ts`、`M src/renderer/src/components/RuleEditorModal.tsx`、`M src/renderer/src/styles.css`（若还有其他文件，停下来向用户确认，不要一起提交）。

- [ ] **Step 2: 提交**

```bash
git add e2e/json-editor.spec.ts src/renderer/src/components/RuleEditorModal.tsx src/renderer/src/styles.css
git commit -m "feat(ui): sequential rows use JSON body editor; error template targets last row; wider modals"
```

---

### Task 1: shared 类型 + API 契约 + preload

**Files:**
- Modify: `src/shared/types.ts:164-167`（Scenario 接口）
- Modify: `src/shared/api.ts:31-35`（Api 接口场景方法）
- Modify: `src/preload/index.ts:32-36`（桥接实现）

- [ ] **Step 1: Scenario 增加 builtin 标记**

`src/shared/types.ts` 中替换：

```ts
export interface Scenario {
  name: string;
  enabled: boolean;
}
```

为：

```ts
export interface Scenario {
  name: string;
  enabled: boolean;
  /** 内置场景「默认」：不可删除、不可改名，缺失时启动自动补种 */
  builtin?: boolean;
}
```

- [ ] **Step 2: Api 接口更新**

`src/shared/api.ts` 中替换：

```ts
  scenariosRemove(name: string): Promise<void>;
```

为：

```ts
  /** moveTo 为目标场景名；null = 条目转为未分组 */
  scenariosRemove(name: string, moveTo: string | null): Promise<void>;
  scenariosReorder(names: string[]): Promise<void>;
```

- [ ] **Step 3: preload 接线**

`src/preload/index.ts` 中替换：

```ts
  scenariosRemove: (name) => ipcRenderer.invoke('scenarios:remove', name),
```

为：

```ts
  scenariosRemove: (name, moveTo) => ipcRenderer.invoke('scenarios:remove', name, moveTo),
  scenariosReorder: (names) => ipcRenderer.invoke('scenarios:reorder', names),
```

- [ ] **Step 4: typecheck（预期失败——调用方 ScenariosPanel 还在用旧签名）**

Run: `npm run typecheck`
Expected: FAIL，报 ScenariosPanel.tsx 中 `scenariosRemove` 参数不匹配（1 处）。这正是 Task 8 要删的文件，此处先记下，不修。

- [ ] **Step 5: Commit（仅 shared/preload 三个文件）**

```bash
git add src/shared/types.ts src/shared/api.ts src/preload/index.ts
git commit -m "feat(shared): scenario builtin flag, scenarios remove-with-move + reorder API"
```

---

### Task 2: ScenariosStore（补种默认 / builtin 守卫 / reorder）

**Files:**
- Modify: `src/main/storage/scenarios-store.ts`（全文重写）
- Test: `tests/scenarios-store.test.ts`（全文重写）

- [ ] **Step 1: 重写测试（先失败）**

`tests/scenarios-store.test.ts` 整体替换为：

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
  it('seeds builtin 默认 when no file', async () => {
    expect(store.list()).toEqual([{ name: '默认', enabled: true, builtin: true }]);
  });

  it('re-seeds 默认 when existing file lacks builtin', async () => {
    await fs.writeFile(path.join(dir, 'scenarios.json'), JSON.stringify([{ name: 'dev', enabled: true }]));
    const other = new ScenariosStore(dir);
    await other.load();
    expect(other.list().map((s) => s.name)).toEqual(['dev', '默认']);
    expect(other.list().find((s) => s.name === '默认')?.builtin).toBe(true);
  });

  it('keeps persisted order when 默认 exists', async () => {
    await store.add('dev');
    await store.reorder(['dev', '默认']);
    const other = new ScenariosStore(dir);
    await other.load();
    expect(other.list().map((s) => s.name)).toEqual(['dev', '默认']);
  });

  it('add persists and lists after builtin', async () => {
    await store.add('dev');
    await store.add('staging');
    expect(store.list().map((s) => s.name)).toEqual(['默认', 'dev', 'staging']);
  });

  it('add duplicate name throws', async () => {
    await store.add('dev');
    await expect(store.add('dev')).rejects.toThrow();
    await expect(store.add('默认')).rejects.toThrow();
  });

  it('rename updates name', async () => {
    await store.add('dev');
    await store.rename('dev', 'local');
    expect(store.list().map((s) => s.name)).toEqual(['默认', 'local']);
  });

  it('rename builtin throws', async () => {
    await expect(store.rename('默认', 'base')).rejects.toThrow('内置场景不可重命名');
  });

  it('rename to existing name throws', async () => {
    await store.add('dev');
    await expect(store.rename('dev', '默认')).rejects.toThrow();
  });

  it('setEnabled toggles builtin too', async () => {
    await store.setEnabled('默认', false);
    expect(store.list()[0]!.enabled).toBe(false);
  });

  it('remove clears non-builtin', async () => {
    await store.add('dev');
    await store.remove('dev');
    expect(store.list().map((s) => s.name)).toEqual(['默认']);
  });

  it('remove builtin throws', async () => {
    await expect(store.remove('默认')).rejects.toThrow('内置场景不可删除');
  });

  it('reorder reorders', async () => {
    await store.add('dev');
    await store.add('staging');
    await store.reorder(['staging', '默认', 'dev']);
    expect(store.list().map((s) => s.name)).toEqual(['staging', '默认', 'dev']);
  });

  it('reorder rejects partial / duplicated / unknown lists', async () => {
    await store.add('dev');
    await expect(store.reorder(['dev'])).rejects.toThrow();
    await expect(store.reorder(['默认', '默认'])).rejects.toThrow();
    await expect(store.reorder(['默认', 'dev', 'ghost'])).rejects.toThrow();
    expect(store.list().map((s) => s.name)).toEqual(['默认', 'dev']);
  });

  it('persists across instances', async () => {
    await store.add('dev');
    await store.setEnabled('dev', false);
    const other = new ScenariosStore(dir);
    await other.load();
    expect(other.list()).toEqual([
      { name: '默认', enabled: true, builtin: true },
      { name: 'dev', enabled: false },
    ]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/scenarios-store.test.ts`
Expected: FAIL——大部分用例失败（当前 load 不补种、无 reorder、builtin 未校验）。

- [ ] **Step 3: 重写实现**

`src/main/storage/scenarios-store.ts` 整体替换为：

```ts
import * as path from 'node:path';
import type { Scenario } from '../../shared/types';
import { JsonStore } from './json-store';

const BUILTIN_DEFAULT: Scenario = { name: '默认', enabled: true, builtin: true };

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
      console.warn('[scenarios-store] failed to load, starting fresh:', err);
      this.scenarios = [];
    }
    // 默认组是恒存兜底分组：文件缺失或被手工删掉都要补种，补种位置在最前。
    if (!this.scenarios.some((s) => s.builtin)) {
      this.scenarios = [BUILTIN_DEFAULT, ...this.scenarios];
      await this.persist();
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

  async rename(oldName: string, newName: string): Promise<void> {
    const idx = this.scenarios.findIndex((s) => s.name === oldName);
    if (idx === -1) throw new Error(`场景不存在: ${oldName}`);
    if (this.scenarios[idx]!.builtin) throw new Error('内置场景不可重命名');
    if (oldName !== newName && this.scenarios.some((s) => s.name === newName)) {
      throw new Error(`目标场景名已存在: ${newName}`);
    }
    this.scenarios[idx] = { ...this.scenarios[idx], name: newName };
    await this.persist();
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const idx = this.scenarios.findIndex((s) => s.name === name);
    if (idx === -1) throw new Error(`场景不存在: ${name}`);
    this.scenarios[idx] = { ...this.scenarios[idx], name, enabled };
    await this.persist();
  }

  async remove(name: string): Promise<void> {
    const target = this.scenarios.find((s) => s.name === name);
    if (!target) throw new Error(`场景不存在: ${name}`);
    if (target.builtin) throw new Error('内置场景不可删除');
    this.scenarios = this.scenarios.filter((s) => s.name !== name);
    await this.persist();
  }

  async reorder(names: string[]): Promise<void> {
    const current = this.scenarios.map((s) => s.name);
    const valid =
      names.length === current.length &&
      new Set(names).size === names.length &&
      names.every((n) => current.includes(n));
    if (!valid) throw new Error('reorder 名单必须与现有场景一一对应');
    const byName = new Map(this.scenarios.map((s) => [s.name, s] as const));
    this.scenarios = names.map((n) => byName.get(n)!);
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.store.write(this.scenarios);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/scenarios-store.test.ts`
Expected: PASS（14 tests）。

- [ ] **Step 5: Commit**

```bash
git add src/main/storage/scenarios-store.ts tests/scenarios-store.test.ts
git commit -m "feat(main): builtin default scenario with re-seed, guards and reorder in ScenariosStore"
```

---

### Task 3: IPC（remove 转移 + reorder）

**Files:**
- Modify: `src/main/ipc.ts:169-177`（scenarios:remove 处理器）、`157-168` 附近新增 reorder

- [ ] **Step 1: 替换 scenarios:remove 处理器**

`src/main/ipc.ts` 中替换：

```ts
  ipcMain.handle('scenarios:remove', async (_e, name: string) => {
    await ctx.scenarios.remove(name);
    for (const r of ctx.rules.list()) {
      if (r.scenario === name) await ctx.rules.update(r.id, { scenario: undefined });
    }
    for (const r of ctx.redirects.list()) {
      if (r.scenario === name) await ctx.redirects.update(r.id, { scenario: undefined });
    }
  });
```

为：

```ts
  ipcMain.handle('scenarios:remove', async (_e, name: string, moveTo: string | null) => {
    // 先校验去向再动手：目标不存在时整体放弃，不产生半删除状态
    if (moveTo !== null && moveTo !== name && !ctx.scenarios.list().some((s) => s.name === moveTo)) {
      throw new Error(`目标场景不存在: ${moveTo}`);
    }
    await ctx.scenarios.remove(name);
    const next = moveTo === null ? undefined : moveTo;
    for (const r of ctx.rules.list()) {
      if (r.scenario === name) await ctx.rules.update(r.id, { scenario: next });
    }
    for (const r of ctx.redirects.list()) {
      if (r.scenario === name) await ctx.redirects.update(r.id, { scenario: next });
    }
  });
  ipcMain.handle('scenarios:reorder', (_e, names: string[]) => ctx.scenarios.reorder(names));
```

- [ ] **Step 2: typecheck（此时 ScenariosPanel 仍是唯一报错源）**

Run: `npm run typecheck`
Expected: FAIL 且仅剩 ScenariosPanel.tsx 一处（Task 1 Step 4 记下的）。除此之外无新错误。

- [ ] **Step 3: Commit**

```bash
git add src/main/ipc.ts
git commit -m "feat(main): scenarios remove transfers entries to target (or ungrouped) atomically; reorder IPC"
```

---

### Task 4: groupByScenario 纯函数

**Files:**
- Create: `src/renderer/src/lib/scenario-groups.ts`
- Test: `tests/scenario-groups.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `tests/scenario-groups.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { DND_MIME, groupByScenario, type DragPayload } from '../src/renderer/src/lib/scenario-groups';
import type { Scenario } from '../src/shared/types';

interface Item { id: string; scenario?: string }

const scenarios: Scenario[] = [
  { name: '默认', enabled: true, builtin: true },
  { name: 'dev', enabled: false },
];

describe('groupByScenario', () => {
  it('puts unassigned items in a leading ungrouped pseudo-group', () => {
    const items: Item[] = [{ id: 'a' }, { id: 'b', scenario: 'dev' }, { id: 'c' }];
    const groups = groupByScenario(items, scenarios);
    expect(groups).toEqual([
      { scenario: undefined, builtin: false, enabled: null, items: [{ id: 'a' }, { id: 'c' }] },
      { scenario: '默认', builtin: true, enabled: true, items: [] },
      { scenario: 'dev', builtin: false, enabled: false, items: [{ id: 'b', scenario: 'dev' }] },
    ]);
  });

  it('omits ungrouped group when nothing unassigned', () => {
    const groups = groupByScenario<Item>([{ id: 'b', scenario: '默认' }], scenarios);
    expect(groups.map((g) => g.scenario)).toEqual(['默认', 'dev']);
  });

  it('keeps item order inside groups', () => {
    const items: Item[] = [{ id: '2', scenario: 'dev' }, { id: '1', scenario: 'dev' }];
    const [devGroup] = groupByScenario(items, scenarios).filter((g) => g.scenario === 'dev');
    expect(devGroup!.items.map((i) => i.id)).toEqual(['2', '1']);
  });

  it('returns only ungrouped group when scenario list is empty', () => {
    const groups = groupByScenario<Item>([{ id: 'a' }], []);
    expect(groups).toEqual([{ scenario: undefined, builtin: false, enabled: null, items: [{ id: 'a' }] }]);
  });

  it('exports a stable DnD mime and payload shape', () => {
    const payload: DragPayload = { type: 'item', value: 'r1' };
    expect(DND_MIME).toBeTruthy();
    expect(JSON.parse(JSON.stringify(payload)).type).toBe('item');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/scenario-groups.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现纯函数**

新建 `src/renderer/src/lib/scenario-groups.ts`：

```ts
import type { Scenario } from '../../../shared/types';

/** 拖拽负载：组头之间拖 = 场景排序；行拖到组 = 条目换场景 */
export interface DragPayload {
  type: 'scenario' | 'item';
  value: string;
}

export const DND_MIME = 'application/x-mocker-drag';

export interface ScenarioGroupView<T> {
  /** undefined = 未分组伪组 */
  scenario: string | undefined;
  builtin: boolean;
  /** null = 未分组（无组开关，条目永远生效） */
  enabled: boolean | null;
  items: T[];
}

/** 未分组（若有）置顶，其余按场景持久化顺序；组内保持传入顺序（调用方按优先级排好） */
export function groupByScenario<T extends { scenario?: string }>(
  items: T[],
  scenarios: Scenario[],
): Array<ScenarioGroupView<T>> {
  const groups: Array<ScenarioGroupView<T>> = [];
  const unassigned = items.filter((it) => !it.scenario);
  if (unassigned.length > 0) {
    groups.push({ scenario: undefined, builtin: false, enabled: null, items: unassigned });
  }
  for (const s of scenarios) {
    groups.push({
      scenario: s.name,
      builtin: Boolean(s.builtin),
      enabled: s.enabled,
      items: items.filter((it) => it.scenario === s.name),
    });
  }
  return groups;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/scenario-groups.test.ts`
Expected: PASS（5 tests）。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/scenario-groups.ts tests/scenario-groups.test.ts
git commit -m "feat(renderer): groupByScenario pure grouping with ungrouped pseudo-group"
```

---

### Task 5: ScenarioGroup / ScenarioCreate 组件 + 样式

**Files:**
- Create: `src/renderer/src/components/ScenarioGroup.tsx`
- Create: `src/renderer/src/components/ScenarioCreate.tsx`
- Modify: `src/renderer/src/styles.css`（`.rules-table .col-ops` 行 + 文件末尾追加分组样式）

UI 组件不做单测（仓库惯例：纯函数单测 + E2E 覆盖 UI），Task 9 E2E 验收。

- [ ] **Step 1: ScenarioGroup 组件**

新建 `src/renderer/src/components/ScenarioGroup.tsx`：

```tsx
import { useState, type ReactNode } from 'react';
import { DND_MIME, type DragPayload } from '../lib/scenario-groups';

export interface MoveTarget {
  /** '' = 未分组 */
  value: string;
  label: string;
}

interface Props {
  /** 稳定 testid 前缀，如 group-默认 / group-ungrouped */
  testId: string;
  name: string;
  /** undefined = 未分组 */
  scenario: string | undefined;
  builtin: boolean;
  enabled: boolean | null;
  count: number;
  createLabel: string;
  moveTargets: MoveTarget[];
  /** 未分组不可作为排序拖拽源 */
  draggableScenario: boolean;
  onToggle?: (enabled: boolean) => void;
  onRename?: (newName: string) => void;
  onDelete?: (moveTo: string | null) => void;
  onCreateItem?: () => void;
  onDropPayload?: (payload: DragPayload) => void;
  children: ReactNode;
}

export default function ScenarioGroup({
  testId, name, scenario, builtin, enabled, count, createLabel, moveTargets,
  draggableScenario, onToggle, onRename, onDelete, onCreateItem, onDropPayload, children,
}: Props) {
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [moveTo, setMoveTo] = useState('');
  const [dropHover, setDropHover] = useState(false);

  const submitRename = () => {
    const next = nameDraft.trim();
    setRenaming(false);
    if (!next || next === name) return;
    onRename?.(next);
  };

  const acceptDrop = (e: React.DragEvent) => {
    const raw = e.dataTransfer.getData(DND_MIME);
    if (!raw) return;
    try {
      onDropPayload?.(JSON.parse(raw) as DragPayload);
    } catch {
      // 非本应用拖拽源，忽略
    }
  };

  return (
    <div
      className={`scenario-group${dropHover ? ' drop-hover' : ''}`}
      data-testid={testId}
      onDragOver={(e) => {
        if (!onDropPayload) return;
        e.preventDefault();
        setDropHover(true);
      }}
      onDragLeave={() => setDropHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropHover(false);
        acceptDrop(e);
      }}
    >
      <div
        className="scenario-head"
        data-testid={`${testId}-head`}
        draggable={draggableScenario}
        onDragStart={(e) => {
          if (!draggableScenario || scenario === undefined) return;
          e.dataTransfer.setData(
            DND_MIME,
            JSON.stringify({ type: 'scenario', value: scenario } satisfies DragPayload),
          );
          e.dataTransfer.effectAllowed = 'move';
        }}
      >
        <span className="drag-handle" aria-hidden="true">⠿</span>
        {enabled !== null && (
          <input
            type="checkbox"
            data-testid={`${testId}-toggle`}
            checked={enabled}
            aria-label={`场景 ${name} 启用`}
            onChange={(e) => onToggle?.(e.target.checked)}
          />
        )}
        {renaming ? (
          <input
            data-testid={`${testId}-rename-input`}
            value={nameDraft}
            autoFocus
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={submitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') {
                setNameDraft(name);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <span className="scenario-name" data-testid={`${testId}-name`} title={name}>{name}</span>
        )}
        <span className="muted">({count})</span>
        {!builtin && onRename && !renaming && (
          <button data-testid={`${testId}-rename`} onClick={() => { setNameDraft(name); setRenaming(true); }}>重命名</button>
        )}
        {!builtin && onDelete && !confirming && (
          <button
            data-testid={`${testId}-delete`}
            onClick={() => {
              setMoveTo(moveTargets[0]?.value ?? '');
              setConfirming(true);
            }}
          >删除</button>
        )}
        {confirming && (
          <span className="scenario-confirm">
            条目去向
            <select
              data-testid={`${testId}-move-to`}
              value={moveTo}
              onChange={(e) => setMoveTo(e.target.value)}
            >
              {moveTargets.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            <button data-testid={`${testId}-confirm-delete`} onClick={() => { setConfirming(false); onDelete?.(moveTo === '' ? null : moveTo); }}>确认删除</button>
            <button onClick={() => setConfirming(false)}>取消</button>
          </span>
        )}
      </div>
      <div className="scenario-body">{children}</div>
      {onCreateItem && (
        <div className="scenario-footer">
          <button data-testid={`${testId}-create`} onClick={onCreateItem}>{createLabel}</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: ScenarioCreate 组件**

新建 `src/renderer/src/components/ScenarioCreate.tsx`：

```tsx
import { useState } from 'react';
import { api } from '../lib/api';

export default function ScenarioCreate({ onCreated }: { onCreated: () => void }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  const add = async () => {
    setError('');
    const n = name.trim();
    if (!n) { setError('名称不能为空'); return; }
    try {
      await api.scenariosAdd(n);
      setName('');
      setCreating(false);
      onCreated();
    } catch (e) {
      setError(String(e));
    }
  };

  if (!creating) {
    return <button data-testid="scenario-new" onClick={() => setCreating(true)}>+ 新建场景</button>;
  }
  return (
    <span className="scenario-create">
      <input
        data-testid="scenario-name-input"
        placeholder="场景名"
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void add(); }}
      />
      <button data-testid="scenario-add" onClick={add}>添加</button>
      <button onClick={() => setCreating(false)}>取消</button>
      {error && <span className="text-err">{error}</span>}
    </span>
  );
}
```

- [ ] **Step 3: 样式**

`src/renderer/src/styles.css` 中把 `.rules-table .col-ops { width: 190px; }` 改为：

```css
.rules-table .col-ops { width: 260px; }
```

在文件末尾追加：

```css
/* 场景分组小节（规则页/重定向页） */
.scenario-group { margin-bottom: 18px; }
.scenario-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: #2b2c34;
  border-radius: 6px;
}
.scenario-head .drag-handle { cursor: grab; color: #8a8b96; user-select: none; }
.scenario-head .scenario-name { font-weight: 600; }
.scenario-group.drop-hover .scenario-head { outline: 2px dashed #6ea8fe; }
.scenario-body .rules-table { margin-top: 6px; }
.scenario-footer { margin-top: 6px; }
.scenario-create { display: inline-flex; gap: 8px; align-items: center; }
.scenario-confirm { display: inline-flex; gap: 8px; align-items: center; }
.rules-table .ops select { max-width: 110px; }
```

（依据既有纪律：组头是工具栏式密集行，必须 flex-wrap；选择器限宽避免把操作列撑爆。）

- [ ] **Step 4: typecheck + 单测回归**

Run: `npm run typecheck && npm test`
Expected: typecheck 仍只剩 ScenariosPanel 旧签名错误（Task 8 删除）；单测全过、数量不变（361 + 5 + 14 重写替换原 8 = 372）。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/ScenarioGroup.tsx src/renderer/src/components/ScenarioCreate.tsx src/renderer/src/styles.css
git commit -m "feat(ui): scenario group section (dnd head, toggle, inline rename, delete-with-move) and create button"
```

---

### Task 6: RulesPanel 分组化 + RuleEditorModal 预挂场景

**Files:**
- Modify: `src/renderer/src/components/RulesPanel.tsx`（全文重写）
- Modify: `src/renderer/src/components/RuleEditorModal.tsx:76-85`（Props + 场景初值）

- [ ] **Step 1: RuleEditorModal 增加 presetScenario**

`src/renderer/src/components/RuleEditorModal.tsx`：

Props 接口（第 76 行起）增加一行 `presetScenario?: string;`（与 `initial`/`draft`/`onClose`/`onSaved` 并列）：

```ts
interface Props {
  initial: MockRule | null;
  draft?: RuleInput;
  presetScenario?: string;
  onClose: () => void;
  onSaved: () => void;
}
```

解构行（第 83 行）改为：

```ts
export default function RuleEditorModal({ initial, draft, presetScenario, onClose, onSaved }: Props) {
```

场景初值行（原 `const [scenario, setScenario] = useState<string | undefined>(seed?.scenario);`）改为：

```ts
  const [scenario, setScenario] = useState<string | undefined>(seed?.scenario ?? presetScenario);
```

- [ ] **Step 2: 重写 RulesPanel**

`src/renderer/src/components/RulesPanel.tsx` 整体替换为：

```tsx
import { useCallback, useEffect, useState } from 'react';
import type { MockRule, Scenario } from '../../../shared/types';
import { api } from '../lib/api';
import { DND_MIME, groupByScenario, type DragPayload } from '../lib/scenario-groups';
import RuleEditorModal from './RuleEditorModal';
import ScenarioCreate from './ScenarioCreate';
import ScenarioGroup, { type MoveTarget } from './ScenarioGroup';

const UNGROUPED_ID = 'group-ungrouped';

export default function RulesPanel() {
  const [rules, setRules] = useState<MockRule[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [editor, setEditor] = useState<{ rule: MockRule | null; scenario: string | undefined } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([api.rulesList(), api.scenariosList()]);
      setRules(r);
      setScenarios(s);
    } catch {
      // keep the current list if the IPC call fails
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const moveTargets = (exclude: string | undefined): MoveTarget[] => [
    { value: '', label: '未分组' },
    ...scenarios.filter((s) => s.name !== exclude).map((s) => ({ value: s.name, label: s.name })),
  ];

  const toggleGroup = async (name: string, enabled: boolean) => {
    await api.scenariosSetEnabled(name, enabled);
    await refresh();
  };

  const renameGroup = async (oldName: string, newName: string) => {
    try {
      await api.scenariosRename(oldName, newName);
    } catch {
      // keep the old name on failure (e.g. duplicated)
    }
    await refresh();
  };

  const deleteGroup = async (name: string, moveTo: string | null) => {
    try {
      await api.scenariosRemove(name, moveTo);
    } catch {
      // keep everything on failure
    }
    await refresh();
  };

  const moveRule = async (rule: MockRule, target: string) => {
    await api.rulesUpdate(rule.id, { scenario: target === '' ? undefined : target });
    await refresh();
  };

  const handleDrop = async (targetScenario: string | undefined, payload: DragPayload) => {
    if (payload.type === 'item') {
      const rule = rules.find((r) => r.id === payload.value);
      if (!rule) return;
      await moveRule(rule, targetScenario ?? '');
      return;
    }
    if (targetScenario === undefined || payload.value === targetScenario) return;
    const names = scenarios.map((s) => s.name).filter((n) => n !== payload.value);
    const idx = names.indexOf(targetScenario);
    if (idx === -1) return;
    names.splice(idx, 0, payload.value);
    try {
      await api.scenariosReorder(names);
    } catch {
      // ignore invalid order payloads
    }
    await refresh();
  };

  const groups = groupByScenario(rules, scenarios);

  return (
    <div className="panel">
      <div className="toolbar">
        <ScenarioCreate onCreated={refresh} />
        <span className="muted">命中顺序跨场景全局按优先级，取第一个命中；组开关只决定整组是否生效</span>
      </div>
      {groups.map((g) => {
        const testId = g.scenario === undefined ? UNGROUPED_ID : `group-${g.scenario}`;
        return (
          <ScenarioGroup
            key={g.scenario ?? UNGROUPED_ID}
            testId={testId}
            name={g.scenario ?? '未分组'}
            scenario={g.scenario}
            builtin={g.builtin}
            enabled={g.enabled}
            count={g.items.length}
            createLabel="+ 新建规则"
            moveTargets={moveTargets(g.scenario)}
            draggableScenario={g.scenario !== undefined}
            onToggle={g.scenario === undefined ? undefined : (enabled) => toggleGroup(g.scenario!, enabled)}
            onRename={g.scenario === undefined ? undefined : (newName) => renameGroup(g.scenario!, newName)}
            onDelete={g.scenario === undefined ? undefined : (moveTo) => deleteGroup(g.scenario!, moveTo)}
            onCreateItem={() => setEditor({ rule: null, scenario: g.scenario })}
            onDropPayload={(payload) => void handleDrop(g.scenario, payload)}
          >
            <table className="rules-table">
              <thead>
                <tr><th className="col-enabled">启用</th><th className="col-name">名称</th><th className="col-match">匹配</th><th className="col-response">响应</th><th className="col-ops">操作</th></tr>
              </thead>
              <tbody>
                {g.items.map((r) => (
                  <tr
                    key={r.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(
                        DND_MIME,
                        JSON.stringify({ type: 'item', value: r.id } satisfies DragPayload),
                      );
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                  >
                    <td className="col-enabled">
                      <input
                        type="checkbox"
                        checked={r.enabled}
                        onChange={async (e) => {
                          await api.rulesUpdate(r.id, { enabled: e.target.checked });
                          await refresh();
                        }}
                      />
                    </td>
                    <td className="col-name" title={r.name}>{r.name}</td>
                    <td className="col-match muted" title={`${r.match.method} ${r.match.urlPattern}`}>{r.match.method} {r.match.urlPattern}</td>
                    <td className="col-response muted">{'status' in r.action ? r.action.status : '—'}</td>
                    <td className="col-ops">
                      <div className="ops">
                        <select
                          aria-label={`移动规则 ${r.name}`}
                          data-testid={`move-${r.name}`}
                          value={r.scenario ?? ''}
                          onChange={(e) => moveRule(r, e.target.value)}
                        >
                          <option value="">未分组</option>
                          {scenarios.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
                        </select>
                        <button onClick={() => moveRuleByPriority(r, -1)}>↑</button>
                        <button onClick={() => moveRuleByPriority(r, 1)}>↓</button>
                        <button onClick={() => setEditor({ rule: r, scenario: undefined })}>编辑</button>
                        <button onClick={() => removeRule(r)}>删除</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {g.items.length === 0 && (
                  <tr><td colSpan={5} className="muted">此场景暂无规则</td></tr>
                )}
              </tbody>
            </table>
          </ScenarioGroup>
        );
      })}
      {editor && (
        <RuleEditorModal
          initial={editor.rule}
          presetScenario={editor.rule ? undefined : editor.scenario}
          onClose={() => setEditor(null)}
          onSaved={() => { setEditor(null); refresh(); }}
        />
      )}
    </div>
  );

  async function moveRuleByPriority(rule: MockRule, dir: -1 | 1) {
    const idx = rules.findIndex((r) => r.id === rule.id);
    const other = rules[idx + dir];
    if (!other) return;
    try {
      await api.rulesUpdate(rule.id, { priority: other.priority });
      await api.rulesUpdate(other.id, { priority: rule.priority });
      await refresh();
    } catch {
      await refresh();
    }
  }

  async function removeRule(rule: MockRule) {
    try {
      await api.rulesRemove(rule.id);
      await refresh();
    } catch {
      await refresh();
    }
  }
}
```

- [ ] **Step 3: typecheck**

Run: `npm run typecheck`
Expected: 仍只剩 ScenariosPanel.tsx 一处错误（Task 8 删除）。RulesPanel 自身无错。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/RulesPanel.tsx src/renderer/src/components/RuleEditorModal.tsx
git commit -m "feat(ui): rules panel grouped by scenario with per-group create, row dnd and move-to"
```

---

### Task 7: RedirectsPanel 分组化 + RedirectEditorModal 预挂场景

**Files:**
- Modify: `src/renderer/src/components/RedirectsPanel.tsx`（全文重写）
- Modify: `src/renderer/src/components/RedirectEditorModal.tsx:9-13,38`（Props + 场景初值）

- [ ] **Step 1: RedirectEditorModal 增加 presetScenario**

Props 接口增加 `presetScenario?: string;`：

```ts
interface Props {
  initial: RedirectRule | null;
  presetScenario?: string;
  onClose: () => void;
  onSaved: () => void;
}
```

解构行改为：

```ts
export default function RedirectEditorModal({ initial, presetScenario, onClose, onSaved }: Props) {
```

场景初值行（原 `const [scenario, setScenario] = useState<string | undefined>(seed?.scenario);`）改为：

```ts
  const [scenario, setScenario] = useState<string | undefined>(seed?.scenario ?? presetScenario);
```

- [ ] **Step 2: 重写 RedirectsPanel**

`src/renderer/src/components/RedirectsPanel.tsx` 整体替换为：

```tsx
import { useCallback, useEffect, useState } from 'react';
import type { RedirectRule, Scenario } from '../../../shared/types';
import { api } from '../lib/api';
import { DND_MIME, groupByScenario, type DragPayload } from '../lib/scenario-groups';
import RedirectEditorModal from './RedirectEditorModal';
import ScenarioCreate from './ScenarioCreate';
import ScenarioGroup, { type MoveTarget } from './ScenarioGroup';

const UNGROUPED_ID = 'group-ungrouped';

export default function RedirectsPanel() {
  const [rules, setRules] = useState<RedirectRule[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [editor, setEditor] = useState<{ rule: RedirectRule | null; scenario: string | undefined } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([api.redirectsList(), api.scenariosList()]);
      setRules(r);
      setScenarios(s);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const moveTargets = (exclude: string | undefined): MoveTarget[] => [
    { value: '', label: '未分组' },
    ...scenarios.filter((s) => s.name !== exclude).map((s) => ({ value: s.name, label: s.name })),
  ];

  const toggleGroup = async (name: string, enabled: boolean) => {
    await api.scenariosSetEnabled(name, enabled);
    await refresh();
  };

  const renameGroup = async (oldName: string, newName: string) => {
    try {
      await api.scenariosRename(oldName, newName);
    } catch {
      // keep the old name on failure
    }
    await refresh();
  };

  const deleteGroup = async (name: string, moveTo: string | null) => {
    try {
      await api.scenariosRemove(name, moveTo);
    } catch {
      // keep everything on failure
    }
    await refresh();
  };

  const moveRule = async (rule: RedirectRule, target: string) => {
    await api.redirectsUpdate(rule.id, { scenario: target === '' ? undefined : target });
    await refresh();
  };

  const handleDrop = async (targetScenario: string | undefined, payload: DragPayload) => {
    if (payload.type === 'item') {
      const rule = rules.find((r) => r.id === payload.value);
      if (!rule) return;
      await moveRule(rule, targetScenario ?? '');
      return;
    }
    if (targetScenario === undefined || payload.value === targetScenario) return;
    const names = scenarios.map((s) => s.name).filter((n) => n !== payload.value);
    const idx = names.indexOf(targetScenario);
    if (idx === -1) return;
    names.splice(idx, 0, payload.value);
    try {
      await api.scenariosReorder(names);
    } catch {
      // ignore invalid order payloads
    }
    await refresh();
  };

  const groups = groupByScenario(rules, scenarios);

  return (
    <div className="panel">
      <div className="toolbar">
        <ScenarioCreate onCreated={refresh} />
        <span className="muted">重定向先于 Mock 规则命中，命中即短路；Map Local 返回本地文件，Map Remote 改 host 转发上游</span>
      </div>
      {groups.map((g) => {
        const testId = g.scenario === undefined ? UNGROUPED_ID : `group-${g.scenario}`;
        return (
          <ScenarioGroup
            key={g.scenario ?? UNGROUPED_ID}
            testId={testId}
            name={g.scenario ?? '未分组'}
            scenario={g.scenario}
            builtin={g.builtin}
            enabled={g.enabled}
            count={g.items.length}
            createLabel="+ 新建重定向"
            moveTargets={moveTargets(g.scenario)}
            draggableScenario={g.scenario !== undefined}
            onToggle={g.scenario === undefined ? undefined : (enabled) => toggleGroup(g.scenario!, enabled)}
            onRename={g.scenario === undefined ? undefined : (newName) => renameGroup(g.scenario!, newName)}
            onDelete={g.scenario === undefined ? undefined : (moveTo) => deleteGroup(g.scenario!, moveTo)}
            onCreateItem={() => setEditor({ rule: null, scenario: g.scenario })}
            onDropPayload={(payload) => void handleDrop(g.scenario, payload)}
          >
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
                {g.items.map((r) => (
                  <tr
                    key={r.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(
                        DND_MIME,
                        JSON.stringify({ type: 'item', value: r.id } satisfies DragPayload),
                      );
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                  >
                    <td className="col-enabled">
                      <input type="checkbox" checked={r.enabled} onChange={async (e) => {
                        await api.redirectsUpdate(r.id, { enabled: e.target.checked });
                        await refresh();
                      }} />
                    </td>
                    <td className="col-name" title={r.name}>{r.name}</td>
                    <td className="col-match muted" title={`${r.match.method} ${r.match.urlPattern}`}>{r.match.method} {r.match.urlPattern}</td>
                    <td className="col-response muted">{r.action === 'mapLocal' ? '本地' : '远程'}</td>
                    <td className="col-ops">
                      <div className="ops">
                        <select
                          aria-label={`移动重定向 ${r.name}`}
                          data-testid={`move-${r.name}`}
                          value={r.scenario ?? ''}
                          onChange={(e) => moveRule(r, e.target.value)}
                        >
                          <option value="">未分组</option>
                          {scenarios.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
                        </select>
                        <button onClick={() => setEditor({ rule: r, scenario: undefined })}>编辑</button>
                        <button onClick={() => removeRule(r)}>删除</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {g.items.length === 0 && (
                  <tr><td colSpan={5} className="muted">此场景暂无重定向</td></tr>
                )}
              </tbody>
            </table>
          </ScenarioGroup>
        );
      })}
      {editor && (
        <RedirectEditorModal
          initial={editor.rule}
          presetScenario={editor.rule ? undefined : editor.scenario}
          onClose={() => setEditor(null)}
          onSaved={() => { setEditor(null); refresh(); }}
        />
      )}
    </div>
  );

  async function removeRule(rule: RedirectRule) {
    await api.redirectsRemove(rule.id);
    await refresh();
  }
}
```

- [ ] **Step 3: typecheck + 单测**

Run: `npm run typecheck && npm test`
Expected: 仍只剩 ScenariosPanel 一处错误；单测全过。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/RedirectsPanel.tsx src/renderer/src/components/RedirectEditorModal.tsx
git commit -m "feat(ui): redirects panel grouped by scenario with move-to and per-group create"
```

---

### Task 8: 移除场景标签页

**Files:**
- Modify: `src/renderer/src/App.tsx`
- Delete: `src/renderer/src/components/ScenariosPanel.tsx`

- [ ] **Step 1: App.tsx 移除场景**

删除 import 行：

```ts
import ScenariosPanel from './components/ScenariosPanel';
```

Tab 类型改为：

```ts
type Tab = 'traffic' | 'rules' | 'redirects' | 'device' | 'settings';
```

删除 nav 按钮行：

```tsx
        <button data-testid="scenarios-tab" className={tab === 'scenarios' ? 'active' : ''} onClick={() => setTab('scenarios')}>场景</button>
```

删除渲染行：

```tsx
        {tab === 'scenarios' && <ScenariosPanel />}
```

- [ ] **Step 2: 删除 ScenariosPanel**

```bash
git rm src/renderer/src/components/ScenariosPanel.tsx
```

- [ ] **Step 3: typecheck + 全部单测**

Run: `npm run typecheck && npm test`
Expected: typecheck 干净（旧签名错误随文件删除消失）；单测全过（372）。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "feat(ui): drop standalone scenarios tab; scenarios now live inside rules/redirects panels"
```

---

### Task 9: E2E 重写与适配

**Files:**
- Rewrite: `e2e/scenarios.spec.ts`

其余 spec（map-local/enhancements/sequence/traffic-ops/json-editor/capture-to-rule/query-rows/smoke）经 grep 确认无 scenarios tab / scenariosRemove 旧签名引用，无需改动。

- [ ] **Step 1: 重写 e2e/scenarios.spec.ts（整体替换）**

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
    for (const r of await window.api.rulesList()) if (r.name.startsWith('e2e-sc-')) await window.api.rulesRemove(r.id);
    for (const s of await window.api.scenariosList()) if (!s.builtin) await window.api.scenariosRemove(s.name, null);
  });
  await app.close();
});

const proxyPort = async () => {
  return win.evaluate(async () => {
    if (!(await window.api.proxyStatus()).running) await window.api.proxyStart();
    return (await window.api.proxyStatus()).port;
  });
};

test('scenario disabled suppresses its rules; ungrouped always effective', async () => {
  const port = await proxyPort();
  await win.evaluate(async () => {
    await window.api.scenariosAdd('e2e-sc');
    await window.api.rulesAdd({
      name: 'e2e-sc-off',
      enabled: true,
      scenario: 'e2e-sc',
      match: { urlType: 'exact', urlPattern: 'http://e2e.example.test/sc-off', method: 'ANY' },
      action: { status: 200, headers: {}, body: 'OFF-RULE' },
    });
    await window.api.rulesAdd({
      name: 'e2e-sc-on',
      enabled: true,
      scenario: undefined,
      match: { urlType: 'exact', urlPattern: 'http://e2e.example.test/sc-on', method: 'ANY' },
      action: { status: 200, headers: {}, body: 'ON-RULE' },
    });
  });

  const agent = new ProxyAgent(`http://127.0.0.1:${port}`);
  try {
    const r1 = await fetch('http://e2e.example.test/sc-off', { dispatcher: agent });
    expect(await r1.text()).toBe('OFF-RULE');
    const r2 = await fetch('http://e2e.example.test/sc-on', { dispatcher: agent });
    expect(await r2.text()).toBe('ON-RULE');
  } finally {
    await agent.close();
  }

  await win.evaluate(async () => { await window.api.scenariosSetEnabled('e2e-sc', false); });
  const agent2 = new ProxyAgent(`http://127.0.0.1:${port}`);
  try {
    const r3 = await fetch('http://e2e.example.test/sc-on', { dispatcher: agent2 });
    expect(await r3.text()).toBe('ON-RULE');
    const r4 = await fetch('http://e2e.example.test/sc-off', { dispatcher: agent2 });
    expect(r4.status).not.toBe(200);
  } finally {
    await agent2.close();
  }
  await win.evaluate(async () => { await window.api.scenariosSetEnabled('e2e-sc', true); });
});

test('rules page groups by scenario; builtin group has no rename/delete', async () => {
  await win.locator('nav.tabs').getByRole('button', { name: '规则', exact: true }).click();
  await expect(win.locator('[data-testid="group-默认"]')).toBeVisible();
  const defaultHead = win.locator('[data-testid="group-默认-head"]');
  await expect(defaultHead.getByTestId('group-默认-rename')).toHaveCount(0);
  await expect(defaultHead.getByTestId('group-默认-delete')).toHaveCount(0);
  await expect(defaultHead.getByTestId('group-默认-toggle')).toBeVisible();
});

test('per-group create presets the scenario field', async () => {
  await win.locator('[data-testid="group-e2e-sc-create"]').click();
  const modal = win.locator('.modal');
  await expect(modal).toBeVisible();
  await expect(win.getByTestId('scenario-field')).toHaveValue('e2e-sc');
  await modal.getByRole('button', { name: '取消', exact: true }).click();
  await expect(win.locator('.modal')).toHaveCount(0);
});

test('group toggle switch suppresses the group (UI path)', async () => {
  await win.locator('nav.tabs').getByRole('button', { name: '规则', exact: true }).click();
  const head = win.locator('[data-testid="group-e2e-sc-head"]');
  await head.getByTestId('group-e2e-sc-toggle').uncheck();
  const port = await proxyPort();
  const agent = new ProxyAgent(`http://127.0.0.1:${port}`);
  try {
    const r = await fetch('http://e2e.example.test/sc-off', { dispatcher: agent });
    expect(r.status).not.toBe(200);
  } finally {
    await agent.close();
  }
  await head.getByTestId('group-e2e-sc-toggle').check();
});

test('inline rename cascades to rules', async () => {
  await win.locator('nav.tabs').getByRole('button', { name: '规则', exact: true }).click();
  const head = win.locator('[data-testid="group-e2e-sc-head"]');
  await head.getByTestId('group-e2e-sc-rename').click();
  await head.getByTestId('group-e2e-sc-rename-input').fill('e2e-sc-renamed');
  await head.getByTestId('group-e2e-sc-rename-input').press('Enter');
  await expect(win.locator('[data-testid="group-e2e-sc-renamed"]')).toBeVisible();
  const scenario = await win.evaluate(async () =>
    (await window.api.rulesList()).find((r) => r.name === 'e2e-sc-off')?.scenario,
  );
  expect(scenario).toBe('e2e-sc-renamed');
  // 改回，供后续用例与清理使用
  const head2 = win.locator('[data-testid="group-e2e-sc-renamed-head"]');
  await head2.getByTestId('group-e2e-sc-renamed-rename').click();
  await head2.getByTestId('group-e2e-sc-renamed-rename-input').fill('e2e-sc');
  await head2.getByTestId('group-e2e-sc-renamed-rename-input').press('Enter');
  await expect(win.locator('[data-testid="group-e2e-sc"]')).toBeVisible();
});

test('move-to select re-assigns a rule to another scenario', async () => {
  await win.locator('nav.tabs').getByRole('button', { name: '规则', exact: true }).click();
  await win.evaluate(async () => {
    await window.api.rulesAdd({
      name: 'e2e-sc-move',
      enabled: true,
      scenario: undefined,
      match: { urlType: 'exact', urlPattern: 'http://e2e.example.test/sc-move', method: 'ANY' },
      action: { status: 200, headers: {}, body: 'MOVE-RULE' },
    });
  });
  await win.locator('nav.tabs').getByRole('button', { name: '规则', exact: true }).click();
  const row = win.locator('[data-testid="group-ungrouped"] tr', { hasText: 'e2e-sc-move' });
  await row.getByTestId('move-e2e-sc-move').selectOption('e2e-sc');
  await expect(win.locator('[data-testid="group-e2e-sc"] tr', { hasText: 'e2e-sc-move' })).toBeVisible();
  const scenario = await win.evaluate(async () =>
    (await window.api.rulesList()).find((r) => r.name === 'e2e-sc-move')?.scenario,
  );
  expect(scenario).toBe('e2e-sc');
});

test('delete scenario transfers entries to chosen target', async () => {
  await win.evaluate(async () => { await window.api.scenariosAdd('e2e-sc-doomed'); });
  await win.evaluate(async () => {
    await window.api.rulesAdd({
      name: 'e2e-sc-doomed-rule',
      enabled: true,
      scenario: 'e2e-sc-doomed',
      match: { urlType: 'exact', urlPattern: 'http://e2e.example.test/sc-doomed', method: 'ANY' },
      action: { status: 200, headers: {}, body: 'DOOMED' },
    });
  });
  await win.locator('nav.tabs').getByRole('button', { name: '规则', exact: true }).click();
  const head = win.locator('[data-testid="group-e2e-sc-doomed-head"]');
  await head.getByTestId('group-e2e-sc-doomed-delete').click();
  await head.getByTestId('group-e2e-sc-doomed-move-to').selectOption('默认');
  await head.getByTestId('group-e2e-sc-doomed-confirm-delete').click();
  await expect(win.locator('[data-testid="group-e2e-sc-doomed"]')).toHaveCount(0);
  await expect(win.locator('[data-testid="group-默认"] tr', { hasText: 'e2e-sc-doomed-rule' })).toBeVisible();
  const scenario = await win.evaluate(async () =>
    (await window.api.rulesList()).find((r) => r.name === 'e2e-sc-doomed-rule')?.scenario,
  );
  expect(scenario).toBe('默认');
});

test('drag scenario head onto another to reorder (persisted)', async () => {
  await win.evaluate(async () => { await window.api.scenariosAdd('e2e-drag'); });
  await win.locator('nav.tabs').getByRole('button', { name: '规则', exact: true }).click();
  const dataTransfer = await win.evaluateHandle(() => new DataTransfer());
  await win.locator('[data-testid="group-e2e-drag"] .drag-handle').dispatchEvent('dragstart', { dataTransfer });
  await win.locator('[data-testid="group-默认-head"]').dispatchEvent('dragover', { dataTransfer });
  await win.locator('[data-testid="group-默认-head"]').dispatchEvent('drop', { dataTransfer });
  const names = await win.evaluate(async () => (await window.api.scenariosList()).map((s) => s.name));
  expect(names.indexOf('e2e-drag')).toBeLessThan(names.indexOf('默认'));
});

test('drag a rule row onto a scenario group to re-assign (persisted)', async () => {
  await win.locator('nav.tabs').getByRole('button', { name: '规则', exact: true }).click();
  const dataTransfer = await win.evaluateHandle(() => new DataTransfer());
  const row = win.locator('[data-testid="group-ungrouped"] tr', { hasText: 'e2e-sc-on' });
  await row.dispatchEvent('dragstart', { dataTransfer });
  await win.locator('[data-testid="group-默认-head"]').dispatchEvent('dragover', { dataTransfer });
  await win.locator('[data-testid="group-默认-head"]').dispatchEvent('drop', { dataTransfer });
  const scenario = await win.evaluate(async () =>
    (await window.api.rulesList()).find((r) => r.name === 'e2e-sc-on')?.scenario,
  );
  expect(scenario).toBe('默认');
});
```

注意：`e2e-sc-on` 是首个用例创建的未分组规则；拖拽用例把它移入默认组。用例间有状态依赖，`workers: 1`（playwright.config.ts 已配）保证顺序执行。

- [ ] **Step 2: 构建 + 运行全量 E2E（8888/8899 需空闲；被占先请用户退出 mocker）**

```bash
lsof -nP -iTCP:8888 -iTCP:8899 -sTCP:LISTEN   # 期望无输出
npm run test:e2e
```

Expected: 全部 PASS（旧 30 条中 scenarios.spec 1 条被替换为 8 条 → 约 37 条；若「场景」tab 断言存在于其他 spec 会在此暴露——grep 已确认没有）。

- [ ] **Step 3: 修复发现的回归（如有）后 Commit**

```bash
git add e2e/scenarios.spec.ts
git commit -m "test(e2e): scenario embedded flows — groups, toggle, rename, delete-with-move, dnd"
```

---

### Task 10: README + 全量验证

**Files:**
- Modify: `README.md`（场景章节重写 + 功能列表更新）

- [ ] **Step 1: 更新 README**

用 Grep 定位 `场景` 关键字所在章节，替换为：

```markdown
## 场景（规则/重定向分组）

- 场景内嵌在「规则」「重定向」页中，按场景分组展示：组头含拖拽把手⠿、组开关、条目数；非默认组可重命名、删除
- 「默认」为内置场景：不可删除、不可改名，可开关；缺失时启动自动补种
- 「未分组」置顶展示未挂场景的条目，不受任何组开关控制（永远生效），不渲染时不可作为拖拽目标
- 组开关关闭 → 组内全部条目失效；组内「+ 新建规则 / + 新建重定向」自动预挂本场景
- 拖拽：组头⠿拖到另一组上换序（持久化）；规则/重定向行拖到目标组改挂场景；每行「移动到…」下拉等效
- 删除场景需选择条目去向（其他场景或未分组），一次持久化完成
- 命中语义：重定向先于一切 Mock；Mock 跨场景全局按优先级取第一个命中，场景只影响整组有效性
- 存储：`<userData>/scenarios.json`（含 builtin 标记与顺序）
```

若功能列表（Features）里有「场景」独立小节/链接，同步改为指向上述章节。

- [ ] **Step 2: 全量验证**

```bash
npm run typecheck && npm test && npm run build && npx playwright test
```

Expected: typecheck 无输出；vitest 全过；E2E 全过（约 37 条）。

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: scenario embedded redesign usage (groups, builtin default, dnd, hit order)"
```

---

## 任务依赖

S1 → S2 → S3 串行（契约→存储→IPC）；S4 独立可并行；S5 依赖 S4（DragPayload/DND_MIME）；S6/S7 依赖 S5；S8 依赖 S6/S7；S9 依赖 S3–S8；S10 收尾。
