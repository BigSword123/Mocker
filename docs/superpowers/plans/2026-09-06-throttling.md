# Mocker 弱网限速实现计划（路线图第三期）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全局弱网限速——一个开关让代理的全部实时响应流量按「下行带宽 + 延迟 ± 抖动」变慢，预设档 + 自定义数值，即时生效。

**Architecture:** 缓冲 + 时延模拟。mockttp 4.x 无 throttle API 且回调响应体只支持整块 Buffer，故在四个响应路径（passthrough 的 `beforeResponse`、mock、mapLocal/mapRemote）统一施加计算出的总时延；`applyThrottle` 分片 200ms 睡眠、每片重读设置，中途关闭/改小立即放行。设置存 `Settings.throttle`，实时经 `getSettings()` 读取。

**Tech Stack:** Electron + mockttp 4.x + React + vitest + Playwright E2E。

**Spec:** `docs/superpowers/specs/2026-09-06-throttling-design.md`

**实施约束（沿路线图惯例）：**
- 必须在 git worktree 内执行（master 常有用户未提交改动）；worktree 内先 `npm install`
- E2E / dev 需 8888/8899 空闲，先让用户退出运行中的 mocker 实例
- 子代理派发若撞 credit usage limit，回退为本会话 inline 执行
- UI 改动无组件单测（项目模式），由 typecheck + E2E 覆盖

---

### Task 1: 共享类型与预设表（types.ts）

**Files:**
- Modify: `src/shared/types.ts`
- Test: `tests/throttle.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

新建 `tests/throttle.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  DOWN_KBPS_MAX,
  JITTER_MS_MAX,
  LATENCY_MS_MAX,
  THROTTLE_PRESETS,
  THROTTLE_PRESET_LABELS,
  type ThrottlePreset,
} from '../src/shared/types';

describe('THROTTLE_PRESETS', () => {
  it('covers every non-custom preset with in-range values', () => {
    const keys = (Object.keys(THROTTLE_PRESETS) as Exclude<ThrottlePreset, 'custom'>[]).sort();
    expect(keys).toEqual(['dialup', 'slow-three-g', 'weak-wifi', 'three-g'].sort());
    for (const v of Object.values(THROTTLE_PRESETS)) {
      expect(v.downKbps).toBeGreaterThanOrEqual(1);
      expect(v.downKbps).toBeLessThanOrEqual(DOWN_KBPS_MAX);
      expect(v.latencyMs).toBeGreaterThanOrEqual(0);
      expect(v.latencyMs).toBeLessThanOrEqual(LATENCY_MS_MAX);
      expect(v.jitterMs).toBeGreaterThanOrEqual(0);
      expect(v.jitterMs).toBeLessThanOrEqual(JITTER_MS_MAX);
    }
  });

  it('labels every preset including custom', () => {
    const all: ThrottlePreset[] = ['three-g', 'slow-three-g', 'dialup', 'weak-wifi', 'custom'];
    for (const p of all) expect(THROTTLE_PRESET_LABELS[p]).toBeTruthy();
  });

  it('default settings ship throttle disabled with a preset', () => {
    expect(DEFAULT_SETTINGS.throttle.enabled).toBe(false);
    expect(DEFAULT_SETTINGS.throttle.preset).toBe('three-g');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/throttle.test.ts`
Expected: FAIL——`THROTTLE_PRESETS` 等导出不存在（TS/运行时报 undefined 或 import 报错）

- [ ] **Step 3: 实现 types.ts**

在 `src/shared/types.ts` 中：

`TrafficEvent` 接口末尾（`sequenceIndex?: number;` 之后）加：

```ts
  /** 实际施加的限速延迟，仅在 >0ms 时写入，单位 ms */
  throttledMs?: number;
```

`Settings` 接口（`autoStartProxy: boolean;` 之后）加：

```ts
  throttle: ThrottleSettings;
```

`DEFAULT_SETTINGS` 加字段：

```ts
export const DEFAULT_SETTINGS: Settings = {
  proxyPort: 8888,
  wsPort: 8899,
  httpsMode: 'whitelist',
  whitelist: [],
  autoStartProxy: true,
  throttle: { enabled: false, preset: 'three-g', ...THROTTLE_PRESETS['three-g'] },
};
```

文件末尾（`DELAY_MS_MAX` 附近）加：

```ts
export type ThrottlePreset = 'three-g' | 'slow-three-g' | 'dialup' | 'weak-wifi' | 'custom';

export interface ThrottleSettings {
  enabled: boolean;
  preset: ThrottlePreset;
  downKbps: number;
  latencyMs: number;
  jitterMs: number;
}

export const DOWN_KBPS_MAX = 100_000;
export const LATENCY_MS_MAX = 60_000;
export const JITTER_MS_MAX = 30_000;

export const THROTTLE_PRESETS: Record<
  Exclude<ThrottlePreset, 'custom'>,
  Pick<ThrottleSettings, 'downKbps' | 'latencyMs' | 'jitterMs'>
> = {
  'three-g': { downKbps: 200, latencyMs: 300, jitterMs: 100 },
  'slow-three-g': { downKbps: 50, latencyMs: 800, jitterMs: 300 },
  dialup: { downKbps: 6, latencyMs: 120, jitterMs: 20 },
  'weak-wifi': { downKbps: 400, latencyMs: 100, jitterMs: 80 },
};

export const THROTTLE_PRESET_LABELS: Record<ThrottlePreset, string> = {
  'three-g': '3G',
  'slow-three-g': '慢速 3G',
  dialup: '56K 拨号',
  'weak-wifi': '弱 WiFi',
  custom: '自定义',
};
```

注意：`DEFAULT_SETTINGS` 引用 `THROTTLE_PRESETS`，`THROTTLE_PRESETS` 定义须放在 `DEFAULT_SETTINGS` **之前**（const 提升限制）——把上面整块放在 `DEFAULT_SETTINGS` 定义之前即可，`TrafficEvent`/`Settings` 接口位置不变。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/throttle.test.ts`
Expected: PASS（3 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/shared/types.ts tests/throttle.test.ts
git commit -m "feat(throttle): shared ThrottleSettings types and preset table"
```

---

### Task 2: computeThrottleDelayMs 纯函数

**Files:**
- Create: `src/main/proxy/throttle.ts`
- Test: `tests/throttle.test.ts`（追加）

- [ ] **Step 1: 写失败测试（追加到 tests/throttle.test.ts）**

文件顶部 import 区补 `computeThrottleDelayMs`：

```ts
import { computeThrottleDelayMs } from '../src/main/proxy/throttle';
```

文件末尾追加：

```ts
describe('computeThrottleDelayMs', () => {
  const base = { enabled: true, preset: 'custom' as const, downKbps: 200, latencyMs: 300, jitterMs: 100 };

  it('returns 0 when disabled', () => {
    expect(computeThrottleDelayMs({ ...base, enabled: false }, 10000)).toBe(0);
  });

  it('latency minus jitter floors at 0 (rng=0)', () => {
    // 300 + floor(0*201) - 100 = 200
    expect(computeThrottleDelayMs(base, 0, () => 0)).toBe(200);
    // jitter 大于 latency 时下限为 0
    expect(computeThrottleDelayMs({ ...base, latencyMs: 50, jitterMs: 100 }, 0, () => 0)).toBe(0);
  });

  it('latency plus jitter at rng upper bound', () => {
    // floor(0.999*201)=200 → 300 + 200 - 100 = 400
    expect(computeThrottleDelayMs(base, 0, () => 0.999)).toBe(400);
  });

  it('transfer time from body bytes', () => {
    // 2048 bytes @ 2KB/s = 1s，latency/jitter 为 0
    expect(computeThrottleDelayMs({ ...base, downKbps: 2, latencyMs: 0, jitterMs: 0 }, 2048, () => 0)).toBe(1000);
  });

  it('caps at DELAY_MS_MAX (300000)', () => {
    expect(computeThrottleDelayMs({ ...base, downKbps: 1, latencyMs: 0, jitterMs: 0 }, 1e9, () => 0)).toBe(300000);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/throttle.test.ts`
Expected: FAIL——模块 `../src/main/proxy/throttle` 不存在

- [ ] **Step 3: 实现 src/main/proxy/throttle.ts（新建）**

```ts
import { DELAY_MS_MAX, type Settings, type ThrottleSettings } from '../../shared/types';
import { sleep } from '../util/sleep';

export function computeThrottleDelayMs(
  t: ThrottleSettings,
  bodyBytes: number,
  rng: () => number = Math.random,
): number {
  if (!t.enabled) return 0;
  const jitterSpan = t.jitterMs * 2 + 1;
  const latencyPart = Math.max(0, t.latencyMs + Math.floor(rng() * jitterSpan) - t.jitterMs);
  const kbps = Math.max(1, t.downKbps);
  const transferMs = (bodyBytes / (kbps * 1024)) * 1000;
  return Math.min(latencyPart + transferMs, DELAY_MS_MAX);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/throttle.test.ts`
Expected: PASS（全部）

- [ ] **Step 5: 提交**

```bash
git add src/main/proxy/throttle.ts tests/throttle.test.ts
git commit -m "feat(throttle): computeThrottleDelayMs pure calculation"
```

---

### Task 3: applyThrottle 分片睡眠（含中途关闭放行 + signal 中止）

**Files:**
- Modify: `src/main/proxy/throttle.ts`
- Test: `tests/throttle.test.ts`（追加）

- [ ] **Step 1: 写失败测试（追加）**

```ts
describe('applyThrottle', () => {
  it('sleeps at least the computed latency', async () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, throttle: { enabled: true, preset: 'custom', downKbps: 100000, latencyMs: 300, jitterMs: 0 } };
    const started = Date.now();
    await applyThrottle(() => settings, 0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
  }, 10000);

  it('releases early when throttle is disabled mid-flight', async () => {
    let settings: Settings = { ...DEFAULT_SETTINGS, throttle: { enabled: true, preset: 'custom', downKbps: 100000, latencyMs: 900, jitterMs: 0 } };
    const get = () => settings;
    const started = Date.now();
    const p = applyThrottle(get, 0);
    setTimeout(() => {
      settings = { ...settings, throttle: { ...settings.throttle, enabled: false } };
    }, 250);
    await p;
    expect(Date.now() - started).toBeLessThan(650);
  }, 10000);

  it('rejects with AbortError when signal fires', async () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, throttle: { enabled: true, preset: 'custom', downKbps: 100000, latencyMs: 5000, jitterMs: 0 } };
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await expect(applyThrottle(() => settings, 0, ac.signal)).rejects.toThrow(/abort/i);
  }, 10000);
});
```

import 区补：

```ts
import { applyThrottle, computeThrottleDelayMs } from '../src/main/proxy/throttle';
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/types';
```

（`DEFAULT_SETTINGS`/`Settings` 若 Task 1 已 import 过则合并，勿重复。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/throttle.test.ts`
Expected: FAIL——`applyThrottle` 未导出

- [ ] **Step 3: 实现（追加到 src/main/proxy/throttle.ts）**

```ts
const THROTTLE_SLICE_MS = 200;

/**
 * 按当前设置睡完限速时延，返回实际睡掉的 ms。
 * 分片睡眠：每片醒来重读最新设置——已关闭则立即放行；参数变化则按新设置
 * 重算总时延并减去已睡时间。signal 触发时以 AbortError 拒绝（与 sleep 一致）。
 */
export async function applyThrottle(
  getSettings: () => Settings,
  bodyBytes: number,
  signal?: AbortSignal,
): Promise<number> {
  const start = Date.now();
  let remaining = computeThrottleDelayMs(getSettings().throttle, bodyBytes);
  while (remaining > 0) {
    if (signal?.aborted) throw new DOMException('sleep aborted', 'AbortError');
    const slice = Math.min(THROTTLE_SLICE_MS, remaining);
    await sleep(slice, signal);
    const recomputed = computeThrottleDelayMs(getSettings().throttle, bodyBytes);
    remaining = Math.max(0, Math.min(remaining - slice, recomputed - (Date.now() - start)));
  }
  return Date.now() - start;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/throttle.test.ts`
Expected: PASS（全部；注意中途放行用例真实计时约 0.5s）

- [ ] **Step 5: 提交**

```bash
git add src/main/proxy/throttle.ts tests/throttle.test.ts
git commit -m "feat(throttle): applyThrottle sliced sleep with live-setting recompute"
```

---

### Task 4: 参数校验 + IPC 接线 + settings 向后兼容

**Files:**
- Modify: `src/main/proxy/throttle.ts`（追加 `assertValidThrottle`）
- Modify: `src/main/ipc.ts:95-101`（settings:set 校验）
- Test: `tests/throttle.test.ts`（追加校验用例）
- Test: `tests/settings-store.test.ts`（追加向后兼容用例）

- [ ] **Step 1: 写失败测试（追加到 tests/throttle.test.ts）**

```ts
describe('assertValidThrottle', () => {
  const base = { enabled: true, preset: 'custom' as const, downKbps: 100, latencyMs: 100, jitterMs: 0 };

  it('accepts a valid throttle', () => {
    expect(() => assertValidThrottle(base)).not.toThrow();
  });

  it('rejects out-of-range numbers', () => {
    expect(() => assertValidThrottle({ ...base, downKbps: 0 })).toThrow();
    expect(() => assertValidThrottle({ ...base, downKbps: 100001 })).toThrow();
    expect(() => assertValidThrottle({ ...base, latencyMs: -1 })).toThrow();
    expect(() => assertValidThrottle({ ...base, latencyMs: 60001 })).toThrow();
    expect(() => assertValidThrottle({ ...base, jitterMs: 30001 })).toThrow();
  });

  it('rejects non-integers, bad enum and bad enabled', () => {
    expect(() => assertValidThrottle({ ...base, downKbps: 1.5 })).toThrow();
    expect(() => assertValidThrottle({ ...base, preset: '5g' as never })).toThrow();
    expect(() => assertValidThrottle({ ...base, enabled: 'yes' as never })).toThrow();
  });
});
```

import 区补 `assertValidThrottle`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/throttle.test.ts`
Expected: FAIL——`assertValidThrottle` 未导出

- [ ] **Step 3: 实现 assertValidThrottle（追加到 src/main/proxy/throttle.ts）**

```ts
import {
  DELAY_MS_MAX,
  DOWN_KBPS_MAX,
  JITTER_MS_MAX,
  LATENCY_MS_MAX,
  THROTTLE_PRESET_LABELS,
  type Settings,
  type ThrottleSettings,
} from '../../shared/types';

export function assertValidThrottle(t: ThrottleSettings): void {
  if (typeof t.enabled !== 'boolean') throw new Error('限速开关必须是布尔值');
  if (!(t.preset in THROTTLE_PRESET_LABELS)) throw new Error('限速预设非法');
  if (!Number.isInteger(t.downKbps) || t.downKbps < 1 || t.downKbps > DOWN_KBPS_MAX) {
    throw new Error(`下行带宽必须是 1-${DOWN_KBPS_MAX} 的整数`);
  }
  if (!Number.isInteger(t.latencyMs) || t.latencyMs < 0 || t.latencyMs > LATENCY_MS_MAX) {
    throw new Error(`延迟必须是 0-${LATENCY_MS_MAX} 的整数`);
  }
  if (!Number.isInteger(t.jitterMs) || t.jitterMs < 0 || t.jitterMs > JITTER_MS_MAX) {
    throw new Error(`抖动必须是 0-${JITTER_MS_MAX} 的整数`);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/throttle.test.ts`
Expected: PASS（全部）

- [ ] **Step 5: IPC 接线（src/main/ipc.ts settings:set）**

顶部 import 区加：

```ts
import { assertValidThrottle } from './proxy/throttle';
```

`settings:set` handler 改为：

```ts
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    if (patch.proxyPort !== undefined) {
      if (!Number.isInteger(patch.proxyPort) || patch.proxyPort < 1 || patch.proxyPort > 65535) {
        throw new Error('代理端口必须是 1-65535 的整数');
      }
    }
    if (patch.throttle !== undefined) assertValidThrottle(patch.throttle);
    return ctx.settings.set(patch);
  });
```

- [ ] **Step 6: settings 向后兼容测试（追加到 tests/settings-store.test.ts）**

按该文件现有 import 风格补齐（若缺）：

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '../src/shared/types';
```

追加用例（老版本 settings.json 无 throttle 字段 → load 后补默认值）：

```ts
it('fills missing throttle field with defaults for legacy settings.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mocker-settings-'));
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ proxyPort: 9999 }), 'utf8');
  const store = new SettingsStore(dir);
  await store.load();
  const s = store.get();
  expect(s.proxyPort).toBe(9999);
  expect(s.throttle).toEqual(DEFAULT_SETTINGS.throttle);
  await rm(dir, { recursive: true, force: true });
});
```

> 说明：`JsonStore.read` 的浅合并（`{ ...defaults, ...parsed }`）已天然支持该行为，此用例是**行为锁定测试**（预期直接 PASS，防将来改坏），非 TDD 失败先行。

- [ ] **Step 7: 跑相关测试**

Run: `npx vitest run tests/throttle.test.ts tests/settings-store.test.ts`
Expected: PASS（全部）

- [ ] **Step 8: 提交**

```bash
git add src/main/proxy/throttle.ts src/main/ipc.ts tests/throttle.test.ts tests/settings-store.test.ts
git commit -m "feat(throttle): settings validation on IPC and legacy settings back-compat"
```

---

### Task 5: 代理管道挂载（passthrough / mock / mapLocal / mapRemote）

**Files:**
- Modify: `src/main/proxy/proxy-server.ts`
- Test: `tests/proxy.integration.test.ts`（追加 describe）

- [ ] **Step 1: 写失败集成测试（追加到 tests/proxy.integration.test.ts）**

文件末尾（最后一个 `describe` 之后）追加；顶部 import 区确认已有 `DEFAULT_SETTINGS`、`Settings`、`fetch`、`ProxyAgent`（已有）：

```ts
describe('Throttle', () => {
  const throttled = (latencyMs: number): Settings => ({
    ...DEFAULT_SETTINGS,
    proxyPort: 0,
    httpsMode: 'whitelist',
    whitelist: ['mocked.test'],
    throttle: { enabled: true, preset: 'custom', downKbps: 100000, latencyMs, jitterMs: 0 },
  });

  beforeEach(() => {
    settings = { ...settings, throttle: { ...DEFAULT_SETTINGS.throttle } };
  });

  it('delays passthrough responses when enabled', async () => {
    settings = throttled(400);
    const agent = new ProxyAgent(`http://127.0.0.1:${proxy.port}`);
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${upstreamPort}/hello`, { dispatcher: agent });
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
  });

  it('delays mocked responses and records throttledMs on the event', async () => {
    settings = throttled(400);
    rules = [rule('http://api.example.test/ping', 'throttled-mock')];
    const agent = new ProxyAgent(`http://127.0.0.1:${proxy.port}`);
    const started = Date.now();
    const res = await fetch('http://api.example.test/ping', { dispatcher: agent });
    expect(await res.text()).toBe('throttled-mock');
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    await waitFor(() => events.some((e) => e.mocked && e.throttledMs !== undefined));
    expect(events.find((e) => e.mocked)!.throttledMs).toBeGreaterThanOrEqual(300);
  });

  it('releases a mid-flight request early when throttle is disabled', async () => {
    settings = throttled(900);
    const agent = new ProxyAgent(`http://127.0.0.1:${proxy.port}`);
    const started = Date.now();
    const pending = fetch(`http://127.0.0.1:${upstreamPort}/hello`, { dispatcher: agent });
    setTimeout(() => {
      settings = { ...settings, throttle: { ...settings.throttle, enabled: false } };
    }, 250);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(800);
  });
});
```

注意：文件顶层 `settings` 是模块级变量且 `getSettings: () => settings` 捕获的是变量本身，重新赋值即可生效。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/proxy.integration.test.ts`
Expected: Throttle 三个用例 FAIL（响应立即返回，耗时断言不满足；`throttledMs` 不存在）

- [ ] **Step 3: 接线 proxy-server.ts**

3a. import 区加：

```ts
import { applyThrottle } from './throttle';
```

3b. `doStart()` 末尾的 master handler 改为（新增 `beforeResponse`）：

```ts
    await server.forAnyRequest().always().thenPassThrough({
      beforeRequest: (req) => this.handle(req),
      beforeResponse: async (resp) => {
        if (!this.opts.getSettings().throttle?.enabled) return;
        const text = await resp.body.getText();
        const slept = await applyThrottle(this.opts.getSettings, Buffer.byteLength(text), this.abort?.signal);
        if (slept > 0) {
          const ev = this.events.get(resp.id);
          if (ev) {
            ev.throttledMs = slept;
            this.emit(ev);
          }
        }
      },
    });
```

3c. `handleMatched`：在 `event.status = result.status;` 之前（networkError 分支之后）插入：

```ts
    let throttledMs: number;
    try {
      throttledMs = await applyThrottle(this.opts.getSettings, Buffer.byteLength(result.body), this.abort?.signal);
    } catch {
      return { response: 'close' };
    }
    if (throttledMs > 0) event.throttledMs = throttledMs;
```

3d. `handleRedirect` mapLocal 分支：在 `event.completedAt = Date.now();`（`resolveMapLocal` 成功/失败统一收尾的那段）之前插入：

```ts
    let localThrottled: number;
    try {
      const bytes = res.ok ? res.content.length : Buffer.byteLength(event.responseBody ?? '');
      localThrottled = await applyThrottle(this.opts.getSettings, bytes, this.abort?.signal);
    } catch {
      return { response: 'close' as const };
    }
    if (localThrottled > 0) event.throttledMs = localThrottled;
```

（插入点：`const res = await resolveMapLocal(rule.target);` 之后、`if (res.ok) {` 之前——即拿到 `res` 之后、写 event 状态之前。）

3e. `handleRedirect` mapRemote 分支：在 `event.status = remote.status;` 之前插入：

```ts
    let remoteThrottled: number;
    try {
      remoteThrottled = await applyThrottle(this.opts.getSettings, Buffer.byteLength(remote.body ?? ''), this.abort?.signal);
    } catch {
      return { response: 'close' as const };
    }
    if (remoteThrottled > 0) event.throttledMs = remoteThrottled;
```

（`remote.error` 分支保持原样，不限速。onboarding 分支（`handle()` 内 `/ca.pem` 与 `/`）不挂限速。）

- [ ] **Step 4: 跑集成测试确认通过**

Run: `npx vitest run tests/proxy.integration.test.ts`
Expected: PASS（全部，含原有用例；Throttle 用例真实计时约 1-2s）

- [ ] **Step 5: 回归全量单测**

Run: `npm run test`
Expected: PASS（原有全部 + 新增）

- [ ] **Step 6: 提交**

```bash
git add src/main/proxy/proxy-server.ts tests/proxy.integration.test.ts
git commit -m "feat(throttle): apply throttle across passthrough, mock and redirect paths"
```

---

### Task 6: 设置面板「弱网限速」小节

**Files:**
- Modify: `src/renderer/src/components/SettingsPanel.tsx`

- [ ] **Step 1: import 区改为**

```ts
import { useEffect, useState } from 'react';
import type {
  CertInstallCommands,
  HttpsMode,
  Settings,
  ThrottlePreset,
  ThrottleSettings,
} from '../../../shared/types';
import { THROTTLE_PRESETS, THROTTLE_PRESET_LABELS } from '../../../shared/types';
import { api } from '../lib/api';
```

- [ ] **Step 2: 组件内加限速保存逻辑（`toggleSystemProxy` 函数之后）**

```tsx
  const saveThrottle = async (throttle: ThrottleSettings) => {
    setSaving(true);
    try {
      const next = await api.settingsSet({ throttle });
      setSettings(next);
      setMessage('限速设置已保存，即时生效');
      setTimeout(() => setMessage(''), 3000);
    } catch (err) {
      setMessage(String(err));
    } finally {
      setSaving(false);
    }
  };

  const patchThrottle = (p: Partial<ThrottleSettings>) => {
    if (!settings) return;
    const next = { ...settings.throttle, ...p };
    if (p.downKbps !== undefined || p.latencyMs !== undefined || p.jitterMs !== undefined) {
      next.preset = 'custom';
    }
    setSettings({ ...settings, throttle: next });
  };

  const applyThrottlePreset = (p: ThrottlePreset) => {
    if (!settings) return;
    if (p === 'custom') {
      setSettings({ ...settings, throttle: { ...settings.throttle, preset: 'custom' } });
      return;
    }
    setSettings({ ...settings, throttle: { ...settings.throttle, preset: p, ...THROTTLE_PRESETS[p] } });
  };
```

注意：`saveThrottle` **不重启代理**（限速即时生效），与主设置区的 `save()`（改端口/模式要重启）分开。

- [ ] **Step 3: JSX——主设置 toolbar 之后、证书小节之前插入**

```tsx
      <div className="cert-section">
        <h3>弱网限速</h3>
        <div className="form-grid">
          <label>启用限速</label>
          <input
            data-testid="throttle-enabled"
            type="checkbox"
            checked={settings.throttle.enabled}
            onChange={(e) =>
              setSettings({ ...settings, throttle: { ...settings.throttle, enabled: e.target.checked } })
            }
          />
          <label>预设</label>
          <select
            data-testid="throttle-preset"
            value={settings.throttle.preset}
            onChange={(e) => applyThrottlePreset(e.target.value as ThrottlePreset)}
          >
            {(Object.keys(THROTTLE_PRESET_LABELS) as ThrottlePreset[]).map((p) => (
              <option key={p} value={p}>
                {THROTTLE_PRESET_LABELS[p]}
              </option>
            ))}
          </select>
          <label>下行带宽（KB/s）</label>
          <input
            data-testid="throttle-down"
            type="number"
            min={1}
            value={settings.throttle.downKbps}
            onChange={(e) => patchThrottle({ downKbps: Number(e.target.value) })}
          />
          <label>延迟（ms）</label>
          <input
            data-testid="throttle-latency"
            type="number"
            min={0}
            value={settings.throttle.latencyMs}
            onChange={(e) => patchThrottle({ latencyMs: Number(e.target.value) })}
          />
          <label>抖动（ms）</label>
          <input
            data-testid="throttle-jitter"
            type="number"
            min={0}
            value={settings.throttle.jitterMs}
            onChange={(e) => patchThrottle({ jitterMs: Number(e.target.value) })}
          />
        </div>
        <div className="toolbar">
          <button className="primary" data-testid="throttle-save" disabled={saving} onClick={() => saveThrottle(settings.throttle)}>
            保存限速设置
          </button>
          <span className="muted">即时生效，无需重启代理</span>
        </div>
      </div>
```

- [ ] **Step 4: typecheck**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 5: 提交**

```bash
git add src/renderer/src/components/SettingsPanel.tsx
git commit -m "feat(ui): throttle section in settings panel with preset-to-custom flow"
```

---

### Task 7: 状态栏限速 chip + 详情页限速标记

**Files:**
- Modify: `src/renderer/src/components/StatusBar.tsx`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/components/TrafficDetail.tsx`（`event.errorTriggered` 行之后）

- [ ] **Step 1: StatusBar 改造**

顶部 import 改为：

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProxyStatus, ThrottleSettings } from '../../../shared/types';
import { THROTTLE_PRESET_LABELS } from '../../../shared/types';
import { api } from '../lib/api';
import { useTrafficStore } from '../stores/traffic';
```

组件签名与状态：

```ts
export default function StatusBar({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const [throttle, setThrottle] = useState<ThrottleSettings | null>(null);
  const connected = useTrafficStore((s) => s.connected);
  const refreshing = useRef(false);
```

`refresh` 内追加设置轮询（与 proxyStatus 同周期，让保存后的 chip 最迟 3s 出现）：

```ts
  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      setStatus(await api.proxyStatus());
      api.settingsGet().then((s) => setThrottle(s.throttle)).catch(() => {});
    } catch {
      // keep last known status
    } finally {
      refreshing.current = false;
    }
  }, []);
```

JSX：`<span className="spacer" />` 之后、`{status && …}` 之前插入：

```tsx
      {throttle?.enabled && (
        <button data-testid="throttle-chip" className="text-warn" onClick={onOpenSettings}>
          {throttle.preset === 'custom'
            ? `限速:${throttle.downKbps}KB/s`
            : `限速:${THROTTLE_PRESET_LABELS[throttle.preset]}`}
        </button>
      )}
```

- [ ] **Step 2: App.tsx 传入跳设置回调**

`<StatusBar />` 改为：

```tsx
      <StatusBar onOpenSettings={() => setTab('settings')} />
```

- [ ] **Step 3: TrafficDetail 限速标记**

`{event.errorTriggered && <div className="text-warn">本次命中网络异常分支</div>}` 之后插入：

```tsx
      {event.throttledMs !== undefined && (
        <div className="text-warn" data-testid="throttle-mark">
          限速 +{event.throttledMs}ms
        </div>
      )}
```

- [ ] **Step 4: typecheck**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 5: 提交**

```bash
git add src/renderer/src/components/StatusBar.tsx src/renderer/src/App.tsx src/renderer/src/components/TrafficDetail.tsx
git commit -m "feat(ui): throttle chip in status bar and throttled mark in traffic detail"
```

---

### Task 8: E2E（UI 行为 + 详情页标记；不断言真实时延）

**Files:**
- Create: `e2e/throttle.spec.ts`

- [ ] **Step 1: 新建 e2e/throttle.spec.ts**

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
  // 幂等清理：限速恢复关闭、删除用例规则，防跨运行残留
  await win.evaluate(async () => {
    const s = await window.api.settingsGet();
    await window.api.settingsSet({ throttle: { ...s.throttle, enabled: false } });
    for (const r of await window.api.rulesList()) if (r.name.startsWith('e2e-thr-')) await window.api.rulesRemove(r.id);
  });
  await app.close();
});

const openSettings = async () => {
  await win.locator('nav.tabs').getByRole('button', { name: '设置', exact: true }).click();
};

test('preset fills values, editing switches to custom, chip reflects saved state', async () => {
  await openSettings();
  await win.getByTestId('throttle-enabled').click();
  await win.getByTestId('throttle-preset').selectOption('slow-three-g');
  await expect(win.getByTestId('throttle-latency')).toHaveValue('800');
  await win.getByTestId('throttle-latency').fill('500');
  await expect(win.getByTestId('throttle-preset')).toHaveValue('custom');
  await win.getByTestId('throttle-save').click();
  // chip 依赖状态栏 3s 轮询；custom 档显示带宽数值
  await expect(win.getByTestId('throttle-chip')).toContainText('限速:50KB/s');
  await win.getByTestId('throttle-chip').click();
  await expect(win.locator('nav.tabs button', { hasText: '设置' })).toHaveClass(/active/);
  // 收尾：关闭限速，chip 消失
  await win.getByTestId('throttle-enabled').click();
  await win.getByTestId('throttle-save').click();
  await expect(win.getByTestId('throttle-chip')).toHaveCount(0);
});

test('throttled request is marked in traffic detail', async () => {
  // API 造数：开启限速（latency 300ms）+ 一条 mock 规则
  await win.evaluate(async () => {
    const s = await window.api.settingsGet();
    await window.api.settingsSet({
      throttle: { enabled: true, preset: 'custom', downKbps: 100000, latencyMs: 300, jitterMs: 0 },
    });
    await window.api.rulesAdd({
      name: 'e2e-thr-rule',
      enabled: true,
      priority: 1,
      match: { urlType: 'exact', urlPattern: 'http://thr.example.test/x', method: 'ANY' },
      action: { status: 200, headers: { 'content-type': 'text/plain' }, body: 'thr-ok' },
    });
  });
  const port = await win.evaluate(async () => {
    if (!(await window.api.proxyStatus()).running) await window.api.proxyStart();
    return (await window.api.proxyStatus()).port;
  });
  const agent = new ProxyAgent(`http://127.0.0.1:${port}`);
  await fetch('http://thr.example.test/x', { dispatcher: agent });
  // 打开流量详情（行点击模式同 capture-to-rule.spec.ts）
  await win.locator('nav.tabs').getByRole('button', { name: '流量', exact: true }).click();
  await win.locator('tr', { hasText: 'thr.example.test' }).first().click();
  await expect(win.getByTestId('throttle-mark')).toContainText('限速 +', { timeout: 5000 });
});
```

- [ ] **Step 2: 跑 E2E（先确认 8888/8899 空闲、无运行中的 mocker 实例）**

Run: `npx playwright test e2e/throttle.spec.ts`
Expected: 2 个用例 PASS（`test:e2e` 脚本自带 build；直接跑 playwright 则先 `npm run build`）

- [ ] **Step 3: 提交**

```bash
git add e2e/throttle.spec.ts
git commit -m "test(e2e): throttle settings UI flows and throttled detail mark"
```

---

### Task 9: README 文档 + 全量验证

**Files:**
- Modify: `README.md`（功能介绍区追加「弱网限速」小节）

- [ ] **Step 1: README 追加小节**（跟随现有功能介绍的格式与语言，放在规则/重定向相关内容之后）

```markdown
## 弱网限速

设置页开启后，所有经过代理的响应流量按「下行带宽 + 延迟 ± 抖动」变慢，内置 3G / 慢速 3G / 56K 拨号 / 弱 WiFi 预设，数值可自定义，保存即时生效（无需重启代理）。状态栏常驻限速标记，抓包详情显示每次实际叠加的限速延迟。

局限：仅对代理可见的流量生效——白名单外的 HTTPS 走盲隧道，内容不可见，无法限速（HTTPS 解密白名单内的流量不受影响）；Replay 不限速；只模拟下行方向。
```

- [ ] **Step 2: 全量验证**

```bash
npm run typecheck
npm run test
npm run test:e2e
```

Expected: 三者全过（typecheck 无输出；vitest 全 PASS；playwright 全 PASS，含既有 40+ 用例）

- [ ] **Step 3: 提交**

```bash
git add README.md
git commit -m "docs: weak-network throttling usage and limitations"
```

---

## 验收清单（对照 spec）

- [ ] 全局开关作用于 passthrough / mock / mapLocal / mapRemote 四条响应路径（Task 5 集成测试覆盖前两条 + mapLocal/mapRemote 由共享 applyThrottle 保证；E2E 覆盖 UI 链路）
- [ ] 预设 + 自定义（选预设填值、改数值变 custom）（Task 1 / 6 / 8）
- [ ] 只做下行；Replay 不限速（applyThrottle 仅挂在 proxy-server，ReplayService 不经过）
- [ ] onboarding 端点不限速（Task 5 未挂载）
- [ ] 时延封顶 300s、stop() 时 signal 中止（Task 2/3 单测）
- [ ] IPC 校验 + 旧 settings 兼容（Task 4）
- [ ] 状态栏 chip、详情页「限速 +nms」、列表不加列（Task 7 / 8）
- [ ] 坑及处理见 spec §8（README 局限标注在 Task 9）
