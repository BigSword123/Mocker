# 上游代理与互斥监控模式 设计

日期：2026-09-08
状态：已与用户对齐（决策点见文末）

## 背景

- mocker 常用链路：手机 → adb reverse → mocker(8888) → 直连外网。用户电脑上还有一层代理（如 Clash，`socks5://127.0.0.1:7892`），未命中 mock 的流量需要能经它出网；部分主机需要绕过它直连。
- 现状手机（adb）与电脑（系统代理）两套开关彼此独立。用户希望一次只监控一边，切换时自动清理另一边。

## 目标

1. **上游代理可配置**：所有 pass-through 转发经上游代理；noProxy 名单内直连。体验类似 VS Code 的 `http.proxy` / `http.noProxy`。
2. **互斥监控模式**：关 / 手机 / 电脑 三态，主进程原子切换，切换时自动清理另一侧。

## 非目标（YAGNI）

- 不做双端口、不做流量来源标记/过滤。
- 不做按规则的分流（只有全局上游 + noProxy 名单）。
- 不做崩溃恢复快照（8d73d04 已回滚，现有退出清理逻辑保持原样）。

## 数据模型（src/shared/types.ts:86 `Settings` 新增字段）

| 字段 | 默认 | 说明 |
|---|---|---|
| `upstreamProxyUrl` | `''` | 空 = 不走上游；支持 `http://` `https://` `socks5://` `pac+http://`（mockttp `ProxySetting.proxyUrl`，底层 proxy-agent）；可含 `user:pass@` |
| `upstreamNoProxy` | `''` | 逗号/分号/换行分隔；条目语义 = mockttp 内置 `matchesNoProxy`（curl 风格：`example.com`、`example.com:443`、`10.0.0.1`；不支持 CIDR） |
| `monitorMode` | `'off'` | `'off' \| 'phone' \| 'computer'` |

**持久化**：三个字段全部走现有 `SettingsStore`（settings.json，JsonStore 落盘），重启不丢。含凭据的 URL 明文存本地（单机工具可接受）。

## 上游代理生效（src/main/proxy/proxy-server.ts）

- `start()` 里现有 `thenPassThrough({ beforeRequest, beforeResponse })` 增加 `proxyConfig`：
  - `upstreamProxyUrl` 非空 → `{ proxyUrl, noProxy: parseNoProxy(upstreamNoProxy) }`；
  - 空 → 不传（现有行为不变）。
- `parseNoProxy`：纯函数，按逗号/分号/换行切分、trim、去空。匹配语义直接用 mockttp 内置实现，不自研。
- 命中 mock 规则的请求不出网，与上游无关。

### 坑与处理

| 坑 | 处理 |
|---|---|
| `proxyConfig` 在建规则时读取，运行中改设置不生效 | settings:set 且 upstream 字段变化且代理在跑 → 自动重启代理（stop+start，秒级） |
| 上游代理不可达 | 转发报错走现有 `client-error` 事件，流量列表显示 error，不崩溃 |
| noProxy 不支持 CIDR 等格式 | UI 说明文案标注支持的格式；无法识别的格式 mockttp 会忽略 |

## 模式编排（ipc.ts 新增 `monitor:set-mode`，主进程单入口）

| 目标模式 | 动作 |
|---|---|
| `phone` | 若系统代理是我们设的 → 先恢复电脑；设备在线则 `adb setupTunnel` + `setPhoneProxy`（复用现有 adb IPC 逻辑）；设备不在线仅提示，不阻塞 |
| `computer` | best-effort 清手机代理（设备在线才执行）→ `enableSystemProxy(proxyPort)` |
| `off` | best-effort 清手机代理 + 若系统代理是我们设的 → 恢复 |

- 编排放主进程单一 IPC，保证「清旧 + 设新」原子完成，不留中间态。
- 结果写入 `settings.monitorMode` 持久化。
- adb 不可用/设备不在线：切换不失败，返回状态文案（复用现有 adb 状态提示）。

## 启动行为（src/main/index.ts bootstrap）

- `autoStartProxy` → `proxy.start()`（不变）。
- `mode==='computer' && autoStartProxy` → 自动 `enableSystemProxy`。
- `mode==='phone' && autoStartProxy` → best-effort adb 重连（静默失败，没插线就跳过）。

## UI

- **StatusBar**：三态「监控：关 / 手机 / 电脑」选择器，全局可见。
- **SettingsPanel**：「上游代理」小节 = URL 输入框 + noProxy 文本框 + 一行说明（格式与生效方式）。
- **DeviceGuide**：现有手动按钮保留为高级手动操作，不删。

## 测试

- **单测**：`parseNoProxy`；`settings:set` 对 `upstreamProxyUrl` 的宽松校验（空，或可解析且协议白名单）；`monitor:set-mode` 三态编排（mock adb + system-proxy，验证互斥清理与不在线分支）。
- **集成**：本地假上游（http server 计数收到的代理请求），验证 noProxy 命中直连不经过上游、未命中走上游。
- **E2E**：模式切换冒烟（无真机：phone 分支验证提示态，computer/off 全流程 + UI 状态）。

## 决策点（已与用户确认）

1. DeviceGuide 手动按钮保留；
2. 上游设置保存即自动重启代理；
3. 模式切换放 StatusBar；
4. 手机模式设备不在线不算失败，只提示；
5. 代理信息（`upstreamProxyUrl` / `upstreamNoProxy` / `monitorMode`）持久化于 settings.json。
