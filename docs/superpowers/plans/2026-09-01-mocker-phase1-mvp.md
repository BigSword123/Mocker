# Mocker Phase 1 (MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付可用的 MVP：Electron 桌面应用，起 mockttp 代理抓包（HTTP/HTTPS），实时流量列表+详情，基础静态响应 Mock 规则，证书生成与设备接入引导，系统代理开关。

**Architecture:** Electron 主进程承载代理/规则/存储/证书/桥接（纯 Node 模块，可脱离 Electron 单测）；渲染进程为 React 面板，经 preload IPC 调控制面、经 WebSocket（端口 8899）收实时流量。代理采用单一主处理器（`forAnyRequest().always().thenHandle`）统一做引导页、白名单隧道、规则匹配与透传。

**Tech Stack:** Electron + electron-vite + React 18 + TypeScript + mockttp + node-forge + ws + zustand + @tanstack/react-virtual + qrcode.react + vitest + Playwright(E2E)

**Spec:** `docs/superpowers/specs/2026-09-01-mocker-design.md`（Phase 1 范围；Phase 2/3 另行出计划）

---

## 文件结构总览

```
package.json / electron.vite.config.ts / vitest.config.ts
tsconfig.node.json / tsconfig.web.json / .gitignore
src/shared/types.ts              全部共享类型与 IPC 契约
src/main/index.ts                主进程入口，装配所有模块
src/main/ipc.ts                  IPC handler 注册
src/main/certs/ca.ts             根 CA 生成/加载/续签
src/main/rules/matcher.ts        匹配引擎（纯函数）
src/main/rules/engine.ts         规则选择（纯函数）
src/main/storage/json-store.ts   原子 JSON 文件读写 + 损坏隔离
src/main/storage/rules-store.ts  规则 CRUD + 快照
src/main/storage/settings-store.ts
src/main/storage/history.ts      JSONL 会话历史
src/main/proxy/proxy-server.ts   mockttp 封装 + 流量采集
src/main/proxy/onboarding.ts     引导页 HTML + 证书下载响应
src/main/bridge/ws-server.ts     WebSocket 广播
src/main/system-proxy/macos.ts / windows.ts / index.ts
src/preload/index.ts             contextBridge
src/renderer/index.html / src/main.tsx / src/App.tsx / src/styles.css
src/renderer/src/lib/api.ts
src/renderer/src/stores/traffic.ts
src/renderer/src/components/{StatusBar,TrafficPanel,TrafficTable,TrafficDetail,RulesPanel,RuleEditorModal,DeviceGuide,SettingsPanel}.tsx
tests/*.test.ts                  vitest 单测/集成
e2e/smoke.spec.ts + playwright.config.ts
```

---

### Task 1: 项目脚手架

**Files:**
- Create: `package.json`, `.gitignore`, `electron.vite.config.ts`, `tsconfig.node.json`, `tsconfig.web.json`, `vitest.config.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/src/main.tsx`, `src/renderer/src/App.tsx`, `src/renderer/src/styles.css`

- [ ] **Step 1: 初始化 package.json 并安装依赖**

```bash
cd /Users/mabelkisskiss/personal/mocker
npm init -y
npm i mockttp node-forge ws zustand @tanstack/react-virtual qrcode.react react react-dom
npm i -D electron electron-vite vite @vitejs/plugin-react typescript vitest @types/node @types/react @types/react-dom playwright undici
```

然后编辑 `package.json`，设置顶层字段与 scripts（保留自动生成的 version/description）：

```json
{
  "name": "mocker",
  "main": "out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "typecheck": "tsc -p tsconfig.node.json --noEmit && tsc -p tsconfig.web.json --noEmit",
    "test": "vitest run",
    "test:e2e": "npm run build && playwright test"
  }
}
```

- [ ] **Step 2: .gitignore**

```
node_modules/
out/
dist/
*.log
.DS_Store
test-results/
playwright-report/
```

- [ ] **Step 3: electron.vite.config.ts**

```ts
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') },
    },
  },
  renderer: {
    plugins: [react()],
    root: 'src/renderer',
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
  },
});
```

- [ ] **Step 4: tsconfig.node.json 与 tsconfig.web.json**

`tsconfig.node.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/main/**/*", "src/preload/**/*", "src/shared/**/*", "tests/**/*", "electron.vite.config.ts", "vitest.config.ts"]
}
```

`tsconfig.web.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  },
  "include": ["src/renderer/**/*", "src/shared/**/*"]
}
```

- [ ] **Step 5: vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
});
```

- [ ] **Step 6: 最小入口文件**

`src/main/index.ts`（占位，Task 12 会重写）：

```ts
import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: { preload: join(__dirname, '../preload/index.js') },
  });
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(createWindow);
```

`src/preload/index.ts`（占位，Task 10 会重写）：

```ts
import { contextBridge } from 'electron';
contextBridge.exposeInMainWorld('api', { ping: () => 'pong' });
```

`src/renderer/index.html`：

```html
<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>Mocker</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`src/renderer/src/main.tsx`：

```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

`src/renderer/src/App.tsx`：

```tsx
export default function App() {
  return <div className="app">Mocker</div>;
}
```

`src/renderer/src/styles.css`：

```css
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, "Segoe UI", sans-serif; background: #1e1f24; color: #e2e2e8; font-size: 13px; }
button { cursor: pointer; }
```

- [ ] **Step 7: 验证**

Run: `npm run typecheck`
Expected: 无错误输出，退出码 0。

Run: `npm run dev`（手动）
Expected: 弹出 Electron 窗口，显示 "Mocker" 文字。验证后关闭窗口。

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json .gitignore electron.vite.config.ts tsconfig.node.json tsconfig.web.json vitest.config.ts src
git commit -m "chore: scaffold electron-vite + react + ts project"
```

---

### Task 2: 共享类型与 IPC 契约

**Files:**
- Create: `src/shared/types.ts`, `src/shared/api.ts`

- [ ] **Step 1: src/shared/types.ts**

```ts
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS' | 'ANY';
export type UrlPatternType = 'exact' | 'wildcard' | 'regex';

export interface RuleMatch {
  urlType: UrlPatternType;
  urlPattern: string;
  method: HttpMethod;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  bodyContains?: string;
}

export interface RuleAction {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface MockRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  match: RuleMatch;
  action: RuleAction;
}

export type RuleInput = Omit<MockRule, 'id' | 'priority'>;
export type RulePatch = Partial<Omit<MockRule, 'id' | 'priority'>>;

export interface TrafficEvent {
  id: string;
  startedAt: number;
  completedAt?: number;
  method: string;
  url: string;
  host: string;
  path: string;
  status?: number;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  mocked: boolean;
  matchedRuleId?: string;
  error?: string;
}

export type HttpsMode = 'whitelist' | 'full';

export interface Settings {
  proxyPort: number;
  wsPort: number;
  httpsMode: HttpsMode;
  whitelist: string[];
  autoStartProxy: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  proxyPort: 8888,
  wsPort: 8899,
  httpsMode: 'whitelist',
  whitelist: [],
  autoStartProxy: true,
};

export interface ProxyStatus {
  running: boolean;
  port: number;
  localIps: string[];
}

export interface CertInfo {
  expiresAt: number;
}
```

- [ ] **Step 2: src/shared/api.ts**

```ts
import type { CertInfo, MockRule, ProxyStatus, RuleInput, RulePatch, Settings } from './types';

export interface Api {
  proxyStart(): Promise<void>;
  proxyStop(): Promise<void>;
  proxyStatus(): Promise<ProxyStatus>;
  rulesList(): Promise<MockRule[]>;
  rulesAdd(input: RuleInput): Promise<MockRule>;
  rulesUpdate(id: string, patch: RulePatch): Promise<MockRule>;
  rulesRemove(id: string): Promise<void>;
  settingsGet(): Promise<Settings>;
  settingsSet(patch: Partial<Settings>): Promise<Settings>;
  certInfo(): Promise<CertInfo>;
  systemProxySet(enabled: boolean): Promise<void>;
  systemProxyStatus(): Promise<boolean>;
}

declare global {
  interface Window {
    api: Api;
  }
}
```

- [ ] **Step 3: 验证**

Run: `npm run typecheck`
Expected: 通过。

- [ ] **Step 4: Commit**

```bash
git add src/shared
git commit -m "feat: add shared types and IPC API contract"
```

---

### Task 3: 规则匹配引擎（TDD）

**Files:**
- Create: `src/main/rules/matcher.ts`, `tests/matcher.test.ts`

- [ ] **Step 1: 写失败测试 `tests/matcher.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { matchRule, type RequestDescription } from '../src/main/rules/matcher';
import type { RuleMatch } from '../src/shared/types';

function req(overrides: Partial<RequestDescription> = {}): RequestDescription {
  return {
    method: 'GET',
    url: 'http://api.example.com/users?page=2',
    query: new URL('http://api.example.com/users?page=2').searchParams,
    headers: { 'content-type': 'application/json', 'x-token': 'abc' },
    body: '',
    ...overrides,
  };
}

const base: RuleMatch = { urlType: 'exact', urlPattern: 'http://api.example.com/users?page=2', method: 'ANY' };

describe('matchRule', () => {
  it('matches exact url', () => {
    expect(matchRule(base, req())).toBe(true);
    expect(matchRule(base, req({ url: 'http://api.example.com/other' }))).toBe(false);
  });

  it('matches wildcard url (* and ?)', () => {
    const m: RuleMatch = { ...base, urlType: 'wildcard', urlPattern: 'http://api.example.com/*page=?' };
    expect(matchRule(m, req())).toBe(true);
    expect(matchRule({ ...m, urlPattern: 'http://other.com/*' }, req())).toBe(false);
  });

  it('matches regex url', () => {
    const m: RuleMatch = { ...base, urlType: 'regex', urlPattern: '^http://api\\.example\\.com/users.*$' };
    expect(matchRule(m, req())).toBe(true);
    expect(matchRule({ ...m, urlPattern: '[invalid' }, req())).toBe(false);
  });

  it('matches method with ANY support', () => {
    expect(matchRule({ ...base, method: 'GET' }, req())).toBe(true);
    expect(matchRule({ ...base, method: 'POST' }, req())).toBe(false);
    expect(matchRule({ ...base, method: 'ANY' }, req({ method: 'DELETE' }))).toBe(true);
  });

  it('matches all query entries', () => {
    const m: RuleMatch = { ...base, query: { page: '2' } };
    expect(matchRule(m, req())).toBe(true);
    expect(matchRule({ ...m, query: { page: '3' } }, req())).toBe(false);
  });

  it('matches headers case-insensitively by name', () => {
    const m: RuleMatch = { ...base, headers: { 'X-Token': 'abc' } };
    expect(matchRule(m, req())).toBe(true);
    expect(matchRule({ ...m, headers: { 'X-Token': 'zzz' } }, req())).toBe(false);
  });

  it('matches body substring', () => {
    const m: RuleMatch = { ...base, bodyContains: '"id":1' };
    expect(matchRule(m, req({ body: '{"id":1,"x":2}' }))).toBe(true);
    expect(matchRule(m, req({ body: '{}' }))).toBe(false);
  });

  it('combines conditions with AND', () => {
    const m: RuleMatch = { ...base, method: 'GET', query: { page: '2' }, bodyContains: 'nomatch' };
    expect(matchRule(m, req())).toBe(false);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/matcher.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/main/rules/matcher.ts`**

```ts
import type { RuleMatch } from '../../shared/types';

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
    matchBody(match.bodyContains, req.body)
  );
}

function matchUrl(match: RuleMatch, url: string): boolean {
  switch (match.urlType) {
    case 'exact':
      return url === match.urlPattern;
    case 'wildcard':
      return wildcardToRegExp(match.urlPattern).test(url);
    case 'regex':
      try {
        return new RegExp(match.urlPattern).test(url);
      } catch {
        return false;
      }
  }
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + escaped.replace(/\?/g, '.').replace(/\*/g, '.*') + '$');
}

function matchMethod(ruleMethod: string, actual: string): boolean {
  return ruleMethod === 'ANY' || ruleMethod === actual.toUpperCase();
}

function matchQuery(expected: Record<string, string> | undefined, query: URLSearchParams): boolean {
  if (!expected) return true;
  return Object.entries(expected).every(([k, v]) => query.get(k) === v);
}

function matchHeaders(expected: Record<string, string> | undefined, headers: Record<string, string>): boolean {
  if (!expected) return true;
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return Object.entries(expected).every(([k, v]) => lower.get(k.toLowerCase()) === v);
}

function matchBody(needle: string | undefined, body: string): boolean {
  if (!needle) return true;
  return body.includes(needle);
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/matcher.test.ts`
Expected: 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/rules/matcher.ts tests/matcher.test.ts
git commit -m "feat: add rule matcher with url/method/query/header/body conditions"
```

---

### Task 4: JSON 文件存储（TDD）

**Files:**
- Create: `src/main/storage/json-store.ts`, `tests/json-store.test.ts`

- [ ] **Step 1: 写失败测试 `tests/json-store.test.ts`**

```ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonStore } from '../src/main/storage/json-store';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mocker-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('JsonStore', () => {
  it('returns defaults when file missing', async () => {
    const store = new JsonStore<{ a: number }>(join(dir, 'x.json'), { a: 1 });
    expect(await store.read()).toEqual({ a: 1 });
  });

  it('round-trips write then read', async () => {
    const store = new JsonStore<{ a: number }>(join(dir, 'x.json'), { a: 1 });
    await store.write({ a: 2 });
    expect(await store.read()).toEqual({ a: 2 });
  });

  it('creates parent directories', async () => {
    const store = new JsonStore<{ a: number }>(join(dir, 'deep/nested/x.json'), { a: 1 });
    await store.write({ a: 3 });
    expect(JSON.parse(await readFile(join(dir, 'deep/nested/x.json'), 'utf8'))).toEqual({ a: 3 });
  });

  it('quarantines corrupt file and returns defaults', async () => {
    const file = join(dir, 'x.json');
    await writeFile(file, '{not json');
    const store = new JsonStore<{ a: number }>(file, { a: 1 });
    expect(await store.read()).toEqual({ a: 1 });
    const original = await readFile(file, 'utf8').catch(() => null);
    expect(original).toBeNull();
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/json-store.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/main/storage/json-store.ts`**

```ts
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export class JsonStore<T> {
  constructor(
    private readonly filePath: string,
    private readonly defaults: T,
  ) {}

  async read(): Promise<T> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      return { ...this.defaults, ...JSON.parse(raw) };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...this.defaults };
      await this.quarantine();
      return { ...this.defaults };
    }
  }

  async write(value: T): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await fs.rename(tmp, this.filePath);
  }

  private async quarantine(): Promise<void> {
    try {
      await fs.rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
    } catch {
      // 文件已不存在则忽略
    }
  }
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/json-store.test.ts`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/storage/json-store.ts tests/json-store.test.ts
git commit -m "feat: add atomic json file store with corrupt-file quarantine"
```

---

### Task 5: 规则存储与快照（TDD）

**Files:**
- Create: `src/main/storage/rules-store.ts`, `tests/rules-store.test.ts`

- [ ] **Step 1: 写失败测试 `tests/rules-store.test.ts`**

```ts
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RulesStore } from '../src/main/storage/rules-store';
import type { RuleInput } from '../src/shared/types';

let dir: string;

const input = (name: string): RuleInput => ({
  name,
  enabled: true,
  match: { urlType: 'exact', urlPattern: `http://x.com/${name}`, method: 'ANY' },
  action: { status: 200, headers: {}, body: name },
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mocker-rules-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('RulesStore', () => {
  it('adds rules with generated id and increasing priority', async () => {
    const store = new RulesStore(dir);
    await store.load();
    const a = await store.add(input('a'));
    const b = await store.add(input('b'));
    expect(a.id).toBeTruthy();
    expect(b.priority).toBeGreaterThan(a.priority);
  });

  it('lists rules sorted by priority', async () => {
    const store = new RulesStore(dir);
    await store.load();
    await store.add(input('a'));
    await store.add(input('b'));
    const list = store.list();
    expect(list.map((r) => r.name)).toEqual(['a', 'b']);
  });

  it('updates and removes rules', async () => {
    const store = new RulesStore(dir);
    await store.load();
    const a = await store.add(input('a'));
    await store.update(a.id, { enabled: false });
    expect(store.list()[0].enabled).toBe(false);
    await store.remove(a.id);
    expect(store.list()).toHaveLength(0);
  });

  it('persists across instances', async () => {
    const store = new RulesStore(dir);
    await store.load();
    await store.add(input('a'));
    const store2 = new RulesStore(dir);
    await store2.load();
    expect(store2.list().map((r) => r.name)).toEqual(['a']);
  });

  it('writes a snapshot on every change', async () => {
    const store = new RulesStore(dir);
    await store.load();
    await store.add(input('a'));
    await store.add(input('b'));
    const snapshots = await readdir(join(dir, 'snapshots'));
    expect(snapshots.length).toBe(2);
  });

  it('notifies change listeners', async () => {
    const store = new RulesStore(dir);
    await store.load();
    let calls = 0;
    store.onChange(() => calls++);
    await store.add(input('a'));
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/rules-store.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/main/storage/rules-store.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { MockRule, RuleInput, RulePatch } from '../../shared/types';
import { JsonStore } from './json-store';

const MAX_SNAPSHOTS = 50;

export class RulesStore {
  private rules: MockRule[] = [];
  private readonly store: JsonStore<MockRule[]>;
  private readonly snapshotsDir: string;
  private listeners = new Set<() => void>();

  constructor(dataDir: string) {
    this.store = new JsonStore<MockRule[]>(path.join(dataDir, 'rules.json'), []);
    this.snapshotsDir = path.join(dataDir, 'snapshots');
  }

  async load(): Promise<void> {
    this.rules = await this.store.read();
  }

  list(): MockRule[] {
    return [...this.rules].sort((a, b) => a.priority - b.priority);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async add(input: RuleInput): Promise<MockRule> {
    const rule: MockRule = { ...input, id: randomUUID(), priority: this.nextPriority() };
    this.rules.push(rule);
    await this.persist();
    return rule;
  }

  async update(id: string, patch: RulePatch): Promise<MockRule> {
    const idx = this.rules.findIndex((r) => r.id === id);
    if (idx === -1) throw new Error(`rule not found: ${id}`);
    this.rules[idx] = { ...this.rules[idx], ...patch };
    await this.persist();
    return this.rules[idx];
  }

  async remove(id: string): Promise<void> {
    this.rules = this.rules.filter((r) => r.id !== id);
    await this.persist();
  }

  private nextPriority(): number {
    return this.rules.length === 0 ? 1 : Math.max(...this.rules.map((r) => r.priority)) + 1;
  }

  private async persist(): Promise<void> {
    await this.store.write(this.rules);
    await this.snapshot();
    for (const fn of this.listeners) fn();
  }

  private async snapshot(): Promise<void> {
    await fs.mkdir(this.snapshotsDir, { recursive: true });
    await fs.writeFile(
      path.join(this.snapshotsDir, `rules-${Date.now()}-${randomUUID().slice(0, 8)}.json`),
      JSON.stringify(this.rules, null, 2),
      'utf8',
    );
    const files = (await fs.readdir(this.snapshotsDir))
      .map((f) => path.join(this.snapshotsDir, f))
      .sort();
    while (files.length > MAX_SNAPSHOTS) {
      await fs.unlink(files.shift()!);
    }
  }
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/rules-store.test.ts`
Expected: 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/storage/rules-store.ts tests/rules-store.test.ts
git commit -m "feat: add rules store with priority, snapshots and change listeners"
```

---

### Task 6: 设置存储与规则引擎（TDD）

**Files:**
- Create: `src/main/storage/settings-store.ts`, `src/main/rules/engine.ts`, `tests/engine.test.ts`

- [ ] **Step 1: 实现 `src/main/storage/settings-store.ts`（薄封装，无独立测试）**

```ts
import * as path from 'node:path';
import { DEFAULT_SETTINGS, type Settings } from '../../shared/types';
import { JsonStore } from './json-store';

export class SettingsStore {
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private readonly store: JsonStore<Settings>;
  private listeners = new Set<() => void>();

  constructor(dataDir: string) {
    this.store = new JsonStore<Settings>(path.join(dataDir, 'settings.json'), DEFAULT_SETTINGS);
  }

  async load(): Promise<void> {
    this.settings = await this.store.read();
  }

  get(): Settings {
    return { ...this.settings };
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async set(patch: Partial<Settings>): Promise<Settings> {
    this.settings = { ...this.settings, ...patch };
    await this.store.write(this.settings);
    for (const fn of this.listeners) fn();
    return this.get();
  }
}
```

- [ ] **Step 2: 写失败测试 `tests/engine.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { findMatchingRule } from '../src/main/rules/engine';
import type { RequestDescription } from '../src/main/rules/matcher';
import type { MockRule } from '../src/shared/types';

const req: RequestDescription = {
  method: 'GET',
  url: 'http://api.example.com/users',
  query: new URLSearchParams(),
  headers: {},
  body: '',
};

function rule(id: string, priority: number, enabled = true, pattern = 'http://api.example.com/users'): MockRule {
  return {
    id,
    name: id,
    enabled,
    priority,
    match: { urlType: 'exact', urlPattern: pattern, method: 'ANY' },
    action: { status: 200, headers: {}, body: id },
  };
}

describe('findMatchingRule', () => {
  it('returns undefined when nothing matches', () => {
    expect(findMatchingRule([rule('a', 1, true, 'http://other.com')], req)).toBeUndefined();
  });

  it('skips disabled rules', () => {
    expect(findMatchingRule([rule('a', 1, false)], req)).toBeUndefined();
  });

  it('picks lowest priority value first regardless of array order', () => {
    const hit = findMatchingRule([rule('late', 9), rule('early', 1)], req);
    expect(hit?.id).toBe('early');
  });
});
```

- [ ] **Step 3: 运行，确认失败**

Run: `npx vitest run tests/engine.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现 `src/main/rules/engine.ts`**

```ts
import type { MockRule } from '../../shared/types';
import { matchRule, type RequestDescription } from './matcher';

export function findMatchingRule(rules: MockRule[], req: RequestDescription): MockRule | undefined {
  return rules
    .filter((r) => r.enabled)
    .sort((a, b) => a.priority - b.priority)
    .find((r) => matchRule(r.match, req));
}
```

- [ ] **Step 5: 运行，确认通过**

Run: `npx vitest run tests/engine.test.ts`
Expected: 3 tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/storage/settings-store.ts src/main/rules/engine.ts tests/engine.test.ts
git commit -m "feat: add settings store and rule selection engine"
```

---

### Task 7: 根 CA 证书模块（TDD）

**Files:**
- Create: `src/main/certs/ca.ts`, `tests/ca.test.ts`

- [ ] **Step 1: 写失败测试 `tests/ca.test.ts`**

```ts
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import forge from 'node-forge';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureCa } from '../src/main/certs/ca';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mocker-ca-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ensureCa', () => {
  it('generates a self-signed CA on first run', async () => {
    const ca = await ensureCa(dir);
    const cert = forge.pki.certificateFromPem(ca.certPem);
    expect(cert.subject.getField('CN').value).toBe('Mocker Root CA');
    expect(cert.isIssuer(cert)).toBe(true);
    const tenYearsMs = 9 * 365 * 24 * 3600 * 1000;
    expect(cert.validity.notAfter.getTime() - Date.now()).toBeGreaterThan(tenYearsMs);
    expect(forge.pki.privateKeyFromPem(ca.keyPem)).toBeTruthy();
  });

  it('reuses existing CA on second run', async () => {
    const first = await ensureCa(dir);
    const second = await ensureCa(dir);
    expect(second.certPem).toBe(first.certPem);
  });

  it('regenerates when expiring within one year', async () => {
    await ensureCa(dir);
    const future = new Date(Date.now() + 9.5 * 365 * 24 * 3600 * 1000);
    const renewed = await ensureCa(dir, future);
    expect(renewed.notAfter.getTime()).toBeGreaterThan(future.getTime() + 9 * 365 * 24 * 3600 * 1000);
  });

  it('regenerates when cert file is corrupt', async () => {
    await mkdir(join(dir, 'certs'), { recursive: true });
    await writeFile(join(dir, 'certs', 'ca.pem'), 'garbage');
    await writeFile(join(dir, 'certs', 'ca.key'), 'garbage');
    const ca = await ensureCa(dir);
    expect(() => forge.pki.certificateFromPem(ca.certPem)).not.toThrow();
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/ca.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/main/certs/ca.ts`**

```ts
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import forge from 'node-forge';

export interface CaMaterial {
  keyPem: string;
  certPem: string;
  notAfter: Date;
}

const TEN_YEARS_MS = 10 * 365 * 24 * 3600 * 1000;
const RENEW_WINDOW_MS = 365 * 24 * 3600 * 1000;

export async function ensureCa(dataDir: string, now: Date = new Date()): Promise<CaMaterial> {
  const certPath = path.join(dataDir, 'certs', 'ca.pem');
  const keyPath = path.join(dataDir, 'certs', 'ca.key');
  try {
    const [certPem, keyPem] = await Promise.all([
      fs.readFile(certPath, 'utf8'),
      fs.readFile(keyPath, 'utf8'),
    ]);
    const cert = forge.pki.certificateFromPem(certPem);
    if (cert.validity.notAfter.getTime() - now.getTime() > RENEW_WINDOW_MS) {
      return { keyPem, certPem, notAfter: cert.validity.notAfter };
    }
  } catch {
    // 缺失或损坏：重新生成
  }
  const generated = generateCa(now);
  await fs.mkdir(path.dirname(certPath), { recursive: true });
  await Promise.all([
    fs.writeFile(certPath, generated.certPem, 'utf8'),
    fs.writeFile(keyPath, generated.keyPem, { encoding: 'utf8', mode: 0o600 }),
  ]);
  return generated;
}

export function generateCa(now: Date): CaMaterial {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(8));
  cert.validity.notBefore = new Date(now.getTime() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(now.getTime() + TEN_YEARS_MS);
  const attrs = [{ name: 'commonName', value: 'Mocker Root CA' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certPem: forge.pki.certificateToPem(cert),
    notAfter: cert.validity.notAfter,
  };
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/ca.test.ts`
Expected: 4 tests PASS（首个用例含 2048 位 RSA 生成，约 1-3 秒）

- [ ] **Step 5: Commit**

```bash
git add src/main/certs/ca.ts tests/ca.test.ts
git commit -m "feat: add root CA generation with renew-on-expiry"
```

---

### Task 8: 历史记录写入器（TDD）

**Files:**
- Create: `src/main/storage/history.ts`, `tests/history.test.ts`

- [ ] **Step 1: 写失败测试 `tests/history.test.ts`**

```ts
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HistoryWriter } from '../src/main/storage/history';
import type { TrafficEvent } from '../src/shared/types';

let dir: string;

const event = (id: string): TrafficEvent => ({
  id,
  startedAt: Date.now(),
  method: 'GET',
  url: 'http://x.com/',
  host: 'x.com',
  path: '/',
  requestHeaders: {},
  mocked: false,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mocker-history-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('HistoryWriter', () => {
  it('writes events as jsonl into the open session file', async () => {
    const writer = new HistoryWriter(dir);
    writer.openSession();
    writer.write(event('e1'));
    writer.write(event('e2'));
    writer.closeSession();
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    const lines = (await readFile(join(dir, files[0]), 'utf8')).trim().split('\n');
    expect(lines.map((l) => JSON.parse(l).id)).toEqual(['e1', 'e2']);
  });

  it('ignores writes when no session is open', () => {
    const writer = new HistoryWriter(dir);
    expect(() => writer.write(event('e1'))).not.toThrow();
  });

  it('prunes old sessions beyond the limit', async () => {
    const writer = new HistoryWriter(dir, 2);
    for (let i = 0; i < 3; i++) {
      writer.openSession();
      writer.write(event(`e${i}`));
      writer.closeSession();
    }
    await writer.prune();
    const files = await readdir(dir);
    expect(files.length).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/history.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/main/storage/history.ts`**

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TrafficEvent } from '../../shared/types';

export class HistoryWriter {
  private stream: fs.WriteStream | null = null;

  constructor(
    private readonly dir: string,
    private readonly maxSessions = 20,
  ) {}

  openSession(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `session-${Date.now()}.jsonl`);
    this.stream = fs.createWriteStream(file, { flags: 'a' });
  }

  write(event: TrafficEvent): void {
    if (!this.stream) return;
    this.stream.write(JSON.stringify(event) + '\n');
  }

  closeSession(): void {
    this.stream?.end();
    this.stream = null;
  }

  async prune(): Promise<void> {
    const files = (await fs.promises.readdir(this.dir))
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(this.dir, f))
      .sort();
    while (files.length > this.maxSessions) {
      await fs.promises.unlink(files.shift()!);
    }
  }
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/history.test.ts`
Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/storage/history.ts tests/history.test.ts
git commit -m "feat: add jsonl history writer with session pruning"
```

---

### Task 9: 引导页与证书下载响应

**Files:**
- Create: `src/main/proxy/onboarding.ts`

- [ ] **Step 1: 实现 `src/main/proxy/onboarding.ts`**

```ts
export interface OnboardingResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export function certDownloadResponse(certPem: string): OnboardingResponse {
  return {
    statusCode: 200,
    headers: {
      'content-type': 'application/x-x509-ca-cert',
      'content-disposition': 'attachment; filename="mocker-ca.pem"',
    },
    body: certPem,
  };
}

export function guidePageResponse(proxyHost: string, proxyPort: number): OnboardingResponse {
  const url = `http://${proxyHost}:${proxyPort}`;
  const body = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mocker 设备接入</title>
<style>
body{font-family:-apple-system,sans-serif;max-width:640px;margin:32px auto;padding:0 16px;color:#222;line-height:1.6}
code{background:#f0f0f4;padding:2px 6px;border-radius:4px}
h1{font-size:22px} h2{font-size:16px;margin-top:24px}
a.btn{display:inline-block;background:#3b6ef6;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none}
</style></head>
<body>
<h1>Mocker 设备接入</h1>
<p>代理已生效：本机代理设置为 <code>${proxyHost}:${proxyPort}</code></p>
<p><a class="btn" href="${url}/ca.pem">下载 Mocker 根证书</a></p>
<h2>iOS</h2>
<ol><li>点击上方按钮下载描述文件</li>
<li>设置 → 已下载描述文件 → 安装</li>
<li>设置 → 通用 → 关于本机 → 证书信任设置 → 开启完全信任</li></ol>
<h2>Android</h2>
<ol><li>点击上方按钮下载证书（.pem）</li>
<li>设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书</li>
<li>注意：Android 7+ 仅 debuggable 应用或配置了信任用户 CA 的应用走用户证书；做了证书固定（SSL Pinning）的应用无法抓包</li></ol>
</body></html>`;
  return { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body };
}
```

- [ ] **Step 2: 验证**

Run: `npm run typecheck`
Expected: 通过。

- [ ] **Step 3: Commit**

```bash
git add src/main/proxy/onboarding.ts
git commit -m "feat: add onboarding guide page and cert download responses"
```

---

### Task 10: mockttp 代理服务器封装（集成测试）

**Files:**
- Create: `src/main/proxy/proxy-server.ts`, `tests/proxy.integration.test.ts`

- [ ] **Step 1: 写失败集成测试 `tests/proxy.integration.test.ts`**

```ts
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { AddressInfo } from 'node:net';
import { fetch, ProxyAgent } from 'undici';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureCa } from '../src/main/certs/ca';
import { ProxyServer } from '../src/main/proxy/proxy-server';
import { DEFAULT_SETTINGS, type MockRule, Settings, TrafficEvent } from '../src/shared/types';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let proxy: ProxyServer;
let rules: MockRule[] = [];
let events: TrafficEvent[] = [];
let upstream: Server;
let upstreamPort: number;
let settings: Settings;
let caPem: string;

function rule(pattern: string, body: string): MockRule {
  return {
    id: body,
    name: body,
    enabled: true,
    priority: 1,
    match: { urlType: 'exact', urlPattern: pattern, method: 'ANY' },
    action: { status: 200, headers: { 'content-type': 'text/plain' }, body },
  };
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mocker-proxy-'));
  const ca = await ensureCa(dir);
  caPem = ca.certPem;

  upstream = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('upstream-ok');
  });
  upstream.listen(0);
  await once(upstream, 'listening');
  upstreamPort = (upstream.address() as AddressInfo).port;

  settings = { ...DEFAULT_SETTINGS, proxyPort: 0, httpsMode: 'whitelist', whitelist: ['mocked.test'] };
  proxy = new ProxyServer({
    caKey: (await ensureCa(dir)).keyPem,
    caCert: caPem,
    getSettings: () => settings,
    getRules: () => rules,
    onEvent: (e) => events.push(e),
  });
  await proxy.start();
});

afterAll(async () => {
  await proxy.stop();
  upstream.close();
  await rm(join(tmpdir()), { recursive: false, force: true }).catch(() => {});
});

beforeEach(() => {
  rules = [];
  events = [];
});

describe('ProxyServer', () => {
  it('serves a mock response for a matched http request', async () => {
    rules = [rule('http://api.example.test/ping', 'mocked-body')];
    const agent = new ProxyAgent(`http://127.0.0.1:${proxy.port}`);
    const res = await fetch('http://api.example.test/ping', { dispatcher: agent });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('mocked-body');
    await waitFor(() => events.some((e) => e.mocked));
    const ev = events.find((e) => e.mocked)!;
    expect(ev.url).toContain('api.example.test');
    expect(ev.status).toBe(200);
  });

  it('passes unmatched http requests through to the upstream', async () => {
    const agent = new ProxyAgent(`http://127.0.0.1:${proxy.port}`);
    const res = await fetch(`http://127.0.0.1:${upstreamPort}/hello`, { dispatcher: agent });
    expect(await res.text()).toBe('upstream-ok');
    await waitFor(() => events.some((e) => e.status === 200 && !e.mocked));
  });

  it('mitm-decrypts whitelisted https hosts and mocks them', async () => {
    rules = [rule('https://mocked.test/secure', 'https-mocked')];
    const agent = new ProxyAgent({
      uri: `http://127.0.0.1:${proxy.port}`,
      requestTls: { ca: caPem },
    });
    const res = await fetch('https://mocked.test/secure', { dispatcher: agent });
    expect(await res.text()).toBe('https-mocked');
  });

  it('tunnels non-whitelisted https hosts without mitm', async () => {
    const agent = new ProxyAgent({
      uri: `http://127.0.0.1:${proxy.port}`,
      requestTls: { ca: caPem, rejectUnauthorized: false },
    });
    // outside.test 不存在：白名单外走盲隧道，直连失败
    await expect(fetch('https://outside.test/x', { dispatcher: agent })).rejects.toThrow();
    expect(events.every((e) => !e.mocked)).toBe(true);
  });

  it('serves the onboarding guide and ca cert on the proxy host', async () => {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Mocker 设备接入');
    const certRes = await fetch(`http://127.0.0.1:${proxy.port}/ca.pem`);
    expect(await certRes.text()).toContain('BEGIN CERTIFICATE');
  });

  it('captures request and response bodies in traffic events', async () => {
    rules = [rule('http://api.example.test/echo', 'echo-back')];
    const agent = new ProxyAgent(`http://127.0.0.1:${proxy.port}`);
    await fetch('http://api.example.test/echo', {
      dispatcher: agent,
      method: 'POST',
      body: 'req-payload',
    });
    await waitFor(() => events.some((e) => e.mocked && e.responseBody === 'echo-back'));
    const ev = events.find((e) => e.mocked)!;
    expect(ev.requestBody).toBe('req-payload');
    expect(ev.method).toBe('POST');
  });
});

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/proxy.integration.test.ts`
Expected: FAIL（ProxyServer 不存在）

- [ ] **Step 3: 实现 `src/main/proxy/proxy-server.ts`**

说明：采用单一主处理器统一处理引导页、白名单隧道、规则匹配与透传。流量事件通过 `request`/`response` 事件建立与收尾，主处理器负责补全请求体与标记命中规则。`extractText` 对不同版本 mockttp 的 body 形态做防御式归一（集成测试会直接断言捕获内容，若形态不符会在此处暴露并修正）。

```ts
import * as mockttp from 'mockttp';
import type { MockRule, Settings, TrafficEvent } from '../../shared/types';
import { findMatchingRule } from '../rules/engine';
import type { RequestDescription } from '../rules/matcher';
import { certDownloadResponse, guidePageResponse } from './onboarding';

export interface ProxyServerOptions {
  caKey: string;
  caCert: string;
  getSettings: () => Settings;
  getRules: () => MockRule[];
  onEvent: (event: TrafficEvent) => void;
}

export class ProxyServer {
  private server?: mockttp.Mockttp;
  private events = new Map<string, TrafficEvent>();

  constructor(private readonly opts: ProxyServerOptions) {}

  get running(): boolean {
    return this.server !== undefined;
  }

  get port(): number {
    return this.server?.port ?? this.opts.getSettings().proxyPort;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = mockttp.getLocal({
      https: { caKey: this.opts.caKey, caCert: this.opts.caCert },
    });
    await server.start(this.opts.getSettings().proxyPort);

    server.on('request', (req) => {
      const event = this.beginEvent(req);
      this.emit(event);
    });

    server.on('response', (resp) => {
      const event = this.events.get(resp.id);
      if (!event) return;
      event.status = resp.statusCode;
      event.responseHeaders = flattenHeaders(resp.headers);
      event.responseBody = extractText((resp as { body?: unknown }).body);
      event.completedAt = Date.now();
      this.emit(event);
    });

    server.on('client-error', (err) => {
      const event: TrafficEvent = {
        id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        startedAt: Date.now(),
        completedAt: Date.now(),
        method: '?',
        url: `connection error: ${err.errorCode}`,
        host: '',
        path: '',
        requestHeaders: {},
        mocked: false,
        error: err.errorCode,
      };
      this.emit(event);
    });

    await server.forAnyRequest().always().thenHandle(async (req) => this.handle(req));
    this.server = server;
  }

  async stop(): Promise<void> {
    await this.server?.stop();
    this.server = undefined;
    this.events.clear();
  }

  private async handle(req: mockttp.Request): Promise<void> {
    const settings = this.opts.getSettings();

    if (req.method === 'GET' && this.isProxyHost(req.hostname)) {
      if (req.path === '/ca.pem') {
        await req.respond(certDownloadResponse(this.opts.caCert));
        return;
      }
      if (req.path === '/') {
        await req.respond(guidePageResponse(req.hostname, this.port));
        return;
      }
    }

    if (req.method === 'CONNECT' && settings.httpsMode === 'whitelist' && !isWhitelisted(settings.whitelist, req.hostname)) {
      await req.passThrough();
      return;
    }

    const bodyText = await requestText(req);
    const event = this.events.get(req.id);
    if (event) {
      event.requestBody = bodyText;
      this.emit(event);
    }

    const matched = findMatchingRule(this.opts.getRules(), describeRequest(req, bodyText));
    if (matched) {
      if (event) {
        event.mocked = true;
        event.matchedRuleId = matched.id;
      }
      await req.respond({
        statusCode: matched.action.status,
        headers: matched.action.headers,
        body: matched.action.body,
      });
      if (event) {
        event.status = matched.action.status;
        event.responseHeaders = matched.action.headers;
        event.responseBody = matched.action.body;
        event.completedAt = Date.now();
        this.emit(event);
      }
      return;
    }

    await req.passThrough();
  }

  private isProxyHost(hostname: string): boolean {
    return hostname === 'localhost' || hostname === '127.0.0.1' || /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
  }

  private beginEvent(req: mockttp.Request): TrafficEvent {
    const url = absoluteUrl(req);
    const event: TrafficEvent = {
      id: req.id,
      startedAt: Date.now(),
      method: req.method,
      url,
      host: req.hostname,
      path: req.path,
      requestHeaders: flattenHeaders(req.headers),
      mocked: false,
    };
    this.events.set(req.id, event);
    if (this.events.size > 2000) {
      const oldest = this.events.keys().next().value;
      if (oldest) this.events.delete(oldest);
    }
    return event;
  }

  private emit(event: TrafficEvent): void {
    this.opts.onEvent({ ...event });
  }
}

export function isWhitelisted(whitelist: string[], host: string): boolean {
  return whitelist.some((d) => host === d || host.endsWith(`.${d}`));
}

function absoluteUrl(req: mockttp.Request): string {
  if (/^https?:\/\//.test(req.url)) return req.url;
  return `http://${req.hostname}${req.path}`;
}

function describeRequest(req: mockttp.Request, body: string): RequestDescription {
  return {
    method: req.method,
    url: absoluteUrl(req),
    query: new URL(absoluteUrl(req)).searchParams,
    headers: flattenHeaders(req.headers),
    body,
  };
}

function flattenHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

async function requestText(req: mockttp.Request): Promise<string> {
  try {
    return await req.body.getText();
  } catch {
    return '';
  }
}

function extractText(body: unknown): string {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  const b = body as { getText?: () => string; text?: string };
  if (typeof b.getText === 'function') {
    try {
      return b.getText();
    } catch {
      return '';
    }
  }
  if (typeof b.text === 'string') return b.text;
  return '';
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/proxy.integration.test.ts`
Expected: 6 tests PASS。若某个断言因 mockttp 事件 body 形态差异失败，仅需修正 `extractText`/`requestText` 的归一逻辑，测试断言本身是行为契约，不得放宽。

- [ ] **Step 5: Commit**

```bash
git add src/main/proxy/proxy-server.ts tests/proxy.integration.test.ts
git commit -m "feat: add mockttp proxy with mitm whitelist, rule matching and traffic capture"
```

---

### Task 11: WebSocket 桥接（TDD）

**Files:**
- Create: `src/main/bridge/ws-server.ts`, `tests/ws-server.test.ts`

- [ ] **Step 1: 写失败测试 `tests/ws-server.test.ts`**

```ts
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Bridge } from '../src/main/bridge/ws-server';
import type { TrafficEvent } from '../src/shared/types';

let bridge: Bridge;
const PORT = 18899;

const event = (id: string): TrafficEvent => ({
  id,
  startedAt: Date.now(),
  method: 'GET',
  url: 'http://x.com/',
  host: 'x.com',
  path: '/',
  requestHeaders: {},
  mocked: false,
});

function connect(): Promise<{ ws: WebSocket; messages: unknown[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const messages: unknown[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(String(data))));
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('error', reject);
  });
}

beforeAll(async () => {
  bridge = new Bridge();
  await bridge.start(PORT);
});

afterAll(async () => {
  await bridge.stop();
});

describe('Bridge', () => {
  it('sends a snapshot on connect and broadcasts new events', async () => {
    bridge.publish(event('before-connect'));
    const { ws, messages } = await connect();
    await waitUntil(() => messages.length >= 1);
    expect(messages[0]).toMatchObject({ type: 'snapshot', events: [{ id: 'before-connect' }] });

    bridge.publish(event('after-connect'));
    await waitUntil(() => messages.length >= 2);
    expect(messages[1]).toMatchObject({ type: 'event', event: { id: 'after-connect' } });
    ws.close();
  });

  it('caps the snapshot ring buffer', async () => {
    for (let i = 0; i < 600; i++) bridge.publish(event(`bulk-${i}`));
    const { ws, messages } = await connect();
    await waitUntil(() => messages.length >= 1);
    const snapshot = messages[0] as { events: TrafficEvent[] };
    expect(snapshot.events.length).toBeLessThanOrEqual(500);
    ws.close();
  });
});

async function waitUntil(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/ws-server.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/main/bridge/ws-server.ts`**

```ts
import { WebSocket, WebSocketServer } from 'ws';
import type { TrafficEvent } from '../../shared/types';

const SNAPSHOT_LIMIT = 500;

export class Bridge {
  private wss?: WebSocketServer;
  private clients = new Set<WebSocket>();
  private recent: TrafficEvent[] = [];

  async start(port: number): Promise<void> {
    this.wss = new WebSocketServer({ port, host: '127.0.0.1' });
    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      ws.send(JSON.stringify({ type: 'snapshot', events: this.recent }));
      ws.on('close', () => this.clients.delete(ws));
    });
    await new Promise<void>((resolve) => this.wss!.once('listening', resolve));
  }

  publish(event: TrafficEvent): void {
    const idx = this.recent.findIndex((e) => e.id === event.id);
    if (idx === -1) {
      this.recent.push(event);
      if (this.recent.length > SNAPSHOT_LIMIT) this.recent.shift();
    } else {
      this.recent[idx] = event;
    }
    const msg = JSON.stringify({ type: 'event', event });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  async stop(): Promise<void> {
    for (const ws of this.clients) ws.close();
    this.clients.clear();
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
    this.wss = undefined;
  }
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/ws-server.test.ts`
Expected: 2 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/bridge/ws-server.ts tests/ws-server.test.ts
git commit -m "feat: add websocket bridge with snapshot ring buffer"
```

---

### Task 12: 系统代理开关（解析函数 TDD）

**Files:**
- Create: `src/main/system-proxy/macos.ts`, `src/main/system-proxy/windows.ts`, `src/main/system-proxy/index.ts`, `tests/system-proxy.test.ts`

- [ ] **Step 1: 写失败测试 `tests/system-proxy.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { parseDefaultInterface, parseServiceOrder } from '../src/main/system-proxy/macos';

describe('parseServiceOrder', () => {
  const sample = `An asterisk (*) denotes that a network service is disabled.
(1) Wi-Fi
(Hardware Port: Wi-Fi, Device: en0)
(2) Thunderbolt 桥接
(Hardware Port: Thunderbolt Bridge, Device: bridge0)
`;

  it('extracts service name and device', () => {
    expect(parseServiceOrder(sample)).toEqual([
      { service: 'Wi-Fi', device: 'en0' },
      { service: 'Thunderbolt 桥接', device: 'bridge0' },
    ]);
  });
});

describe('parseDefaultInterface', () => {
  it('extracts interface from route output', () => {
    const sample = `   route to: default
destination: default
       mask: default
    gateway: 192.168.1.1
  interface: en0
      flags: <UGSc>
`;
    expect(parseDefaultInterface(sample)).toBe('en0');
  });

  it('returns undefined when missing', () => {
    expect(parseDefaultInterface('no route')).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/system-proxy.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/main/system-proxy/macos.ts`**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface NetworkService {
  service: string;
  device: string;
}

export function parseServiceOrder(output: string): NetworkService[] {
  const services: NetworkService[] = [];
  const lines = output.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const name = lines[i].match(/^\(\d+\)\s+(.+)$/);
    if (name && lines[i + 1]) {
      const hw = lines[i + 1].match(/Hardware Port: (.+?), Device: ([\w-]+)/);
      if (hw) services.push({ service: name[1].trim(), device: hw[2] });
    }
  }
  return services;
}

export function parseDefaultInterface(routeOutput: string): string | undefined {
  return routeOutput.match(/interface: (\w+)/)?.[1];
}

export async function activeService(): Promise<string | undefined> {
  const [{ stdout: routeOut }, { stdout: orderOut }] = await Promise.all([
    run('route', ['-n', 'get', 'default']).catch(() => ({ stdout: '' })),
    run('networksetup', ['-listnetworkserviceorder']),
  ]);
  const device = parseDefaultInterface(routeOut);
  if (!device) return undefined;
  return parseServiceOrder(orderOut).find((s) => s.device === device)?.service;
}

export async function enable(port: number): Promise<void> {
  const service = await activeService();
  if (!service) throw new Error('找不到活跃的网络服务');
  await run('networksetup', ['-setwebproxy', service, '127.0.0.1', String(port)]);
  await run('networksetup', ['-setsecurewebproxy', service, '127.0.0.1', String(port)]);
}

export async function disable(): Promise<void> {
  const service = await activeService();
  if (!service) return;
  await run('networksetup', ['-setwebproxystate', service, 'off']);
  await run('networksetup', ['-setsecurewebproxystate', service, 'off']);
}

export async function isEnabled(): Promise<boolean> {
  const service = await activeService();
  if (!service) return false;
  const { stdout } = await run('networksetup', ['-getwebproxy', service]);
  return /Enabled:\s*Yes/i.test(stdout);
}
```

- [ ] **Step 4: 实现 `src/main/system-proxy/windows.ts`**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

export async function enable(port: number): Promise<void> {
  await run('reg', ['add', KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f']);
  await run('reg', ['add', KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', `127.0.0.1:${port}`, '/f']);
}

export async function disable(): Promise<void> {
  await run('reg', ['add', KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f']);
}

export async function isEnabled(): Promise<boolean> {
  try {
    const { stdout } = await run('reg', ['query', KEY, '/v', 'ProxyEnable']);
    return /ProxyEnable\s+REG_DWORD\s+0x1/i.test(stdout);
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: 实现 `src/main/system-proxy/index.ts`**

```ts
import * as macos from './macos';
import * as windows from './windows';

function impl() {
  if (process.platform === 'darwin') return macos;
  if (process.platform === 'win32') return windows;
  throw new Error(`不支持的平台: ${process.platform}`);
}

export async function enableSystemProxy(port: number): Promise<void> {
  await impl().enable(port);
}

export async function disableSystemProxy(): Promise<void> {
  await impl().disable();
}

export async function systemProxyEnabled(): Promise<boolean> {
  try {
    return await impl().isEnabled();
  } catch {
    return false;
  }
}
```

- [ ] **Step 6: 运行，确认通过**

Run: `npx vitest run tests/system-proxy.test.ts`
Expected: 3 tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/system-proxy tests/system-proxy.test.ts
git commit -m "feat: add system proxy toggle for macos and windows"
```

---

### Task 13: IPC 注册与主进程装配

**Files:**
- Create: `src/main/ipc.ts`
- Modify: `src/main/index.ts`（整体重写）, `src/preload/index.ts`（整体重写）

- [ ] **Step 1: 实现 `src/main/ipc.ts`**

```ts
import { ipcMain } from 'electron';
import { networkInterfaces } from 'node:os';
import type { ProxyServer } from './proxy/proxy-server';
import type { RulesStore } from './storage/rules-store';
import type { SettingsStore } from './storage/settings-store';
import { disableSystemProxy, enableSystemProxy, systemProxyEnabled } from './system-proxy';
import type { CaMaterial } from './certs/ca';
import type { RuleInput, RulePatch } from '../shared/types';

export interface IpcContext {
  proxy: ProxyServer;
  rules: RulesStore;
  settings: SettingsStore;
  ca: CaMaterial;
  onSystemProxyChanged: (enabled: boolean) => void;
}

export function localIps(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i): i is NonNullable<typeof i> => !!i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

export function registerIpc(ctx: IpcContext): void {
  ipcMain.handle('proxy:start', async () => {
    await ctx.proxy.start();
  });
  ipcMain.handle('proxy:stop', async () => {
    await ctx.proxy.stop();
  });
  ipcMain.handle('proxy:status', () => ({
    running: ctx.proxy.running,
    port: ctx.proxy.port,
    localIps: localIps(),
  }));

  ipcMain.handle('rules:list', () => ctx.rules.list());
  ipcMain.handle('rules:add', (_e, input: RuleInput) => ctx.rules.add(input));
  ipcMain.handle('rules:update', (_e, id: string, patch: RulePatch) => ctx.rules.update(id, patch));
  ipcMain.handle('rules:remove', (_e, id: string) => ctx.rules.remove(id));

  ipcMain.handle('settings:get', () => ctx.settings.get());
  ipcMain.handle('settings:set', (_e, patch) => ctx.settings.set(patch));

  ipcMain.handle('cert:info', () => ({ expiresAt: ctx.ca.notAfter.getTime() }));

  ipcMain.handle('system-proxy:set', async (_e, enabled: boolean) => {
    if (enabled) {
      await enableSystemProxy(ctx.proxy.port);
    } else {
      await disableSystemProxy();
    }
    ctx.onSystemProxyChanged(enabled);
  });
  ipcMain.handle('system-proxy:status', () => systemProxyEnabled());
}
```

- [ ] **Step 2: 重写 `src/main/index.ts`**

```ts
import { app, BrowserWindow, dialog } from 'electron';
import { join } from 'node:path';
import { Bridge } from './bridge/ws-server';
import { ensureCa } from './certs/ca';
import { registerIpc } from './ipc';
import { ProxyServer } from './proxy/proxy-server';
import { HistoryWriter } from './storage/history';
import { RulesStore } from './storage/rules-store';
import { SettingsStore } from './storage/settings-store';
import { disableSystemProxy } from './system-proxy';

let mainWindow: BrowserWindow | null = null;
let systemProxySetByUs = false;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: { preload: join(__dirname, '../preload/index.js') },
  });
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

async function bootstrap(): Promise<void> {
  const dataDir = app.getPath('userData');

  const settings = new SettingsStore(dataDir);
  await settings.load();
  const rules = new RulesStore(dataDir);
  await rules.load();
  const ca = await ensureCa(dataDir);

  const history = new HistoryWriter(join(dataDir, 'history'));
  const bridge = new Bridge();
  await bridge.start(settings.get().wsPort);

  const proxy = new ProxyServer({
    caKey: ca.keyPem,
    caCert: ca.certPem,
    getSettings: () => settings.get(),
    getRules: () => rules.list(),
    onEvent: (event) => {
      bridge.publish(event);
      history.write(event);
    },
  });

  registerIpc({
    proxy,
    rules,
    settings,
    ca,
    onSystemProxyChanged: (enabled) => {
      systemProxySetByUs = enabled;
    },
  });

  if (settings.get().autoStartProxy) {
    try {
      await proxy.start();
      history.openSession();
    } catch (err) {
      dialog.showErrorBox('代理启动失败', String(err));
    }
  }

  createWindow();

  app.on('before-quit', async () => {
    if (systemProxySetByUs) {
      try {
        await disableSystemProxy();
      } catch {
        // 退出时尽力恢复，失败忽略
      }
    }
    history.closeSession();
    await proxy.stop();
    await bridge.stop();
  });
}

app.whenReady().then(bootstrap);
```

注意：`before-quit` 中异步清理可能未跑完进程就退出，对 MVP 可接受（系统代理恢复是最高优先级，放在最前）。

- [ ] **Step 3: 重写 `src/preload/index.ts`**

```ts
import { contextBridge, ipcRenderer } from 'electron';
import type { Api } from '../shared/api';
import type { RuleInput, RulePatch, Settings } from '../shared/types';

const api: Api = {
  proxyStart: () => ipcRenderer.invoke('proxy:start'),
  proxyStop: () => ipcRenderer.invoke('proxy:stop'),
  proxyStatus: () => ipcRenderer.invoke('proxy:status'),
  rulesList: () => ipcRenderer.invoke('rules:list'),
  rulesAdd: (input: RuleInput) => ipcRenderer.invoke('rules:add', input),
  rulesUpdate: (id: string, patch: RulePatch) => ipcRenderer.invoke('rules:update', id, patch),
  rulesRemove: (id: string) => ipcRenderer.invoke('rules:remove', id),
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch: Partial<Settings>) => ipcRenderer.invoke('settings:set', patch),
  certInfo: () => ipcRenderer.invoke('cert:info'),
  systemProxySet: (enabled: boolean) => ipcRenderer.invoke('system-proxy:set', enabled),
  systemProxyStatus: () => ipcRenderer.invoke('system-proxy:status'),
};

contextBridge.exposeInMainWorld('api', api);
```

- [ ] **Step 4: 验证**

Run: `npm run typecheck`
Expected: 通过。

Run: `npm run dev`（手动）
Expected: 应用启动，窗口出现；控制台无报错。关闭应用。

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc.ts src/main/index.ts src/preload/index.ts
git commit -m "feat: wire ipc, proxy, bridge, history and stores in main process"
```

---

### Task 14: 渲染进程——流量面板

**Files:**
- Create: `src/renderer/src/lib/api.ts`, `src/renderer/src/stores/traffic.ts`, `src/renderer/src/components/StatusBar.tsx`, `src/renderer/src/components/TrafficPanel.tsx`, `src/renderer/src/components/TrafficTable.tsx`, `src/renderer/src/components/TrafficDetail.tsx`
- Modify: `src/renderer/src/styles.css`（整体重写）

- [ ] **Step 1: `src/renderer/src/lib/api.ts`**

```ts
export const api = window.api;
```

- [ ] **Step 2: `src/renderer/src/stores/traffic.ts`**

```ts
import { create } from 'zustand';
import type { TrafficEvent } from '../../../shared/types';

const MAX_EVENTS = 2000;

interface TrafficState {
  list: TrafficEvent[];
  connected: boolean;
  paused: boolean;
  filter: string;
  setFilter: (f: string) => void;
  togglePause: () => void;
  clear: () => void;
  connect: (wsPort: number) => void;
}

let ws: WebSocket | null = null;
let pending: TrafficEvent[] = [];

function upsert(list: TrafficEvent[], event: TrafficEvent): TrafficEvent[] {
  const idx = list.findIndex((e) => e.id === event.id);
  if (idx === -1) return [...list, event].slice(-MAX_EVENTS);
  const next = list.slice();
  next[idx] = event;
  return next;
}

export const useTrafficStore = create<TrafficState>((set, get) => ({
  list: [],
  connected: false,
  paused: false,
  filter: '',
  setFilter: (filter) => set({ filter }),
  togglePause: () => set({ paused: !get().paused }),
  clear: () => {
    pending = [];
    set({ list: [] });
  },
  connect: (wsPort) => {
    if (ws) return;
    const open = () => {
      ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
      ws.onopen = () => set({ connected: true });
      ws.onclose = () => {
        ws = null;
        set({ connected: false });
        setTimeout(open, 2000);
      };
      ws.onmessage = (msg) => {
        const data = JSON.parse(msg.data);
        if (data.type === 'snapshot') {
          set({ list: data.events.slice(-MAX_EVENTS) });
          pending = [];
        } else if (data.type === 'event') {
          if (get().paused) {
            pending.push(data.event);
            return;
          }
          let list = get().list;
          for (const p of pending) list = upsert(list, p);
          pending = [];
          set({ list: upsert(list, data.event) });
        }
      };
    };
    open();
  },
}));
```

- [ ] **Step 3: `src/renderer/src/components/StatusBar.tsx`**

```tsx
import { useCallback, useEffect, useState } from 'react';
import type { ProxyStatus } from '../../../shared/types';
import { api } from '../lib/api';
import { useTrafficStore } from '../stores/traffic';

export default function StatusBar() {
  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const connected = useTrafficStore((s) => s.connected);

  const refresh = useCallback(async () => {
    setStatus(await api.proxyStatus());
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  const toggle = async () => {
    if (status?.running) await api.proxyStop();
    else await api.proxyStart();
    await refresh();
  };

  return (
    <div className="status-bar">
      <span className={`dot ${connected ? 'ok' : 'err'}`} title="实时连接" />
      <span>Mocker</span>
      <span className="spacer" />
      {status && (
        <>
          <span className={status.running ? 'text-ok' : 'text-err'}>
            {status.running ? `代理运行中 :${status.port}` : '代理已停止'}
          </span>
          <button onClick={toggle}>{status.running ? '停止' : '启动'}</button>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: `src/renderer/src/components/TrafficTable.tsx`**

```tsx
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef } from 'react';
import type { TrafficEvent } from '../../../shared/types';

interface Props {
  events: TrafficEvent[];
  selectedId: string | null;
  onSelect: (e: TrafficEvent) => void;
}

export default function TrafficTable({ events, selectedId, onSelect }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 20,
  });

  return (
    <div ref={parentRef} className="traffic-table">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const e = events[item.index];
          return (
            <div
              key={e.id}
              className={`row ${selectedId === e.id ? 'selected' : ''} ${e.mocked ? 'mocked' : ''} ${e.error ? 'errored' : ''}`}
              style={{ position: 'absolute', top: item.start, height: item.size, width: '100%' }}
              onClick={() => onSelect(e)}
            >
              <span className="cell status">{e.status ?? '…'}</span>
              <span className="cell method">{e.method}</span>
              <span className="cell url" title={e.url}>{e.url}</span>
              {e.mocked && <span className="badge">MOCK</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: `src/renderer/src/components/TrafficDetail.tsx`**

```tsx
import type { TrafficEvent } from '../../../shared/types';

function pretty(body: string | undefined): string {
  if (!body) return '';
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function HeaderTable({ headers }: { headers?: Record<string, string> }) {
  if (!headers || Object.keys(headers).length === 0) return <div className="muted">（无）</div>;
  return (
    <table className="kv">
      <tbody>
        {Object.entries(headers).map(([k, v]) => (
          <tr key={k}>
            <td className="k">{k}</td>
            <td className="v">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function TrafficDetail({ event }: { event: TrafficEvent | null }) {
  if (!event) return <div className="detail empty">选择一个请求查看详情</div>;
  return (
    <div className="detail">
      <h3>{event.method} {event.url}</h3>
      {event.error && <div className="text-err">错误：{event.error}</div>}
      {event.mocked && <div className="text-ok">由规则命中（{event.matchedRuleId}）</div>}
      <h4>请求头</h4>
      <HeaderTable headers={event.requestHeaders} />
      <h4>请求体</h4>
      <pre>{pretty(event.requestBody) || '（无）'}</pre>
      <h4>响应头</h4>
      <HeaderTable headers={event.responseHeaders} />
      <h4>响应体</h4>
      <pre>{pretty(event.responseBody) || '（无）'}</pre>
    </div>
  );
}
```

- [ ] **Step 6: `src/renderer/src/components/TrafficPanel.tsx`**

```tsx
import { useMemo, useState } from 'react';
import type { TrafficEvent } from '../../../shared/types';
import { useTrafficStore } from '../stores/traffic';
import TrafficDetail from './TrafficDetail';
import TrafficTable from './TrafficTable';

export default function TrafficPanel() {
  const { list, filter, paused, setFilter, togglePause, clear } = useTrafficStore();
  const [selected, setSelected] = useState<TrafficEvent | null>(null);

  const filtered = useMemo(
    () => (filter ? list.filter((e) => e.url.includes(filter)) : list),
    [list, filter],
  );

  return (
    <div className="traffic-panel">
      <div className="toolbar">
        <input placeholder="过滤 URL…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button onClick={togglePause}>{paused ? '继续' : '暂停'}</button>
        <button onClick={() => { clear(); setSelected(null); }}>清空</button>
        <span className="muted">{filtered.length} 条</span>
      </div>
      <div className="split">
        <TrafficTable events={filtered} selectedId={selected?.id ?? null} onSelect={setSelected} />
        <TrafficDetail event={selected} />
      </div>
    </div>
  );
}
```

- [ ] **Step 7: 整体重写 `src/renderer/src/styles.css`**

```css
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, "Segoe UI", sans-serif; background: #1e1f24; color: #e2e2e8; font-size: 13px; }
button { cursor: pointer; background: #33343c; color: #e2e2e8; border: 1px solid #4a4b55; border-radius: 6px; padding: 4px 12px; }
button:hover { background: #3e3f49; }
button.primary { background: #3b6ef6; border-color: #3b6ef6; color: #fff; }
input, select, textarea { background: #26272e; color: #e2e2e8; border: 1px solid #4a4b55; border-radius: 6px; padding: 5px 8px; font-size: 13px; }
.app { display: flex; flex-direction: column; height: 100vh; }
.status-bar { display: flex; align-items: center; gap: 10px; padding: 8px 14px; border-bottom: 1px solid #33343c; }
.status-bar .spacer { flex: 1; }
.dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
.dot.ok { background: #38c172; }
.dot.err { background: #e3342f; }
.text-ok { color: #38c172; }
.text-err { color: #e3342f; }
.muted { color: #8a8b96; }
.tabs { display: flex; gap: 4px; padding: 8px 14px 0; border-bottom: 1px solid #33343c; }
.tabs button { border: none; border-radius: 6px 6px 0 0; background: transparent; padding: 8px 16px; color: #8a8b96; }
.tabs button.active { background: #26272e; color: #fff; }
.content { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
.toolbar { display: flex; gap: 8px; align-items: center; padding: 10px 14px; }
.toolbar input { flex: 1; max-width: 420px; }
.split { flex: 1; display: flex; overflow: hidden; }
.traffic-table { flex: 3; overflow-y: auto; border-right: 1px solid #33343c; }
.traffic-table .row { display: flex; align-items: center; gap: 8px; padding: 0 12px; cursor: default; border-bottom: 1px solid #2a2b32; }
.traffic-table .row:hover { background: #26272e; }
.traffic-table .row.selected { background: #2c3550; }
.traffic-table .row.mocked .url { color: #8ab4ff; }
.traffic-table .row.errored { color: #e3342f; }
.cell.status { width: 40px; }
.cell.method { width: 60px; color: #8a8b96; }
.cell.url { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.badge { font-size: 10px; background: #3b6ef6; color: #fff; border-radius: 4px; padding: 1px 5px; }
.detail { flex: 2; overflow-y: auto; padding: 12px 16px; }
.detail.empty { display: flex; align-items: center; justify-content: center; color: #8a8b96; }
.detail h3 { font-size: 13px; margin-bottom: 8px; word-break: break-all; }
.detail h4 { margin: 12px 0 4px; color: #8a8b96; font-size: 12px; }
.detail pre { background: #26272e; border-radius: 6px; padding: 8px; white-space: pre-wrap; word-break: break-all; max-height: 240px; overflow-y: auto; }
table.kv { border-collapse: collapse; width: 100%; }
table.kv td { border: 1px solid #33343c; padding: 3px 8px; word-break: break-all; }
table.kv .k { color: #8ab4ff; width: 200px; }
.panel { padding: 16px; overflow-y: auto; }
.form-grid { display: grid; grid-template-columns: 120px 1fr; gap: 10px; align-items: center; max-width: 640px; }
.form-grid label { color: #8a8b96; text-align: right; }
.form-grid input, .form-grid select, .form-grid textarea { width: 100%; }
.rules-table { width: 100%; border-collapse: collapse; }
.rules-table th, .rules-table td { border-bottom: 1px solid #33343c; padding: 8px 10px; text-align: left; }
.rules-table .ops { white-space: nowrap; display: flex; gap: 6px; }
.modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; z-index: 10; }
.modal { background: #26272e; border-radius: 10px; padding: 20px; width: 680px; max-height: 86vh; overflow-y: auto; }
.guide { max-width: 720px; line-height: 1.7; }
.guide code { background: #33343c; padding: 2px 6px; border-radius: 4px; }
.guide h3 { margin: 16px 0 6px; }
```

- [ ] **Step 8: 验证**

Run: `npm run typecheck`
Expected: 通过。

- [ ] **Step 9: Commit**

```bash
git add src/renderer
git commit -m "feat: add traffic panel with virtual list, detail viewer and ws store"
```

---

### Task 15: 渲染进程——规则管理

**Files:**
- Create: `src/renderer/src/components/RulesPanel.tsx`, `src/renderer/src/components/RuleEditorModal.tsx`

- [ ] **Step 1: `src/renderer/src/components/RuleEditorModal.tsx`**

```tsx
import { useState } from 'react';
import type { HttpMethod, MockRule, RuleInput, UrlPatternType } from '../../../shared/types';
import { api } from '../lib/api';

const METHODS: HttpMethod[] = ['ANY', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
const URL_TYPES: Array<{ value: UrlPatternType; label: string }> = [
  { value: 'exact', label: '精确' },
  { value: 'wildcard', label: '通配符' },
  { value: 'regex', label: '正则' },
];

function parseLines(text: string, sep: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf(sep);
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + sep.length).trim();
  }
  return out;
}

function formatLines(map: Record<string, string> | undefined, sep: string): string {
  return Object.entries(map ?? {})
    .map(([k, v]) => `${k}${sep}${v}`)
    .join('\n');
}

interface Props {
  initial: MockRule | null;
  onClose: () => void;
  onSaved: () => void;
}

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
  const [error, setError] = useState('');

  const save = async () => {
    const input: RuleInput = {
      name: name.trim() || urlPattern,
      enabled: initial?.enabled ?? true,
      match: {
        urlType,
        urlPattern,
        method,
        query: Object.keys(parseLines(queryText, '=')).length ? parseLines(queryText, '=') : undefined,
        headers: Object.keys(parseLines(headersText, ': ')).length ? parseLines(headersText, ': ') : undefined,
        bodyContains: bodyContains || undefined,
      },
      action: {
        status,
        headers: { 'content-type': 'application/json', ...parseLines(respHeadersText, ': ') },
        body,
      },
    };
    if (!urlPattern) {
      setError('URL 匹配模式不能为空');
      return;
    }
    try {
      if (initial) await api.rulesUpdate(initial.id, input);
      else await api.rulesAdd(input);
      onSaved();
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{initial ? '编辑规则' : '新建规则'}</h2>
        {error && <div className="text-err">{error}</div>}
        <div className="form-grid">
          <label>名称</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
          <label>URL 类型</label>
          <select value={urlType} onChange={(e) => setUrlType(e.target.value as UrlPatternType)}>
            {URL_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <label>URL 模式</label>
          <input value={urlPattern} onChange={(e) => setUrlPattern(e.target.value)} placeholder="http://api.example.com/*" />
          <label>Method</label>
          <select value={method} onChange={(e) => setMethod(e.target.value as HttpMethod)}>
            {METHODS.map((m) => <option key={m}>{m}</option>)}
          </select>
          <label>Query（每行 k=v）</label>
          <textarea rows={2} value={queryText} onChange={(e) => setQueryText(e.target.value)} />
          <label>请求头（每行 k: v）</label>
          <textarea rows={2} value={headersText} onChange={(e) => setHeadersText(e.target.value)} />
          <label>请求体包含</label>
          <input value={bodyContains} onChange={(e) => setBodyContains(e.target.value)} />
          <label>响应状态码</label>
          <input type="number" value={status} onChange={(e) => setStatus(Number(e.target.value))} />
          <label>响应头（每行 k: v）</label>
          <textarea rows={2} value={respHeadersText} onChange={(e) => setRespHeadersText(e.target.value)} />
          <label>响应体</label>
          <textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} placeholder='{"code":0}' />
        </div>
        <div className="toolbar">
          <button className="primary" onClick={save}>保存</button>
          <button onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: `src/renderer/src/components/RulesPanel.tsx`**

```tsx
import { useCallback, useEffect, useState } from 'react';
import type { MockRule } from '../../../shared/types';
import { api } from '../lib/api';
import RuleEditorModal from './RuleEditorModal';

export default function RulesPanel() {
  const [rules, setRules] = useState<MockRule[]>([]);
  const [editing, setEditing] = useState<MockRule | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    setRules(await api.rulesList());
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const move = async (rule: MockRule, dir: -1 | 1) => {
    const idx = rules.findIndex((r) => r.id === rule.id);
    const other = rules[idx + dir];
    if (!other) return;
    await api.rulesUpdate(rule.id, { priority: other.priority });
    await api.rulesUpdate(other.id, { priority: rule.priority });
    await refresh();
  };

  return (
    <div className="panel">
      <div className="toolbar">
        <button className="primary" onClick={() => setCreating(true)}>新建规则</button>
        <span className="muted">优先级从上到下递减；开启即生效</span>
      </div>
      <table className="rules-table">
        <thead>
          <tr><th>启用</th><th>名称</th><th>匹配</th><th>响应</th><th>操作</th></tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id}>
              <td>
                <input
                  type="checkbox"
                  checked={r.enabled}
                  onChange={(e) => api.rulesUpdate(r.id, { enabled: e.target.checked }).then(refresh)}
                />
              </td>
              <td>{r.name}</td>
              <td className="muted">{r.match.method} {r.match.urlPattern}</td>
              <td className="muted">{r.action.status}</td>
              <td>
                <div className="ops">
                  <button onClick={() => move(r, -1)}>↑</button>
                  <button onClick={() => move(r, 1)}>↓</button>
                  <button onClick={() => setEditing(r)}>编辑</button>
                  <button onClick={() => api.rulesRemove(r.id).then(refresh)}>删除</button>
                </div>
              </td>
            </tr>
          ))}
          {rules.length === 0 && (
            <tr><td colSpan={5} className="muted">还没有规则，点击「新建规则」开始</td></tr>
          )}
        </tbody>
      </table>
      {(creating || editing) && (
        <RuleEditorModal
          initial={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); refresh(); }}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 3: 验证**

Run: `npm run typecheck`
Expected: 通过。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/RulesPanel.tsx src/renderer/src/components/RuleEditorModal.tsx
git commit -m "feat: add rules panel with editor modal and priority reordering"
```

---

### Task 16: 渲染进程——设备接入与设置

**Files:**
- Create: `src/renderer/src/components/DeviceGuide.tsx`, `src/renderer/src/components/SettingsPanel.tsx`

- [ ] **Step 1: `src/renderer/src/components/DeviceGuide.tsx`**

```tsx
import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useState } from 'react';
import type { CertInfo, ProxyStatus } from '../../../shared/types';
import { api } from '../lib/api';

export default function DeviceGuide() {
  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const [cert, setCert] = useState<CertInfo | null>(null);

  useEffect(() => {
    api.proxyStatus().then(setStatus);
    api.certInfo().then(setCert);
    const timer = setInterval(() => api.proxyStatus().then(setStatus), 3000);
    return () => clearInterval(timer);
  }, []);

  const ip = status?.localIps[0];
  const guideUrl = ip && status ? `http://${ip}:${status.port}` : '';

  return (
    <div className="panel guide">
      <h2>设备接入</h2>
      {!status?.running && <div className="text-err">代理未运行，请先在状态栏启动代理。</div>}
      {status?.running && ip && (
        <>
          <p>1. 手机与电脑连接同一网络。</p>
          <p>2. 手机系统代理设置为 <code>{ip}:{status.port}</code>。</p>
          <p>3. 手机浏览器扫码或访问 <code>{guideUrl}</code>，按页面指引安装证书。</p>
          <div style={{ margin: '16px 0', background: '#fff', padding: 12, display: 'inline-block', borderRadius: 8 }}>
            <QRCodeSVG value={guideUrl} size={180} />
          </div>
          <p>
            <button className="primary" onClick={() => window.open(`${guideUrl}/ca.pem`)}>下载根证书（本机）</button>
          </p>
          <p className="muted">
            HTTPS 抓包需在「设置」中把目标域名加入白名单（或切换全量解密模式）。
            {cert && ` 证书有效期至 ${new Date(cert.expiresAt).toLocaleDateString()}`}
          </p>
        </>
      )}
      <h3>已知限制</h3>
      <ul>
        <li>Android 7+ 应用默认不信任用户证书：仅 debuggable 或显式信任用户 CA 的应用可抓。</li>
        <li>SSL Pinning 应用无法抓包。</li>
        <li>iOS 需关闭 iCloud 私有中继。</li>
        <li>HTTP/3 (QUIC) 不走代理，无法抓取。</li>
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: `src/renderer/src/components/SettingsPanel.tsx`**

```tsx
import { useEffect, useState } from 'react';
import type { HttpsMode, Settings } from '../../../shared/types';
import { api } from '../lib/api';

export default function SettingsPanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [systemProxy, setSystemProxy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    api.settingsGet().then(setSettings);
    api.systemProxyStatus().then(setSystemProxy).catch(() => setSystemProxy(false));
  }, []);

  if (!settings) return <div className="panel muted">加载中…</div>;

  const save = async (patch: Partial<Settings>) => {
    const next = await api.settingsSet(patch);
    setSettings(next);
    // 端口或模式变更后重启代理使其生效
    await api.proxyStop();
    await api.proxyStart();
    setMessage('已保存，代理已重启生效');
    setTimeout(() => setMessage(''), 3000);
  };

  const toggleSystemProxy = async () => {
    try {
      await api.systemProxySet(!systemProxy);
      setSystemProxy(!systemProxy);
    } catch (err) {
      setMessage(String(err));
    }
  };

  return (
    <div className="panel">
      <div className="form-grid">
        <label>代理端口</label>
        <input
          type="number"
          value={settings.proxyPort}
          onChange={(e) => setSettings({ ...settings, proxyPort: Number(e.target.value) })}
        />
        <label>HTTPS 模式</label>
        <select
          value={settings.httpsMode}
          onChange={(e) => setSettings({ ...settings, httpsMode: e.target.value as HttpsMode })}
        >
          <option value="whitelist">白名单（仅解密下列域名）</option>
          <option value="full">全量解密</option>
        </select>
        <label>白名单域名（每行一个）</label>
        <textarea
          rows={5}
          value={settings.whitelist.join('\n')}
          onChange={(e) =>
            setSettings({ ...settings, whitelist: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })
          }
        />
        <label>启动时自动开代理</label>
        <input
          type="checkbox"
          checked={settings.autoStartProxy}
          onChange={(e) => setSettings({ ...settings, autoStartProxy: e.target.checked })}
        />
        <label>系统代理</label>
        <div>
          <button onClick={toggleSystemProxy}>{systemProxy ? '关闭系统代理' : '开启系统代理'}</button>
        </div>
      </div>
      <div className="toolbar">
        <button
          className="primary"
          onClick={() =>
            save({
              proxyPort: settings.proxyPort,
              httpsMode: settings.httpsMode,
              whitelist: settings.whitelist,
              autoStartProxy: settings.autoStartProxy,
            })
          }
        >
          保存并重启代理
        </button>
        {message && <span className="muted">{message}</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 验证**

Run: `npm run typecheck`
Expected: 通过。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/DeviceGuide.tsx src/renderer/src/components/SettingsPanel.tsx
git commit -m "feat: add device guide with qr code and settings panel"
```

---

### Task 17: 组装 App 入口

**Files:**
- Modify: `src/renderer/src/App.tsx`（整体重写）

- [ ] **Step 1: 重写 `src/renderer/src/App.tsx`**

```tsx
import { useEffect, useState } from 'react';
import StatusBar from './components/StatusBar';
import TrafficPanel from './components/TrafficPanel';
import RulesPanel from './components/RulesPanel';
import DeviceGuide from './components/DeviceGuide';
import SettingsPanel from './components/SettingsPanel';
import { api } from './lib/api';
import { useTrafficStore } from './stores/traffic';

type Tab = 'traffic' | 'rules' | 'device' | 'settings';

export default function App() {
  const [tab, setTab] = useState<Tab>('traffic');
  const connect = useTrafficStore((s) => s.connect);

  useEffect(() => {
    api.settingsGet().then((s) => connect(s.wsPort));
  }, [connect]);

  return (
    <div className="app">
      <StatusBar />
      <nav className="tabs">
        <button data-testid="traffic-tab" className={tab === 'traffic' ? 'active' : ''} onClick={() => setTab('traffic')}>流量</button>
        <button className={tab === 'rules' ? 'active' : ''} onClick={() => setTab('rules')}>规则</button>
        <button className={tab === 'device' ? 'active' : ''} onClick={() => setTab('device')}>设备接入</button>
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>设置</button>
      </nav>
      <main className="content">
        {tab === 'traffic' && <TrafficPanel />}
        {tab === 'rules' && <RulesPanel />}
        {tab === 'device' && <DeviceGuide />}
        {tab === 'settings' && <SettingsPanel />}
      </main>
    </div>
  );
}
```

- [ ] **Step 2: 手动端到端验证（dev 模式）**

Run: `npm run dev`
依次验证：
1. 窗口打开，「流量」页显示空列表，状态栏绿点（实时连接）。
2. 状态栏点「启动」→ 显示「代理运行中 :8888」。
3. 「规则」页新建规则：URL 通配符 `http://api.example.com/*`，响应体 `{"ok":true}`，保存。
4. 终端执行：`curl -x http://127.0.0.1:8888 http://api.example.com/ping`
   Expected: 输出 `{"ok":true}`。
5. 「流量」页出现该请求，带 MOCK 标记，点开详情可见响应体。
6. 「设备接入」页显示二维码与本机 IP。

验证完关闭窗口。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "feat: assemble app shell with traffic/rules/device/settings tabs"
```

---

### Task 18: E2E 冒烟测试与收尾

**Files:**
- Create: `playwright.config.ts`, `e2e/smoke.spec.ts`, `README.md`

- [ ] **Step 1: `playwright.config.ts`**

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 120000,
  retries: 0,
  workers: 1,
});
```

- [ ] **Step 2: 写 E2E 测试 `e2e/smoke.spec.ts`**

```ts
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { fetch, ProxyAgent } from 'undici';

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'] });
  win = await app.firstWindow();
});

test.afterAll(async () => {
  await app.close();
});

test('app boots and mocks a request end-to-end', async () => {
  await win.waitForSelector('[data-testid="traffic-tab"]');

  // 确保代理在运行
  await win.evaluate(async () => {
    const status = await window.api.proxyStatus();
    if (!status.running) await window.api.proxyStart();
  });
  const status = await win.evaluate(() => window.api.proxyStatus());
  expect(status.running).toBe(true);

  // 通过 IPC 建一条规则（与 UI 走同一存储路径）
  await win.evaluate(async () => {
    await window.api.rulesAdd({
      name: 'e2e-rule',
      enabled: true,
      match: { urlType: 'exact', urlPattern: 'http://e2e.example.test/ping', method: 'ANY' },
      action: { status: 200, headers: { 'content-type': 'text/plain' }, body: 'e2e-mocked' },
    });
  });

  // 经代理发请求，断言 mock 生效
  const agent = new ProxyAgent(`http://127.0.0.1:${status.port}`);
  const res = await fetch('http://e2e.example.test/ping', { dispatcher: agent });
  expect(await res.text()).toBe('e2e-mocked');

  // 流量表中出现该请求（轮询等待）
  await expect(async () => {
    const text = await win.locator('.traffic-table').innerText();
    expect(text).toContain('e2e.example.test');
  }).toPass({ timeout: 10000 });

  // 清理规则，避免污染下次运行
  await win.evaluate(async () => {
    for (const r of await window.api.rulesList()) await window.api.rulesRemove(r.id);
  });
});
```

- [ ] **Step 3: 运行 E2E**

Run: `npx playwright install chromium`（首次需要；E2E 通过 _electron 驱动，无需浏览器内核，但安装一次避免缺失报错）
Run: `npm run test:e2e`
Expected: 1 test PASSED。若失败，先看 `test-results/` 输出定位是代理未启动还是规则未命中。

- [ ] **Step 4: 全量回归**

Run: `npm run test`
Expected: 所有单测/集成测试通过。
Run: `npm run typecheck`
Expected: 通过。

- [ ] **Step 5: 写 README.md**

```markdown
# Mocker

Charles 式本地抓包与 Mock 工具（开发者自用）。

## 功能（Phase 1）

- HTTP/HTTPS 抓包（HTTPS 白名单 MITM / 全量解密可切换）
- 实时流量列表与请求/响应详情
- 静态响应 Mock 规则（URL 精确/通配/正则 + method + query + 头 + 请求体包含）
- 根证书管理与手机扫码接入（Android / iOS）
- 系统代理一键开关（macOS / Windows）

## 开发

- `npm install`
- `npm run dev` 启动开发模式
- `npm test` 单元/集成测试
- `npm run test:e2e` E2E 冒烟
- `npm run typecheck` 类型检查

## 手机接入

1. 手机与电脑同网段，设置系统代理为 `电脑IP:8888`
2. 手机浏览器访问 `http://电脑IP:8888` 按指引安装证书
3. HTTPS 抓包：在「设置」中把目标域名加入白名单

## 已知限制

见「设备接入」页说明：Android 7+ 用户证书、SSL Pinning、iOS 私有中继、HTTP/3。

## 设计文档

`docs/superpowers/specs/2026-09-01-mocker-design.md`
```

- [ ] **Step 6: Commit**

```bash
git add playwright.config.ts e2e README.md
git commit -m "test: add electron e2e smoke test and readme"
```

---

## Self-Review 结论

- **规格覆盖**：§1 目标（Phase 1 范围）→ Task 17/18；§3 架构 → Task 10/11/13；§4 规则引擎（MVP 静态响应部分）→ Task 3/6/15；§4.3 存储与快照 → Task 4/5；§6 HTTPS/证书/设备接入 → Task 7/9/10/16；§7 存储布局 → Task 5/6/8/13；§8 系统代理 → Task 12/16；§10 错误处理（端口占用/握手失败条目）→ Task 10 client-error 与 Task 13 启动失败对话框；§11 测试 → Task 3-12 单测、Task 10 集成、Task 18 E2E。Phase 2/3 内容（脚本动作、延迟/故障、场景、重放、Schema、导入导出）按规格分期，不在本计划。
- **无占位符**：所有代码步骤均给出完整代码。
- **类型一致性**：`TrafficEvent`/`MockRule`/`Settings`/`Api` 在 shared/types.ts 与 shared/api.ts 定义一次，后续任务均引用同名类型与 `Api` 方法（`rulesAdd`/`rulesUpdate`/`proxyStatus` 等，与 Task 2 契约一致）。
