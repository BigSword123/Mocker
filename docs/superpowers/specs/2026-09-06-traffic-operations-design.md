# Mocker 流量操作设计文档（功能路线图第一期）

日期：2026-09-06
状态：已确认，待实现
路线图：2026-09-06 定三期——流量操作（本期）→ 规则引擎扩展（Map Local/Remote、场景、序列响应）→ 代理干预（断点、限速）。

## 1. 目标与范围

围绕流量列表/详情补齐四个日常操作，不动代理架构：

| 功能 | 决议 |
|---|---|
| 分面过滤与全文搜索 | 方法下拉 + 状态码下拉 + host 输入 + 全文输入，AND 组合；不做结构化查询语法、不做过滤器预设 |
| 请求重放 + Compose | 原样重放 + 可编辑后重发；不做并发重放 |
| Copy as cURL | bash / cmd / PowerShell 三方言，默认跟随运行平台，可手动切换 |
| HAR 导入/导出 | 导出当前过滤结果为 HAR 1.2；导入外部 HAR 替换当前列表查看；不做历史 JSONL 会话恢复（另行一期） |

非目标：并发重放、WebSocket、二进制 body 保真、断点/限速（第三期）。

## 2. 数据结构变更（src/shared/types.ts）

```ts
export interface TrafficEvent {
  // …现有字段不变…
  origin?: 'capture' | 'replay' | 'imported'; // 缺省视为 capture，兼容存量数据
  replayedFromId?: string;
}

export interface ReplayRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface TrafficFilter {
  text: string;   // 全文：url + 请求/响应头 + 请求/响应体
  method: string; // '' = 全部；否则精确匹配 method
  status: string; // '' | '2' | '3' | '4' | '5' | 'error'
  host: string;   // e.host 子串
}
```

状态桶规则：`'2'`~`'5'` 按状态码首位匹配；`'error'` 匹配 `error` 字段非空（覆盖连接级异常与 client-error）。所有匹配大小写不敏感。

## 3. 分面过滤（TrafficPanel + traffic store）

- store 的 `filter: string` 升级为 `TrafficFilter`；过滤纯在 renderer 内存中做（上限 2000 条，`useMemo` 足够）
- 过滤栏一行：方法下拉、状态下拉、host 输入、全文输入（200ms debounce）、「清除」按钮
- 「N 条」计数逻辑沿用，改为过滤后数量
- 全文搜索字段：`url`、`requestHeaders`、`requestBody`、`responseHeaders`、`responseBody`，统一 `toLowerCase()` 后 `includes`

## 4. 重放 + Compose

### 4.1 重放模块（src/main/replay/replay.ts）

方案：main 进程独立重放（不回环走代理端口，不改写真实请求）。

输入 `ReplayRequest`，流程：

1. `findMatchingRule(rules, description)` —— 命中则执行与代理完全一致的动作：概率网络异常 → 固定延迟 → 模板渲染（`renderTemplate` + fakerLocale）
   - 为保证两处语义一致，从 `proxy-server.ts` 的 `handleMatched` 抽出纯计算函数（输入规则 + 请求描述 + abort signal，输出 `{ status, headers, body, warnings, networkError }`，不改事件），代理与重放各自消费结果。proxy-server 行为不得改变（有单测回归）。
2. 未命中：`http/https` 按 URL scheme 直连上游
   - 不跟随重定向（3xx 原样记录，与抓包视角一致）
   - 发送前删除 `content-length`、`connection`，`host` 以 URL 为准
   - 超时常量 30s；响应体按现有系统惯例取文本
3. 产出 `TrafficEvent`：新 id、`origin: 'replay'`、`replayedFromId`、`mocked`/`matchedRuleId`/`errorTriggered`/`renderWarnings` 正常回填，经 `onEvent` → WS → UI；网络失败记入 `error` 字段（UI 红色行，与 client-error 一致）

HTTPS 用 Node 原生 TLS（系统信任链），不走 MITM。代理停止/未启动时重放照常可用。

IPC：`replay:send`（invoke），返回新事件 id 供 UI 自动选中。

### 4.2 Compose 编辑器（renderer，新组件 ComposeModal）

- 入口：详情区按钮「重放」（原样直发）与「编辑后重发…」（打开 modal）
- Modal 布局仿 RuleEditorModal：方法 + URL 输入、请求头 EditableTable、body tabs（none / raw / form-data / x-www-form-urlencoded）；raw 模式内容可解析为 JSON 时复用 JsonBodyEditor，否则退化为纯 textarea
- 发送时 form/urlencoded 拼接为 body 并自动补 `content-type`；none = 无 body
- 发送成功后关闭 modal、自动选中新条目；重放条目可再次编辑重发（链式）

## 5. Copy as cURL（renderer，lib/curl.ts）

- 纯函数 `buildCurl(event, dialect)`，dialect ∈ `bash | cmd | powershell`
- 形态：`curl -X <method> <url> -H '<k>: <v>'… --data-binary <body>`
- 方言差异：

| | 引号（内含 `'` 时转义） | 多行续行 | 二进制 body 注释 |
|---|---|---|---|
| bash/zsh | `'…'`，内部 `'\''` | `\` | `# …` |
| cmd | `"…"`，内部 `\"` | `^` | `REM …` |
| PowerShell | `"…"`，内部 `` `" `` | `` ` `` | `# …` |

- 省略 `host`、`content-length`、`connection`、`accept-encoding`
- body 含不可打印字符时以方言注释行提示「body 含二进制，请自行处理」
- UI：详情区「Copy as cURL」按钮 + 方言小下拉，默认值取运行平台（macOS → bash，Windows → cmd；复用 `CertInstallCommands` 的平台探测）

## 6. HAR 导入/导出（src/shared/har.ts 纯映射 + main 文件 IO）

### 导出

- 过滤栏旁「导出 HAR」：renderer 把**当前过滤结果**经 IPC `har:export` 交给 main，`dialog.showSaveDialog`（默认名 `mocker-<时间戳>.har`）后写 HAR 1.2
- 映射：`log.creator = { name: 'Mocker' }`；entry 含 startedDateTime（ISO）、time、request（method/url/headers/queryString/postData）、response（status/headers/content{text,mimeType}）
- 自定义字段：`_mocked`、`_matchedRuleId`、`_origin`
- 仅导出 `completedAt` 存在的条目；全部未完成时按钮禁用

### 导入

- 工具栏「导入 HAR」（与导出按钮同在 TrafficPanel 过滤栏一行的右侧）：main `dialog.showOpenDialog`（filter `*.har`）→ 解析 → `fromHar` 映射为 TrafficEvent（id 重生成、`origin: 'imported'`、mocked 取 `_mocked`）→ 返回 renderer
- **替换**当前列表，替换前确认弹窗（「导入 N 条将替换当前流量列表」）；此后实时流量照常叠加
- 超过 MAX_EVENTS=2000 时按现有惯例保留最新 2000 条
- 容错：entries 非数组/文件非 JSON → toast 报错不替换；缺失字段给默认值（无 postData → body `''`）

## 7. 平台兼容性（macOS / Windows）

- 重放、过滤、HAR 读写均走 Node/Electron 跨平台 API，无平台分支
- 唯一平台相关点是 cURL 方言（见第 5 节），三方言均为纯字符串函数，单测覆盖

## 8. 回归面

- 重放/导入条目是普通 TrafficEvent，「转为规则」自动可用
- 现有暂停/清空/WS 重连逻辑不变；重放条目同样受暂停队列约束（恢复后补显）
- proxy-server 仅做 `handleMatched` 抽函数重构，行为不变，靠现有单测兜底

## 9. 测试

- 单测：`buildCurl` 三方言转义与头过滤；`toHar`/`fromHar` 往返映射与容错；TrafficFilter 各桶匹配；重放命中（mock 模板/异常）/未命中（上游发送）/超时错误分支
- E2E：过滤栏组合过滤、重放按钮产生新条目并自动选中、导出产生 .har 文件、导入替换列表
