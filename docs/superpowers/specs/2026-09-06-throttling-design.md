# Mocker 弱网限速设计文档（路线图第三期）

日期：2026-09-06
状态：已确认，待实现
路线图：第三期「代理干预」收窄为 限速 + USB 连手机引导页（断点不做，另行一期或放弃）。本文档只覆盖**限速**；USB 引导页另出设计。

## 1. 目标与范围

全局弱网限速：一个开关作用于代理的全部实时响应流量，参数为下行带宽 + 延迟 + 抖动，提供预设档与自定义数值。

已确认决议：

| 决策点 | 决议 |
|---|---|
| 粒度 | **全局开关**，不做按域名/规则限速 |
| 参数形态 | **预设 + 自定义**（预设 = 一组默认值，选中填入数值；手改数值 → preset 变 custom） |
| 方向 | **只做下行带宽**，不做上行/上传限速 |
| 实现路线 | **缓冲 + 时延模拟**（理由见 §2） |

非目标：按域名/规则粒度、上行限速、渐进式流式传输、丢包模拟、Replay 限速。

## 2. 技术约束（为什么是缓冲 + 时延模拟）

- mockttp 4.x（当前 ^4.6.1）没有任何 throttle/bandwidth API。
- `thenPassThrough` 的 `beforeRequest`/`beforeResponse` 回调返回的响应体只支持 `string | Buffer | Uint8Array` 整块数据；`thenStream`（StreamStep）只能配静态内容规则，不能携带上游透传响应。
- 项目现有架构本就全量缓冲 body 用于抓包展示（`response` 事件 `extractText`），限速引入的缓冲无新增内存负担。
- 因此语义定义为**总时延模拟**：响应总时长基本正确（等待延迟 + 传输时长），但客户端是「等待 → 一次性收到」，非渐进式到达。对弱网测试（loading 态、超时、重试逻辑）足够。

## 3. 数据模型变更

`src/shared/types.ts`：

```ts
export type ThrottlePreset = 'three-g' | 'slow-three-g' | 'dialup' | 'weak-wifi' | 'custom';

export interface ThrottleSettings {
  enabled: boolean;
  preset: ThrottlePreset;
  downKbps: number;    // 1..100000
  latencyMs: number;   // 0..60000
  jitterMs: number;    // 0..30000
}

export const THROTTLE_PRESETS: Record<Exclude<ThrottlePreset, 'custom'>,
  Pick<ThrottleSettings, 'downKbps' | 'latencyMs' | 'jitterMs'>> = {
  'three-g':      { downKbps: 200, latencyMs: 300, jitterMs: 100 },
  'slow-three-g': { downKbps: 50,  latencyMs: 800, jitterMs: 300 },
  'dialup':       { downKbps: 6,   latencyMs: 120, jitterMs: 20 },
  'weak-wifi':    { downKbps: 400, latencyMs: 100, jitterMs: 80 },
};

// Settings 增加字段
export interface Settings {
  // …existing…
  throttle: ThrottleSettings;
}

// DEFAULT_SETTINGS.throttle = { enabled: false, preset: 'three-g', ...THROTTLE_PRESETS['three-g'] }

// TrafficEvent 增加字段：实际施加的限速延迟，仅在 >0ms 时写入，单位 ms
export interface TrafficEvent {
  // …existing…
  throttledMs?: number;
}
```

向后兼容：旧 settings JSON 缺 `throttle` 字段时，加载后用 `DEFAULT_SETTINGS.throttle` 补齐（settings-store 的 merge 语义，实现时确认现有 load 路径并补测试）。

## 4. 核心机制

`src/main/proxy/throttle.ts`（新建），两个函数：

```ts
// 纯计算，便于单测（rng 注入）
computeThrottleDelayMs(t: ThrottleSettings, bodyBytes: number, rng: () => number): number
//   disabled → 0
//   latencyPart = latencyMs + floor(rng() * (2*jitterMs + 1)) - jitterMs，下限 0
//   transferMs  = bodyBytes / (downKbps * 1024) * 1000
//   结果 = min(latencyPart + transferMs, DELAY_MS_MAX /* 300000 */)

// 实际睡眠；返回实际睡掉的 ms（调用方写入 event.throttledMs）
applyThrottle(getSettings: () => Settings, bodyBytes: number, signal?: AbortSignal): Promise<number>
```

`applyThrottle` 分片睡眠：总时延按当时设置算出，每睡 ~200ms 醒来重读最新设置——已关闭 → 立即放行；参数变化 → 按新设置重算总时延，减去已睡时间得剩余，≤0 放行，否则继续。中止信号触发时立即结束（复用 `src/main/util/sleep`）。

挂载点（覆盖全部响应路径，设置实时从 `getSettings()` 读取，改动即生效、无需重启代理）：

| 路径 | 挂载方式 |
|---|---|
| 直连透传 | `thenPassThrough({ beforeRequest, beforeResponse })` 新增 `beforeResponse`：`await applyThrottle(resp.body 字节数)` 后返回 void（不改写响应） |
| mock 命中 | `handleMatched` 在 `computeMockResult` 之后、构造返回前 `await applyThrottle(body 字节数)` |
| mapLocal / mapRemote | `handleRedirect` 返回响应前同上 |
| onboarding（证书/引导页） | **不挂**，避免自己坑自己 |

时序叠加：概率网络异常 → 规则自带 `delayMs`（现状，`computeMockResult` 内）→ **限速延迟（新增，最后）**。

## 5. UI

- **SettingsPanel** 新增「弱网限速」小节：启用开关、预设下拉（3G / 慢速 3G / 56K 拨号 / 弱 WiFi / 自定义）、三个数值输入（下行 KB/s、延迟 ms、抖动 ms）。选预设自动填数值；手改任一数值 → preset 自动变 `custom`。布局遵守密集打包纪律：控件行 flex-wrap + flex: 0 0 auto，不得溢出不可见。
- **StatusBar** 新增限速 chip：仅 `throttle.enabled` 时显示，预设显示「限速:3G」等名称，custom 显示「限速:<downKbps>KB/s」；点击跳转到设置页。让弱网状态在抓包主界面常驻可见。
- **TrafficDetail** meta 区：`throttledMs` 存在时显示一行「限速 +<n>ms」。流量列表**不加新列**（表格已密集，遵守 table-layout 纪律，避免水平滚动）。

## 6. 错误处理

- `settings:set`（`src/main/ipc.ts`）对 `throttle` 各字段校验：`enabled` boolean、`preset` 枚举、`downKbps` 整数 1–100000、`latencyMs` 整数 0–60000、`jitterMs` 整数 0–30000；非法 patch 整体拒绝，风格同现有 `proxyPort` 校验。
- `jitterMs > latencyMs` 不额外禁止：延迟下限自然落到 0。
- 无 body 响应（204/HEAD）只施加延迟部分。
- 代理 `stop()` 时正在睡的请求经 AbortSignal 立即中止。
- 大 body × 小带宽：封顶 `DELAY_MS_MAX`（300s），不会无限挂起。
- 客户端中途断开由 mockttp 自行处理，限速层无感知、无特殊逻辑。

## 7. 测试策略

| 层 | 覆盖 | 说明 |
|---|---|---|
| 单测（vitest） | `computeThrottleDelayMs`：disabled=0、抖动边界（注入 rng 取 0/1）、带宽换算、封顶 300s、无 body=延迟部分；`THROTTLE_PRESETS` 表完整性；`settings:set` throttle 校验各非法分支 | 纯函数，无 IO |
| 集成（`tests/proxy.integration.test.ts` 模式） | 起真代理 + mock 上游：开限速（latency 300ms 档）断言响应耗时 ≥ 计算下限；请求睡眠中途关闭限速 → 耗时明显小于原总时延（验证分片重算）；关限速后耗时无额外增加 | 时延断言只在这一层，参数取小控制单测时长 |
| E2E（playwright） | 设置面板选预设/改数值 → preset 变 custom；开关切换；状态栏 chip 显隐与文案；详情页「限速 +nms」出现 | 不断言真实时延（UI 时序不稳定，归集成层） |

跨平台：无平台特定 API（纯 Node 时序 + React UI），mac/Windows 行为一致；时延类断言不进 E2E，规避 CI 机器性能差异。

## 8. 局限与坑（每条带处理方式）

| 坑 | 处理方式 |
|---|---|
| 白名单外的 HTTPS 走 TLS 盲隧道，mockttp 碰不到内容，**无法限速** | 文档与引导页明确标注此局限；HTTPS 抓包（=被 MITM 的流量）不受影响，属预期行为不修 |
| 响应非渐进式到达（等待 → 一次性收到） | §2 已明确语义为总时延模拟；`event.throttledMs` + 详情页展示让行为可解释 |
| 忘关限速后「网络怎么这么慢」排查困惑 | 双重可见性：StatusBar 常驻 chip + 详情页「限速 +nms」 |
| 56K 档下载大文件把请求挂 5 分钟 | 封顶 DELAY_MS_MAX（300s）+ stop() 时 signal 中止 |
| 限速睡眠中途用户改小参数/关闭 | 分片 200ms 重算，尽快放行，不睡完旧时延 |
| 限速开启时关闭代理，客户端连接被切 | mockttp stop 既有语义，不做特殊处理；状态栏 chip 提示当前处于限速中 |

## 9. 实施约束（沿路线图惯例）

- 实现在 git worktree 内进行（master 有未提交改动时避免冲突）。
- 8888/8899 端口需空闲（E2E 与 dev）。
- 完成后安排 dogfooding 收敛轮。
