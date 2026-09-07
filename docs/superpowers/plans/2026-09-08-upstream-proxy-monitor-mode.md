# 上游代理与互斥监控模式 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** mockttp 转发流量可经用户配置的上游代理（含 noProxy 直连名单），并以「关/手机/电脑」互斥模式一键切换抓包入口。

**Architecture:** 上游代理用 mockttp 原生 `thenPassThrough({ proxyConfig })`（`ProxySetting = { proxyUrl, noProxy }`），不自研转发；模式切换为主进程单一 IPC `monitor:set-mode`，编排逻辑抽成可单测的 `src/main/monitor-mode.ts`；持久化全部走现有 `SettingsStore`（settings.json，JsonStore 读时合并默认值，旧文件免迁移）。设置面板已有「保存并重启代理」链路（SettingsPanel.tsx:40-45），上游字段搭车即可自动生效，无需新重启逻辑。

**Tech Stack:** Electron + mockttp 4.6.1（`proxyConfig`，见 node_modules/mockttp/dist/rules/passthrough-handling-definitions.d.ts:91）、React、Vitest、Playwright（electron.launch）。

**Spec:** docs/superpowers/specs/2026-09-08-upstream-proxy-monitor-mode-design.md

**基线（已验证）**：`npm run typecheck` 无错误；`npx vitest run` 423/423 通过。所有 `Settings` 构造处均为 `{ ...DEFAULT_SETTINGS }` 展开，新增字段无破坏。

---

### Task 1: 共享类型与上游工具函数

**Files:**
- Modify: `src/shared/types.ts:86-93`（Settings）、`src/shared/types.ts:127-134`（DEFAULT_SETTINGS）
- Create: `src/shared/upstream.ts`
- Test: `tests/upstream.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/upstream.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { parseNoProxyList, validateUpstreamProxyUrl } from '../src/shared/upstream';

describe('parseNoProxyList', () => {
  it('splits on comma, semicolon and newline', () => {
    expect(parseNoProxyList('a.com, b.com;c.com\nd.com')).toEqual(['a.com', 'b.com', 'c.com', 'd.com']);
  });
  it('drops empty entries', () => {
    expect(parseNoProxyList(' , a.com;;\n')).toEqual(['a.com']);
  });
  it('returns empty array for empty input', () => {
    expect(parseNoProxyList('')).toEqual([]);
  });
});

describe('validateUpstreamProxyUrl', () => {
  it('accepts empty (feature disabled)', () => {
    expect(validateUpstreamProxyUrl('')).toBeNull();
  });
  it('accepts supported protocols', () => {
    for (const url of [
      'http://127.0.0.1:7890',
      'https://proxy.corp:8443',
      'socks5://127.0.0.1:7892',
      'pac+http://127.0.0.1:8080/proxy.pac',
    ]) {
      expect(validateUpstreamProxyUrl(url)).toBeNull();
    }
  });
  it('accepts credentials in URL', () => {
    expect(validateUpstreamProxyUrl('http://user:pass@proxy.corp:8080')).toBeNull();
  });
  it('rejects unsupported protocol and garbage', () => {
    expect(validateUpstreamProxyUrl('ftp://x')).toMatch(/无效/);
    expect(validateUpstreamProxyUrl('not a url')).toMatch(/无效/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/upstream.test.ts`
Expected: FAIL（`Cannot find module '../src/shared/upstream'`）

- [ ] **Step 3: 实现 shared/upstream.ts 并加类型字段**

创建 `src/shared/upstream.ts`：

```ts
export const UPSTREAM_PROXY_PROTOCOLS = ['http:', 'https:', 'socks5:', 'pac+http:'];

export function parseNoProxyList(raw: string): string[] {
  return raw
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function validateUpstreamProxyUrl(raw: string): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (UPSTREAM_PROXY_PROTOCOLS.includes(parsed.protocol)) return null;
  } catch {
    // 落到下面的错误返回
  }
  return '上游代理 URL 无效：支持 http:// https:// socks5:// pac+http://';
}
```

`src/shared/types.ts` — 在 `export type HttpsMode = 'whitelist' | 'full';`（第 84 行）后加：

```ts
export type MonitorMode = 'off' | 'phone' | 'computer';
```

`Settings` 接口（第 86-93 行）加三个字段：

```ts
export interface Settings {
  proxyPort: number;
  wsPort: number;
  httpsMode: HttpsMode;
  whitelist: string[];
  autoStartProxy: boolean;
  throttle: ThrottleSettings;
  upstreamProxyUrl: string;
  upstreamNoProxy: string;
  monitorMode: MonitorMode;
}
```

`DEFAULT_SETTINGS`（第 127-134 行）加：

```ts
export const DEFAULT_SETTINGS: Settings = {
  proxyPort: 8888,
  wsPort: 8899,
  httpsMode: 'whitelist',
  whitelist: [],
  autoStartProxy: true,
  throttle: { enabled: false, preset: 'three-g', ...THROTTLE_PRESETS['three-g'] },
  upstreamProxyUrl: '',
  upstreamNoProxy: '',
  monitorMode: 'off',
};
```

- [ ] **Step 4: 跑测试与 typecheck 确认通过**

Run: `npx vitest run tests/upstream.test.ts && npm run typecheck`
Expected: 测试 PASS；typecheck 无错误（存量 Settings 构造全是展开，不受影响）

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/shared/upstream.ts tests/upstream.test.ts
git commit -m "feat(shared): upstream proxy settings fields and no-proxy parsing"
```

---

### Task 2: proxy-server 接入 proxyConfig（集成测试先行）

**Files:**
- Modify: `src/main/proxy/proxy-server.ts`（doStart 内 thenPassThrough，约 140-160 行）
- Test: `tests/upstream-proxy.integration.test.ts`（新建）

- [ ] **Step 1: 写失败集成测试**

创建 `tests/upstream-proxy.integration.test.ts`（基架仿照 tests/proxy.integration.test.ts）：

```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { AddressInfo } from 'node:net';
import { fetch, ProxyAgent } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureCa } from '../src/main/certs/ca';
import { ProxyServer } from '../src/main/proxy/proxy-server';
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/types';

let proxy: ProxyServer;
let fakeUpstream: Server; // 充当电脑上已有的那层代理
let upstreamHits = 0;
let directServer: Server; // noProxy 命中时直连的目标
let directHits = 0;
let settings: Settings;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'mocker-upstream-'));
  const ca = await ensureCa(tmpDir);

  fakeUpstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    upstreamHits += 1;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('via-upstream');
  });
  fakeUpstream.listen(0);
  await once(fakeUpstream, 'listening');
  const upstreamPort = (fakeUpstream.address() as AddressInfo).port;

  directServer = createServer((_req, res) => {
    directHits += 1;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('direct-ok');
  });
  directServer.listen(0);
  await once(directServer, 'listening');

  settings = {
    ...DEFAULT_SETTINGS,
    proxyPort: 0,
    upstreamProxyUrl: `http://127.0.0.1:${upstreamPort}`,
    upstreamNoProxy: '127.0.0.1',
  };
  proxy = new ProxyServer({
    caKey: ca.keyPem,
    caCert: ca.certPem,
    getSettings: () => settings,
    getRules: () => [],
    onEvent: () => {},
  });
  await proxy.start();
});

afterAll(async () => {
  await proxy.stop();
  fakeUpstream.close();
  directServer.close();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('upstream proxy', () => {
  it('forwards unmatched requests through the configured upstream proxy', async () => {
    const agent = new ProxyAgent(`http://127.0.0.1:${proxy.port}`);
    const res = await fetch('http://api.example.test/ping', { dispatcher: agent });
    expect(await res.text()).toBe('via-upstream');
    expect(upstreamHits).toBe(1);
  });

  it('sends noProxy-matched hosts direct, bypassing the upstream', async () => {
    const directPort = (directServer.address() as AddressInfo).port;
    const agent = new ProxyAgent(`http://127.0.0.1:${proxy.port}`);
    const res = await fetch(`http://127.0.0.1:${directPort}/x`, { dispatcher: agent });
    expect(await res.text()).toBe('direct-ok');
    expect(directHits).toBe(1);
    expect(upstreamHits).toBe(1); // 未新增，证明没走上游
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/upstream-proxy.integration.test.ts`
Expected: 第一个用例 FAIL（未配上游时 `api.example.test` 无法解析，fetch 抛错；`via-upstream` 断言不到）

- [ ] **Step 3: 在 doStart 的 thenPassThrough 加 proxyConfig**

`src/main/proxy/proxy-server.ts` 顶部加 import：

```ts
import { parseNoProxyList } from '../../shared/upstream';
```

把 `await server.forAnyRequest().always().thenPassThrough({` 一段（约 147 行）改为：

```ts
    const upstreamUrl = settings.upstreamProxyUrl.trim();
    await server.forAnyRequest().always().thenPassThrough({
      proxyConfig: upstreamUrl
        ? { proxyUrl: upstreamUrl, noProxy: parseNoProxyList(settings.upstreamNoProxy) }
        : undefined,
      beforeRequest: (req) => this.handle(req),
```

`beforeResponse` 及其后内容保持不变。说明：`settings` 在 doStart 开头读取，重启代理即换新配置；`proxyConfig` 类型为 mockttp `ProxyConfig`（`ProxySetting` 结构匹配）。noProxy 匹配语义由 mockttp 内置 `matchesNoProxy`（curl 风格）实现。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/upstream-proxy.integration.test.ts`
Expected: 2 个用例 PASS

- [ ] **Step 5: 全量回归**

Run: `npx vitest run && npm run typecheck`
Expected: 全部 PASS（含原 proxy.integration 423+ 用例），typecheck 无错误

- [ ] **Step 6: Commit**

```bash
git add src/main/proxy/proxy-server.ts tests/upstream-proxy.integration.test.ts
git commit -m "feat(proxy): forward pass-through traffic via configurable upstream proxy"
```

---

### Task 3: monitor-mode 编排模块（TDD）

**Files:**
- Create: `src/main/monitor-mode.ts`
- Test: `tests/monitor-mode.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/monitor-mode.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { applyMonitorMode, type MonitorModeDeps } from '../src/main/monitor-mode';

function makeDeps(over: Partial<MonitorModeDeps> = {}): MonitorModeDeps {
  return {
    proxyRunning: vi.fn(() => true),
    startProxy: vi.fn(async () => {}),
    systemProxySetByUs: vi.fn(() => false),
    restoreSystemProxy: vi.fn(async () => {}),
    enableSystemProxy: vi.fn(async () => {}),
    setupPhoneProxy: vi.fn(async () => ({ ok: true, message: 'ok' })),
    clearPhoneProxy: vi.fn(async () => ({ ok: true, message: 'ok' })),
    persistMode: vi.fn(async () => {}),
    ...over,
  };
}

describe('applyMonitorMode', () => {
  it('phone: restores system proxy first, then sets phone proxy, persists mode', async () => {
    const d = makeDeps({ systemProxySetByUs: vi.fn(() => true) });
    const r = await applyMonitorMode('phone', d);
    expect(d.restoreSystemProxy).toHaveBeenCalledOnce();
    expect(d.setupPhoneProxy).toHaveBeenCalledOnce();
    expect(d.persistMode).toHaveBeenCalledWith('phone');
    expect(r.notice).toBeUndefined();
  });

  it('phone: device offline keeps mode persisted and surfaces adb message', async () => {
    const d = makeDeps({
      setupPhoneProxy: vi.fn(async () => ({ ok: false, message: '未检测到已授权设备' })),
    });
    const r = await applyMonitorMode('phone', d);
    expect(r.notice).toContain('未检测到已授权设备');
    expect(d.persistMode).toHaveBeenCalledWith('phone');
  });

  it('phone: starts proxy when not running', async () => {
    const d = makeDeps({ proxyRunning: vi.fn(() => false) });
    await applyMonitorMode('phone', d);
    expect(d.startProxy).toHaveBeenCalledOnce();
  });

  it('computer: clears phone proxy, enables system proxy, does not touch restore', async () => {
    const d = makeDeps();
    const r = await applyMonitorMode('computer', d);
    expect(d.clearPhoneProxy).toHaveBeenCalledOnce();
    expect(d.enableSystemProxy).toHaveBeenCalledOnce();
    expect(d.restoreSystemProxy).not.toHaveBeenCalled();
    expect(d.persistMode).toHaveBeenCalledWith('computer');
    expect(r.notice).toBeUndefined();
  });

  it('off: clears phone proxy and restores system proxy', async () => {
    const d = makeDeps({ systemProxySetByUs: vi.fn(() => true) });
    await applyMonitorMode('off', d);
    expect(d.clearPhoneProxy).toHaveBeenCalledOnce();
    expect(d.restoreSystemProxy).toHaveBeenCalledOnce();
    expect(d.persistMode).toHaveBeenCalledWith('off');
  });

  it('off: clearing phone proxy best-effort, failure adds no notice', async () => {
    const d = makeDeps({
      clearPhoneProxy: vi.fn(async () => ({ ok: false, message: '未检测到已授权设备' })),
    });
    const r = await applyMonitorMode('off', d);
    expect(r.notice).toBeUndefined();
    expect(d.persistMode).toHaveBeenCalledWith('off');
  });

  it('computer: enable failure surfaces notice but still persists', async () => {
    const d = makeDeps({
      enableSystemProxy: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const r = await applyMonitorMode('computer', d);
    expect(r.notice).toContain('boom');
    expect(d.persistMode).toHaveBeenCalledWith('computer');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/monitor-mode.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 src/main/monitor-mode.ts**

```ts
import type { AdbOpResult, MonitorMode } from '../shared/types';

export interface MonitorModeDeps {
  proxyRunning: () => boolean;
  startProxy: () => Promise<void>;
  systemProxySetByUs: () => boolean;
  restoreSystemProxy: () => Promise<void>;
  enableSystemProxy: () => Promise<void>;
  setupPhoneProxy: () => Promise<AdbOpResult>;
  clearPhoneProxy: () => Promise<AdbOpResult>;
  persistMode: (mode: MonitorMode) => Promise<void>;
}

export interface MonitorModeResult {
  mode: MonitorMode;
  notice?: string;
}

function errText(err: unknown): string {
  return String((err as Error)?.message ?? err);
}

export async function applyMonitorMode(
  mode: MonitorMode,
  d: MonitorModeDeps,
): Promise<MonitorModeResult> {
  const notices: string[] = [];

  // 目标不是电脑模式时，先恢复系统代理（互斥：一次只监控一边）
  if (mode !== 'computer' && d.systemProxySetByUs()) {
    try {
      await d.restoreSystemProxy();
    } catch (err) {
      notices.push(`恢复系统代理失败：${errText(err)}`);
    }
  }

  // 目标不是手机模式时，尽力清掉手机代理
  if (mode !== 'phone') {
    try {
      await d.clearPhoneProxy();
    } catch {
      // 设备不在线等：尽力而为，静默
    }
  }

  if (mode === 'phone') {
    if (!d.proxyRunning()) await d.startProxy();
    const res = await d.setupPhoneProxy();
    if (!res.ok) notices.push(res.message);
  } else if (mode === 'computer') {
    if (!d.proxyRunning()) await d.startProxy();
    try {
      await d.enableSystemProxy();
    } catch (err) {
      notices.push(`设置系统代理失败：${errText(err)}`);
    }
  }

  await d.persistMode(mode);
  return { mode, notice: notices.length ? notices.join('；') : undefined };
}
```

说明：`AdbOpResult` 在 `src/shared/types.ts:239`。手机代理设置失败/设备不在线返回 `ok:false`（不抛错），仅进 notice；模式始终持久化（用户拍板：设备不在线不算失败）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/monitor-mode.test.ts`
Expected: 7 个用例 PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/monitor-mode.ts tests/monitor-mode.test.ts
git commit -m "feat(main): atomic monitor-mode orchestration module"
```

---

### Task 4: IPC/preload/Api 接线 + 启动行为

**Files:**
- Modify: `src/main/ipc.ts`（IpcContext 23-36、adb handlers 96-100、settings:set 102-110、新增 monitor:set-mode）
- Modify: `src/main/index.ts`（import、创建 adb、启动行为 107-116）
- Modify: `src/shared/api.ts`（Api 接口）
- Modify: `src/preload/index.ts`

- [ ] **Step 1: IpcContext 增加 adb，AdbService 上移到 bootstrap**

`src/main/ipc.ts`：
- `IpcContext`（23-36 行）加成员：

```ts
  adb: AdbService;
```

- 删除第 96 行 `const adb = new AdbService();`，97-100 行的 `adb.` 全部改为 `ctx.adb.`：

```ts
  ipcMain.handle('adb:status', () => ctx.adb.status(ctx.settings.get().proxyPort));
  ipcMain.handle('adb:setup-tunnel', () => ctx.adb.setupTunnel(ctx.settings.get().proxyPort));
  ipcMain.handle('adb:set-phone-proxy', () => ctx.adb.setPhoneProxy(ctx.settings.get().proxyPort));
  ipcMain.handle('adb:clear-phone-proxy', () => ctx.adb.clearPhoneProxy());
```

- import 区（第 16 行已有 AdbService import，保留）；类型 import 行（第 14 行）加 `MonitorMode`：

```ts
import type { RenderContext, ReplayRequest, RuleAction, RuleInput, RulePatch, Settings, TrafficEvent, MapLocalSaveInput, MonitorMode } from '../shared/types';
```

- 加 import：

```ts
import { applyMonitorMode } from './monitor-mode';
import { validateUpstreamProxyUrl } from '../shared/upstream';
```

`src/main/index.ts`：
- import 区加：

```ts
import { AdbService } from './adb/adb-service';
```

- 在 `registerIpc({` 之前（约第 89 行前）创建：

```ts
  const adb = new AdbService();
```

- `registerIpc({...})` 对象（90-105 行）加 `adb,`：

```ts
  registerIpc({
    proxy,
    rules,
    redirects,
    maplocal,
    scenarios,
    settings,
    ca,
    history,
    dataDir,
    adb,
    systemProxySetByUs: () => systemProxySetByUs,
    onSystemProxyChanged: (enabled) => {
      systemProxySetByUs = enabled;
    },
    replay,
  });
```

- [ ] **Step 2: settings:set 校验 + monitor:set-mode**

`src/main/ipc.ts` settings:set（102-110 行）加校验：

```ts
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    if (patch.proxyPort !== undefined) {
      if (!Number.isInteger(patch.proxyPort) || patch.proxyPort < 1 || patch.proxyPort > 65535) {
        throw new Error('代理端口必须是 1-65535 的整数');
      }
    }
    if (patch.throttle !== undefined) assertValidThrottle(patch.throttle);
    if (patch.upstreamProxyUrl !== undefined) {
      const err = validateUpstreamProxyUrl(patch.upstreamProxyUrl);
      if (err) throw new Error(err);
    }
    if (
      patch.monitorMode !== undefined &&
      !['off', 'phone', 'computer'].includes(patch.monitorMode)
    ) {
      throw new Error('monitorMode 必须是 off/phone/computer');
    }
    return ctx.settings.set(patch);
  });
```

在 `system-proxy:set` handler 之后新增：

```ts
  ipcMain.handle('monitor:set-mode', async (_e, mode: MonitorMode) => {
    return applyMonitorMode(mode, {
      proxyRunning: () => ctx.proxy.running,
      startProxy: async () => {
        await ctx.proxy.start();
        ctx.history.openSession();
      },
      systemProxySetByUs: ctx.systemProxySetByUs,
      restoreSystemProxy: async () => {
        await disableSystemProxy();
        ctx.onSystemProxyChanged(false);
      },
      enableSystemProxy: async () => {
        await enableSystemProxy(ctx.proxy.port);
        ctx.onSystemProxyChanged(true);
      },
      setupPhoneProxy: async () => {
        const tunnel = await ctx.adb.setupTunnel(ctx.settings.get().proxyPort);
        if (!tunnel.ok) return tunnel;
        return ctx.adb.setPhoneProxy(ctx.settings.get().proxyPort);
      },
      clearPhoneProxy: () => ctx.adb.clearPhoneProxy(),
      persistMode: async (m) => {
        await ctx.settings.set({ monitorMode: m });
      },
    });
  });
```

- [ ] **Step 3: 启动行为（index.ts bootstrap）**

`src/main/index.ts` 第 107-116 行 autoStartProxy 块内、`await history.prune()...` 之后追加：

```ts
      const mode = settings.get().monitorMode;
      if (mode === 'computer') {
        try {
          await enableSystemProxy(proxy.port);
          systemProxySetByUs = true;
        } catch (err) {
          console.warn('自动恢复系统代理失败', err);
        }
      } else if (mode === 'phone') {
        try {
          const tunnel = await adb.setupTunnel(proxy.port);
          if (tunnel.ok) await adb.setPhoneProxy(proxy.port);
        } catch {
          // 没插线/没装 adb：静默跳过
        }
      }
```

- [ ] **Step 4: Api + preload**

`src/shared/api.ts`：
- 第 1 行类型 import 加 `MonitorMode`：

```ts
import type { AdbOpResult, AdbStatus, CertInfo, CertInstallCommands, MapLocalSaveInput, MockRule, MonitorMode, ProxyStatus, RedirectRule, RenderContext, ReplayRequest, RuleAction, RuleInput, RulePatch, Scenario, Settings, TrafficEvent } from './types';
```

- `Api` 接口（systemProxyStatus 之后）加：

```ts
  monitorSetMode(mode: MonitorMode): Promise<{ mode: MonitorMode; notice?: string }>;
```

`src/preload/index.ts`：
- 第 3 行类型 import 加 `MonitorMode`；`api` 对象 `systemProxyStatus` 之后加：

```ts
  monitorSetMode: (mode: MonitorMode) => ipcRenderer.invoke('monitor:set-mode', mode),
```

- [ ] **Step 5: 验证与提交**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck 无错误；全部测试 PASS

```bash
git add src/main/ipc.ts src/main/index.ts src/shared/api.ts src/preload/index.ts
git commit -m "feat(main): monitor:set-mode IPC, upstream validation and startup mode restore"
```

---

### Task 5: StatusBar 三态模式选择器

**Files:**
- Modify: `src/renderer/src/components/StatusBar.tsx`

- [ ] **Step 1: 实现模式选择器**

`src/renderer/src/components/StatusBar.tsx` 全量替换为：

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MonitorMode, ProxyStatus, ThrottleSettings } from '../../../shared/types';
import { THROTTLE_PRESET_LABELS } from '../../../shared/types';
import { api } from '../lib/api';
import { useTrafficStore } from '../stores/traffic';

const MODE_LABELS: Record<MonitorMode, string> = { off: '关', phone: '手机', computer: '电脑' };
const MODES: MonitorMode[] = ['off', 'phone', 'computer'];

export default function StatusBar({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const [throttle, setThrottle] = useState<ThrottleSettings | null>(null);
  const [mode, setMode] = useState<MonitorMode>('off');
  const [notice, setNotice] = useState('');
  const connected = useTrafficStore((s) => s.connected);
  const refreshing = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      setStatus(await api.proxyStatus());
      api.settingsGet()
        .then((s) => {
          setThrottle(s.throttle);
          setMode(s.monitorMode);
        })
        .catch(() => {});
    } catch {
      // keep last known status
    } finally {
      refreshing.current = false;
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  const toggle = async () => {
    try {
      if (status?.running) await api.proxyStop();
      else await api.proxyStart();
      await refresh();
    } catch {
      // ignore; next refresh will recover the status
    }
  };

  const switchMode = async (next: MonitorMode) => {
    if (next === mode) return;
    try {
      const r = await api.monitorSetMode(next);
      setMode(r.mode);
      setNotice(r.notice ?? '');
      if (r.notice) setTimeout(() => setNotice(''), 5000);
      await refresh();
    } catch (err) {
      setNotice(String(err));
      setTimeout(() => setNotice(''), 5000);
    }
  };

  return (
    <div className="status-bar">
      <span className={`dot ${connected ? 'ok' : 'err'}`} title="实时连接" />
      <span>Mocker</span>
      <span className="spacer" />
      {notice && (
        <span data-testid="monitor-notice" className="text-warn">
          {notice}
        </span>
      )}
      <span data-testid="monitor-mode">
        {MODES.map((m) => (
          <button
            key={m}
            data-testid={`monitor-${m}`}
            className={m === mode ? 'text-ok' : undefined}
            onClick={() => switchMode(m)}
          >
            {MODE_LABELS[m]}
          </button>
        ))}
      </span>
      {throttle?.enabled && (
        <button data-testid="throttle-chip" className="text-warn" onClick={onOpenSettings}>
          {throttle.preset === 'custom'
            ? `限速:${throttle.downKbps}KB/s`
            : `限速:${THROTTLE_PRESET_LABELS[throttle.preset]}`}
        </button>
      )}
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

说明：状态栏按钮沿用现有紧凑 button 风格，密集排布遵守既有 flex 工具栏纪律；选中态复用 `text-ok` 类。

- [ ] **Step 2: 验证**

Run: `npm run typecheck`
Expected: 无错误（Api.monitorSetMode 已在 Task 4 定义）

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/StatusBar.tsx
git commit -m "feat(ui): monitor mode selector in status bar"
```

---

### Task 6: SettingsPanel 上游代理设置

**Files:**
- Modify: `src/renderer/src/components/SettingsPanel.tsx`（表单 130-133 行附近 + 保存按钮 140-145 行）

- [ ] **Step 1: 表单加两个字段**

在「系统代理」行（130-133 行）之前插入：

```tsx
        <label>上游代理</label>
        <input
          placeholder="留空不走上游；http:// socks5:// pac+http://"
          value={settings.upstreamProxyUrl}
          onChange={(e) => setSettings({ ...settings, upstreamProxyUrl: e.target.value })}
        />
        <label>直连名单（逗号分隔）</label>
        <input
          placeholder="如 localhost, 127.0.0.1, internal.corp"
          value={settings.upstreamNoProxy}
          onChange={(e) => setSettings({ ...settings, upstreamNoProxy: e.target.value })}
        />
```

- [ ] **Step 2: 保存按钮带上新字段**

保存按钮的 `save({...})`（139-146 行）改为：

```tsx
            save({
              proxyPort: settings.proxyPort,
              httpsMode: settings.httpsMode,
              whitelist: settings.whitelist,
              autoStartProxy: settings.autoStartProxy,
              upstreamProxyUrl: settings.upstreamProxyUrl,
              upstreamNoProxy: settings.upstreamNoProxy,
            })
```

上游字段走现有 `save()` 链路：保存 → 重启代理 → 若系统代理开着自动重设（SettingsPanel.tsx:38-45 原逻辑），无需新代码。无效 URL 会被主进程 settings:set 校验拒绝，错误显示在现有 `message` 区。

- [ ] **Step 3: 验证**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/SettingsPanel.tsx
git commit -m "feat(ui): upstream proxy and no-proxy fields in settings panel"
```

---

### Task 7: E2E 模式切换冒烟

**Files:**
- Create: `e2e/monitor-mode.spec.ts`

- [ ] **Step 1: 写 e2e**

```ts
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { test, expect } from '@playwright/test';

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'] });
  win = await app.firstWindow();
});

test.afterAll(async () => {
  // 必须恢复：本 spec 会真实修改系统代理，结束必回 off
  await win.evaluate(async () => {
    await window.api.monitorSetMode('off');
  }).catch(() => {});
  await app.close();
});

test('mode switch persists and is mutually exclusive', async () => {
  await win.waitForSelector('[data-testid="monitor-mode"]');

  // 电脑模式：真实设置系统代理
  await win.getByTestId('monitor-computer').click();
  await expect(win.getByTestId('monitor-computer')).toHaveClass(/text-ok/);
  expect(await win.evaluate(async () => (await window.api.settingsGet()).monitorMode)).toBe('computer');
  expect(await win.evaluate(async () => window.api.systemProxyStatus())).toBe(true);

  // 切手机模式：互斥清理系统代理（真机上若无设备会有 notice，不在这里断言环境差异）
  await win.getByTestId('monitor-phone').click();
  expect(await win.evaluate(async () => (await window.api.settingsGet()).monitorMode)).toBe('phone');
  expect(await win.evaluate(async () => window.api.systemProxyStatus())).toBe(false);

  await win.getByTestId('monitor-off').click();
  expect(await win.evaluate(async () => (await window.api.settingsGet()).monitorMode)).toBe('off');
  expect(await win.evaluate(async () => window.api.systemProxyStatus())).toBe(false);
});
```

- [ ] **Step 2: 构建后跑 e2e（先 build，否则跑的是旧 out/）**

Run: `npm run build && npx playwright test e2e/monitor-mode.spec.ts`
Expected: 1 个用例 PASS；结束后本机系统代理为关闭状态

- [ ] **Step 3: Commit**

```bash
git add e2e/monitor-mode.spec.ts
git commit -m "test(e2e): monitor mode switch coverage"
```

---

### Task 8: 全量验证

- [ ] **Step 1: 全套检查**

Run: `npm run typecheck && npx vitest run && npm run build && npx playwright test`
Expected: typecheck 无错误；单测全过；e2e 全过（8888/8899 需空闲）

- [ ] **Step 2: 手动冒烟（UI 黄金路径）**

Run: `npm run dev`，在应用里：
1. StatusBar 点「电脑」→ 系统代理开、按钮高亮；
2. 设置页填上游 `socks5://127.0.0.1:7892` + 直连名单 → 保存并重启代理 → 手机经 adb 访问外网成功、命中名单的域名直连；
3. 点「手机」→ 系统代理恢复；点「关」→ 全部清理；
4. 重启应用 → monitorMode 与上游配置仍在（持久化）。

- [ ] **Step 3: 收尾提交（如有手工修正）**

```bash
git status
# 如有修正文件：
git add -A && git commit -m "fix: address findings from manual smoke test"
```

---

## 计划自审记录

- **Spec 覆盖**：上游代理（Task 1/2/6）、noProxy（Task 1/2/6）、互斥模式编排（Task 3/4）、启动恢复（Task 4 Step 3）、持久化（Task 1 默认值 + JsonStore 合并；Task 3 persistMode）、StatusBar 选择器（Task 5）、设置页字段（Task 6）、测试三层（Task 2/3/7）、设备不在线不阻塞（Task 3 用例 2）。Spec 的「保存即自动重启」由现有 save() 链路承载，无需新任务。
- **占位符**：无 TBD/TODO；所有代码步骤含完整代码。
- **类型一致性**：`MonitorMode` 在 types/api/preload/ipc/monitor-mode/StatusBar 拼写一致；`MonitorModeDeps` 七个依赖与 Task 4 接线一一对应；`AdbOpResult` 来自 shared/types（:239）。
- **决策偏差声明**：模式切换时若代理未运行会自动 `startProxy()`（spec 未明说，属「一次切换到位」的最小补充）。
