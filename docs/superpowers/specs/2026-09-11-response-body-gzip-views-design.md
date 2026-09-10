# Mocker 流量详情响应体视图设计文档（复制 / gzip 解压 / gzip 压缩）

日期：2026-09-11
状态：已确认，待实现

## 1. 目标与范围

在流量 tab 的详情区，为**响应体**补齐三个查看能力：

| 功能 | 决议 |
|---|---|
| 一键复制 | 每个视图各自一个复制按钮；压缩视图额外提供「复制 base64」 |
| gzip 解压查看 | 纯视图层嗅探当前响应体字符串，命中才启用该 tab |
| gzip 压缩查看 | 对当前响应体做 gzip，以 hex dump + 压缩率展示 |

核心约束：**全程不改变响应体原本的结果**。三个视图都是派生展示，不写回 traffic store、不改 `TrafficEvent`、不影响 HAR 导出与「转为规则」等下游能力。

非目标：

- 不改造捕获链路保留原始字节（`body.buffer`），即不引入 `responseBodyRaw` 之类字段
- 不做 brotli / deflate 等其他内容编码
- 不做压缩级别、压缩策略调节
- 不改请求体区域（本期仅响应体）

## 2. 背景约束

现有链路决定了本设计的形态，记录在此避免后续误判：

- `TrafficEvent.responseBody` 类型是 `string`（`src/shared/types.ts:57`）
- 抓包侧用 mockttp 的 `body.getText()` 取响应体（`src/main/proxy/proxy-server.ts:485` 的 `extractText`）。mockttp 的 `getText()` 会按 `content-encoding` **自动解码**，因此实时抓到的响应体基本已是解压后的明文
- 代码库中没有任何位置保留过 gzip 原始字节；`replay.ts` 与 `redirect.ts` 里的 `accept-encoding` 仅出现在跳过发送的头集合中

推论：解压 tab 对实时抓包流量多数时候不命中。真正可靠的输入是 **base64 形式的 gzip 文本**（例如规则里手工存放的 mock body、导入的 HAR 条目）。

## 3. 模块边界

| 单元 | 职责 | 依赖 |
|---|---|---|
| `src/renderer/src/lib/body-codec.ts`（新增） | 全部字节逻辑：gzip 嗅探、压缩/解压、hex dump、base64 编解码、压缩率计算 | 仅使用全局 `CompressionStream` / `DecompressionStream` / `TextEncoder` / `atob` / `btoa`；不依赖 React、IPC、store、DOM |
| `src/renderer/src/lib/body-format.ts`（新增） | 承接从 `TrafficDetail.tsx` 移出的 `pretty()`：JSON 美化 + 500_000 字符显示截断 | 无 |
| `src/renderer/src/components/ResponseBodyViews.tsx`（新增） | 响应体视图状态机：tab 切换、懒计算调度、就地错误展示、复制交互 | 调用 body-codec 与 body-format，自身不含任何字节运算 |
| `src/renderer/src/components/TrafficDetail.tsx`（修改） | 「响应体」小节改为渲染 `ResponseBodyViews`，不再自持响应体展示逻辑；请求体仍用 `pretty()` | — |
| `src/renderer/src/styles.css`（修改） | 复用现有 `.body-tabs` / `.tab` / `.tab.active` 视觉，新增一行 tab + 按钮的容器样式 | — |

划分理由：body-codec 不依赖 DOM 与 React，vitest 的 `environment: 'node'`（Node 24 已全局提供 `CompressionStream` / `DecompressionStream`，且 `@types/node` 26 以「DOM lib 存在时让位」的条件类型声明了同名全局）可直接完整覆盖；`pretty()` 独立成 lib 是因为原始视图与解压视图都要用它做显示美化，留在 `TrafficDetail` 内会造成重复；响应体视图有独立的状态机（3 个视图 × 各自的异步计算状态），抽成组件后 `TrafficDetail` 维持在原有体量。

## 4. body-codec 接口与规则

### 4.1 导出接口

```ts
export type GzipVia = 'raw-bytes' | 'base64';

export interface GzipSniffResult {
  detected: boolean;
  via?: GzipVia;
}

export interface CompressResult {
  rawBytes: number;      // 原文 UTF-8 字节数
  gzippedBytes: number;  // gzip 后字节数
  ratio: number;         // gzippedBytes / rawBytes，rawBytes 为 0 时取 0
  hex: string;           // 完整 hex dump（不截断）
  base64: string;        // 完整 base64（不折行）
}

export function sniffGzip(body: string): GzipSniffResult;
export function gzipDecodeBytes(body: string, via: GzipVia): Uint8Array;
export async function gunzipText(bytes: Uint8Array): Promise<string>;
export async function gzipCompress(text: string): Promise<CompressResult>;
export function toHexDump(bytes: Uint8Array, maxBytes?: number): string;
export function toBase64(bytes: Uint8Array): string;
```

### 4.2 嗅探规则

`sniffGzip(body)` 按顺序判定，命中即返回：

1. `body` 为空串 → `{ detected: false }`
2. `body.charCodeAt(0) === 0x1f && body.charCodeAt(1) === 0x8b` → `{ detected: true, via: 'raw-bytes' }`
   - 直接读 char code，O(1)，不对大字符串做整体 UTF-8 编码
   - 依据：gzip 魔数字节 `0x1f` `0x8b` 中 `0x1f` 属 ASCII，UTF-8 解码后仍为 U+001F
3. 取 `body.trim()` 的**前 16 个字符**（不足 16 个则取全部）；若全部落在 base64 字符集 `[A-Za-z0-9+/=]` 且长度 ≥ 4，解码后前 2 字节为 `0x1f` `0x8b` → `{ detected: true, via: 'base64' }`
   - 只看前缀，因此 5 MB 响应体的嗅探开销与 1 KB 相同
   - 解码前 16 字符即可得到 ≥ 12 字节，足够判定魔数
4. 以上均不满足 → `{ detected: false }`

### 4.3 解压输入还原

`gzipDecodeBytes(body, via)`：

- `via === 'base64'`：`atob(body.trim())` 全量解码，逐字符取 `charCodeAt` 组装 `Uint8Array`。**字节无损**
- `via === 'raw-bytes'`：`TextEncoder().encode(body)`。**有损**：原始 gzip 字节经 mockttp 的 UTF-8 解码后，非法字节序列已被替换为 U+FFFD，无法还原

决议：**保留 raw-bytes 路径**。因此遇到真实 gzip 流量时，解压 tab 会启用并显示「gzip 解压失败：…」错误行，而非直接置灰。取舍理由是失败信息本身能解释链路已自动解压这一事实，比静默置灰更可诊断。

### 4.4 hex dump 格式

`toHexDump(bytes, maxBytes?)`：

- 每行 16 字节，格式 `OOOOOOOO  HH HH HH HH HH HH HH HH  HH HH HH HH HH HH HH  |AAAAAAAAAAAAAAAA|`
  - `OOOOOOOO`：8 位小写十六进制偏移
  - 前 8 字节与后 8 字节之间两个空格分隔
  - 末行不足 16 字节时，hex 区按原位数留空对齐（缺失位置补两个空格）
  - ASCII 侧栏：`0x20`–`0x7e` 原样输出，其余输出 `.`
- `maxBytes` 给定时只渲染前 `maxBytes` 字节，并在末尾追加一行 `…（已截断，仅显示前 N 字节）`；不给定则输出完整内容
- 空字节数组 → 返回空串

### 4.5 base64 与压缩

- `toBase64(bytes)`：分块（每块 ≤ 8192 字节）调用 `String.fromCharCode` 后 `btoa`，避免大输入触发实参数量上限爆栈
- `gzipCompress(text)`：`TextEncoder().encode(text)` → `CompressionStream('gzip')` → 收集字节 → 计算 `rawBytes` / `gzippedBytes` / `ratio` 并生成完整 `hex` 与 `base64`
- `gunzipText(bytes)`：`DecompressionStream('gzip')` → 收集字节 → `TextDecoder('utf-8', { fatal: true })` 转文本。`fatal: true` 保证非法 UTF-8 抛错而非静默产生替换字符

## 5. UI 结构

「响应体」标题下方一行容器，左侧 tab 组、右侧复制按钮组（沿用 `.json-editor-bar` 的 flex 布局思路，tab 视觉复用 `.body-tabs .tab`）：

```
响应体
[原始] [gzip 解压] [gzip 压缩]          [复制] [复制 hex] [复制 base64]
<当前视图内容>
```

复制按钮组随当前 tab 变化，只渲染该 tab 适用的按钮。

总原则：**内容区做美化与截断，复制给原始完整数据**。即显示层可以走 `pretty()` 的 JSON 美化与长度截断，但任何复制按钮输出的都是未经美化、未经截断的完整内容。

| tab | 按钮 | 复制内容 |
|---|---|---|
| 原始 | 复制 | **完整未截断**的 `event.responseBody`。注意现有 `pretty()` 在 500_000 字符处截断，复制不继承该截断 |
| gzip 解压 | 复制 | 解压后的完整文本（未经 `pretty()` 美化、未截断） |
| gzip 压缩 | 复制 hex / 复制 base64 | 完整 hex dump / 完整 base64，均不受渲染截断影响 |

解压 tab 计算失败（错误行可见）时没有可复制内容，该 tab 的复制按钮不渲染。

各 tab 内容区：

- **原始**：沿用现有 `pretty(event.responseBody)`，空则显示「（无）」
- **gzip 解压**：未命中嗅探时 tab 置灰（`disabled`），内容区显示「未检测到 gzip 内容」；命中时显示 `pretty(解压结果)`
- **gzip 压缩**：顶部统计行 `原始 12,345 B → gzip 2,310 B（18.7%）`，下方 `<pre>` 渲染截断后的 hex dump；响应体为空时 tab 置灰

交互约定沿用现有实现（`TrafficDetail.tsx:58-65`）：复制成功后对应按钮文案短暂变为「已复制」；`event.id` 变化时重置全部复制态与当前 tab（回到「原始」）。

`data-testid`：`body-view-raw` / `body-view-gunzip` / `body-view-gzip`、`copy-body-raw` / `copy-body-gunzip` / `copy-body-hex` / `copy-body-base64`、`body-gzip-stats`、`body-view-content`、`body-view-error`。

## 6. 性能与截断

- **懒计算**：仅在首次切到某 tab 时计算，结果按 `event.id` + tab 缓存于组件 state；`event.id` 变化即丢弃
- **压缩输入上限 5 MiB**（按 `TextEncoder` 编码后的字节数判定）。该判定属懒计算的一部分，只能在首次激活压缩 tab 时得出，因此超限不表现为 tab 置灰，而是内容区显示「响应体过大（X.X MB），不支持压缩查看」；压缩 tab 仅在响应体为空时置灰
- **hex dump 渲染上限 4 KiB**（256 行）。`toHexDump(bytes, 4096)` 用于渲染；复制走无 `maxBytes` 的完整输出
- 原始/解压文本渲染继续沿用 `pretty()` 的 500_000 字符截断，复制不截断

## 7. 错误处理

| 场景 | 处理 |
|---|---|
| `gunzipText` 抛错（raw-bytes 有损、gzip 流不完整） | 解压 tab 内容区就地显示红色错误行「gzip 解压失败：{message}」，不冒泡、不影响其他 tab |
| `gzipCompress` 抛错 | 压缩 tab 内容区就地显示「gzip 压缩失败：{message}」 |
| 嗅探未命中 | 解压 tab `disabled`，内容区「未检测到 gzip 内容」 |
| 响应体超过 5 MiB | 压缩 tab 仍可点击，内容区显示「响应体过大（X.X MB），不支持压缩查看」，不执行压缩 |
| 响应体为空 | 解压与压缩 tab 均 `disabled`，原始 tab 显示「（无）」 |
| clipboard 写入被拒 | 沿用现有 try/catch，按钮不进入「已复制」态，无额外提示 |

计算过程中的异常一律捕获后落到对应 tab 的错误行，不允许抛到渲染流程导致详情区白屏。

## 8. 回归面

- 不改 `TrafficEvent` 结构与任何 main 进程代码，HAR 导入/导出、转为规则、转为 MapLocal、重放、Compose 全部不受影响
- `pretty()` 从 `TrafficDetail.tsx` 迁移到 `lib/body-format.ts`，签名与行为不变（纯位置迁移），请求体区域渲染结果等价
- 仅新增渲染派生视图，代理与规则引擎行为零变更

## 9. 测试

### 单测 `tests/body-codec.test.ts`（vitest / node）

- 嗅探：raw-bytes 魔数命中、base64 命中、明文 JSON 不命中、空串不命中、含前导空白的 base64 命中、长 base64 串只读前缀即判定
- 往返：`gzipCompress` 后取字节 `gunzipText` 得到原文；含中文的多字节文本往返一致
- 失败分支：对非 gzip 字节调用 `gunzipText` 抛错；对含 U+FFFD 的有损字节调用 `gunzipText` 抛错
- hex dump：首行偏移与分组格式、末行不足 16 字节的对齐、不可打印字符在 ASCII 侧栏为 `.`、`maxBytes` 截断标记、空输入返回空串
- base64：> 64 KiB 输入不抛错且结果可解码回原字节
- 压缩率：`ratio` 计算、`rawBytes` 为 0 时取 0

### 单测 `tests/body-format.test.ts`（vitest / node）

- `pretty()`：合法 JSON 两空格缩进美化、非法 JSON 原样返回、超过 500_000 字符截断并追加提示行、`undefined` 与空串返回空串

### E2E `e2e/traffic-body-views.spec.ts`（playwright + 真 Electron）

- 建一条 mock 规则，body 为 `base64(gzip(已知明文))` → 经代理发起请求 → 在流量列表选中该条
  - 断言解压 tab 可点击，内容区显示已知明文
  - 断言压缩 tab 显示统计行与非空 hex dump
  - 断言原始 tab 仍显示 base64 串本身（证明未改写响应体）
- 建一条 body 为普通明文的规则 → 请求 → 选中
  - 断言解压 tab 处于 `disabled`
  - 断言原始 tab 的复制按钮存在且可点击
