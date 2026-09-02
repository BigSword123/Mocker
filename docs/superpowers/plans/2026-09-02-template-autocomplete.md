# 模板编辑器代码补全 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 规则编辑弹窗的响应体升级为 CodeMirror 6 编辑器，输入 `{{` 弹出 VSCode 风格补全，候选覆盖内置变量、req.* 字段与 Faker 全量方法（运行时枚举，约 260+ 条）。

**Architecture:** 主进程新增 `catalog.ts` 从已安装的 faker 实例枚举全量 `模块.方法` 并合并静态内置/req 清单，经新 IPC 通道 `template:catalog` 提供给渲染层；渲染层新组件 `TemplateEditor.tsx` 封装 CodeMirror（JSON 高亮 + 自定义补全源 + 深色主题），`RuleEditorModal.tsx` 用它替换响应体 textarea，速查按钮改为光标处插入。静态清单放 `src/shared/template-catalog-data.ts` 供主进程与渲染层降级路径共用（DRY）。

**Tech Stack:** CodeMirror 6（`codemirror`、`@codemirror/state`、`@codemirror/view`、`@codemirror/autocomplete`、`@codemirror/lang-json`）、Electron IPC、React、vitest、playwright。

**设计文档:** `docs/superpowers/specs/2026-09-02-template-autocomplete-design.md`

**已核实事实（实现者直接使用，不必重新验证）:**
- `@faker-js/faker@10.6.0`：`Object.keys(faker)` 得 28 个模块，模块内 `typeof === 'function'` 的方法共 262 个；`faker.person` 内有非函数的 `faker` 反向引用属性（用 typeof 过滤即可排除）。
- v10 方法名是 `internet.username`（无 `internet.userName`）。
- `FAKER_BLOCKLIST`（helpers.fake）与 `DANGEROUS_KEYS`（__proto__/constructor/prototype）目前是 `src/main/rules/template.ts` 的模块私有常量，Task 1 会导出它们。
- vitest 环境是 `node`（无 jsdom），渲染层组件不写单测，由 E2E 覆盖。
- `e2e/enhancements.spec.ts` 现有两个用例用 `textarea[placeholder='{"code":0}']` 定位响应体，Task 5 必须同步改为 `.cm-content`。
- CodeMirror basicSetup 自带 closeBrackets：输入 `{{` 自动补 `}}` 且光标居中；继续输入 `}` 时自动跳过已存在的 `}`（skip-over），不会产生重复括号。

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 修改 | `src/shared/types.ts` | 新增 `TemplateCatalogItem` 类型 |
| 新建 | `src/shared/template-catalog-data.ts` | 静态清单：内置变量、req 字段、faker 中文注释表（主进程与渲染层共用） |
| 修改 | `src/main/rules/template.ts` | 导出 `FAKER_BLOCKLIST`、`DANGEROUS_KEYS` |
| 新建 | `src/main/rules/catalog.ts` | `buildCatalog()`：faker 运行时枚举 + 静态清单合并 + 模块级缓存 |
| 新建 | `tests/catalog.test.ts` | catalog 单测 |
| 修改 | `src/main/ipc.ts` | `template:catalog` handler |
| 修改 | `src/shared/api.ts` | Api 接口加 `templateCatalog()` |
| 修改 | `src/preload/index.ts` | 暴露 `templateCatalog` |
| 新建 | `src/renderer/src/lib/catalog.ts` | 渲染层 catalog 拉取 + 缓存 + 降级清单 |
| 新建 | `src/renderer/src/components/TemplateEditor.tsx` | CodeMirror 封装组件 |
| 修改 | `src/renderer/src/components/RuleEditorModal.tsx` | 替换 textarea、接 catalog、速查改光标插入 |
| 修改 | `src/renderer/src/styles.css` | 编辑器容器样式 |
| 修改 | `e2e/enhancements.spec.ts` | 更新响应体选择器 + 新增补全用例 |
| 修改 | `docs/guide-enhancements.md` | 补全功能使用说明 |

---

### Task 1: catalog 数据源（shared + main，TDD）

**Files:**
- Modify: `src/shared/types.ts`
- Create: `src/shared/template-catalog-data.ts`
- Modify: `src/main/rules/template.ts`（第 24-25 行附近加 `export`）
- Create: `src/main/rules/catalog.ts`
- Test: `tests/catalog.test.ts`

- [ ] **Step 1: shared/types.ts 追加类型**

在文件末尾（`RenderContext` 定义之后）追加：

```ts
export interface TemplateCatalogItem {
  /** 完整 token，如 faker.person.firstName、req.query. */
  token: string;
  /** 补全列表展示名 */
  label: string;
  /** 说明文本：中文含义、参数写法、示例输出 */
  detail: string;
}
```

- [ ] **Step 2: 新建 src/shared/template-catalog-data.ts**

```ts
import type { TemplateCatalogItem } from './types';

export const BUILTIN_CATALOG_ITEMS: TemplateCatalogItem[] = [
  { token: 'now', label: 'now', detail: '当前时间；{{now}} / {{now:iso}} / {{now:ms}} / {{now:YYYY-MM-DD HH:mm}}' },
  { token: 'uuid', label: 'uuid', detail: 'UUID v4，如 11111111-2222-4333-8444-555555555555' },
  { token: 'random.int', label: 'random.int', detail: '随机整数；{{random.int:1:100}}（min:max）' },
  { token: 'random.float', label: 'random.float', detail: '随机浮点；{{random.float:0:1:2}}（min:max:小数位）' },
  { token: 'random.choice', label: 'random.choice', detail: '随机枚举；{{random.choice:OK:WARN:ERR}}' },
  { token: 'random.string', label: 'random.string', detail: '随机字母串；{{random.string:16}}（长度）' },
];

export const REQ_CATALOG_ITEMS: TemplateCatalogItem[] = [
  { token: 'req.method', label: 'req.method', detail: '请求方法，如 POST' },
  { token: 'req.url', label: 'req.url', detail: '完整 URL' },
  { token: 'req.host', label: 'req.host', detail: '主机名，如 api.example.com' },
  { token: 'req.path', label: 'req.path', detail: '路径，如 /users' },
  { token: 'req.query.', label: 'req.query.<name>', detail: 'query 参数；替换为实际键，如 {{req.query.id}}' },
  { token: 'req.header.', label: 'req.header.<name>', detail: '请求头（键不区分大小写）；如 {{req.header.Authorization}}' },
  { token: 'req.body', label: 'req.body', detail: '原始请求体文本' },
  { token: 'req.body.json.', label: 'req.body.json.<path>', detail: '请求体 JSON 字段；如 {{req.body.json.userId}}' },
];

/** 常用 faker 方法的中文注释；键为 `模块.方法`（不带 faker. 前缀），方法名已对照 v10.6 核实 */
export const FAKER_NOTES: Record<string, string> = {
  'person.firstName': '名字',
  'person.lastName': '姓氏',
  'person.fullName': '全名',
  'person.jobTitle': '职位',
  'internet.email': '邮箱',
  'internet.username': '用户名',
  'internet.url': 'URL',
  'internet.ip': 'IPv4 地址',
  'phone.number': '电话号码',
  'location.city': '城市',
  'location.country': '国家',
  'location.streetAddress': '街道地址',
  'location.zipCode': '邮编',
  'location.latitude': '纬度',
  'location.longitude': '经度',
  'number.int': '整数；参数 :min:max',
  'number.float': '浮点数；参数 :min:max:小数位',
  'string.alphanumeric': '字母数字串；参数 :长度',
  'string.numeric': '数字串；参数 :长度',
  'string.alpha': '字母串；参数 :长度',
  'string.uuid': 'UUID',
  'date.recent': '最近日期',
  'date.future': '未来日期',
  'date.past': '过去日期',
  'date.anytime': '任意时间（ISO）',
  'company.name': '公司名',
  'commerce.productName': '商品名',
  'commerce.price': '价格',
  'lorem.word': '假词',
  'lorem.sentence': '假句',
  'lorem.paragraph': '假段落',
  'image.url': '随机图片 URL',
  'database.mongodbObjectId': 'MongoDB ObjectId',
};
```

- [ ] **Step 3: template.ts 导出过滤常量**

把 `src/main/rules/template.ts` 中这两行：

```ts
const FAKER_BLOCKLIST = new Set(['helpers.fake']);
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
```

改为：

```ts
export const FAKER_BLOCKLIST = new Set(['helpers.fake']);
export const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
```

- [ ] **Step 4: 写失败测试 tests/catalog.test.ts**

```ts
import { describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/main/rules/catalog';

describe('buildCatalog', () => {
  const catalog = buildCatalog();
  const tokens = new Set(catalog.map((i) => i.token));

  it('includes all builtin tokens', () => {
    for (const t of ['now', 'uuid', 'random.int', 'random.float', 'random.choice', 'random.string']) {
      expect(tokens.has(t), `missing ${t}`).toBe(true);
    }
  });

  it('includes req tokens', () => {
    expect(tokens.has('req.method')).toBe(true);
    expect(tokens.has('req.host')).toBe(true);
    expect(tokens.has('req.query.')).toBe(true);
    expect(tokens.has('req.body.json.')).toBe(true);
  });

  it('enumerates the full faker catalog', () => {
    expect(tokens.has('faker.person.firstName')).toBe(true);
    expect(tokens.has('faker.internet.email')).toBe(true);
    const fakerCount = catalog.filter((i) => i.token.startsWith('faker.')).length;
    expect(fakerCount).toBeGreaterThan(200);
  });

  it('excludes blocklisted and dangerous entries', () => {
    expect(tokens.has('faker.helpers.fake')).toBe(false);
    const dangerous = ['__proto__', 'constructor', 'prototype'];
    for (const item of catalog) {
      for (const seg of item.token.split('.')) {
        expect(dangerous).not.toContain(seg);
      }
    }
  });

  it('annotates curated faker methods with notes', () => {
    const first = catalog.find((i) => i.token === 'faker.person.firstName');
    expect(first?.detail).toBe('名字');
  });

  it('gives every item non-empty label and detail', () => {
    for (const item of catalog) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.detail.length).toBeGreaterThan(0);
    }
  });

  it('caches the result across calls', () => {
    expect(buildCatalog()).toBe(catalog);
  });
});
```

- [ ] **Step 5: 跑测试确认失败**

Run: `npx vitest run tests/catalog.test.ts`
Expected: FAIL —「Cannot find module '../src/main/rules/catalog'」

- [ ] **Step 6: 实现 src/main/rules/catalog.ts**

```ts
import { faker as fakerEn } from '@faker-js/faker';
import type { TemplateCatalogItem } from '../../shared/types';
import {
  BUILTIN_CATALOG_ITEMS,
  FAKER_NOTES,
  REQ_CATALOG_ITEMS,
} from '../../shared/template-catalog-data';
import { DANGEROUS_KEYS, FAKER_BLOCKLIST } from './template';

// 各 locale 的 faker 实例方法路径一致，枚举 en 实例一次即可
function enumerateFakerMethods(): TemplateCatalogItem[] {
  const items: TemplateCatalogItem[] = [];
  const root = fakerEn as unknown as Record<string, unknown>;
  for (const moduleKey of Object.keys(root)) {
    if (DANGEROUS_KEYS.has(moduleKey)) continue;
    const mod = root[moduleKey];
    if (!mod || typeof mod !== 'object') continue;
    const methods = mod as Record<string, unknown>;
    for (const methodKey of Object.keys(methods)) {
      if (DANGEROUS_KEYS.has(methodKey)) continue;
      if (typeof methods[methodKey] !== 'function') continue;
      const path = `${moduleKey}.${methodKey}`;
      if (FAKER_BLOCKLIST.has(path)) continue;
      items.push({
        token: `faker.${path}`,
        label: `faker.${path}`,
        detail: FAKER_NOTES[path] ?? path,
      });
    }
  }
  return items;
}

let cached: TemplateCatalogItem[] | undefined;

export function buildCatalog(): TemplateCatalogItem[] {
  if (!cached) {
    cached = [...BUILTIN_CATALOG_ITEMS, ...REQ_CATALOG_ITEMS, ...enumerateFakerMethods()];
  }
  return cached;
}
```

- [ ] **Step 7: 跑测试确认通过**

Run: `npx vitest run tests/catalog.test.ts`
Expected: PASS（7 个用例）

- [ ] **Step 8: 全量验证并提交**

Run: `npm run typecheck && npm test`
Expected: typecheck 无错误；122 个测试全过（115 既有 + 7 新增）

```bash
git add src/shared/types.ts src/shared/template-catalog-data.ts src/main/rules/template.ts src/main/rules/catalog.ts tests/catalog.test.ts
git commit -m "feat(rules): build template catalog from faker runtime enumeration"
```

---

### Task 2: IPC 通道 template:catalog

**Files:**
- Modify: `src/main/ipc.ts`（`template:preview` handler 之后）
- Modify: `src/shared/api.ts`
- Modify: `src/preload/index.ts`

- [ ] **Step 1: main/ipc.ts 加 handler**

顶部 import 追加：

```ts
import { buildCatalog } from './rules/catalog';
```

在 `ipcMain.handle('template:preview', ...)` 之后追加：

```ts
  ipcMain.handle('template:catalog', () => buildCatalog());
```

- [ ] **Step 2: shared/api.ts 加接口**

import 行的类型列表加 `TemplateCatalogItem`：

```ts
import type { CertInfo, CertInstallCommands, MockRule, ProxyStatus, RenderContext, RuleAction, RuleInput, RulePatch, Settings, TemplateCatalogItem } from './types';
```

`Api` 接口中 `templatePreview` 之后加：

```ts
  templateCatalog(): Promise<TemplateCatalogItem[]>;
```

- [ ] **Step 3: preload/index.ts 加桥接**

在 `templatePreview` 条目之后加：

```ts
  templateCatalog: () => ipcRenderer.invoke('template:catalog'),
```

- [ ] **Step 4: 验证并提交**

Run: `npm run typecheck && npm test`
Expected: 全部通过（本任务无新测试，接线由 Task 5 E2E 覆盖）

```bash
git add src/main/ipc.ts src/shared/api.ts src/preload/index.ts
git commit -m "feat(ipc): expose template catalog channel"
```

---

### Task 3: 安装 CodeMirror 并实现 TemplateEditor 组件

**Files:**
- Create: `src/renderer/src/components/TemplateEditor.tsx`

- [ ] **Step 1: 安装依赖**

```bash
npm install codemirror @codemirror/state @codemirror/view @codemirror/autocomplete @codemirror/lang-json
```

Expected: package.json dependencies 新增 5 项，安装无报错。

- [ ] **Step 2: 新建 TemplateEditor.tsx（完整代码）**

```tsx
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { EditorView, placeholder as cmPlaceholder } from '@codemirror/view';
import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { json } from '@codemirror/lang-json';
import type { TemplateCatalogItem } from '../../../shared/types';

export interface TemplateEditorHandle {
  insertAtCursor(text: string): void;
}

interface Props {
  value: string;
  onChange: (next: string) => void;
  catalog: TemplateCatalogItem[];
  placeholder?: string;
}

/** 仅在 {{ 与 }} 之间提供模板补全；其余位置返回 null 不弹窗 */
function templateCompletion(
  context: CompletionContext,
  catalog: TemplateCatalogItem[],
): CompletionResult | null {
  if (catalog.length === 0) return null;
  const pos = context.pos;
  const line = context.state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  const open = before.lastIndexOf('{{');
  if (open === -1) return null;
  const typed = before.slice(open + 2);
  if (typed.includes('}}')) return null;
  return {
    from: line.from + open + 2,
    options: catalog.map((item) => ({
      label: item.label,
      detail: item.detail,
      apply: item.token,
      type: 'variable',
    })),
  };
}

const editorTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: '#26272e',
      color: '#e2e2e8',
      border: '1px solid #4a4b55',
      borderRadius: '6px',
      fontSize: '13px',
      height: '180px',
    },
    '&.cm-focused': { outline: 'none', borderColor: '#3b6ef6' },
    '.cm-scroller': {
      overflow: 'auto',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      lineHeight: '1.5',
    },
    '.cm-tooltip': {
      backgroundColor: '#26272e',
      border: '1px solid #4a4b55',
      borderRadius: '6px',
      color: '#e2e2e8',
    },
    '.cm-tooltip-autocomplete ul li[aria-selected]': {
      backgroundColor: '#3b6ef6',
      color: '#fff',
    },
    '.cm-tooltip-autocomplete ul li .cm-completionDetail': {
      color: '#8a8b96',
      marginLeft: '12px',
      fontStyle: 'normal',
    },
  },
  { dark: true },
);

const TemplateEditor = forwardRef<TemplateEditorHandle, Props>(function TemplateEditor(
  { value, onChange, catalog, placeholder },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const catalogRef = useRef(catalog);

  // 编辑器只创建一次；catalog / onChange 通过 ref 读最新值，避免重建
  useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        json(),
        editorTheme,
        cmPlaceholder(placeholder ?? ''),
        autocompletion({
          override: [(ctx) => templateCompletion(ctx, catalogRef.current)],
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 受控同步：外部 value 与文档不一致时重设（如速查按钮走父级 state 的场景）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (value !== current) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    catalogRef.current = catalog;
  }, [catalog]);

  useImperativeHandle(ref, () => ({
    insertAtCursor(text: string) {
      const view = viewRef.current;
      if (!view) return;
      const pos = view.state.selection.main.head;
      view.dispatch({
        changes: { from: pos, to: pos, insert: text },
        selection: { anchor: pos + text.length },
      });
      view.focus();
    },
  }));

  return <div className="template-editor" ref={hostRef} />;
});

export default TemplateEditor;
```

- [ ] **Step 3: typecheck**

Run: `npm run typecheck`
Expected: 通过（组件此时尚未被引用，仅验证类型与导入正确）

- [ ] **Step 4: 提交**

```bash
git add package.json package-lock.json src/renderer/src/components/TemplateEditor.tsx
git commit -m "feat(ui): add CodeMirror-based template editor component"
```

---

### Task 4: RuleEditorModal 集成 + 渲染层 catalog 缓存

**Files:**
- Create: `src/renderer/src/lib/catalog.ts`
- Modify: `src/renderer/src/components/RuleEditorModal.tsx`
- Modify: `src/renderer/src/styles.css`

- [ ] **Step 1: 新建 src/renderer/src/lib/catalog.ts**

```ts
import type { TemplateCatalogItem } from '../../../shared/types';
import { BUILTIN_CATALOG_ITEMS, REQ_CATALOG_ITEMS } from '../../../shared/template-catalog-data';
import { api } from './api';

/** IPC 不可用时的降级目录：内置变量 + req 字段（与主进程静态清单同源） */
export const FALLBACK_CATALOG: TemplateCatalogItem[] = [
  ...BUILTIN_CATALOG_ITEMS,
  ...REQ_CATALOG_ITEMS,
];

let cache: TemplateCatalogItem[] | undefined;
let inflight: Promise<TemplateCatalogItem[]> | undefined;

export function getTemplateCatalog(): Promise<TemplateCatalogItem[]> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = api.templateCatalog().then(
      (items) => {
        cache = items;
        return items;
      },
      (err) => {
        inflight = undefined;
        throw err;
      },
    );
  }
  return inflight;
}
```

- [ ] **Step 2: RuleEditorModal.tsx 改动**

2a. import 区调整。第一行 react import 改为：

```tsx
import { useEffect, useRef, useState } from 'react';
```

shared/types 的 import 列表追加 `type TemplateCatalogItem`；再追加两条新 import：

```tsx
import TemplateEditor, { type TemplateEditorHandle } from './TemplateEditor';
import { FALLBACK_CATALOG, getTemplateCatalog } from '../lib/catalog';
```

2b. state 块（`const [previewWarnings, ...]` 之后）追加：

```tsx
  const [catalog, setCatalog] = useState<TemplateCatalogItem[]>(FALLBACK_CATALOG);
  const editorRef = useRef<TemplateEditorHandle>(null);
```

2c. state 块之后、`buildAction` 之前追加挂载时拉取 catalog 的 effect：

```tsx
  useEffect(() => {
    let cancelled = false;
    getTemplateCatalog()
      .then((items) => {
        if (!cancelled) setCatalog(items);
      })
      .catch(() => {
        if (!cancelled) setError('模板目录加载失败，仅内置变量可用');
      });
    return () => {
      cancelled = true;
    };
  }, []);
```

2d. `insertSnippet` 由追加到末尾改为光标处插入：

```tsx
  const insertSnippet = (text: string) => editorRef.current?.insertAtCursor(text);
```

（原实现 `setBody((prev) => prev + text)` 删除。）

2e. 基础区块中响应体一行：

```tsx
          <label>响应体</label>
          <textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} placeholder='{"code":0}' />
```

替换为：

```tsx
          <label>响应体</label>
          <TemplateEditor
            ref={editorRef}
            value={body}
            onChange={setBody}
            catalog={catalog}
            placeholder='{"code":0}'
          />
```

- [ ] **Step 3: styles.css 追加**

```css
.template-editor { width: 100%; }
```

- [ ] **Step 4: 验证**

Run: `npm run typecheck && npm test`
Expected: 全部通过（既有 115+7=122 个单测不回归；组件行为由 Task 5 E2E 验证）

- [ ] **Step 5: 提交**

```bash
git add src/renderer/src/lib/catalog.ts src/renderer/src/components/RuleEditorModal.tsx src/renderer/src/styles.css
git commit -m "feat(ui): integrate template editor with catalog into rule modal"
```

---

### Task 5: E2E 更新与补全用例

**Files:**
- Modify: `e2e/enhancements.spec.ts`

> 注意：跑 e2e 前确认 8888/8899 端口空闲（`lsof -nP -iTCP:8888 -iTCP:8899 -sTCP:LISTEN`）；若用户本机 mocker 在运行需先退出。`npm run test:e2e` 会先自动 build。

- [ ] **Step 1: 更新既有两个用例的响应体定位**

「snippet button inserts {{uuid}}」用例整体替换为：

```ts
test('snippet button inserts {{uuid}} into response body', async () => {
  await openNewRuleModal();
  const editor = win.locator('.modal .cm-content');
  await expect(editor).toBeVisible();
  await win.getByRole('button', { name: '+uuid', exact: true }).click();
  await expect(editor).toContainText('{{uuid}}');
  await closeRuleModal();
});
```

「template preview renders」用例整体替换为（closeBrackets 会对输入的 `}` 自动 skip-over，最终文本恰为 `host={{req.host}}`）：

```ts
test('template preview renders {{req.host}} from example context', async () => {
  await openNewRuleModal();
  const editor = win.locator('.modal .cm-content');
  await editor.click();
  await win.keyboard.type('host={{req.host}}');
  await expect(editor).toContainText('host={{req.host}}');
  await win.getByRole('button', { name: '刷新预览', exact: true }).click();
  await expect(win.locator('pre.preview')).toContainText('host=example.test');
  await closeRuleModal();
});
```

- [ ] **Step 2: 新增补全弹窗用例**

追加到文件末尾：

```ts
test('typing {{ opens autocomplete and Enter inserts {{uuid}}', async () => {
  await openNewRuleModal();
  const editor = win.locator('.modal .cm-content');
  await editor.click();
  await win.keyboard.type('{{');
  await expect(win.locator('.cm-tooltip-autocomplete')).toBeVisible();
  await win.keyboard.type('uuid');
  await win.keyboard.press('Enter');
  await expect(editor).toContainText('{{uuid}}');
  await closeRuleModal();
});
```

- [ ] **Step 3: 跑 E2E**

Run: `npm run test:e2e`
Expected: 7 passed（smoke 1 + enhancements 6），0 failed。

若补全弹窗断言超时：检查弹窗是否被 modal 的 overflow 裁剪（`.cm-tooltip` 应可见）；若 Enter 插入了错误候选，检查过滤是否生效（输入 uuid 后列表应只剩少数项）。

- [ ] **Step 4: 提交**

```bash
git add e2e/enhancements.spec.ts
git commit -m "test(e2e): cover template autocomplete popup and editor migration"
```

---

### Task 6: 文档更新

**Files:**
- Modify: `docs/guide-enhancements.md`

- [ ] **Step 1: 「2. 动态数据（模板）」小节末尾追加**

在「编辑规则时可用「变量速查」按钮快速插入占位符……」段落之后追加：

```markdown
### 代码补全

响应体是代码编辑器（JSON 高亮）：输入 `{{` 会弹出全量模板变量补全列表——内置变量、`req.*` 字段和 Faker 全部方法（约 260+，从安装的 faker 版本实时枚举）。继续输入可模糊过滤（如 `faker.per` 过滤出 person 模块），↑↓ 选择、Tab/回车插入、Esc 关闭；常用方法带中文说明，带参方法在说明里给出参数写法。「变量速查」按钮在光标处插入。
```

并把原段落中「点「刷新预览」查看渲染结果」保留不动。

- [ ] **Step 2: 提交**

```bash
git add docs/guide-enhancements.md
git commit -m "docs: describe template autocomplete in user guide"
```

---

## 自检

1. **Spec 覆盖**：
   - catalog 数据源（faker 枚举 + 静态清单 + 缓存）✅ Task 1
   - IPC `template:catalog` 四层接线 ✅ Task 2
   - TemplateEditor（JSON 高亮/深色主题/补全弹窗/closeBrackets/insertAtCursor）✅ Task 3
   - RuleEditorModal 集成（替换 textarea、catalog 缓存与降级、速查改光标插入、失败提示）✅ Task 4
   - E2E（补全弹窗、既有用例迁移）✅ Task 5
   - 用户指南 ✅ Task 6
   - 响应头不接编辑器 ✅（未列入任何任务，维持现状）
2. **占位符扫描**：所有代码步骤均为完整可粘贴代码；无 TBD/TODO。
3. **类型一致性**：`TemplateCatalogItem`（Task 1 定义，Task 2/3/4 引用同名）；`buildCatalog()`（Task 1 定义，Task 2 调用）；`templateCatalog()`（Task 2 定义，Task 4 调用）；`TemplateEditorHandle.insertAtCursor`（Task 3 定义，Task 4 调用）；`FALLBACK_CATALOG`/`getTemplateCatalog`（Task 4 内定义并使用）。
4. **与规格偏差（已知且接受）**：设计文档 §4.1 写编辑器「约 8 行，可拉伸」，实现为固定 180px 高 + 内部滚动（CodeMirror 容器 resize 联动不可靠，固定高度更稳）。
