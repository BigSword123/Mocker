# 抓包转规则（Capture → Rule）设计

## 1. 目标

在流量面板选中一条已录制的请求后，一键生成预填好的 Mock 规则草稿，进入现有规则编辑弹窗修改并保存。把「录到一条真实请求」到「把它 mock 住」的路径从手抄 URL/响应缩短为一次点击。

非目标：请求重放（replay 模块）、录制开关/落盘控制、匹配字段勾选向导——均不在本设计范围。

## 2. 现状与约束

- `TrafficEvent`（src/shared/types.ts:25-43）已含转换所需全部字段：`method`、`url`、`path`、`requestHeaders`、`requestBody`、`status?`、`responseHeaders?`、`responseBody?`、`mocked`、`error?`。
- `matchRule`（src/main/rules/matcher.ts:34-47）对 `exact` 是**全 URL（含 query）**字符串比较；`match.query` 是额外约束。因此「匹配这条路径、忽略 query」无法用 exact 表达，默认策略见 §4。
- `RuleEditorModal` 现签名 `{ initial: MockRule | null, onClose, onSaved }`，保存走 `api.rulesAdd`/`rulesUpdate` 并自带全部校验、预览与模板补全。
- 流量事件只存在于渲染层内存（WebSocket 推送，上限 2000 条）与主进程会话 JSONL；本功能只用前者。

## 3. 架构与数据流

方案：纯渲染层转换，零 IPC、零主进程改动。

- 新文件 `src/renderer/src/lib/capture-to-rule.ts`：导出纯函数 `captureToRuleInput(event: TrafficEvent): RuleInput`。无副作用，vitest 可直接单测。
- `TrafficDetail` 增加可选回调 prop（如 `onCaptureToRule?: (event: TrafficEvent) => void`）；标题行（`{method} {url}` 旁）在事件存在且回调提供时渲染「转为规则」按钮。
- `TrafficPanel` 持有 `draft: RuleInput | null`：按钮回调中 `setDraft(captureToRuleInput(event))`；`draft` 非空时在流量页直接渲染 `<RuleEditorModal initial={null} draft={draft} onClose={…} onSaved={…} />`，关闭或保存后清空。**不切换 tab**。
- `RuleEditorModal` 增加可选 `draft?: RuleInput` prop：`initial === null && draft` 存在时，各 `useState` 以 draft 字段为种子；其余行为不变。`initial` 非空时忽略 `draft`（两者实际不会同时出现）。
- `RulesPanel`、主进程、IPC、shared 类型均不改动（`RuleInput` 已存在）。保存后切到规则 tab 时列表挂载刷新，即可见新规则。

数据流：选中行 → 详情按钮 → 纯函数产出 draft → 弹窗预填 → 用户修改 → `rulesAdd` → 关弹窗。

## 4. 字段映射与边界

| 目标字段 | 取值 |
|---|---|
| `name` | `${method} ${path}`，如 `GET /users/7` |
| `enabled` | `true` |
| `match.urlType` / `urlPattern` | `exact` / `event.url` 完整串（含 query） |
| `match.method` | `event.method` 大写；不在 `HttpMethod` 中除 `ANY` 外的取值内则 `ANY` |
| `match.query` / `headers` / `bodyContains` | 不设 |
| `action.status` | `event.status ?? 200` |
| `action.headers` | 仅当响应头含 `content-type` 时预填该一行；否则留空（保存时弹窗默认补 `application/json`） |
| `action.body` | `event.responseBody ?? ''`，原样不美化、不截断 |
| `delayMs` / `fakerLocale` / `networkError` | 不设 |

边界：

- **已 mock 的请求**：允许转换（等于拿现成匹配条件改响应），不做特殊处理。
- **出错请求**（无 `status`/响应体）：status 落 200、body 留空；按钮不禁用，详情区已有错误横幅。
- **超大响应体**：不截断，与录制落盘行为一致；详情面板的 500KB 截断只作用于展示。属用户自担的已知取舍。
- 预填值即普通受控状态，用户可在弹窗内任意修改；响应头预填走现有「每行 k: v」文本框格式。

## 5. 错误处理

- 转换纯函数无失败路径；可选字段缺失一律按 §4 默认值落地，不抛错。
- 保存失败（校验/IPC）复用弹窗现有 error 横幅，不新增提示通道。
- 不新增 IPC 与主进程代码，不新增跨进程失败面。

## 6. 测试策略

- **单元**（vitest）`tests/capture-to-rule.test.ts`：全字段事件的完整映射；error 事件（→ 200 + 空 body）；无 content-type 响应头 → headers 空；非标准 method → `ANY`；mocked 事件不特殊处理；name 拼接。
- **E2E**（playwright）`e2e/capture-to-rule.spec.ts`：复用 smoke 模式——先 IPC 建规则、经代理 fetch 产生一条 mocked 流量 → 流量表点中该行 → 详情出现「转为规则」→ 断言弹窗预填（URL 模式 = 完整 URL、响应体含 mock 文本、content-type 行预填）→ 保存 → 切规则 tab 断言新规则出现 → afterAll 只删本用例创建的规则。
- **手工**：无选中时按钮不渲染；预填后改字段保存正常。

## 7. 依赖变更

无新增依赖。
