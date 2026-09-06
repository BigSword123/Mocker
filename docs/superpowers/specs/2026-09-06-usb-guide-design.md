# Mocker「USB 连手机」引导页设计文档（路线图第三期收官项）

日期：2026-09-06
状态：已确认（决策此前已逐条议定），待实现
路线图：三期「代理干预」剩最后一项；限速已合入（05ab4cf）。

## 1. 目标与范围

在「设备接入」页新增**「Android USB 直连」区块**：手机与电脑不同网段（如手机走 4G）时，经数据线把手机流量转到电脑代理，命中 mock 规则。引导页覆盖**全过程与结束后清理**。

已确认决策（沿用路线图记录）：

| 决策点 | 决议 |
|---|---|
| UI 位置 | 「设备接入」tab 内新区块，不加独立 tab |
| adb 检测 | 检测 adb 可用性、已连接设备、隧道状态、手机代理状态 |
| 操作方式 | 按钮直接执行 adb（非仅复制）；adb 不可用时降级为展示命令 + 复制按钮 |
| 结束后清理 | 常驻「一键恢复手机网络」按钮（`settings put global http_proxy :0`），文案醒目提醒否则手机断网 |
| 隧道失效 | `adb reverse --list` 检测，未建立时「建立隧道」一键重跑 |
| 局限标注 | 绕过系统代理的 app 与 QUIC（UDP 443）抓不到；iOS 无无越狱等价方案 |

非目标：iOS USB 方案、多设备选择 UI（多台时取第一台 `state=device` 的设备并显示 serial）、QUIC 拦截、adb 无线调试。

## 2. 数据模型

`src/shared/types.ts`：

```ts
export interface AdbDevice {
  serial: string;
  state: string;   // device / unauthorized / offline ...
}

export interface AdbStatus {
  adbAvailable: boolean;
  installHint?: string;      // adb 不可用时的安装指引（mac: brew install android-platform-tools；win: choco/官网）
  devices: AdbDevice[];
  activeSerial?: string;     // 被选中的设备（第一个 state=device）
  tunnelActive: boolean;     // adb reverse --list 含 tcp:<proxyPort>
  phoneProxySet: boolean;    // settings get global http_proxy 非空且非 null
}

export interface AdbOpResult {
  ok: boolean;
  message: string;           // 中文，含失败原因（stderr 摘要 / 未检测到设备等）
}
```

## 3. AdbService（`src/main/adb/adb-service.ts`，新建）

- 纯函数（可单测）：
  - `parseAdbDevices(stdout): AdbDevice[]` —— 跳过 `List of devices attached` 头，按 `serial\tstate` 逐行解析
  - `parseAdbReverseListHas(stdout, port): boolean` —— 任一行含 `tcp:<port>` 即为有
  - `parseAdbProxyValue(stdout): boolean` —— trim 后非空且非 `null`
- `AdbService` 类，构造注入 runner `(file, args, timeoutMs) => Promise<string>`（默认 `execFile` + 5s 超时 + 错误归一化：ENOENT → adb 不可用；超时 → 明确提示）：
  - `status(proxyPort)`：`adb version` → 可用性；`adb devices` → 设备；`adb reverse --list` → 隧道；`adb -s <serial> shell settings get global http_proxy` → 手机代理。任一步失败返回尽力而为的部分状态。
  - `setupTunnel(proxyPort, serial?)`：`adb [-s serial] reverse tcp:<port> tcp:<port>`
  - `setPhoneProxy(proxyPort, serial?)`：`adb [-s serial] shell settings put global http_proxy 127.0.0.1:<port>`
  - `clearPhoneProxy(serial?)`：`adb [-s serial] shell settings put global http_proxy :0`
- 设备选择：取 `devices` 中第一个 `state === 'device'` 的 serial；无可用设备 → `{ok:false, message:'未检测到已授权设备…'}`。
- 安全：全部 `execFile` 参数数组调用，无 shell 拼接；port 为整数（来自 settings 校验）。

## 4. IPC 与 preload

- `ipc.ts` 新增：`adb:status` / `adb:setup-tunnel` / `adb:set-phone-proxy` / `adb:clear-phone-proxy`，均返回 `AdbStatus` / `AdbOpResult`；proxyPort 取自 `ctx.settings.get().proxyPort`。
- `shared/api.ts` + `preload/index.ts` 各加四个方法的类型与实现。

## 5. UI（`DeviceGuide.tsx` 新区块）

在代理运行（`status.running && ip`）时，于「已知限制」之前渲染：

- **状态行**：adb 可用 ✓/✗ · 设备 N 台（serial） · 隧道 已建立/未建立 · 手机代理 已设置/未设置。挂载时检测一次，每次操作后自动重新检测；不做轮询。
- **按钮行**（flex-wrap + flex:0 0 auto，遵守密集打包纪律）：`检测` `建立隧道` `设置手机代理` `一键恢复手机网络`（最后一个用警示色，常驻）。操作按钮在 adb 不可用/无设备时禁用。
- **降级**：adb 不可用时展示两条手动命令 + 复制按钮（复用现有复制交互样式），并给安装指引。
- **坑与处理文案**（醒目，警示色）：① 用完或拔线前必须点「一键恢复手机网络」，否则手机全局代理指向死端口直接断网；② 拔线/重连后隧道失效，重新点「建立隧道」；③ 绕过系统代理的 app 与 QUIC（UDP 443）抓不到，属预期；④ iOS 无此方案。
- **HTTPS 提示**：手机需先按上方扫码流程安装 CA 证书，且目标域名在白名单/全量解密。

## 6. 错误处理

- adb 命令 5s 超时；ENOENT（未安装）→ `installHint`；`device unauthorized` → 文案提示在手机上授权；`more than one device` → 已用 `-s` 规避，取第一台可用设备。
- 操作结果统一 `AdbOpResult`，失败不抛未捕获异常，message 可直接展示。

## 7. 测试策略

| 层 | 覆盖 |
|---|---|
| 单测 | 三个纯解析函数（多设备/未授权/空输出、代理值 null/有值、reverse 列表含/不含端口）；AdbService 注入 fake runner：命令与参数正确、`-s` 选取、ENOENT/超时归一化、无可用设备拒绝操作 |
| E2E | 区块渲染幂等断言：无论 adb 是否安装，「Android USB 直连」标题与 `检测` 按钮可见（不依赖 adb 真实状态，不点会改手机状态的操作） |
| 手工 | 真机验证（用户执行 adb 命令属系统级操作） |

## 8. 坑与处理

| 坑 | 处理 |
|---|---|
| 忘记清手机代理 → 拔线后断网 | 「一键恢复手机网络」常驻 + 醒目文案；状态行显示手机代理已设置，可见即提醒 |
| 拔线/重连后 reverse 失效 | `adb reverse --list` 检测 + 「建立隧道」一键重跑 |
| 多设备时报 `more than one device` | 固定 `-s <第一台可用设备>`；状态行显示所选 serial |
| adb 不在 PATH | installHint + 手动命令复制降级 |
| 绕过系统代理的 app / QUIC 抓不到 | 局限文案标注，属预期不解决 |
| iOS 无方案 | 文案明示仅 Android |

## 9. 实施约束

- git worktree 内实现；8888/8899 空闲跑 E2E；完成后 dogfooding（真机部分由用户执行）。
