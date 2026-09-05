# 流量操作（第一期）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 mocker 实现 spec `docs/superpowers/specs/2026-09-06-traffic-operations-design.md` 定义的第一期功能：分面过滤、重放 + Compose、Copy as cURL（bash/cmd/PowerShell）、HAR 导入导出。

**Architecture:** main 进程新建独立 `replay` 服务（复用 rules 引擎，命中规则走 mock、未命中直连上游）；`proxy-server.handleMatched` 抽出纯计算函数保证两处 mock 行为一致；过滤/cURL/HAR 映射均为纯函数放 renderer lib 与 shared；UI 改动集中在 TrafficPanel / TrafficDetail / 新 ComposeModal。

**Tech Stack:** Electron + mockttp + React + zustand + vitest + Playwright（既有栈，无新依赖）。

**执行注意：**

- `npm run test:e2e` 需 8888/8899 端口空闲——先退出正在运行的 mocker 实例。
- 类型检查命令：`npm run typecheck`；单测：`npm test`。
- 提交信息风格沿用仓库惯例（`feat:` / `test:` / `docs:` / `refactor:`，scope 用模块名）。

---

## 文件结构总览

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/shared/types.ts` | 修改 | TrafficEvent 加 origin/replayedFromId；新增 ReplayRequest、TrafficFilter |
| `src/renderer/src/lib/traffic-filter.ts` | 新建 | 分面过滤纯函数 |
| `src/renderer/src/stores/traffic.ts` | 修改 | filter 升级为 TrafficFilter；加 setEvents |
| `src/renderer/src/components/TrafficPanel.tsx` | 修改 | 分面过滤栏 + HAR 导入导出按钮 + 重放/Compose 接线 |
| `src/renderer/src/lib/curl.ts` | 新建 | buildCurl 三方言 + 平台默认方言 |
| `src/renderer/src/components/TrafficDetail.tsx` | 修改 | 重放/Compose/Copy as cURL 按钮 + 方言下拉 |
| `src/shared/api.ts`、`src/preload/index.ts`、`src/main/ipc.ts` | 修改 | app:platform、replay:send、har:export、har:import 四条 IPC |
| `src/shared/har.ts` | 新建 | HAR 1.2 双向纯映射 |
| `src/main/rules/apply-rule.ts` | 新建 | computeMockResult（从 proxy-server 抽出） |
| `src/main/proxy/proxy-server.ts` | 修改 | handleMatched 改用 computeMockResult（行为不变） |
| `src/main/replay/replay.ts` | 新建 | ReplayService：命中规则 mock / 未命中直连上游 |
| `src/main/index.ts` | 修改 | 构造 ReplayService 并注入 IpcContext |
| `src/renderer/src/components/ComposeModal.tsx` | 新建 | 编辑后重发弹窗 |
| `src/renderer/src/components/TrafficTable.tsx` | 修改 | 重放/导入角标 |
| `src/renderer/src/styles.css` | 修改 | 过滤栏、角标、tab 行样式 |
| `e2e/traffic-ops.spec.ts` | 新建 | 过滤/重放/cURL 按钮 E2E |
| `tests/traffic-filter.test.ts`、`tests/curl.test.ts`、`tests/har.test.ts`、`tests/replay.test.ts` | 新建 | 单测 |

---

### Task 1: shared 类型扩展

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: 修改 TrafficEvent 并新增两个类型**

在 `TrafficEvent` 的 `errorTriggered?: boolean;` 之后追加两个字段；在文件末尾 `DELAY_MS_MAX` 之前插入两个新接口：

```ts
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
  renderWarnings?: string[];
  errorTriggered?: boolean;
  origin?: 'capture' | 'replay' | 'imported';
  replayedFromId?: string;
}

export interface ReplayRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface TrafficFilter {
  text: string;
  method: string;
  status: string;
  host: string;
}
```

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: 无错误（新类型无人引用，纯增量）

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(types): add origin/replayedFromId, ReplayRequest, TrafficFilter"
```

---

### Task 2: 分面过滤纯函数

**Files:**
- Create: `src/renderer/src/lib/traffic-filter.ts`
- Test: `tests/traffic-filter.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/traffic-filter.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { EMPTY_FILTER, matchesFilter } from '../src/renderer/src/lib/traffic-filter';
import type { TrafficEvent } from '../src/shared/types';

function event(overrides: Partial<TrafficEvent> = {}): TrafficEvent {
  return {
    id: 'e1',
    startedAt: 0,
    method: 'GET',
    url: 'http://api.example.com/users/7?page=2',
    host: 'api.example.com',
    path: '/users/7',
    status: 200,
    requestHeaders: { 'x-token': 'abc' },
    requestBody: '{"name":"伟"}',
    responseHeaders: { 'content-type': 'application/json' },
    responseBody: '{"ok":true}',
    mocked: false,
    ...overrides,
  };
}

describe('matchesFilter', () => {
  it('empty filter matches everything', () => {
    expect(matchesFilter(event(), EMPTY_FILTER)).toBe(true);
  });

  it('method match is case-insensitive', () => {
    expect(matchesFilter(event({ method: 'POST' }), { ...EMPTY_FILTER, method: 'get' })).toBe(false);
    expect(matchesFilter(event(), { ...EMPTY_FILTER, method: 'GET' })).toBe(true);
  });

  it('status buckets by first digit', () => {
    expect(matchesFilter(event(), { ...EMPTY_FILTER, status: '2' })).toBe(true);
    expect(matchesFilter(event(), { ...EMPTY_FILTER, status: '5' })).toBe(false);
  });

  it('in-flight events match no status bucket', () => {
    expect(matchesFilter(event({ status: undefined }), { ...EMPTY_FILTER, status: '2' })).toBe(false);
  });

  it('error bucket matches non-empty error field only', () => {
    expect(matchesFilter(event({ error: 'ECONNRESET' }), { ...EMPTY_FILTER, status: 'error' })).toBe(true);
    expect(matchesFilter(event(), { ...EMPTY_FILTER, status: 'error' })).toBe(false);
  });

  it('host is a case-insensitive substring match', () => {
    expect(matchesFilter(event(), { ...EMPTY_FILTER, host: 'EXAMPLE' })).toBe(true);
    expect(matchesFilter(event(), { ...EMPTY_FILTER, host: 'other.com' })).toBe(false);
  });

  it('full-text searches url, headers and bodies', () => {
    expect(matchesFilter(event(), { ...EMPTY_FILTER, text: 'users/7' })).toBe(true);
    expect(matchesFilter(event(), { ...EMPTY_FILTER, text: 'x-token' })).toBe(true);
    expect(matchesFilter(event(), { ...EMPTY_FILTER, text: 'ABC' })).toBe(true);
    expect(matchesFilter(event(), { ...EMPTY_FILTER, text: 'ok":true' })).toBe(true);
    expect(matchesFilter(event(), { ...EMPTY_FILTER, text: 'missing' })).toBe(false);
  });

  it('conditions AND together', () => {
    expect(matchesFilter(event(), { ...EMPTY_FILTER, method: 'GET', host: 'api.example.com', status: '2' })).toBe(true);
    expect(matchesFilter(event(), { ...EMPTY_FILTER, method: 'GET', status: '5' })).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- traffic-filter`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`src/renderer/src/lib/traffic-filter.ts`：

```ts
import type { TrafficEvent, TrafficFilter } from '../../../shared/types';

export const EMPTY_FILTER: TrafficFilter = { text: '', method: '', status: '', host: '' };

export function matchesFilter(e: TrafficEvent, f: TrafficFilter): boolean {
  if (f.method !== '' && e.method.toUpperCase() !== f.method.toUpperCase()) return false;
  if (f.status !== '' && !matchStatus(e, f.status)) return false;
  if (f.host !== '' && !e.host.toLowerCase().includes(f.host.toLowerCase())) return false;
  if (f.text !== '' && !matchText(e, f.text.toLowerCase())) return false;
  return true;
}

function matchStatus(e: TrafficEvent, bucket: string): boolean {
  if (bucket === 'error') return e.error !== undefined;
  if (e.status === undefined) return false;
  return String(e.status).startsWith(bucket);
}

function matchText(e: TrafficEvent, needle: string): boolean {
  return (
    e.url.toLowerCase().includes(needle) ||
    JSON.stringify(e.requestHeaders).toLowerCase().includes(needle) ||
    (e.requestBody ?? '').toLowerCase().includes(needle) ||
    JSON.stringify(e.responseHeaders ?? {}).toLowerCase().includes(needle) ||
    (e.responseBody ?? '').toLowerCase().includes(needle)
  );
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- traffic-filter`
Expected: 9 passed

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/traffic-filter.ts tests/traffic-filter.test.ts
git commit -m "feat(filter): faceted AND filter with full-text search over url/headers/bodies"
```

---

### Task 3: store 结构化 filter + TrafficPanel 分面过滤栏

**Files:**
- Modify: `src/renderer/src/stores/traffic.ts`
- Modify: `src/renderer/src/components/TrafficPanel.tsx`

- [ ] **Step 1: 升级 traffic store**

`src/renderer/src/stores/traffic.ts` 全文替换为：

```ts
import { create } from 'zustand';
import type { TrafficEvent, TrafficFilter } from '../../../shared/types';
import { EMPTY_FILTER } from '../lib/traffic-filter';

const MAX_EVENTS = 2000;

interface TrafficState {
  list: TrafficEvent[];
  connected: boolean;
  paused: boolean;
  filter: TrafficFilter;
  setFilter: (patch: Partial<TrafficFilter>) => void;
  setEvents: (events: TrafficEvent[]) => void;
  togglePause: () => void;
  clear: () => void;
  connect: (wsPort: number) => void;
}

let ws: WebSocket | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
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
  filter: { ...EMPTY_FILTER },
  setFilter: (patch) => set({ filter: { ...get().filter, ...patch } }),
  setEvents: (events) => set({ list: events.slice(-MAX_EVENTS) }),
  togglePause: () => set({ paused: !get().paused }),
  clear: () => {
    pending = [];
    set({ list: [] });
  },
  connect: (wsPort) => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (ws) return;
    const open = () => {
      retryTimer = null;
      ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
      ws.onopen = () => set({ connected: true });
      ws.onclose = () => {
        ws = null;
        set({ connected: false });
        retryTimer = setTimeout(open, 2000);
      };
      ws.onmessage = (msg) => {
        let data: { type: string; events?: TrafficEvent[]; event?: TrafficEvent };
        try {
          data = JSON.parse(msg.data);
        } catch {
          return;
        }
        if (data.type === 'snapshot') {
          set({ list: data.events!.slice(-MAX_EVENTS) });
          pending = [];
        } else if (data.type === 'event') {
          if (get().paused) {
            pending.push(data.event!);
            if (pending.length > MAX_EVENTS) pending.shift();
            return;
          }
          let list = get().list;
          for (const p of pending) list = upsert(list, p);
          pending = [];
          set({ list: upsert(list, data.event!) });
        }
      };
    };
    open();
  },
}));
```

- [ ] **Step 2: 重写 TrafficPanel 过滤栏**

`src/renderer/src/components/TrafficPanel.tsx` 全文替换为（导入/导出/重放等按钮在后续任务接线，此处仅过滤）：

```tsx
import { useEffect, useMemo, useState } from 'react';
import type { RuleInput, TrafficEvent } from '../../../shared/types';
import { captureToRuleInput } from '../lib/capture-to-rule';
import { EMPTY_FILTER, matchesFilter } from '../lib/traffic-filter';
import { useTrafficStore } from '../stores/traffic';
import RuleEditorModal from './RuleEditorModal';
import TrafficDetail from './TrafficDetail';
import TrafficTable from './TrafficTable';

const FILTER_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

export default function TrafficPanel() {
  const { list, filter, paused, setFilter, togglePause, clear } = useTrafficStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RuleInput | null>(null);
  const [textDraft, setTextDraft] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setFilter({ text: textDraft }), 200);
    return () => clearTimeout(t);
  }, [textDraft, setFilter]);

  const filtered = useMemo(() => list.filter((e) => matchesFilter(e, filter)), [list, filter]);

  const selected = useMemo(
    () => list.find((e) => e.id === selectedId) ?? null,
    [list, selectedId],
  );

  return (
    <div className="traffic-panel">
      <div className="toolbar">
        <select
          data-testid="filter-method"
          value={filter.method}
          onChange={(e) => setFilter({ method: e.target.value })}
        >
          <option value="">全部方法</option>
          {FILTER_METHODS.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <select
          data-testid="filter-status"
          value={filter.status}
          onChange={(e) => setFilter({ status: e.target.value })}
        >
          <option value="">全部状态</option>
          <option value="2">2xx</option>
          <option value="3">3xx</option>
          <option value="4">4xx</option>
          <option value="5">5xx</option>
          <option value="error">错误</option>
        </select>
        <input
          data-testid="filter-host"
          className="filter-host"
          placeholder="域名…"
          value={filter.host}
          onChange={(e) => setFilter({ host: e.target.value })}
        />
        <input
          data-testid="filter-text"
          placeholder="搜索 URL / 头 / 体…"
          value={textDraft}
          onChange={(e) => setTextDraft(e.target.value)}
        />
        <button data-testid="filter-clear" onClick={() => { setTextDraft(''); setFilter(EMPTY_FILTER); }}>
          清除
        </button>
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

- [ ] **Step 3: 追加样式**

`src/renderer/src/styles.css` 在 `.toolbar input { flex: 1; max-width: 420px; }` 之后追加：

```css
.toolbar select { max-width: 130px; }
.toolbar .filter-host { flex: 0 1 180px; }
```

- [ ] **Step 4: 类型检查 + 全量单测**

Run: `npm run typecheck && npm test`
Expected: 全部通过（store 是既有消费方，行为兼容——`filter` 对象只在组件内消费）

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/stores/traffic.ts src/renderer/src/components/TrafficPanel.tsx src/renderer/src/styles.css
git commit -m "feat(ui): faceted traffic filter (method/status/host/full-text)"
```

---

### Task 4: Copy as cURL 纯函数（三方言）

**Files:**
- Create: `src/renderer/src/lib/curl.ts`
- Test: `tests/curl.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/curl.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { buildCurl, defaultDialectFor } from '../src/renderer/src/lib/curl';
import type { TrafficEvent } from '../src/shared/types';

function event(overrides: Partial<TrafficEvent> = {}): TrafficEvent {
  return {
    id: 'e1',
    startedAt: 0,
    method: 'POST',
    url: 'http://api.example.com/orders',
    host: 'api.example.com',
    path: '/orders',
    status: 201,
    requestHeaders: {
      host: 'api.example.com',
      'content-type': 'application/json',
      'content-length': '15',
      connection: 'keep-alive',
      'x-token': "it's",
    },
    requestBody: '{"amount":100}',
    mocked: false,
    ...overrides,
  };
}

describe('buildCurl', () => {
  it('bash: quotes url/headers/body, escapes single quotes, skips hop-by-hop headers', () => {
    const cmd = buildCurl(event(), 'bash');
    expect(cmd.startsWith('curl -X POST ')).toBe(true);
    expect(cmd).toContain("'http://api.example.com/orders'");
    expect(cmd).toContain("-H 'content-type: application/json'");
    expect(cmd).toContain("-H 'x-token: it'\\''s'");
    expect(cmd).not.toContain('host:');
    expect(cmd).not.toContain('content-length');
    expect(cmd).not.toContain('connection');
    expect(cmd).toContain("--data-binary '{\"amount\":100}'");
  });

  it('bash: continues lines with backslash', () => {
    expect(buildCurl(event(), 'bash')).toContain(' \\\n  -H ');
  });

  it('cmd: double quotes, backslash-slash escape, caret continuation', () => {
    const cmd = buildCurl(event(), 'cmd');
    expect(cmd).toContain('"http://api.example.com/orders"');
    expect(cmd).toContain('-H "x-token: it\\"s"');
    expect(cmd).toContain(' ^\n  ');
  });

  it('powershell: backtick escape and backtick continuation', () => {
    const cmd = buildCurl(event(), 'powershell');
    expect(cmd).toContain(' `\n  ');
    expect(cmd).toContain('-H "x-token: it`s"');
  });

  it('binary body becomes a comment instead of data (bash)', () => {
    const cmd = buildCurl(event({ requestBody: '\u0000\u0001binary' }), 'bash');
    expect(cmd).not.toContain('--data-binary');
    expect(cmd).toContain('# 请求体含二进制');
  });

  it('binary body comment uses REM in cmd', () => {
    const cmd = buildCurl(event({ requestBody: '\u0000' }), 'cmd');
    expect(cmd).toContain('REM 请求体含二进制');
  });

  it('no body means no data flag', () => {
    expect(buildCurl(event({ requestBody: undefined }), 'bash')).not.toContain('--data-binary');
  });

  it('defaultDialectFor maps platform', () => {
    expect(defaultDialectFor('macos')).toBe('bash');
    expect(defaultDialectFor('windows')).toBe('cmd');
    expect(defaultDialectFor('other')).toBe('bash');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- curl`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`src/renderer/src/lib/curl.ts`：

```ts
import type { TrafficEvent } from '../../../shared/types';

export type CurlDialect = 'bash' | 'cmd' | 'powershell';

/** 重放/复现时无意义或由 curl 自动处理的头，不进命令行。 */
export const SKIP_HEADERS = new Set(['host', 'content-length', 'connection', 'accept-encoding']);

const CONTINUATION: Record<CurlDialect, string> = {
  bash: ' \\',
  cmd: ' ^',
  powershell: ' `',
};

export function defaultDialectFor(platform: 'macos' | 'windows' | 'other'): CurlDialect {
  if (platform === 'windows') return 'cmd';
  return 'bash';
}

export function buildCurl(event: TrafficEvent, dialect: CurlDialect): string {
  const args: string[] = [`-X ${event.method}`, quote(event.url, dialect)];
  for (const [k, v] of Object.entries(event.requestHeaders)) {
    if (SKIP_HEADERS.has(k.toLowerCase())) continue;
    args.push(`-H ${quote(`${k}: ${v}`, dialect)}`);
  }

  const notes: string[] = [];
  const body = event.requestBody ?? '';
  if (hasBinary(body)) {
    notes.push(comment(dialect, '请求体含二进制字符，请自行处理'));
  } else if (body !== '') {
    args.push(`--data-binary ${quote(body, dialect)}`);
  }

  const head = `curl ${args[0]}`;
  const tail = args.slice(1);
  const cmd = tail.length === 0 ? head : [head, ...tail].join(`${CONTINUATION[dialect]}\n  `);
  return notes.length > 0 ? `${cmd}\n${notes.join('\n')}` : cmd;
}

function quote(s: string, dialect: CurlDialect): string {
  if (dialect === 'bash') return `'${s.replace(/'/g, `'\\''`)}'`;
  const escaped = dialect === 'cmd' ? s.replace(/"/g, '\\"') : s.replace(/"/g, '`"');
  return `"${escaped}"`;
}

function comment(dialect: CurlDialect, text: string): string {
  return dialect === 'cmd' ? `REM ${text}` : `# ${text}`;
}

function hasBinary(s: string): boolean {
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- curl`
Expected: 8 passed

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/curl.ts tests/curl.test.ts
git commit -m "feat(curl): copy-as-cURL generator with bash/cmd/powershell dialects"
```

---

### Task 5: HAR 1.2 双向映射纯函数

**Files:**
- Create: `src/shared/har.ts`
- Test: `tests/har.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/har.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { fromHar, toHar } from '../src/shared/har';
import type { TrafficEvent } from '../src/shared/types';

function event(overrides: Partial<TrafficEvent> = {}): TrafficEvent {
  return {
    id: 'evt-1',
    startedAt: 1_700_000_000_000,
    completedAt: 1_700_000_000_120,
    method: 'POST',
    url: 'http://api.example.com/orders?page=2',
    host: 'api.example.com',
    path: '/orders',
    status: 200,
    requestHeaders: { 'content-type': 'application/json' },
    requestBody: '{"a":1}',
    responseHeaders: { 'content-type': 'application/json' },
    responseBody: '{"ok":true}',
    mocked: true,
    matchedRuleId: 'r1',
    origin: 'capture',
    ...overrides,
  };
}

describe('toHar', () => {
  it('maps an event to HAR 1.2 with mock metadata', () => {
    const har = toHar([event()]);
    expect(har.log.version).toBe('1.2');
    expect(har.log.creator.name).toBe('Mocker');
    const entry = har.log.entries[0]!;
    expect(entry.startedDateTime).toBe(new Date(1_700_000_000_000).toISOString());
    expect(entry.time).toBe(120);
    expect(entry.request.method).toBe('POST');
    expect(entry.request.queryString).toEqual([{ name: 'page', value: '2' }]);
    expect(entry.request.postData?.text).toBe('{"a":1}');
    expect(entry.response.status).toBe(200);
    expect(entry.response.content.text).toBe('{"ok":true}');
    expect(entry._mocked).toBe(true);
    expect(entry._matchedRuleId).toBe('r1');
    expect(entry._origin).toBe('capture');
  });

  it('drops entries that never completed', () => {
    const har = toHar([event({ completedAt: undefined }), event({ id: 'done' })]);
    expect(har.log.entries).toHaveLength(1);
    expect(har.log.entries[0]!.request.url).not.toBe(''); // 完成的那条在
  });
});

describe('fromHar', () => {
  it('round-trips through toHar with fresh ids and origin=imported', () => {
    const back = fromHar(JSON.stringify(toHar([event()])));
    expect(back).toHaveLength(1);
    const e = back[0]!;
    expect(e.id).not.toBe('evt-1');
    expect(e.method).toBe('POST');
    expect(e.url).toBe('http://api.example.com/orders?page=2');
    expect(e.host).toBe('api.example.com');
    expect(e.path).toBe('/orders?page=2');
    expect(e.status).toBe(200);
    expect(e.requestHeaders).toEqual({ 'content-type': 'application/json' });
    expect(e.requestBody).toBe('{"a":1}');
    expect(e.responseBody).toBe('{"ok":true}');
    expect(e.mocked).toBe(true);
    expect(e.matchedRuleId).toBe('r1');
    expect(e.origin).toBe('imported');
    expect(e.completedAt! - e.startedAt).toBe(120);
  });

  it('throws on non-JSON input', () => {
    expect(() => fromHar('nope')).toThrow();
  });

  it('throws when log.entries is missing', () => {
    expect(() => fromHar(JSON.stringify({ log: {} }))).toThrow();
  });

  it('tolerates minimal entries', () => {
    const events = fromHar(
      JSON.stringify({
        log: {
          version: '1.2',
          creator: { name: 'x' },
          entries: [
            {
              startedDateTime: '2026-01-01T00:00:00.000Z',
              time: 5,
              request: { method: 'GET', url: 'http://a.example.com/' },
              response: { status: 200 },
            },
          ],
        },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe(200);
    expect(events[0]!.requestBody).toBe('');
    expect(events[0]!.mocked).toBe(false);
    expect(events[0]!.origin).toBe('imported');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- har`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`src/shared/har.ts`：

```ts
import type { TrafficEvent } from './types';

export interface HarNameValuePair {
  name: string;
  value: string;
}

export interface HarHeader extends HarNameValuePair {}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    headers: HarHeader[];
    queryString: HarNameValuePair[];
    cookies: unknown[];
    headersSize: number;
    bodySize: number;
    postData?: { mimeType: string; text: string };
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    headers: HarHeader[];
    content: { size: number; mimeType: string; text: string };
    redirectURL: string;
    headersSize: number;
    bodySize: number;
  };
  cache: Record<string, unknown>;
  timings: { send: number; wait: number; receive: number };
  _mocked?: boolean;
  _matchedRuleId?: string;
  _origin?: string;
}

export interface HarLog {
  log: {
    version: string;
    creator: { name: string };
    entries: HarEntry[];
  };
}

export function toHar(events: TrafficEvent[]): HarLog {
  return {
    log: {
      version: '1.2',
      creator: { name: 'Mocker' },
      entries: events.filter((e) => e.completedAt !== undefined).map(toEntry),
    },
  };
}

export function fromHar(text: string): TrafficEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('文件不是合法 JSON');
  }
  const entries = (parsed as { log?: { entries?: unknown } })?.log?.entries;
  if (!Array.isArray(entries)) throw new Error('HAR 缺少 log.entries');
  const now = Date.now();
  return entries.map((raw, index) => entryToEvent(raw, now, index));
}

function toEntry(e: TrafficEvent): HarEntry {
  const time = e.completedAt! - e.startedAt;
  const body = e.requestBody ?? '';
  const queryString: HarNameValuePair[] = [];
  try {
    new URL(e.url).searchParams.forEach((v, k) => queryString.push({ name: k, value: v }));
  } catch {
    // 非法 URL 时 queryString 留空
  }
  return {
    startedDateTime: new Date(e.startedAt).toISOString(),
    time,
    request: {
      method: e.method,
      url: e.url,
      httpVersion: 'HTTP/1.1',
      headers: toHeaderList(e.requestHeaders),
      queryString,
      cookies: [],
      headersSize: -1,
      bodySize: body.length,
      ...(body !== ''
        ? { postData: { mimeType: headerValue(e.requestHeaders, 'content-type') ?? 'unknown', text: body } }
        : {}),
    },
    response: {
      status: e.status ?? 0,
      statusText: '',
      httpVersion: 'HTTP/1.1',
      headers: toHeaderList(e.responseHeaders),
      content: {
        size: (e.responseBody ?? '').length,
        mimeType: headerValue(e.responseHeaders, 'content-type') ?? 'unknown',
        text: e.responseBody ?? '',
      },
      redirectURL: '',
      headersSize: -1,
      bodySize: -1,
    },
    cache: {},
    timings: { send: 0, wait: time, receive: 0 },
    _mocked: e.mocked,
    ...(e.matchedRuleId !== undefined ? { _matchedRuleId: e.matchedRuleId } : {}),
    ...(e.origin !== undefined ? { _origin: e.origin } : {}),
  };
}

function entryToEvent(raw: unknown, now: number, index: number): TrafficEvent {
  const entry = (raw ?? {}) as Partial<HarEntry> & Record<string, unknown>;
  const request = (entry.request ?? {}) as Partial<HarEntry['request']>;
  const response = (entry.response ?? {}) as Partial<HarEntry['response']>;
  const url = String(request.url ?? '');
  let host = '';
  let path = url;
  try {
    const u = new URL(url);
    host = u.hostname;
    path = u.pathname + u.search;
  } catch {
    // 非法 URL 保留原样
  }
  const startedAt = Date.parse(String(entry.startedDateTime ?? '')) || now;
  return {
    id: `import-${now.toString(36)}-${index}`,
    startedAt,
    completedAt: startedAt + (typeof entry.time === 'number' ? entry.time : 0),
    method: String(request.method ?? 'GET').toUpperCase(),
    url,
    host,
    path,
    status: typeof response.status === 'number' && response.status > 0 ? response.status : undefined,
    requestHeaders: fromHeaderList(request.headers),
    requestBody: request.postData?.text ?? '',
    responseHeaders: fromHeaderList(response.headers),
    responseBody: response.content?.text ?? '',
    mocked: entry._mocked === true,
    matchedRuleId: typeof entry._matchedRuleId === 'string' ? entry._matchedRuleId : undefined,
    origin: 'imported',
  };
}

function toHeaderList(headers?: Record<string, string>): HarHeader[] {
  return Object.entries(headers ?? {}).map(([name, value]) => ({ name, value }));
}

function fromHeaderList(list: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    const h = item as Partial<HarHeader>;
    if (typeof h.name === 'string' && h.name !== '') out[h.name] = String(h.value ?? '');
  }
  return out;
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- har`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add src/shared/har.ts tests/har.test.ts
git commit -m "feat(har): bidirectional HAR 1.2 mapping for TrafficEvent"
```

---

### Task 6: 抽出 computeMockResult（proxy-server 行为不变）

**Files:**
- Create: `src/main/rules/apply-rule.ts`
- Modify: `src/main/proxy/proxy-server.ts`
- Test: 既有 `tests/proxy.integration.test.ts`、`tests/network-error.test.ts` 兜底

- [ ] **Step 1: 新建 apply-rule.ts**

`src/main/rules/apply-rule.ts`：

```ts
import type { MockRule, RenderContext } from '../../shared/types';
import { renderTemplate } from './template';
import { resolveNetworkError, type NetworkErrorResolution } from './network-error';
import { sleep } from '../util/sleep';

export interface MockComputation {
  status: number;
  headers: Record<string, string>;
  body: string;
  warnings: string[];
  /** 概率网络异常命中时的处理决定；null 表示走正常 mock 响应。 */
  networkError: NetworkErrorResolution | null;
}

export interface MockComputationOptions {
  signal?: AbortSignal;
  rng?: () => number;
}

/**
 * 纯计算：给定命中规则与渲染上下文，算出代理/重放共用的 mock 结果。
 * 顺序与原 proxy-server.handleMatched 一致：概率异常 → 固定延迟 → 模板渲染。
 * signal 在延迟期间中止时抛出（调用方决定如何收尾）。
 */
export async function computeMockResult(
  matched: MockRule,
  ctx: RenderContext,
  options: MockComputationOptions = {},
): Promise<MockComputation> {
  const ne = matched.action.networkError;
  const rng = options.rng ?? Math.random;
  if (ne && rng() * 100 < ne.probability) {
    return { status: 0, headers: {}, body: '', warnings: [], networkError: resolveNetworkError(ne) };
  }

  const delayMs = matched.action.delayMs ?? 0;
  if (delayMs > 0) {
    await sleep(delayMs, options.signal);
  }

  const warnings: string[] = [];
  const body = renderTemplate(matched.action.body, ctx, matched.action.fakerLocale, warnings);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(matched.action.headers)) {
    headers[k] = renderTemplate(v, ctx, matched.action.fakerLocale, warnings);
  }
  return { status: matched.action.status, headers, body, warnings, networkError: null };
}
```

- [ ] **Step 2: proxy-server.handleMatched 改用共享函数**

`src/main/proxy/proxy-server.ts` 修改三处。

① 头部 import 区，删除不再使用的 `renderTemplate` 与 `resolveNetworkError` 导入，新增：

```ts
import { computeMockResult, type MockComputation } from '../rules/apply-rule';
```

（`renderTemplate`、`resolveNetworkError`、`RenderContext` type-only 导入若仅 handleMatched 使用则一并清理；`sleep` 仍被别处使用与否以实际为准——当前只有 handleMatched 使用，删除 `import { sleep } from '../util/sleep';`。）

② 整个 `handleMatched` 方法替换为：

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
    try {
      result = await computeMockResult(matched, buildRenderContext(req, bodyText), {
        signal: this.abort?.signal,
      });
    } catch {
      // Proxy is stopping; drop the request rather than forward it.
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
      return {
        response: { statusCode: resolution.statusCode, headers: {}, body: '' },
      };
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

- [ ] **Step 3: 跑全部相关测试确认行为不变**

Run: `npm test -- proxy network-error engine`
Expected: 全部 PASS（与重构前一致）

- [ ] **Step 4: 类型检查**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 5: Commit**

```bash
git add src/main/rules/apply-rule.ts src/main/proxy/proxy-server.ts
git commit -m "refactor(rules): extract computeMockResult shared by proxy and replay"
```

---

### Task 7: ReplayService（命中规则 mock / 未命中直连上游）

**Files:**
- Create: `src/main/replay/replay.ts`
- Test: `tests/replay.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/replay.test.ts`：

```ts
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReplayService } from '../src/main/replay/replay';
import type { MockRule, TrafficEvent } from '../src/shared/types';

let server: Server;
let port: number;
let calls = 0;
const seen: { path?: string; body?: string; headers?: Record<string, unknown> } = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    calls += 1;
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.path = req.url;
      seen.body = body;
      seen.headers = req.headers;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"upstream":true}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

function service(rules: MockRule[] = []): { svc: ReplayService; events: TrafficEvent[] } {
  const events: TrafficEvent[] = [];
  return { svc: new ReplayService({ getRules: () => rules, onEvent: (e) => events.push(e) }), events };
}

describe('sendReplay passthrough', () => {
  it('sends method/headers/body upstream and records the response', async () => {
    const before = calls;
    const { svc, events } = service();
    const id = await svc.send({
      method: 'POST',
      url: `http://127.0.0.1:${port}/echo?x=1`,
      headers: {
        'content-type': 'application/json',
        'content-length': '7',
        host: 'elsewhere.example.com',
        connection: 'keep-alive',
      },
      body: '{"a":1}',
    });
    expect(calls).toBe(before + 1);
    expect(seen.path).toBe('/echo?x=1');
    expect(seen.body).toBe('{"a":1}');
    expect(seen.headers?.['content-type']).toBe('application/json');
    expect(seen.headers?.host).toBe(`127.0.0.1:${port}`);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.id).toBe(id);
    expect(e.id.startsWith('replay-')).toBe(true);
    expect(e.origin).toBe('replay');
    expect(e.status).toBe(200);
    expect(e.responseBody).toBe('{"upstream":true}');
    expect(e.completedAt).toBeDefined();
  });

  it('records connection failures in error', async () => {
    const { svc, events } = service();
    await svc.send({ method: 'GET', url: 'http://127.0.0.1:1/nope', headers: {}, body: '' });
    expect(events[0]!.error).toBeDefined();
    expect(events[0]!.completedAt).toBeDefined();
  });
});

describe('sendReplay with rules', () => {
  function mockRule(url: string): MockRule {
    return {
      id: 'r1',
      name: 'mock',
      enabled: true,
      priority: 0,
      match: { urlType: 'exact', urlPattern: url, method: 'ANY' },
      action: { status: 418, headers: { 'x-mock': 'yes' }, body: 'mocked-body' },
    };
  }

  it('returns the mock without touching the network', async () => {
    const before = calls;
    const { svc, events } = service([mockRule(`http://127.0.0.1:${port}/mocked`)]);

    const id = await svc.send({
      method: 'POST',
      url: `http://127.0.0.1:${port}/mocked`,
      headers: {},
      body: 'x',
    }, 'evt-origin');

    expect(calls).toBe(before);
    const e = events[0]!;
    expect(e.id).toBe(id);
    expect(e.mocked).toBe(true);
    expect(e.matchedRuleId).toBe('r1');
    expect(e.status).toBe(418);
    expect(e.responseHeaders?.['x-mock']).toBe('yes');
    expect(e.responseBody).toBe('mocked-body');
    expect(e.replayedFromId).toBe('evt-origin');
  });

  it('renders templates with the replay request context', async () => {
    const rule = mockRule(`http://127.0.0.1:${port}/tpl`);
    rule.action = { status: 200, headers: {}, body: 'q={{req.query.x}}' };
    const { svc, events } = service([rule]);
    await svc.send({ method: 'GET', url: `http://127.0.0.1:${port}/tpl?x=7`, headers: {}, body: '' });
    expect(events[0]!.responseBody).toBe('q=7');
  });

  it('fires probabilistic network error at 100%', async () => {
    const rule = mockRule(`http://127.0.0.1:${port}/err`);
    rule.action = {
      status: 200,
      headers: {},
      body: 'unused',
      networkError: { probability: 100, type: 'HTTP_STATUS', errorStatusCode: 504 },
    };
    const { svc, events } = service([rule]);
    await svc.send({ method: 'GET', url: `http://127.0.0.1:${port}/err`, headers: {}, body: '' });
    const e = events[0]!;
    expect(e.errorTriggered).toBe(true);
    expect(e.error).toBe('network-error:HTTP_STATUS');
    expect(e.status).toBe(504);
  });

  it('connection-level error leaves status undefined', async () => {
    const rule = mockRule(`http://127.0.0.1:${port}/reset`);
    rule.action = {
      status: 200,
      headers: {},
      body: 'unused',
      networkError: { probability: 100, type: 'ECONNRESET' },
    };
    const { svc, events } = service([rule]);
    await svc.send({ method: 'GET', url: `http://127.0.0.1:${port}/reset`, headers: {}, body: '' });
    const e = events[0]!;
    expect(e.errorTriggered).toBe(true);
    expect(e.error).toBe('network-error:ECONNRESET');
    expect(e.status).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- replay`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`src/main/replay/replay.ts`：

```ts
import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import type { MockRule, RenderContext, ReplayRequest, TrafficEvent } from '../../shared/types';
import { computeMockResult } from '../rules/apply-rule';
import { findMatchingRule } from '../rules/engine';
import type { RequestDescription } from '../rules/matcher';

export const REPLAY_TIMEOUT_MS = 30_000;

export interface ReplayDeps {
  getRules: () => MockRule[];
  onEvent: (event: TrafficEvent) => void;
}

export class ReplayService {
  constructor(private readonly deps: ReplayDeps) {}

  send(input: ReplayRequest, replayedFromId?: string): Promise<string> {
    return sendReplay(this.deps, input, replayedFromId);
  }
}

async function sendReplay(
  deps: ReplayDeps,
  input: ReplayRequest,
  replayedFromId?: string,
): Promise<string> {
  const url = new URL(input.url);
  const id = `replay-${randomUUID()}`;
  const description: RequestDescription = {
    method: input.method.toUpperCase(),
    url: input.url,
    query: url.searchParams,
    headers: input.headers,
    body: input.body,
  };
  const event: TrafficEvent = {
    id,
    startedAt: Date.now(),
    method: description.method,
    url: input.url,
    host: url.hostname,
    path: url.pathname + url.search,
    requestHeaders: input.headers,
    mocked: false,
    origin: 'replay',
    ...(replayedFromId !== undefined ? { replayedFromId } : {}),
  };

  const matched = findMatchingRule(deps.getRules(), description);
  if (matched) {
    await applyMock(deps, event, matched, description, url.host);
  } else {
    await sendUpstream(deps, event, input, url);
  }
  return id;
}

async function applyMock(
  deps: ReplayDeps,
  event: TrafficEvent,
  matched: MockRule,
  description: RequestDescription,
  host: string,
): Promise<void> {
  const result = await computeMockResult(matched, toRenderContext(description, host));
  event.mocked = true;
  event.matchedRuleId = matched.id;
  if (result.networkError) {
    event.errorTriggered = true;
    event.error = `network-error:${matched.action.networkError?.type ?? ''}`;
    if (result.networkError.kind === 'respond') {
      event.status = result.networkError.statusCode;
      event.responseHeaders = {};
      event.responseBody = '';
    }
  } else {
    event.status = result.status;
    event.responseHeaders = result.headers;
    event.responseBody = result.body;
    event.renderWarnings = result.warnings.length > 0 ? result.warnings : undefined;
  }
  event.completedAt = Date.now();
  deps.onEvent(event);
}

function toRenderContext(req: RequestDescription, host: string): RenderContext {
  const query: Record<string, string> = {};
  req.query.forEach((v, k) => {
    query[k] = v;
  });
  const url = new URL(req.url);
  return {
    method: req.method,
    url: req.url,
    host,
    path: url.pathname + url.search,
    query,
    headers: req.headers,
    body: req.body,
  };
}

async function sendUpstream(
  deps: ReplayDeps,
  event: TrafficEvent,
  input: ReplayRequest,
  url: URL,
): Promise<void> {
  const mod = url.protocol === 'https:' ? https : http;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) {
    if (SKIP.has(k.toLowerCase())) continue;
    headers[k] = v;
  }
  const body = input.body !== '' ? Buffer.from(input.body, 'utf8') : undefined;
  try {
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = mod.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || undefined,
          path: url.pathname + url.search,
          method: event.method,
          headers: body ? { ...headers, 'content-length': String(body.length) } : headers,
        },
        resolve,
      );
      req.on('error', reject);
      req.setTimeout(REPLAY_TIMEOUT_MS, () => req.destroy(new Error('replay-timeout')));
      if (body) req.write(body);
      req.end();
    });
    const chunks: Buffer[] = [];
    for await (const chunk of res) chunks.push(chunk as Buffer);
    event.status = res.statusCode;
    event.responseHeaders = flatten(res.headers);
    event.responseBody = Buffer.concat(chunks).toString('utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    event.error = e.code ?? e.message;
  }
  event.completedAt = Date.now();
  deps.onEvent(event);
}

const SKIP = new Set(['host', 'connection', 'content-length', 'accept-encoding']);

function flatten(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}
```

实现说明（写给执行者）：
- `applyMock` 必须 `await`：单测在 `send()` 返回后立即断言事件，fire-and-forget 会产生竞态。
- `SKIP` 与 renderer `lib/curl.ts` 的 `SKIP_HEADERS` 语义相同；main 不 import renderer 代码，此处独立声明。
- 未跟随重定向：`http.request` 默认不跟随，3xx 原样记录。

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- replay`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add src/main/replay/replay.ts tests/replay.test.ts
git commit -m "feat(replay): ReplayService with rule-matched mock and direct upstream send"
```

---

### Task 8: 四条 IPC + Api/preload 扩展 + main 接线

**Files:**
- Modify: `src/shared/api.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/ipc.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: 扩展 Api 接口**

`src/shared/api.ts` 顶部 import 增加 `ReplayRequest, TrafficEvent`：

```ts
import type { CertInfo, CertInstallCommands, MockRule, ProxyStatus, RenderContext, ReplayRequest, RuleAction, RuleInput, RulePatch, Settings, TrafficEvent } from './types';
```

`Api` 接口末尾（`systemProxyStatus` 之后）追加：

```ts
  appPlatform(): Promise<'macos' | 'windows' | 'other'>;
  replaySend(input: ReplayRequest, replayedFromId?: string): Promise<string>;
  harExport(payload: { events: TrafficEvent[]; defaultName: string }): Promise<{ saved: boolean; filePath?: string }>;
  harImport(): Promise<{ events: TrafficEvent[] | null }>;
```

- [ ] **Step 2: preload 透传**

`src/preload/index.ts` import 增加 `ReplayRequest`、`TrafficEvent` 类型；`api` 对象末尾追加：

```ts
  appPlatform: () => ipcRenderer.invoke('app:platform'),
  replaySend: (input: ReplayRequest, replayedFromId?: string) =>
    ipcRenderer.invoke('replay:send', input, replayedFromId),
  harExport: (payload: { events: TrafficEvent[]; defaultName: string }) =>
    ipcRenderer.invoke('har:export', payload),
  harImport: () => ipcRenderer.invoke('har:import'),
```

- [ ] **Step 3: 注册 handler**

`src/main/ipc.ts`：

① import 区改为：

```ts
import { BrowserWindow, dialog, ipcMain } from 'electron';
import * as fs from 'node:fs';
```

并新增：

```ts
import { fromHar, toHar } from '../shared/har';
import type { ReplayRequest, TrafficEvent } from '../shared/types';
import type { OpenDialogOptions, SaveDialogOptions } from 'electron';
import type { ReplayService } from './replay/replay';
```

② `IpcContext` 增加字段 `replay: ReplayService;`

③ `registerIpc` 末尾（`system-proxy:status` 之后）追加：

```ts
  ipcMain.handle('app:platform', () =>
    process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'other',
  );

  ipcMain.handle('replay:send', (_e, input: ReplayRequest, replayedFromId?: string) =>
    ctx.replay.send(input, replayedFromId),
  );

  ipcMain.handle('har:export', async (_e, payload: { events: TrafficEvent[]; defaultName: string }) => {
    const { canceled, filePath } = await showSaveDialog({
      defaultPath: payload.defaultName,
      filters: [{ name: 'HAR', extensions: ['har'] }],
    });
    if (canceled || !filePath) return { saved: false as const };
    await fs.promises.writeFile(filePath, JSON.stringify(toHar(payload.events), null, 2), 'utf8');
    return { saved: true as const, filePath };
  });

  ipcMain.handle('har:import', async () => {
    const { canceled, filePaths } = await showOpenDialog({
      filters: [{ name: 'HAR', extensions: ['har'] }],
      properties: ['openFile'],
    });
    if (canceled || filePaths.length === 0) return { events: null };
    const text = await fs.promises.readFile(filePaths[0]!, 'utf8');
    return { events: fromHar(text) };
  });
```

④ `registerIpc` 函数之后、文件末尾追加两个模块级辅助函数（Electron 的 dialog 单参重载不接受 `BrowserWindow | undefined`，必须按有无窗口分流）：

```ts
async function showSaveDialog(opts: SaveDialogOptions) {
  const win = BrowserWindow.getFocusedWindow();
  return win ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts);
}

async function showOpenDialog(opts: OpenDialogOptions) {
  const win = BrowserWindow.getFocusedWindow();
  return win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts);
}
```

- [ ] **Step 4: main/index.ts 构造 ReplayService**

`src/main/index.ts`：

① 新增 import：

```ts
import { ReplayService } from './replay/replay';
```

② `bootstrap` 中把 `onEvent` 回调提为局部变量，proxy 与 replay 共用——将现有

```ts
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
```

替换为：

```ts
  const onEvent = (event: TrafficEvent): void => {
    bridge.publish(event);
    history.write(event);
  };
  const proxy = new ProxyServer({
    caKey: ca.keyPem,
    caCert: ca.certPem,
    getSettings: () => settings.get(),
    getRules: () => rules.list(),
    onEvent,
  });
  const replay = new ReplayService({ getRules: () => rules.list(), onEvent });
```

并在文件顶部 import 区加 `import type { TrafficEvent } from '../shared/types';`。

③ `registerIpc({ ... })` 调用里补 `replay,` 一行。

- [ ] **Step 5: 类型检查**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add src/shared/api.ts src/preload/index.ts src/main/ipc.ts src/main/index.ts
git commit -m "feat(ipc): app:platform, replay:send, har:export, har:import channels"
```

---

### Task 9: TrafficDetail 按钮（重放 / Compose / Copy as cURL）

**Files:**
- Modify: `src/renderer/src/components/TrafficDetail.tsx`

- [ ] **Step 1: 重写 TrafficDetail**

注意：Hooks 必须在 early return 之前。全文替换为：

```tsx
import { useEffect, useState } from 'react';
import type { TrafficEvent } from '../../../shared/types';
import { api } from '../lib/api';
import { buildCurl, defaultDialectFor, type CurlDialect } from '../lib/curl';

function pretty(body: string | undefined): string {
  if (!body) return '';
  if (body.length > 500_000) {
    return body.slice(0, 500_000) + '\n…（内容过长已截断）';
  }
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

interface Props {
  event: TrafficEvent | null;
  onCaptureToRule?: (event: TrafficEvent) => void;
  onReplay?: (event: TrafficEvent) => void;
  onCompose?: (event: TrafficEvent) => void;
}

export default function TrafficDetail({ event, onCaptureToRule, onReplay, onCompose }: Props) {
  const [dialect, setDialect] = useState<CurlDialect>('bash');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.appPlatform()
      .then((p) => setDialect(defaultDialectFor(p)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setCopied(false);
  }, [event?.id]);

  if (!event) return <div className="detail empty">选择一个请求查看详情</div>;

  const copyCurl = async () => {
    try {
      await navigator.clipboard.writeText(buildCurl(event, dialect));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="detail">
      <div className="detail-head">
        <h3>{event.method} {event.url}</h3>
        {onCaptureToRule && (
          <button data-testid="capture-to-rule" onClick={() => onCaptureToRule(event)}>
            转为规则
          </button>
        )}
        {onReplay && (
          <button data-testid="replay" onClick={() => onReplay(event)}>
            重放
          </button>
        )}
        {onCompose && (
          <button data-testid="compose" onClick={() => onCompose(event)}>
            编辑后重发…
          </button>
        )}
        <select
          data-testid="curl-dialect"
          aria-label="cURL 方言"
          value={dialect}
          onChange={(e) => setDialect(e.target.value as CurlDialect)}
        >
          <option value="bash">bash</option>
          <option value="cmd">cmd</option>
          <option value="powershell">PowerShell</option>
        </select>
        <button data-testid="copy-curl" onClick={copyCurl}>
          {copied ? '已复制' : 'Copy as cURL'}
        </button>
      </div>
      {event.error && <div className="text-err">错误：{event.error}</div>}
      {event.mocked && <div className="text-ok">由规则命中（{event.matchedRuleId}）</div>}
      {event.errorTriggered && <div className="text-warn">本次命中网络异常分支</div>}
      {event.renderWarnings && event.renderWarnings.length > 0 && (
        <details>
          <summary>模板告警 ({event.renderWarnings.length})</summary>
          <ul>
            {event.renderWarnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
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

- [ ] **Step 2: 样式**

`src/renderer/src/styles.css` 在 `.detail-head h3` 规则之后追加：

```css
.detail-head select { max-width: 110px; }
```

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/TrafficDetail.tsx src/renderer/src/styles.css
git commit -m "feat(ui): replay/compose/copy-as-curl actions in traffic detail"
```

---

### Task 10: ComposeModal（编辑后重发）

**Files:**
- Create: `src/renderer/src/components/ComposeModal.tsx`
- Modify: `src/renderer/src/styles.css`

- [ ] **Step 1: 新建 ComposeModal**

```tsx
import { useState } from 'react';
import type { HeaderRow, HttpMethod, ReplayRequest, TrafficEvent } from '../../../shared/types';
import { api } from '../lib/api';
import { SKIP_HEADERS } from '../lib/curl';
import EditableTable from './EditableTable';
import JsonBodyEditor from './JsonBodyEditor';

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
type ComposeBodyMode = 'none' | 'raw' | 'form-data' | 'urlencoded';

const BODY_MODES: Array<{ value: ComposeBodyMode; label: string }> = [
  { value: 'none', label: '无' },
  { value: 'raw', label: 'raw' },
  { value: 'form-data', label: 'form-data' },
  { value: 'urlencoded', label: 'x-www-form-urlencoded' },
];

const EMPTY_ROW: HeaderRow = { enabled: true, name: '', value: '', description: '' };

function toMethod(raw: string): HttpMethod {
  const upper = raw.toUpperCase();
  return (METHODS as string[]).includes(upper) ? (upper as HttpMethod) : 'GET';
}

function rowsFromHeaders(headers: Record<string, string>): HeaderRow[] {
  const rows = Object.entries(headers)
    .filter(([k]) => !SKIP_HEADERS.has(k.toLowerCase()))
    .map(([name, value]) => ({ enabled: true, name, value, description: '' }));
  return rows.length > 0 ? rows : [{ ...EMPTY_ROW }];
}

function hasContentType(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
}

interface Props {
  seed: TrafficEvent;
  onClose: () => void;
  onSent: (id: string) => void;
}

export default function ComposeModal({ seed, onClose, onSent }: Props) {
  const [method, setMethod] = useState<HttpMethod>(toMethod(seed.method));
  const [url, setUrl] = useState(seed.url);
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>(() => rowsFromHeaders(seed.requestHeaders));
  const [mode, setMode] = useState<ComposeBodyMode>(seed.requestBody ? 'raw' : 'none');
  const [raw, setRaw] = useState(seed.requestBody ?? '');
  const [formRows, setFormRows] = useState<HeaderRow[]>([{ ...EMPTY_ROW }]);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);

  const send = async () => {
    setError('');
    try {
      new URL(url);
    } catch {
      setError('URL 不合法');
      return;
    }
    const headers: Record<string, string> = {};
    for (const r of headerRows) {
      if (r.enabled && r.name.trim() !== '') headers[r.name.trim()] = r.value;
    }

    let body = '';
    if (mode === 'raw') {
      body = raw;
    } else if (mode === 'urlencoded') {
      const params = new URLSearchParams();
      for (const r of formRows) {
        if (r.enabled && r.name.trim() !== '') params.append(r.name.trim(), r.value);
      }
      body = params.toString();
      if (!hasContentType(headers)) headers['content-type'] = 'application/x-www-form-urlencoded';
    } else if (mode === 'form-data') {
      const boundary = `----Mocker${Date.now().toString(36)}`;
      const parts: string[] = [];
      for (const r of formRows) {
        if (!r.enabled || r.name.trim() === '') continue;
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${r.name.trim()}"\r\n\r\n${r.value}\r\n`);
      }
      body = `${parts.join('')}--${boundary}--\r\n`;
      if (!hasContentType(headers)) {
        headers['content-type'] = `multipart/form-data; boundary=${boundary}`;
      }
    }

    const payload: ReplayRequest = { method, url, headers, body };
    setSending(true);
    try {
      const id = await api.replaySend(payload, seed.id);
      onSent(id);
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>编辑后重发</h3>
        <div className="form-row">
          <select
            data-testid="compose-method"
            aria-label="方法"
            value={method}
            onChange={(e) => setMethod(e.target.value as HttpMethod)}
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <input
            data-testid="compose-url"
            placeholder="完整 URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            style={{ flex: 1 }}
          />
        </div>
        <h4>请求头</h4>
        <EditableTable rows={headerRows} onChange={setHeaderRows} columns={{ description: false }} ariaLabel="请求头" />
        <h4>请求体</h4>
        <div className="tab-row">
          {BODY_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              className={mode === m.value ? 'active' : ''}
              data-testid={`compose-body-${m.value}`}
              onClick={() => setMode(m.value)}
            >
              {m.label}
            </button>
          ))}
        </div>
        {mode === 'raw' && (/^[\s]*[[{]/.test(raw) ? (
          <JsonBodyEditor value={raw} onChange={setRaw} ariaLabel="raw 请求体" />
        ) : (
          <textarea
            data-testid="compose-raw"
            aria-label="raw 请求体"
            rows={10}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
          />
        ))}
        {(mode === 'form-data' || mode === 'urlencoded') && (
          <EditableTable rows={formRows} onChange={setFormRows} columns={{ description: false }} ariaLabel="表单字段" />
        )}
        {error && <div className="text-err" data-testid="compose-error">{error}</div>}
        <div className="modal-actions">
          <button onClick={onClose}>取消</button>
          <button data-testid="compose-send" disabled={sending} onClick={send}>
            {sending ? '发送中…' : '发送'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 样式**

`src/renderer/src/styles.css` 追加：

```css
.tab-row { display: flex; gap: 6px; margin: 6px 0; }
.tab-row button.active { font-weight: 600; text-decoration: underline; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
```

（`form-row` 类若 styles.css 不存在则同样补一条：`.form-row { display: flex; gap: 8px; align-items: center; }`。）

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/ComposeModal.tsx src/renderer/src/styles.css
git commit -m "feat(ui): compose modal for edited replay"
```

---

### Task 11: TrafficPanel 总接线 + TrafficTable 角标

**Files:**
- Modify: `src/renderer/src/components/TrafficPanel.tsx`
- Modify: `src/renderer/src/components/TrafficTable.tsx`
- Modify: `src/renderer/src/styles.css`

- [ ] **Step 1: TrafficPanel 接上重放/Compose/HAR**

在 Task 3 版本基础上修改（`useTrafficStore` 解构加 `setEvents`；import 区加 `api` 与 `ComposeModal`）：

```tsx
import { api } from '../lib/api';
import ComposeModal from './ComposeModal';
```

组件内新增状态与回调（放在 `textDraft` 之后）：

```tsx
  const [composeSeed, setComposeSeed] = useState<TrafficEvent | null>(null);
  const [actionError, setActionError] = useState('');
```

（同时给 `useTrafficStore()` 解构补上 `setEvents`。）

toolbar 中「清除」按钮之后、「暂停」之前插入三个控件：

```tsx
        <button data-testid="har-export" disabled={!filtered.some((e) => e.completedAt !== undefined)} onClick={exportHar}>
          导出 HAR
        </button>
        <button data-testid="har-import" onClick={importHar}>
          导入 HAR
        </button>
        {actionError && <span className="text-err">{actionError}</span>}
```

组件内、`return` 之前定义三个回调：

```tsx
  const replay = async (event: TrafficEvent) => {
    setActionError('');
    try {
      const id = await api.replaySend(
        { method: event.method, url: event.url, headers: event.requestHeaders, body: event.requestBody ?? '' },
        event.id,
      );
      setSelectedId(id);
    } catch (err) {
      setActionError(String(err));
    }
  };

  const exportHar = async () => {
    setActionError('');
    try {
      await api.harExport({
        events: filtered.filter((e) => e.completedAt !== undefined),
        defaultName: `mocker-${new Date().toISOString().replace(/[:.]/g, '-')}.har`,
      });
    } catch (err) {
      setActionError(String(err));
    }
  };

  const importHar = async () => {
    setActionError('');
    try {
      const res = await api.harImport();
      if (!res.events) return;
      if (list.length > 0 && !window.confirm(`导入 ${res.events.length} 条将替换当前流量列表，继续？`)) return;
      setEvents(res.events);
      setSelectedId(null);
    } catch (err) {
      setActionError(String(err));
    }
  };
```

`TrafficDetail` 调用改为：

```tsx
        <TrafficDetail
          event={selected}
          onCaptureToRule={(e) => setDraft(captureToRuleInput(e))}
          onReplay={replay}
          onCompose={(e) => setComposeSeed(e)}
        />
```

`draft` modal 之后追加：

```tsx
      {composeSeed && (
        <ComposeModal
          seed={composeSeed}
          onClose={() => setComposeSeed(null)}
          onSent={(id) => {
            setComposeSeed(null);
            setSelectedId(id);
          }}
        />
      )}
```

- [ ] **Step 2: TrafficTable 角标**

`src/renderer/src/components/TrafficTable.tsx` 中

```tsx
              {e.mocked && <span className="badge">MOCK</span>}
```

之后追加：

```tsx
              {e.origin === 'replay' && <span className="badge badge-replay">重放</span>}
              {e.origin === 'imported' && <span className="badge badge-import">导入</span>}
```

- [ ] **Step 3: 样式**

`src/renderer/src/styles.css` 在 `.badge` 规则之后追加：

```css
.badge-replay { background: #7a3bf6; }
.badge-import { background: #0f9d58; }
```

- [ ] **Step 4: 类型检查 + 单测**

Run: `npm run typecheck && npm test`
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/TrafficPanel.tsx src/renderer/src/components/TrafficTable.tsx src/renderer/src/styles.css
git commit -m "feat(ui): wire replay/compose/har into traffic panel, add origin badges"
```

---

### Task 12: E2E（过滤 / 重放 / cURL 按钮）

**Files:**
- Create: `e2e/traffic-ops.spec.ts`

前置：8888/8899 端口空闲（退出正在运行的 mocker 实例）。全流程不依赖外部网络（全部走 e2e.example.test 的 mock 规则）。

- [ ] **Step 1: 写 E2E spec**

`e2e/traffic-ops.spec.ts`：

```ts
import { _electron as electron, test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { fetch, ProxyAgent } from 'undici';

let app: ElectronApplication;
let win: Page;

const RULE_NAMES = ['e2e-filter-get', 'e2e-filter-post', 'e2e-filter-404', 'e2e-replay'];

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'] });
  win = await app.firstWindow();
});

test.afterAll(async () => {
  await win.evaluate(async (names: string[]) => {
    for (const r of await window.api.rulesList()) {
      if (names.includes(r.name)) await window.api.rulesRemove(r.id);
    }
  }, RULE_NAMES);
  await app.close();
});

async function ensureProxy(): Promise<number> {
  await win.evaluate(async () => {
    const status = await window.api.proxyStatus();
    if (!status.running) await window.api.proxyStart();
  });
  return (await win.evaluate(() => window.api.proxyStatus())).port;
}

async function fetchViaProxy(port: number, method: string, url: string): Promise<void> {
  const agent = new ProxyAgent(`http://127.0.0.1:${port}`);
  try {
    await fetch(url, { method, dispatcher: agent });
  } finally {
    await agent.close();
  }
}

test('faceted filter narrows the traffic list', async () => {
  const port = await ensureProxy();

  await win.evaluate(async (names: string[]) => {
    await window.api.rulesAdd({
      name: names[0]!,
      enabled: true,
      match: { urlType: 'exact', urlPattern: 'http://e2e.example.test/filter-get', method: 'GET' },
      action: { status: 200, headers: { 'content-type': 'text/plain' }, body: 'get-ok' },
    });
    await window.api.rulesAdd({
      name: names[1]!,
      enabled: true,
      match: { urlType: 'exact', urlPattern: 'http://e2e.example.test/filter-post', method: 'POST' },
      action: { status: 200, headers: { 'content-type': 'text/plain' }, body: 'post-ok' },
    });
    await window.api.rulesAdd({
      name: names[2]!,
      enabled: true,
      match: { urlType: 'exact', urlPattern: 'http://e2e.example.test/filter-404', method: 'GET' },
      action: { status: 404, headers: {}, body: 'missing' },
    });
  }, RULE_NAMES);

  await fetchViaProxy(port, 'GET', 'http://e2e.example.test/filter-get');
  await fetchViaProxy(port, 'POST', 'http://e2e.example.test/filter-post');
  await fetchViaProxy(port, 'GET', 'http://e2e.example.test/filter-404');

  const table = win.locator('.traffic-table');
  await expect(async () => {
    const text = await table.innerText();
    expect(text).toContain('filter-get');
    expect(text).toContain('filter-post');
    expect(text).toContain('filter-404');
  }).toPass({ timeout: 10_000 });

  // 方法过滤
  await win.locator('[data-testid="filter-method"]').selectOption('GET');
  await expect(async () => {
    const text = await table.innerText();
    expect(text).toContain('filter-get');
    expect(text).not.toContain('filter-post');
  }).toPass({ timeout: 5_000 });
  await win.locator('[data-testid="filter-method"]').selectOption('');

  // 状态过滤
  await win.locator('[data-testid="filter-status"]').selectOption('4');
  await expect(async () => {
    const text = await table.innerText();
    expect(text).toContain('filter-404');
    expect(text).not.toContain('filter-get');
  }).toPass({ timeout: 5_000 });
  await win.locator('[data-testid="filter-status"]').selectOption('');

  // 全文搜索（命中请求 URL 子串）
  await win.locator('[data-testid="filter-text"]').fill('filter-post');
  await expect(async () => {
    const text = await table.innerText();
    expect(text).toContain('filter-post');
    expect(text).not.toContain('filter-get');
  }).toPass({ timeout: 5_000 });

  // 清除
  await win.locator('[data-testid="filter-clear"]').click();
  await expect(async () => {
    const text = await table.innerText();
    expect(text).toContain('filter-get');
    expect(text).toContain('filter-post');
  }).toPass({ timeout: 5_000 });
});

test('replay produces a new entry that honors mock rules', async () => {
  const port = await ensureProxy();
  await win.evaluate(async (names: string[]) => {
    await window.api.rulesAdd({
      name: names[3]!,
      enabled: true,
      match: { urlType: 'exact', urlPattern: 'http://e2e.example.test/replay-me', method: 'ANY' },
      action: { status: 201, headers: { 'content-type': 'text/plain' }, body: 'replayed' },
    });
  }, RULE_NAMES);

  await fetchViaProxy(port, 'POST', 'http://e2e.example.test/replay-me');
  const firstRow = win.locator('.traffic-table .row', { hasText: 'replay-me' }).first();
  await firstRow.waitFor({ state: 'visible', timeout: 10_000 });

  const rowsBefore = await win.locator('.traffic-table .row', { hasText: 'replay-me' }).count();
  await firstRow.click();
  await win.locator('[data-testid="replay"]').click();

  await expect(async () => {
    const rows = await win.locator('.traffic-table .row', { hasText: 'replay-me' }).count();
    expect(rows).toBe(rowsBefore + 1);
  }).toPass({ timeout: 10_000 });

  // 新条目带「重放」角标，且命中规则（201）
  await expect(win.locator('.badge-replay')).toHaveCount(1, { timeout: 10_000 });
});

test('copy as cURL copies to clipboard and shows feedback', async () => {
  const row = win.locator('.traffic-table .row', { hasText: 'replay-me' }).first();
  await row.click();
  await win.locator('[data-testid="copy-curl"]').click();
  await expect(win.locator('[data-testid="copy-curl"]')).toHaveText('已复制', { timeout: 5_000 });
});
```

- [ ] **Step 2: 运行 E2E**

Run: `npm run test:e2e -- --grep "faceted|replay|copy as cURL"`
Expected: 3 passed（端口被占用时先退出运行中的 mocker 实例再跑）

- [ ] **Step 3: Commit**

```bash
git add e2e/traffic-ops.spec.ts
git commit -m "test(e2e): faceted filter, replay, copy-as-curl flows"
```

---

### Task 13: README 文档 + 全量验证

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 更新 README**

在「### 表格编辑」一节之后追加：

```markdown
### 流量操作

「流量」页工具栏与详情区提供四个日常操作：

- **分面过滤**：方法下拉、状态码下拉（2xx–5xx、错误）、域名输入、全文搜索框（URL + 请求/响应头 + 请求/响应体），条件 AND 组合；「清除」一键还原
- **重放 / 编辑后重发**：详情区「重放」原样重发选中请求；「编辑后重发…」打开弹窗可改方法、URL、请求头与请求体（none / raw / form-data / urlencoded）再发。重放会照常命中 Mock 规则（含延迟 / 异常 / 模板），新条目带「重放」角标，可继续链式重放
- **Copy as cURL**：详情区复制选中请求为 cURL 命令，方言可选 bash / cmd / PowerShell（默认跟随当前系统），hop-by-hop 头自动省略
- **HAR 导入 / 导出**：「导出 HAR」把当前过滤结果存为 HAR 1.2 文件（保留 mock 标记）；「导入 HAR」加载外部 HAR 文件并替换当前流量列表查看，导入条目带「导入」角标，同样支持转规则
```

- [ ] **Step 2: 全量验证**

Run: `npm run typecheck && npm test`
Expected: 全部通过

Run（确认 8888/8899 空闲后）: `npm run test:e2e`
Expected: 全部通过（含既有 spec）

- [ ] **Step 3: 手工冒烟（UI 路径，E2E 无法覆盖对话框）**

Run: `npm run dev`，然后：
1. 抓任意请求 → 详情区选 PowerShell → Copy as cURL → 粘贴到终端可执行
2. 重放一条请求 → 列表出现带「重放」角标的新条目
3. 「导出 HAR」→ 保存的文件可被 chrome devtools 导入
4. 「导入 HAR」→ 选择上一步文件 → 列表替换为导入条目（带「导入」角标）

发现问题时回到对应 Task 修复后重新验证。

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: traffic operations (filter/replay/curl/har) usage"
```

---

## 计划自审记录

- **Spec 覆盖**：分面过滤（Task 2/3）、重放+Compose（Task 6/7/8/9/10/11）、Copy as cURL 三方言（Task 4/5/9）、HAR 双向（Task 5/8/11）、平台兼容（Task 4/5/8 的 app:platform）、回归面（Task 6 重构 + Task 13 全量回归）、测试（各任务 + Task 12/13）——spec 第 1–9 节均有对应任务。
- **占位符**：无 TBD/TODO；所有代码步骤给出完整代码。
- **类型一致性**：`ReplayService.send(input, replayedFromId?)` ↔ IPC `replay:send` ↔ `api.replaySend`；`TrafficFilter` 四字段在 Task 1/2/3 一致；`CurlDialect` 三值在 Task 4/5/9 一致；`HarEntry` 字段在 Task 5 内自洽；`EMPTY_FILTER`/`matchesFilter`/`SKIP_HEADERS` 导出名各处一致。
