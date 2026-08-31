# Mocker — Charles 式抓包 Mock 工具设计文档

日期：2026-09-01
状态：已确认，待实现

## 1. 目标与定位

面向开发者的本地调试工具，功能对标 Charles / Proxyman：

- 抓取 Android 设备、iOS 设备、浏览器、本机系统代理的 HTTP/HTTPS 流量
- 按规则对请求进行 Mock（返回自定义响应），支持动态脚本、延迟、故障注入
- 提供请求录制回放、JSON Schema 随机数据生成、场景切换、规则导入导出与版本快照

非目标：团队共享的 Mock 服务、root/越狱级 SSL Pinning 绕过、付费授权体系。

## 2. 技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| 应用形态 | Electron 桌面应用 | 原生窗口体验，对标 Proxyman |
| 运行时 | Node.js (TypeScript) | 生态成熟，用户具备环境 |
| 代理内核 | `mockttp` | 成熟的 MITM 代理库，内置证书、WebSocket、HTTP/2 |
| 证书 | `node-forge` | 纯 JS 生成根 CA 与按域名签发叶子证书 |
| 渲染层 | React + TypeScript | 面板类组件生态最成熟 |
| 存储 | 文件（JSON + JSONL） | 简单可控，便于导出 |
| 构建 | electron-vite + Vite | Electron + React 主流方案 |
| 测试 | vitest + Playwright | 单测/集成 + E2E |

## 3. 总体架构

```
Electron 主进程
├── proxy        mockttp 代理服务器（默认 :8888，端口可配）
├── cert         根 CA 生成/续签 + 按域名动态签发叶子证书（LRU）
├── rules        规则引擎（匹配条件 → 动作）
├── scenarios    场景 = 规则开关状态快照，一键切换
├── storage      文件存储：规则/场景/设置/历史/快照
├── replay       抓包请求重放（原样/改写/重复 N 次）
├── schema       JSON Schema → 随机数据（json-schema-faker）
├── system-proxy macOS networksetup / Windows 注册表 开关
└── bridge       WebSocket → 渲染进程实时流量事件
        ↕
渲染进程（React + TS）
├── 流量面板      虚拟化表格、过滤/搜索、录制暂停、mock 命中高亮
├── 详情查看器    请求/响应头与体、JSON 格式化、耗时瀑布
├── 规则编辑器    条件表单 + Monaco 脚本编辑 + JSON 响应编辑
├── 场景管理      场景列表、切换、另存
├── 重放面板      选择历史请求 → 编辑 → 重发
├── 设备接入向导  二维码、证书下载页指引、平台说明
└── 设置页        端口、HTTPS 模式、主题等
```

### 数据流

```
设备/浏览器 → :8888 代理 → mockttp → 规则引擎匹配
   ├─ 命中 → 执行动作（静态响应 / 脚本 / 延迟 / 故障 / 改写透传）
   └─ 未命中 → 透传上游
两条路径均记录事件 → WebSocket 推送 → UI 实时展示（mock 命中高亮）
```

## 4. 规则引擎

### 4.1 匹配条件（可组合，AND 语义）

- URL：精确 / 通配符 / 正则
- Method：GET/POST/PUT/DELETE/PATCH/任意
- Query 参数：键存在 / 键值匹配
- Header：键值匹配
- Body：子串 / JSON 路径匹配（JSONPath）

### 4.2 动作

- **静态响应**：状态码、Headers、Body（JSON 编辑器，支持从 Schema 生成填充）
- **JS 脚本**：`vm` 模块执行，5 秒超时；脚本接收 `{ request }`，返回 `{ status, headers, body }`。定位为开发者本地可信代码，不做强隔离
- **延迟**：固定或区间随机毫秒
- **故障注入**：直接返回指定状态码 / 断开连接
- **改写透传**：修改头/体后转发真实上游

### 4.3 规则管理

- 规则按优先级顺序匹配，命中即止；支持启用/停用、分组（文件夹）
- 规则存储为 `rules.json`；每次变更自动写入有界快照历史（上限 50 份）
- 导入/导出：单个规则、整组规则、场景打包为 JSON 文件

## 5. 场景（Scenarios）

- 场景 = 一组规则的启用状态 + 可选的参数覆盖
- 一键切换场景（如「正常流程 / 空数据 / 服务端错误」）
- 同一时刻只有一个激活场景，切换即时生效

## 6. HTTPS / 证书

- 首次启动生成根 CA（node-forge 自签名，10 年有效期），私钥与证书存 `userData/certs/`；到期前一年自动续签
- 叶子证书按目标域名动态签发（SAN 包含域名），LRU 缓存 100 张
- **HTTPS 模式**：
  - 白名单（默认）：仅名单内域名的 CONNECT 连接被 MITM，其余走盲隧道透传
  - 全量解密：所有 CONNECT 均 MITM（可在设置中切换）

### 设备接入流程

1. 手机与电脑同网段，设置系统代理为 `电脑IP:8888`（UI 显示本机 IP，一键复制）
2. 手机浏览器访问 `http://电脑IP:8888` → 内置接入引导页（二维码 + 证书下载）
3. iOS：下载描述文件 → 安装 → 「证书信任设置」开启信任
4. Android：安装用户证书；UI 内说明 Android 7+ 限制（仅 `debuggable` 或配置了信任用户 CA 的 `networkSecurityConfig` 的应用生效；证书固定的应用无法抓包，如实提示，不做 root 级绕过）
5. macOS 本机：一键将 CA 加入系统钥匙串并信任（`security` 命令）

## 7. 存储布局（`userData` 目录）

```
userData/
├── rules.json          规则定义
├── scenarios.json      场景定义与当前激活场景
├── settings.json       端口、HTTPS 模式、主题等
├── snapshots/          规则快照（有界，上限 50）
├── certs/              根 CA 私钥与证书
└── history/            按会话的抓包记录，滚动 JSONL
```

## 8. 系统代理开关

- macOS：`networksetup` 对当前活跃网络服务设置/清除 webproxy 与 securewebproxy
- Windows：写注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`
- 应用退出时若系统代理由本工具设置，自动恢复原状态

## 9. 重放与 Schema 生成

- 重放：从历史记录选请求 → 可编辑方法/头/体 → 发送（经代理或不经过），支持重复 N 次、间隔
- Schema 生成：录入 JSON Schema → json-schema-faker 生成随机数据，可作为静态响应的数据源（每次请求重新生成）

## 10. 错误处理

| 场景 | 行为 |
|---|---|
| 代理端口占用 | 提示并自动切换下一可用端口 |
| JS 脚本报错/超时 | 该请求返回 502 + 错误详情；UI 红色标记 |
| 上游透传失败 | 记录为失败请求并显示原因 |
| TLS 握手失败 | 连接级错误记录；UI 提示「可能未安装/信任证书」 |
| 存储文件损坏 | 备份原文件后重置为默认，提示用户 |
| WebSocket 断线 | 渲染进程自动重连并拉取最近快照 |

## 11. 测试策略

- **单元测试**（vitest）：规则匹配引擎（各匹配器 + 优先级）、存储读写与快照、证书生成与缓存
- **集成测试**：ephemeral 端口起真实代理，node 客户端走代理发请求，验证：
  - mock 命中与响应内容
  - 未命中透传
  - 白名单行为（名单外不解密）
  - 延迟与故障注入
- **E2E**：Playwright 驱动 Electron 冒烟（建规则 → 发请求 → 流量列表可见 → 命中高亮）
- **手工验收**：真机 Android / iOS + 浏览器完整流程

## 12. 实施分期

| 阶段 | 内容 |
|---|---|
| Phase 1（MVP） | 代理启动/停止、实时抓包列表与详情、基础静态响应规则、证书生成与设备接入引导、系统代理开关 |
| Phase 2 | JS 脚本动作、延迟/故障注入、场景管理、重放 |
| Phase 3 | Schema 随机数据、导入导出、规则快照版本、E2E 完善 |

## 13. 已知限制（明确告知用户）

- Android 7+ 应用默认不信任用户证书，需应用本身支持；证书固定（SSL Pinning）应用无法抓包
- iOS 15+ 私有中继（iCloud Private Relay）开启时需关闭才能走代理
- HTTP/3 (QUIC) 流量不经过 HTTP 代理，不在抓取范围
