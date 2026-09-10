# 实用工具面板 设计

日期：2026-09-11
状态：已与用户对齐（决策点见文末）

## 背景

- mocker 日常调试中反复要用到几类与抓包无关的小工具：时间戳换算、gzip 压缩/解压、图片转 WebP。目前都要切到外部网页或命令行，割裂工作流。
- 现有 tab 为 流量 / 规则 / 重定向 / 设备接入 / 设置。用户要求在「设备接入」左侧新增「实用工具」入口，收纳这三个工具。

## 目标

1. **时间戳互转**：秒 / 毫秒时间戳与「年月日时分秒毫秒」标准时间双向转换，可指定 IANA 时区。
2. **gzip 压缩/解压**：支持文件 ↔ 文件、文本 ↔ base64 两种形态。
3. **图片转 WebP**：png / jpg 转 webp，质量可调，支持整个文件夹批量转换并按原目录结构镜像输出。

## 非目标（YAGNI）

- 不做 base64 / URL / JSON 格式化等其它编解码工具（本次只要这三个）。
- 不做 zlib deflate / brotli，只做 gzip。
- 不做 webp → png/jpg 反向转换，不做 avif / tiff / gif。
- 不做图片缩放、裁剪、无损 webp、metadata 控制。
- 不与流量面板联动（例如「把这条响应体一键 gzip 解压」）——虽然契合 mocker 场景，但本次不做。
- 不引入任何新 npm 依赖。

## 关键技术决策

### WebP 编码引擎：Chromium 内置（零依赖）

用 Electron 自带 Chromium 的 WebP 编码器（内核即 Google libwebp），在渲染进程通过 `OffscreenCanvas.convertToBlob({ type: 'image/webp', quality })` 完成。

否决的备选：

| 备选 | 否决理由 |
|---|---|
| `sharp`（原生 libvips） | 会成为项目第一个原生依赖。README 已专门提醒 `npm install` 在国内的体积与网络痛点（Electron 二进制约 100MB），再加 15-30MB 原生包不划算；且一旦平台无预编译包会退化到源码编译 libvips。 |
| `@jsquash/webp`（WASM） | squoosh 项目已归档停止维护；WASM 资源在 rollup 打包的 Electron 主进程里加载较麻烦。复杂度最高、收益最小。 |

### 批量管道：主进程 dialog + 主进程读取

沿用项目现有 `showOpenDialog` 约定（与 `dialog:open-file` 一致）。主进程选目录、递归扫描、读取源图字节经 IPC 交给渲染进程；渲染进程编码后把 webp 字节回传，主进程按相对路径镜像写入输出目录。

IPC 开销实测评估：200 张 1MB 图片额外复制约 200MB，摊到全程约 0.1~0.2s；而 canvas 解码 + 编码每张需 200~500ms。**编码才是瓶颈，IPC 拷贝成本可忽略**，因此不采用渲染进程 `<input webkitdirectory>` 直读方案（那会引入第二种文件选择模式，且主进程失去源目录真实路径）。也不做分块批量 IPC（往返本就不是瓶颈，只会白增协议复杂度与内存峰值）。

### 二进制经 contextBridge 传递

已核实：Electron `contextBridge` 支持 `ArrayBuffer` / TypedArray / `Blob`，通过结构化克隆**复制**传递。主进程返回 `Buffer` 时在渲染进程侧表现为 `Uint8Array`，反向亦然。本项目此前无二进制 IPC，需在实现早期用 e2e 真实验证（见「测试」）。

## 1. Tab 接入（src/renderer/src/App.tsx）

- `Tab` 联合类型加 `'tools'`：`'traffic' | 'rules' | 'redirects' | 'tools' | 'device' | 'settings'`
- 按钮插在 `redirects-tab` 与 `device-tab` 之间，`data-testid="tools-tab"`，文案「实用工具」
- `{tab === 'tools' && <ToolsPanel />}`

最终顺序：流量 / 规则 / 重定向 / **实用工具** / 设备接入 / 设置。

## 2. 面板结构

新增 4 个组件，沿用 `components/` 扁平命名约定：

| 文件 | 职责 |
|---|---|
| `ToolsPanel.tsx` | `.panel` 容器 + 现有 `.tab-row` 样式做二级导航，本地 state 记住选中子工具 |
| `TimestampTool.tsx` | 时间戳互转 |
| `GzipTool.tsx` | gzip 压缩/解压 |
| `WebpTool.tsx` | 图片转 WebP |

不引入新 CSS 类，复用 `.form-grid`、`.toolbar`、`.tab-row`、`.preview`、`.muted`、`.text-ok/err/warn`。

## 3. 时间戳工具

**纯渲染进程，零 IPC** —— `Intl` 在 Chromium 里已足够，且 `Intl.supportedValuesOf('timeZone')`（Chromium 93+）可动态生成完整 IANA 时区列表，无需硬编码。

逻辑放 `src/renderer/src/lib/datetime.ts`（与 `json-format.ts`、`curl.ts` 同层，vitest Node 环境可测）：

| 函数 | 说明 |
|---|---|
| `detectTimestampUnit(n)` | `Math.abs(n) < 1e11` → `'s'`，否则 `'ms'`。当前秒级 ≈ 1.78e9、毫秒级 ≈ 1.78e12，阈值余量充足 |
| `formatTimestamp(ms, timeZone)` | → `{ standard, iso, offsetMinutes, parts }`；`standard` 形如 `2026-09-11 14:30:05.123`，`iso` 形如 `2026-09-11T14:30:05.123+08:00` |
| `parseZonedDateTime(text, timeZone)` | → ms。接受 `YYYY-MM-DD HH:mm:ss[.SSS]`、`YYYY/MM/DD ...`、ISO8601。用两遍 offset 收敛处理 DST 边界 |
| `listTimeZones()` | → `{ id, offsetLabel }[]`，附当前 UTC 偏移便于查找；置顶「本地时区」与 `UTC` |

**DST 两遍收敛**：先按输入字段当作 UTC 求一个猜测值，用 `Intl.DateTimeFormat` 在该时区 `formatToParts` 求出该时刻的偏移，得 `utc = guess - offset`；再用 `utc` 重算一次偏移并修正。覆盖绝大多数 DST 切换点。

**边界处理**：超出 `Date` 有效范围 ±8.64e15 ms、非法数字、无法解析的时间字符串 → 返回结构化错误，UI 行内提示，不抛异常。

**UI**：双向联动。时间戳输入 + 单位选择（自动/秒/毫秒）+ 时区选择（可搜索下拉）→ 标准时间、ISO8601、UTC 偏移、字段拆分；反向输入标准时间 + 时区 → 秒/毫秒时间戳。「现在」按钮一键填当前值，改一边自动更新另一边，结果均可复制（复用 `DeviceGuide.tsx` 里 `CmdRow` 已有的复制反馈写法）。

## 4. gzip 工具

逻辑放 `src/main/tools/gzip.ts`，纯 Buffer 进出，vitest 直接可测：

| 函数 | 说明 |
|---|---|
| `gzipCompress(buf, level = 9)` | Node `zlib.gzipSync` |
| `gzipDecompress(buf, maxOutputBytes = 256MB)` | 流式解压，超限中止并抛错 |

**解压侧的两道校验**（gzip 输入属外部数据，是真正的系统边界）：

1. 魔数校验：前两字节非 `1f 8b` → 明确中文文案「不是有效的 gzip 数据」
2. **解压炸弹防护**：输出超过 256MB 立即中止抛错。小 .gz 可展开到 GB 级，抓包场景下响应体可能来自不可信服务器。

非法 / 截断 gzip 数据 → 明确错误文案，不崩溃。

**IPC（2 个）**：

| channel | 入参 | 返回 |
|---|---|---|
| `tools:gzip-file` | `{ mode: 'compress' \| 'decompress', inputPath }` | `{ saved, filePath, inputBytes, outputBytes }` |
| `tools:gzip-text` | `{ mode, text?, base64? }` | `{ base64?, text?, binary: boolean }` |

- 文件模式：弹保存对话框，默认名压缩时加 `.gz`、解压时去掉 `.gz`
- 文本模式：二进制用 **base64** 表示（与 HAR 对二进制 body 的处理一致）
- 文本模式字段契约明确无歧义：`compress` 只读 `text`、只返回 `base64`；`decompress` 只读 `base64`、返回 `text`。解压结果不是合法 UTF-8 时 `text` 为 `undefined`、`binary: true`，并把原始字节的 base64 放在 `base64` 里回落展示。传入与 mode 不匹配的字段视为空输入报错，不做猜测性兜底。

**UI**：`.tab-row` 分「文件模式」「文本模式」。文件模式显示原体积 / 结果体积 / 压缩率；文本模式两侧 textarea 互转 + 复制按钮。

## 5. 图片转 WebP

### 主进程 `src/main/tools/image-scan.ts`

| 函数 | 说明 |
|---|---|
| `scanImages(dir, limit = 5000)` | 递归扫描，扩展名大小写不敏感匹配 `.png` / `.jpg` / `.jpeg`，返回 `{ relPath, ext, size, outName }[]`；`relPath` 为 POSIX 风格相对路径。**匹配数一旦超过 limit 立即停止遍历**并抛错 |
| `readImage(dir, relPath)` | → `Uint8Array` |
| `writeWebp(outDir, outName, bytes)` | `mkdir -p` 父目录后写 `outDir/outName`，返回写入路径 |

- **扫描 limit 5000**：防误选家目录把应用卡死的保险，不是性能优化。之所以「超限即停 + 抛错」而不是「截断 + 继续」，是为了避免静默漏转一部分文件；且提前停止遍历才能真正规避卡死风险。错误文案需可操作：「匹配图片超过 5000 张，请选择更小的子目录」。
- **输出命名与重名策略**：`outName` = `relPath` 把原扩展名替换为 `.webp`（`a/b.png` → `a/b.webp`）。同目录下 `b.png` 与 `b.jpg` 会撞名，扫描阶段即检测：撞名的一组全部改用保留原扩展名的形式（`b.png.webp`、`b.jpg.webp`），保证确定且不丢文件。`outName` 由主进程在扫描时算好并随清单返回，渲染进程不参与命名。
- **`readImage` 的路径收敛校验**：`dir` 与 `relPath` 都从渲染进程经 IPC 传入，主进程 `path.resolve` 后校验结果仍落在 `dir` 内再读。Electron 的威胁模型把 renderer→main 消息当不可信输入，这是正当边界检查，不是假想场景。

### 渲染进程 `src/renderer/src/lib/webp.ts`

`encodeWebp(bytes: Uint8Array, quality: number)` → `{ bytes, width, height }`

实现：`createImageBitmap(new Blob([bytes]))` → `new OffscreenCanvas(w, h)` → `ctx.drawImage` → `convertToBlob({ type: 'image/webp', quality })`。解码失败或尺寸超限 → 抛结构化错误，不静默。

### 批量流程（渲染进程驱动，并发 3）

1. 选源目录（`dialog:open-directory`）
2. `tools:scan-images` → 显示「扫描到 N 张」
3. 质量滑块 0-100，默认 **80**（传给 `encodeWebp` 前除以 100，canvas 的 `quality` 取值域是 0-1）
4. 选输出目录（`dialog:open-directory`）
5. 逐张：`tools:read-image(dir, relPath)` → `encodeWebp` → `tools:write-webp(outDir, outName, bytes)`
6. 进度条 + 逐条结果表（文件名、原体积 → 新体积、压缩率、状态/失败原因）
7. 结束汇总：成功 X / 失败 Y / 总体积变化

单张失败不中断整批，逐条归因。

重复运行同一批次会按 `outName` 覆盖输出目录里的既有 `.webp`——这是预期行为（便于换质量重跑对比体积）。源图永不被触碰，因此即使用户把输出目录选成源目录也只是多出一批 `.webp`，不会损坏原文件。

### UI 明写的已知限制

- 边长 > 16383px 时 Chromium 编码会失败（单条报错，不中断整批）
- ICC 色彩配置文件可能不被保留
- **CMYK 色彩空间的 JPEG**（部分 Photoshop 导出）可能被 Chromium 解码失败 → 单条报错跳过。这是零依赖 canvas 方案相对 `sharp` 的真实短板，如实标注而非静默失败
- PNG 透明通道会保留
- 仅 png / jpg，不处理 GIF、动画、webp 源文件

## 6. API 接线

`src/shared/types.ts` 新增工具相关类型（`GzipMode`、`GzipFileResult`、`GzipTextResult`、`ScannedImage`、`ImageScanResult`、`WebpWriteResult`）。

`src/shared/api.ts` + `src/preload/index.ts` + `src/main/ipc.ts` 各新增 6 项：

| channel / 方法 | 用途 |
|---|---|
| `dialog:open-directory` / `openDirectoryDialog()` | 返回目录路径或 null。与现有 `dialog:open-file` 对称命名，通用便于复用 |
| `tools:gzip-file` | 文件模式压缩/解压 |
| `tools:gzip-text` | 文本模式压缩/解压 |
| `tools:scan-images` | 递归扫描源目录 |
| `tools:read-image` | 读单张源图字节 |
| `tools:write-webp` | 按相对路径镜像写入 |

时间戳工具不占 IPC。

## 7. 测试

**vitest（Node 环境，测纯逻辑）**：

| 文件 | 覆盖 |
|---|---|
| `tests/datetime.test.ts` | s/ms 自动识别；UTC 与 Asia/Shanghai 格式化；America/New_York 春秋 DST 边界；双向往返一致；非法输入与超范围 |
| `tests/gzip.test.ts` | 往返一致；魔数校验；解压上限触发；空输入；非 gzip 输入报错文案；解压结果非 UTF-8 时 `binary: true` 回落；mode 与字段不匹配时报错 |
| `tests/image-scan.test.ts` | 递归；扩展名大小写；相对路径形态；空目录；limit 触发；`outName` 生成；同目录 `b.png` / `b.jpg` 撞名改名策略；`readImage` 路径收敛校验拒绝越界 `relPath`（tmpdir 造夹具） |

**e2e（`e2e/tools.spec.ts`，启动真实 Electron，与现有 e2e 一致不 mock api）**：

- `tools-tab` 存在且 DOM 顺序在 `device-tab` 之前
- 时间戳：输入固定 ms 值 + UTC → 断言标准时间文本；反向解析回到同一值
- gzip：文本模式往返一致
- webp：造一张小 png 到 tmp 目录 → 走完整批量流程 → 断言输出文件存在，且前 4 字节为 `RIFF`、第 8-12 字节为 `WEBP`

最后这条 e2e 同时是 **canvas 编码与二进制 IPC 的真实验证**，是零依赖方案的关键安全网。若二进制经 contextBridge 往返出现问题，需在实现早期即暴露，届时回退方案为 base64 字符串传输（+33% 体积，但确定可行）。

`npm run typecheck` 必须通过。

## 8. 文档

README 新增「实用工具」小节：三个工具的用途、webp 的已知限制、gzip 解压上限 256MB。

## 决策点（已与用户确认）

1. WebP 引擎用 Chromium 内置编码，**零新增依赖**（否决 sharp 与 WASM）；
2. 批量输出到**用户选定目录并镜像源目录结构**，原图完全不动；
3. gzip **同时支持文件模式与文本模式**；
4. 批量管道走**主进程 dialog + 主进程读取**（方案 A）；
5. gzip 解压上限 256MB、图片扫描上限 5000 张、webp 质量默认 80。
