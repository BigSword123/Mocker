# 代理开关简化（Proxy Switch Cleanup）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「关 / 手机 / 电脑」成为系统代理的唯一入口，删掉设置页里冗余且会与状态栏打架的「开启/关闭系统代理」按钮，并修掉保存设置时静默关闭系统代理的两个真实 bug。

**Architecture:** 把渲染进程里手写的「存盘 → 停代理 → 起代理 → 重设系统代理」编排下沉为主进程模块 `src/main/apply-settings.ts`（沿用 `src/main/monitor-mode.ts` 的「编排函数 + 注入依赖 + node 环境单测」范式），通过新 IPC 通道 `settings:apply` 暴露。归属标记 `systemProxySetByUs` 在主进程内实时读取，渲染进程不再持有任何系统代理状态快照。

**Tech Stack:** Electron 44 + React 19 + TypeScript，vitest（`environment: 'node'`，只收 `tests/**/*.test.ts`，**没有 DOM 测试环境**），Playwright `_electron`（`workers: 1`，打真实 Electron、真实改操作系统代理）。

---

## 背景：为什么要改

设置页和状态栏存在两代重叠的开关（旧按钮来自 phase-1 MVP `80e96d9`，状态栏监控模式来自 `3b299da` / `fae1450`，旧的没删也没接通）。当前行为对照：

| | 设置页「开启系统代理」 | 状态栏「电脑」 |
|---|---|---|
| 设置操作系统代理 | 是 | 是 |
| 代理没启动时 | **抛错 `请先启动代理服务`**（`ipc.ts:131`） | 自动启动（`monitor-mode.ts:52`） |
| 清理手机端代理 | 否 | 是（`monitor-mode.ts:39-45`） |
| 持久化 `monitorMode` | **否** → 重启不恢复 | 是（`monitor-mode.ts:60`） |

「电脑」是「开启系统代理」的严格超集，旧按钮没有可达的独有状态。更糟的是两者会互相打架——根因是 `SettingsPanel.tsx:14,21` 只在挂载时读一次系统代理状态、之后从不刷新，而状态栏在设置页是可见的（`App.tsx:24,39`）：

- **Bug A（静默断网）**：设置页 → 点状态栏「电脑」（系统代理已开）→ 点「保存并重启代理」。`proxyStop` 会还原系统代理（`ipc.ts:61-68`），但 `SettingsPanel.tsx:43` 的 `if (systemProxy)` 用的是过期快照 `false`，重设那步不执行 → **用户的系统代理被静默关掉**，界面还提示「已保存，代理已重启生效」。
- **Bug B（劫持别人的代理）**：若系统代理是 Clash 等工具设的，挂载快照为 `true`；`proxyStop` 因为 `systemProxySetByUs === false` 不会碰它，但 `SettingsPanel.tsx:44` 会调 `systemProxySet(true)` 把它劫持到 mocker 端口并置 `systemProxySetByUs = true` → **退出 mocker 时会把别人的代理一起关掉**。

附带问题：「启动时自动开代理」这个标签名没说明它同时管着 `monitorMode` 的恢复（`index.ts:111-137`），关掉它连「电脑/手机」模式也不恢复了。

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `src/main/apply-settings.ts` | 「保存设置 + 重启代理 + 按归属重设系统代理」的编排，纯函数、依赖注入 | 新建 |
| `tests/apply-settings.test.ts` | 上述编排的 5 条单测，含 Bug A/B 的回归 | 新建 |
| `src/main/ipc.ts` | 抽出 `startProxy` / `stopProxy` / `setSettings` 复用；新增 `settings:apply`；删除死通道 `system-proxy:set` | 修改 |
| `src/shared/api.ts` | 渲染进程 API 契约：加 `settingsApply`，删 `systemProxySet` | 修改 |
| `src/preload/index.ts` | contextBridge 实现，与 `api.ts` 同步 | 修改 |
| `src/renderer/src/components/SettingsPanel.tsx` | 删系统代理按钮/状态/handler，`save()` 改走 `settingsApply`，标签改名 + 加说明 | 修改 |
| `e2e/settings-apply.spec.ts` | 真实 Electron 下验证 Bug A 已修 + 按钮已移除 | 新建 |
| `README.md` | 合并「系统代理一键开关」与「监控模式」两条重叠的功能描述 | 修改 |

不动的文件（明确记录，避免误改）：

- `src/main/index.ts` —— `systemProxySetByUs` 的持有者与 `before-quit` 清理逻辑保持原样，`apply-settings` 只通过既有的 `ctx.systemProxySetByUs()` / `ctx.onSystemProxyChanged()` 读写它。
- `src/main/monitor-mode.ts` 与 `tests/monitor-mode.test.ts` —— 「电脑」路径已经是正确实现，不改。
- `src/main/system-proxy/**` —— macOS `networksetup` / Windows 注册表的底层实现不改。
- `src/renderer/src/components/StatusBar.tsx` —— 本次不重做状态栏（用户在方案选择时已明确排除）。
- `system-proxy:status` 通道与 `api.systemProxyStatus()` **保留**：`e2e/monitor-mode.spec.ts:29,37,43` 依赖它。

## 不在本次范围

- 状态栏「关/手机/电脑」的视觉重做、端口实时显示。
- adb 用配置端口而非实际绑定端口的不一致（`ipc.ts:104,157,159` vs `ipc.ts:133,153`）。
- `String(err)` 跨 IPC 会带 `Error invoking remote method '...':` 前缀的问题（既有现象，`saveThrottle` 与 `StatusBar.switchMode` 同样如此）。
- `SettingsStore.onChange` 零订阅者的问题。

## 跨会话协调（执行前必读）

- 本仓库可能有其他 agent 会话共用同一工作目录。**每个 Task 的 commit 只 `git add` 该 Task 明确列出的文件，严禁 `git add -A` / `git add .`。**
- 每次 commit 前先 `git status --short` 确认没有别人的在途改动被卷进来。
- `src/renderer/src/lib/body-codec.ts` 是跨会话冻结契约，本次不涉及，别碰。
- 工作分支：`refactor/proxy-switch-cleanup`（已从 `master` @ `e7d43f6` 建好）。

---

### Task 1: `applySettings` 编排模块

**Files:**
- Create: `src/main/apply-settings.ts`
- Test: `tests/apply-settings.test.ts`

- [ ] **Step 1: 写失败测试 `tests/apply-settings.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest';
import { applySettings, type ApplySettingsDeps } from '../src/main/apply-settings';
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/types';

const PATCH: Partial<Settings> = { proxyPort: 9999 };
const NEXT: Settings = { ...DEFAULT_SETTINGS, proxyPort: 9999 };

function makeDeps(over: Partial<ApplySettingsDeps> = {}): ApplySettingsDeps {
  return {
    systemProxyOwnedByUs: vi.fn(() => false),
    settingsSet: vi.fn(async () => NEXT),
    proxyStop: vi.fn(async () => {}),
    proxyStart: vi.fn(async () => {}),
    enableSystemProxy: vi.fn(async () => {}),
    ...over,
  };
}

describe('applySettings', () => {
  it('saves then restarts the proxy in stop-before-start order', async () => {
    const order: string[] = [];
    const d = makeDeps({
      settingsSet: vi.fn(async () => {
        order.push('set');
        return NEXT;
      }),
      proxyStop: vi.fn(async () => {
        order.push('stop');
      }),
      proxyStart: vi.fn(async () => {
        order.push('start');
      }),
    });
    await expect(applySettings(PATCH, d)).resolves.toBe(NEXT);
    expect(d.settingsSet).toHaveBeenCalledWith(PATCH);
    expect(order).toEqual(['set', 'stop', 'start']);
  });

  it('re-applies the system proxy after restart when mocker owns it', async () => {
    const d = makeDeps({ systemProxyOwnedByUs: vi.fn(() => true) });
    await applySettings(PATCH, d);
    expect(d.enableSystemProxy).toHaveBeenCalledOnce();
  });

  it('leaves the system proxy alone when another tool owns it', async () => {
    // 回归 Bug B：Clash 等工具设的系统代理不得被劫持到 mocker 端口
    const d = makeDeps({ systemProxyOwnedByUs: vi.fn(() => false) });
    await applySettings(PATCH, d);
    expect(d.enableSystemProxy).not.toHaveBeenCalled();
  });

  it('snapshots ownership before stop, so a stop that clears the flag still re-applies', async () => {
    // 回归 Bug A：proxyStop 会还原系统代理并把归属标记清成 false，
    // 归属必须在停止之前读取，否则重启后不会重设，用户的系统代理被静默关掉
    let owned = true;
    const d = makeDeps({
      systemProxyOwnedByUs: () => owned,
      proxyStop: vi.fn(async () => {
        owned = false;
      }),
    });
    await applySettings(PATCH, d);
    expect(d.enableSystemProxy).toHaveBeenCalledOnce();
  });

  it('does not restart or read ownership when validation rejects the patch', async () => {
    const d = makeDeps({
      settingsSet: vi.fn(async () => {
        throw new Error('代理端口必须是 1-65535 的整数');
      }),
      systemProxyOwnedByUs: vi.fn(() => true),
    });
    await expect(applySettings(PATCH, d)).rejects.toThrow('代理端口必须是 1-65535 的整数');
    expect(d.systemProxyOwnedByUs).not.toHaveBeenCalled();
    expect(d.proxyStop).not.toHaveBeenCalled();
    expect(d.proxyStart).not.toHaveBeenCalled();
    expect(d.enableSystemProxy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/apply-settings.test.ts`
Expected: FAIL — `Cannot find module '../src/main/apply-settings'`

- [ ] **Step 3: 实现 `src/main/apply-settings.ts`**

```ts
import type { Settings } from '../shared/types';

export interface ApplySettingsDeps {
  /** 系统代理是否由 mocker 设置；Clash 等第三方工具设的不算 */
  systemProxyOwnedByUs: () => boolean;
  settingsSet: (patch: Partial<Settings>) => Promise<Settings>;
  proxyStop: () => Promise<void>;
  proxyStart: () => Promise<void>;
  enableSystemProxy: () => Promise<void>;
}

// 端口 / HTTPS 模式 / 白名单 / 上游代理只在代理启动时读取（proxy-server.ts:71-164），
// 所以必须重启才生效；规则、重定向、场景、限速是实时读取的，不走这里。
export async function applySettings(
  patch: Partial<Settings>,
  d: ApplySettingsDeps,
): Promise<Settings> {
  const next = await d.settingsSet(patch);
  // 归属必须在 proxyStop 之前读取：停止代理会还原系统代理并把归属标记清成 false
  const reapply = d.systemProxyOwnedByUs();
  await d.proxyStop();
  await d.proxyStart();
  if (reapply) await d.enableSystemProxy();
  return next;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/apply-settings.test.ts`
Expected: PASS，5 个用例全绿

- [ ] **Step 5: 跑全量单测确认无回归**

Run: `npm test`
Expected: PASS（原 526 个 + 新 5 个）

- [ ] **Step 6: Commit**

```bash
git status --short
git add src/main/apply-settings.ts tests/apply-settings.test.ts
git commit -m "feat(main): applySettings orchestration owning system-proxy reapply"
```

---

### Task 2: IPC 接线 —— 抽出复用函数，新增 `settings:apply`

本 Task 只**新增**，不删任何既有通道，保证中间态可构建可运行。

**Files:**
- Modify: `src/main/ipc.ts:14`（import）、`src/main/ipc.ts:51-71`（抽 `startProxy`/`stopProxy`）、`src/main/ipc.ts:106-125`（抽 `setSettings`）、新增 `settings:apply` handler

- [ ] **Step 1: 加 import**

`src/main/ipc.ts` 第 20 行 `import { applyMonitorMode } from './monitor-mode';` 之后插入一行：

```ts
import { applySettings } from './apply-settings';
```

- [ ] **Step 2: 把 `proxy:start` / `proxy:stop` 的 handler 体抽成局部函数**

将 `src/main/ipc.ts:51-71` 这段：

```ts
export function registerIpc(ctx: IpcContext): void {
  ipcMain.handle('proxy:start', async () => {
    await ctx.proxy.start();
    ctx.history.openSession();
    // Best-effort cleanup of stale session files; never fail start over it.
    await ctx.history.prune().catch(() => {});
  });
  ipcMain.handle('proxy:stop', async () => {
    // Restore the OS proxy first while the proxy still serves, so traffic is
    // never routed at a dead port. Only our own setting is ours to undo.
    if (ctx.systemProxySetByUs()) {
      try {
        await disableSystemProxy();
      } catch {
        // 尽力恢复，失败不阻塞停止流程
      }
      ctx.onSystemProxyChanged(false);
    }
    await ctx.proxy.stop();
    await ctx.history.closeSession();
  });
```

整体替换为：

```ts
export function registerIpc(ctx: IpcContext): void {
  const startProxy = async (): Promise<void> => {
    await ctx.proxy.start();
    ctx.history.openSession();
    // Best-effort cleanup of stale session files; never fail start over it.
    await ctx.history.prune().catch(() => {});
  };

  const stopProxy = async (): Promise<void> => {
    // Restore the OS proxy first while the proxy still serves, so traffic is
    // never routed at a dead port. Only our own setting is ours to undo.
    if (ctx.systemProxySetByUs()) {
      try {
        await disableSystemProxy();
      } catch {
        // 尽力恢复，失败不阻塞停止流程
      }
      ctx.onSystemProxyChanged(false);
    }
    await ctx.proxy.stop();
    await ctx.history.closeSession();
  };

  ipcMain.handle('proxy:start', startProxy);
  ipcMain.handle('proxy:stop', stopProxy);
```

注意：紧随其后的 `ipcMain.handle('proxy:status', ...)` 保持原样不动。

- [ ] **Step 3: 把 `settings:set` 的校验体抽成局部函数，并新增 `settings:apply`**

将 `src/main/ipc.ts:106-125` 这段：

```ts
  ipcMain.handle('settings:get', () => ctx.settings.get());
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

整体替换为：

```ts
  const setSettings = (patch: Partial<Settings>): Settings => {
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
  };

  ipcMain.handle('settings:get', () => ctx.settings.get());
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => setSettings(patch));
  ipcMain.handle('settings:apply', (_e, patch: Partial<Settings>) =>
    applySettings(patch, {
      systemProxyOwnedByUs: ctx.systemProxySetByUs,
      settingsSet: async (p) => setSettings(p),
      proxyStop: stopProxy,
      proxyStart: startProxy,
      enableSystemProxy: async () => {
        await enableSystemProxy(ctx.proxy.port);
        ctx.onSystemProxyChanged(true);
      },
    }),
  );
```

`settings:apply` 复用 `setSettings`，因此端口/限速/上游/monitorMode 的校验一条都不会绕过；校验失败时 `applySettings` 在快照归属之前就抛出，不会重启代理。

对象字面量里的属性名 `enableSystemProxy` 不会遮蔽第 14 行导入的同名函数（属性名不创建绑定），既有 `monitor:set-mode`（`ipc.ts:152-155`）已是同样写法。

- [ ] **Step 4: 类型检查**

Run: `npm run typecheck`
Expected: 无输出、退出码 0

- [ ] **Step 5: 跑全量单测**

Run: `npm test`
Expected: PASS，数量与 Task 1 结束时一致（本 Task 不新增单测；`registerIpc` 依赖 Electron 的 `ipcMain`，既有惯例是不做单测，由 Task 6 的 e2e 覆盖）

- [ ] **Step 6: Commit**

```bash
git status --short
git add src/main/ipc.ts
git commit -m "feat(main): settings:apply channel reusing extracted proxy start/stop"
```

---

### Task 3: API 契约与 preload 桥

**Files:**
- Modify: `src/shared/api.ts:18`（`settingsSet` 之后插入）
- Modify: `src/preload/index.ts:17`（`settingsSet` 之后插入）

- [ ] **Step 1: `src/shared/api.ts` 的 `Api` 接口中，第 18 行 `settingsSet(patch: Partial<Settings>): Promise<Settings>;` 之后插入**

```ts
  /** 保存设置并重启代理；系统代理若由 mocker 设置，重启后自动重设 */
  settingsApply(patch: Partial<Settings>): Promise<Settings>;
```

- [ ] **Step 2: `src/preload/index.ts` 的 `api` 对象中，第 17 行 `settingsSet: ...` 之后插入**

```ts
  settingsApply: (patch: Partial<Settings>) => ipcRenderer.invoke('settings:apply', patch),
```

`Settings` 类型在 `preload/index.ts:3` 已导入，无需改 import。

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck`
Expected: 无输出、退出码 0

- [ ] **Step 4: Commit**

```bash
git status --short
git add src/shared/api.ts src/preload/index.ts
git commit -m "feat(api): expose settingsApply to the renderer"
```

---

### Task 4: SettingsPanel —— 删旧按钮、改走 `settingsApply`、标签改名

**Files:**
- Modify: `src/renderer/src/components/SettingsPanel.tsx`

- [ ] **Step 1: 删掉系统代理的本地状态与挂载时快照**

删除第 14 行：

```ts
  const [systemProxy, setSystemProxy] = useState(false);
```

并把第 19-23 行的 `useEffect` 中这一行删除：

```ts
    api.systemProxyStatus().then(setSystemProxy).catch(() => setSystemProxy(false));
```

改完后 `useEffect` 应为：

```ts
  useEffect(() => {
    api.settingsGet().then(setSettings).catch(() => {});
    api.certInstallCommands().then(setCertCmds).catch(() => {});
  }, []);
```

- [ ] **Step 2: `save()` 改走 `settingsApply`**

将第 27-53 行的 `save` 整体替换为：

```ts
  const save = async (patch: Partial<Settings>) => {
    setSaving(true);
    try {
      if (
        !Number.isInteger(settings.proxyPort) ||
        settings.proxyPort < 1 ||
        settings.proxyPort > 65535
      ) {
        setMessage('代理端口必须是 1-65535 的整数');
        return;
      }
      setSettings(await api.settingsApply(patch));
      setMessage('已保存，代理已重启生效');
      setTimeout(() => setMessage(''), 3000);
    } catch (err) {
      setMessage(String(err));
    } finally {
      setSaving(false);
    }
  };
```

保留客户端端口校验：它给出的是不带 IPC 前缀的干净文案，且不属于本次「开关混乱」的范围。`return` 仍会走 `finally`，`saving` 正常复位。

- [ ] **Step 3: 删掉 `toggleSystemProxy`**

删除第 55-62 行整个函数：

```ts
  const toggleSystemProxy = async () => {
    try {
      await api.systemProxySet(!systemProxy);
      setSystemProxy(!systemProxy);
    } catch (err) {
      setMessage(String(err));
    }
  };
```

- [ ] **Step 4: 改标签名 + 加说明行**

将第 124-129 行：

```tsx
        <label>启动时自动开代理</label>
        <input
          type="checkbox"
          checked={settings.autoStartProxy}
          onChange={(e) => setSettings({ ...settings, autoStartProxy: e.target.checked })}
        />
```

替换为：

```tsx
        <label>启动时自动恢复</label>
        <input
          data-testid="autostart-proxy"
          type="checkbox"
          checked={settings.autoStartProxy}
          onChange={(e) => setSettings({ ...settings, autoStartProxy: e.target.checked })}
        />
        <label />
        <div className="form-note">
          勾选后启动时会自动开启代理服务，并恢复上次的「电脑 / 手机」监控模式；取消勾选则两者都不恢复。
          需点「保存并重启代理」才写入，下次启动生效。
        </div>
```

标签保持 7 个字：`.form-grid` 的标签列是固定 `120px` 右对齐（`styles.css:60-61`），原「启动时自动开代理」8 字已接近上限，更长的名字会折行。`<label />` + `.form-note` 是仓库既有写法（见 `TimestampTool.tsx:160-163`、`WebpTool.tsx:194-197`、`GzipTool.tsx:159-162`）。

- [ ] **Step 5: 把「系统代理」按钮行换成指向状态栏的说明**

将第 142-145 行：

```tsx
        <label>系统代理</label>
        <div>
          <button onClick={toggleSystemProxy}>{systemProxy ? '关闭系统代理' : '开启系统代理'}</button>
        </div>
```

替换为：

```tsx
        <label>系统代理</label>
        <div className="form-note" data-testid="system-proxy-hint">
          由窗口底部状态栏的「关 / 手机 / 电脑」统一控制，此处不再单独设置。
          选「电脑」会自动启动代理、接管系统代理，并在下次启动时恢复；退出应用时自动还原。
        </div>
```

- [ ] **Step 6: 给保存按钮和消息加 testid**

将第 147-165 行的 toolbar：

```tsx
      <div className="toolbar">
        <button
          className="primary"
          disabled={saving}
          onClick={() =>
            save({
              proxyPort: settings.proxyPort,
              httpsMode: settings.httpsMode,
              whitelist: settings.whitelist,
              autoStartProxy: settings.autoStartProxy,
              upstreamProxyUrl: settings.upstreamProxyUrl,
              upstreamNoProxy: settings.upstreamNoProxy,
            })
          }
        >
          保存并重启代理
        </button>
        {message && <span className="muted">{message}</span>}
      </div>
```

替换为：

```tsx
      <div className="toolbar">
        <button
          className="primary"
          data-testid="settings-save"
          disabled={saving}
          onClick={() =>
            save({
              proxyPort: settings.proxyPort,
              httpsMode: settings.httpsMode,
              whitelist: settings.whitelist,
              autoStartProxy: settings.autoStartProxy,
              upstreamProxyUrl: settings.upstreamProxyUrl,
              upstreamNoProxy: settings.upstreamNoProxy,
            })
          }
        >
          保存并重启代理
        </button>
        {message && (
          <span className="muted" data-testid="settings-message">
            {message}
          </span>
        )}
      </div>
```

patch 字段不变：仍然**不含** `monitorMode` 与 `throttle`，保存设置不会覆盖监控模式，限速仍走自己的「保存限速设置」按钮。

- [ ] **Step 7: 类型检查 + 全量单测**

Run: `npm run typecheck && npm test`
Expected: typecheck 无输出；单测 PASS

此时 `api.systemProxySet` 已无任何调用方，但接口与 handler 仍在 —— Task 5 才删，保证本 Task 结束时可构建。

- [ ] **Step 8: Commit**

```bash
git status --short
git add src/renderer/src/components/SettingsPanel.tsx
git commit -m "refactor(ui): drop settings system-proxy button, save via settingsApply"
```

---

### Task 5: 删除死代码 —— `system-proxy:set` 通道与 `systemProxySet`

**Files:**
- Modify: `src/main/ipc.ts`（删 `system-proxy:set` handler）
- Modify: `src/shared/api.ts:21`（删 `systemProxySet`）
- Modify: `src/preload/index.ts:20`（删 `systemProxySet`）

- [ ] **Step 1: 确认确实没有调用方**

Run: `grep -rn "systemProxySet" src e2e tests`
Expected: 只出现 3 处 —— `src/shared/api.ts:21`（声明）、`src/preload/index.ts:20`（实现）、以及 `src/main/ipc.ts` 中形如 `systemProxySetByUs` 的**不同**标识符。若出现任何调用点（`api.systemProxySet(`），停止并重新评估。

注意区分：`systemProxySetByUs` 是 `IpcContext` 上的归属 getter，**必须保留**；本步只删 `systemProxySet`。

- [ ] **Step 2: 删 `src/main/ipc.ts` 的 handler**

删除这一段（原第 130-138 行，Task 2 之后行号可能小幅前移，按内容定位）：

```ts
  ipcMain.handle('system-proxy:set', async (_e, enabled: boolean) => {
    if (enabled && !ctx.proxy.running) throw new Error('请先启动代理服务');
    if (enabled) {
      await enableSystemProxy(ctx.proxy.port);
    } else {
      await disableSystemProxy();
    }
    ctx.onSystemProxyChanged(enabled);
  });
```

**保留**紧随其后的 `ipcMain.handle('system-proxy:status', () => systemProxyEnabled());` —— `e2e/monitor-mode.spec.ts:29,37,43` 依赖它。

删除后第 14 行的 `import { disableSystemProxy, enableSystemProxy, systemProxyEnabled } from './system-proxy';` 三个符号仍全部在用（`disableSystemProxy` 用于 `stopProxy` 与 `monitor:set-mode` 的 `restoreSystemProxy`；`enableSystemProxy` 用于 `monitor:set-mode` 与 `settings:apply`；`systemProxyEnabled` 用于 `system-proxy:status`），**不要删 import**。

- [ ] **Step 3: 删 `src/shared/api.ts` 第 21 行**

```ts
  systemProxySet(enabled: boolean): Promise<void>;
```

下一行 `systemProxyStatus(): Promise<boolean>;` 保留。

- [ ] **Step 4: 删 `src/preload/index.ts` 第 20 行**

```ts
  systemProxySet: (enabled: boolean) => ipcRenderer.invoke('system-proxy:set', enabled),
```

下一行 `systemProxyStatus: () => ipcRenderer.invoke('system-proxy:status'),` 保留。

- [ ] **Step 5: 类型检查 + 全量单测 + 构建**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck 无输出；单测 PASS；构建成功（`Api` 与 preload 实现必须严格一致，少一个或多一个都会在这里报错）

- [ ] **Step 6: Commit**

```bash
git status --short
git add src/main/ipc.ts src/shared/api.ts src/preload/index.ts
git commit -m "refactor(main): remove dead system-proxy:set channel"
```

---

### Task 6: E2E —— 真实 Electron 下验证 Bug A 已修

**Files:**
- Create: `e2e/settings-apply.spec.ts`

本 spec 会**真实修改本机系统代理**（走 macOS `networksetup`）。`playwright.config.ts` 已设 `workers: 1`，不会与 `e2e/monitor-mode.spec.ts` 并发抢占；`afterAll` 必须把模式还原到 `off`。

- [ ] **Step 1: 写 `e2e/settings-apply.spec.ts`**

```ts
import { _electron as electron, test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'] });
  win = await app.firstWindow();
});

test.afterAll(async () => {
  // 必须恢复：本 spec 会真实修改系统代理，结束必回 off
  await win
    .evaluate(async () => {
      await window.api.monitorSetMode('off');
    })
    .catch(() => {});
  await app.close();
});

const openSettings = async () => {
  await win.locator('nav.tabs').getByRole('button', { name: '设置', exact: true }).click();
};

test('settings page no longer has its own system-proxy button', async () => {
  await openSettings();
  await expect(win.getByTestId('system-proxy-hint')).toContainText('状态栏');
  await expect(win.getByRole('button', { name: '开启系统代理' })).toHaveCount(0);
  await expect(win.getByRole('button', { name: '关闭系统代理' })).toHaveCount(0);
  await expect(win.getByTestId('autostart-proxy')).toBeVisible();
});

test('saving settings keeps a mocker-owned system proxy on', async () => {
  await win.waitForSelector('[data-testid="monitor-mode"]');
  await win.getByTestId('monitor-computer').click();
  await expect
    .poll(async () => win.evaluate(async () => window.api.systemProxyStatus()))
    .toBe(true);

  await openSettings();
  await win.getByTestId('settings-save').click();
  await expect(win.getByTestId('settings-message')).toContainText('已保存，代理已重启生效', {
    timeout: 20000,
  });

  // 回归 Bug A：旧代码用挂载时的快照，走到这里系统代理已被静默关掉
  await expect
    .poll(async () => win.evaluate(async () => window.api.systemProxyStatus()))
    .toBe(true);
  expect(await win.evaluate(async () => (await window.api.proxyStatus()).running)).toBe(true);
  expect(await win.evaluate(async () => (await window.api.settingsGet()).monitorMode)).toBe(
    'computer',
  );
});

test('saving settings does not enable a system proxy mocker does not own', async () => {
  await win.evaluate(async () => {
    await window.api.monitorSetMode('off');
  });
  await expect
    .poll(async () => win.evaluate(async () => window.api.systemProxyStatus()))
    .toBe(false);

  // 仍停在设置页；monitorMode 不属于保存 patch，保存不会把模式改回去
  await win.getByTestId('settings-save').click();
  await expect(win.getByTestId('settings-message')).toContainText('已保存', { timeout: 20000 });
  expect(await win.evaluate(async () => window.api.systemProxyStatus())).toBe(false);
});
```

注意断言写法：`toHaveText('')` 对 `<input>` 恒真（表单控件 textContent 永远是空串），本 spec 断言的是 `<div>` / `<span>` 文本与 checkbox 可见性，不受此坑影响；如需断言输入框内容必须用 `toHaveValue`。

- [ ] **Step 2: 跑新 spec**

Run: `npm run build && npx playwright test e2e/settings-apply.spec.ts`
Expected: 3 个用例 PASS。**跑完确认本机系统代理已关闭**（macOS：系统设置 → 网络 → 详细信息 → 代理；或 `networksetup -getwebproxy Wi-Fi` 应为 `Enabled: No`）

若第 2 个用例在 `systemProxyStatus()` 上失败为 `false`，先确认不是环境问题：`networksetup -listnetworkserviceorder` 能否解析出当前活动网卡（`src/main/system-proxy/macos.ts:28-36` 依赖 `route -n get default`）。

- [ ] **Step 3: 跑全量 e2e 确认无回归**

Run: `npm run test:e2e`
Expected: PASS（原 63 个 + 新 3 个）。`e2e/monitor-mode.spec.ts` 必须仍然全绿——它依赖的 `systemProxyStatus` 通道在 Task 5 中被刻意保留。

- [ ] **Step 4: Commit**

```bash
git status --short
git add e2e/settings-apply.spec.ts
git commit -m "test(e2e): settings save must not silently drop a mocker-owned system proxy"
```

---

### Task 7: README

**Files:**
- Modify: `README.md:14-15`、`README.md:106-113`

- [ ] **Step 1: 合并功能列表里重叠的两条**

将 `README.md` 第 14-15 行：

```markdown
- 系统代理一键开关（macOS / Windows）
- 监控模式三态切换（关 / 手机 / 电脑）：一次只监控一边，切换时自动清理另一侧
```

替换为：

```markdown
- 监控模式三态切换（关 / 手机 / 电脑）：接管流量的唯一入口，一次只监控一边，切换时自动清理另一侧；「电脑」即一键接管系统代理（macOS / Windows）
```

- [ ] **Step 2: 在「使用说明」里补一句归属说明**

将 `README.md` 第 106-113 行：

```markdown
## 使用说明

1. 启动后代理自动运行（默认 `8888`）。状态栏「监控」三态选择：
   - **关**：不接管任何流量
   - **手机**：一键建立 adb 隧道并设置手机代理（需数据线 + USB 调试；设备不在线只提示，不影响切换）
   - **电脑**：接管系统代理——浏览器/系统流量要经代理才能被抓到
   切换时自动清理另一侧（如电脑切手机会自动还原系统代理）；应用退出时自动还原系统代理与手机代理
```

替换为：

```markdown
## 使用说明

1. 启动后代理自动运行（默认 `8888`）。状态栏「监控」三态选择是接管流量的**唯一入口**：
   - **关**：不接管任何流量
   - **手机**：一键建立 adb 隧道并设置手机代理（需数据线 + USB 调试；设备不在线只提示，不影响切换）
   - **电脑**：接管系统代理——浏览器/系统流量要经代理才能被抓到；代理没启动会自动启动
   切换时自动清理另一侧（如电脑切手机会自动还原系统代理）；应用退出时自动还原系统代理与手机代理。
   设置页不再单独提供系统代理开关；「设置 → 保存并重启代理」只负责让端口 / HTTPS 模式 / 白名单 / 上游代理生效，重启后会按归属自动恢复系统代理（由第三方工具如 Clash 设置的不会被改动）
```

- [ ] **Step 3: 确认没有别处还在教用户点旧按钮**

Run: `grep -n "开启系统代理\|关闭系统代理\|启动时自动开代理" README.md docs/superpowers/specs/*.md`
Expected: 命中只出现在历史 spec/plan 文档里（`docs/superpowers/specs/2026-09-01-mocker-design.md` 等）—— 那些是存档，**不要改**。`README.md` 应零命中。

- [ ] **Step 4: Commit**

```bash
git status --short
git add README.md
git commit -m "docs: monitor mode is the single entry point for traffic takeover"
```

---

## 验收清单

- [ ] 设置页不再有「开启/关闭系统代理」按钮，取而代之是一行指向状态栏的说明
- [ ] 「启动时自动开代理」改名为「启动时自动恢复」，并说明它同时管监控模式恢复
- [ ] 点状态栏「电脑」后再点「保存并重启代理」，系统代理**保持开启**（Bug A 修复，e2e 第 2 例覆盖）
- [ ] 系统代理由第三方工具设置时，保存设置不会去碰它（Bug B 修复，单测 `leaves the system proxy alone...` 覆盖）
- [ ] 校验失败（如端口越界）时不重启代理、不读归属（单测 `does not restart or read ownership...` 覆盖）
- [ ] `system-proxy:set` 通道与 `api.systemProxySet` 已删除；`system-proxy:status` 保留
- [ ] 保存设置的 patch 仍不含 `monitorMode` / `throttle`
- [ ] `npm run typecheck`、`npm test`、`npm run test:e2e` 全绿
- [ ] 跑完 e2e 后本机系统代理处于关闭状态

## 手工验证（未自动化，需真人操作）

按仓库既有惯例，以下项不写自动化测试，完成后在此勾选：

- [ ] macOS 上点「电脑」→ 系统设置里能看到代理被设为 `127.0.0.1:<端口>`；点「关」→ 还原
- [ ] 开着 Clash 系统代理时点「保存并重启代理」→ Clash 的代理设置不被改写；退出 mocker 后 Clash 代理仍在
- [ ] 取消勾选「启动时自动恢复」并保存 → 重启应用后代理不自动启动、监控模式也不恢复
- [ ] 勾选状态下以「电脑」模式退出应用 → 重新启动后系统代理自动恢复
