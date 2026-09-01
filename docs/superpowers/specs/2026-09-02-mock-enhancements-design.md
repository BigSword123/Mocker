# Mocker — Mock 规则增强设计（Phase 1.5）

- 日期：2026-09-02
- 范围：规则级时延模拟、动态 Mock 数据（Faker.js）、网络异常概率触发
- 状态：待 review

## 1. 背景与目标

当前 `MockRule` 仅支持静态响应（`status / headers / body`）。为覆盖更真实的联调与演练场景，需要补充：

1. **时延模拟**：规则级固定延迟
2. **动态 Mock 数据**：Faker.js 全家桶 + 内置变量（时间、UUID、请求字段）
3. **网络异常模拟**：概率触发连接重置 / 超时 / DNS 失败 / 连接拒绝 / 截断 / 自定义状态码

全部挂在 `RuleAction` 上，向后兼容现有规则。

### 非目标

- 全局 / Profile 级弱网配置（留给后续）
- 条件 / 循环等模板控制流
- 脚本化（JS 表达式 / 沙箱）
- 概率粘滞（同一规则对同一 host 连续命中保持一致结果）

## 2. 类型扩展

```ts
// src/shared/types.ts

export type NetworkErrorType =
  | 'ECONNRESET'
  | 'ETIMEDOUT'
  | 'ENOTFOUND'
  | 'ECONNREFUSED'
  | 'TRUNCATE'
  | 'HTTP_STATUS';

export interface NetworkError {
  /** 0-100，每次请求独立 roll */
  probability: number;
  type: NetworkErrorType;
  /** 仅当 type === 'HTTP_STATUS' 时有效 */
  errorStatusCode?: number;
}

export interface RuleAction {
  status: number;
  headers: Record<string, string>;
  body: string;

  /** 固定延迟（ms），命中异常分支时不生效。上限 300_000 */
  delayMs?: number;
  /** Faker locale，如 zh_CN / en / ja。未设置时走默认 locale */
  fakerLocale?: string;
  /** 网络异常配置。命中后忽略 status/headers/body */
  networkError?: NetworkError;
}
```

`TrafficEvent` 增加可选字段：

```ts
export interface TrafficEvent {
  // ...existing fields
  /** 模板渲染产生的非致命告警（变量不存在、解析失败等） */
  renderWarnings?: string[];
  /** 本次请求是否命中异常分支（probability roll 命中）。用于排查"为什么这条规则没返回 mock" */
  errorTriggered?: boolean;
}
```

### 校验规则

- `delayMs`：整数，`0 ≤ delayMs ≤ 300_000`
- `networkError.probability`：数值，`0 ≤ p ≤ 100`，允许小数
- `networkError.type === 'HTTP_STATUS'` 时 `errorStatusCode` 必填且为 `100-999` 整数
- 异常分支命中时 `delayMs` 不执行（互斥语义）

## 3. 模板引擎

新增模块 `src/main/rules/template.ts`。

### 语法

占位符：`{{ namespace.path[:arg1:arg2] }}`，未识别或解析失败的占位符**原样保留**（不抛错、不 500）。

### 命名空间

| 命名空间 | 示例 | 说明 |
|---|---|---|
| `now` | `{{now}}` `{{now:iso}}` `{{now:ms}}` `{{now:YYYY-MM-DD}}` | 内置；默认 ISO 8601，`ms` 输出时间戳，其他按 dayjs 格式化 |
| `uuid` | `{{uuid}}` | `crypto.randomUUID()` |
| `random.int:min:max` | `{{random.int:1:100}}` | 内置 |
| `random.float:min:max:precision` | `{{random.float:0:1:4}}` | 内置 |
| `random.choice:a:b:c` | `{{random.choice:OK:WARN:ERR}}` | 内置 |
| `random.string:len` | `{{random.string:16}}` | 内置 |
| `req.method` / `req.url` / `req.host` / `req.path` | `{{req.path}}` | 请求上下文 |
| `req.query.xxx` | `{{req.query.id}}` | URL query |
| `req.header.xxx` | `{{req.header.Authorization}}` | 不区分大小写取 |
| `req.body` / `req.body.json.xxx` | `{{req.body.json.userId}}` | body 为 JSON 时按路径取；非 JSON 返回空串 |
| `faker.<module>.<method>` | `{{faker.person.firstName}}` `{{faker.internet.email}}` | `@faker-js/faker`，按 `fakerLocale` 取实例 |
| `faker.xxx:arg1:arg2` | `{{faker.number.int:1:100}}` | 参数按位置传入，数值自动转 number |

### 实现要点

- **Faker 单例 + locale 缓存**：`Map<locale, Faker>`，避免每条规则重建实例
- **占位符正则**：`/\{\{\s*([^{}]+?)\s*\}\}/g`，单次扫描替换
- **白名单**：faker 调用限制在已知模块列表，禁止 `faker.helpers.fake`（避免二次模板解析）
- **错误处理**：单条变量解析失败 → 替换为空串并在 `renderWarnings` 追加 `template_warn: <token>: <reason>`
- **JSON 友好**：纯字符串替换。若用户要数值类型，需外层不加引号（`"age": {{random.int:18:60}}`），UI 帮助文案明示

### 渲染范围

- `action.body`：始终渲染
- `action.headers` 的值：逐值渲染（key 不渲染）
- `action.status`：不渲染（保持 number）

## 4. 执行流

改造 `src/main/proxy/proxy-server.ts` 的 `handle`：

```
命中规则 matched
  │
  ├─ matched.action.networkError 存在
  │     且 roll(0..100) < probability ?
  │     │
  │     ├─ 是 → 记录 event.error = type
  │     │        按 type 调用 mockttp 异常接口
  │     │        立即返回，不执行 delayMs
  │     │
  │     └─ 否 → 落入正常响应分支
  │
  └─ 正常响应分支
        ├─ 若 delayMs > 0：await sleep(delayMs, signal)
        │     signal 来自 ProxyServer 维护的 AbortController，
        │     stop() 时 abort()，避免悬挂计时器
        ├─ renderTemplate(action.body, reqCtx, fakerLocale)
        ├─ 逐值渲染 action.headers
        ├─ 写 event.responseBody / responseHeaders / status
        ├─ 写 event.renderWarnings（如有）
        └─ 返回 toCallbackResponse(...)
```

### Abort 机制

- `ProxyServer` 新增 `private abort = new AbortController()`
- `start()` 时重建，`stop()` 时 `abort()`
- 所有 `sleep` 与长耗时模板渲染接受 signal

### 事件记录

- `event.completedAt` 在 sleep 结束后或异常返回时写，贴近真实体感
- `event.responseBody` 存**渲染后**的最终值（方便排查）

## 5. mockttp 异常接口映射

> 落地时以 `node_modules/mockttp` 实际 API 为准，下表为预期映射。

| NetworkErrorType | mockttp 实现 | 备注 |
|---|---|---|
| `ECONNRESET` | `thenCloseConnection()` | 客户端看到连接被重置 |
| `ETIMEDOUT` | `thenTimeout(timeoutMs)` | `timeoutMs` 独立于 `delayMs`：未配置时默认 30_000；若需要在规则中配置，可在 `NetworkError` 上追加 `timeoutMs`（本设计暂不开放，固定 30s） |
| `ENOTFOUND` | `thenCloseConnection()` | 客户端已建立连接后被关闭，等价于 DNS 失败后的连接失败 |
| `ECONNREFUSED` | `thenCloseConnection()` | 同上，客户端视角为连接失败 |
| `TRUNCATE` | 降级为连接重置（同 `ECONNRESET`） | 见下方实现偏差 |
| `HTTP_STATUS` | 掷骰命中异常分支后返回 `status = errorStatusCode` 的空响应 | 见下方实现偏差 |

若 mockttp 版本不提供 `thenTimeout`，降级为 `await sleep(N) + thenCloseConnection()`。

### 实现偏差（已批准）

单处理器（`beforeRequest`）架构下的最终落地语义：

1. **`ETIMEDOUT`**：降级为直接关闭连接（无真实等待），客户端表现为失联。
2. **`TRUNCATE`**：降级为立即重置连接，不做字节级截断。
3. **`HTTP_STATUS`**：按用户"规则响应与网络异常互斥"的决定，作为异常分支参与概率掷骰——命中即跳过 `delayMs`、返回空 body 并置 `errorTriggered`；不再走正常响应分支，也不渲染模板错误报文。

## 6. UI 变更

文件：`src/renderer/src/components/RuleEditorModal.tsx`

表单拆为三块，后两块默认折叠：

### 基础（现有）

URL 类型 / URL 模式 / Method / Query / 请求头 / 请求体包含 / 响应状态码 / 响应头 / 响应体

### 动态数据（新增折叠）

- Faker locale 下拉：`zh_CN / en / ja / ko / de / fr`
- 变量速查按钮：点击插入 `{{now}}` / `{{uuid}}` / `{{faker.person.firstName}}` / `{{req.query.id}}` 等常用 token
- 渲染预览：取当前 body 调一次 `renderTemplate` 并展示结果（走 IPC 到主进程）

### 行为模拟（新增折叠）

- 延迟（ms）：数值输入，`0–300000`，超出校验报错
- 网络异常开关 → 展开：
  - 概率（%）：数值或滑块 0–100
  - 异常类型下拉：`ECONNRESET / ETIMEDOUT / ENOTFOUND / ECONNREFUSED / TRUNCATE / HTTP_STATUS`
  - 仅当 `HTTP_STATUS` 时：状态码输入框

### 校验提示

- `delayMs` 超上限 → 红色文案"延迟不能超过 300000ms"
- `HTTP_STATUS` 未填 `errorStatusCode` → "请选择/输入错误状态码"
- 异常开启时若 `probability = 0` → 黄色提示"概率为 0，异常永远不会触发"

## 7. 测试策略

### 单元（vitest）

- `template.ts`：覆盖所有命名空间、未知变量原样保留、参数解析、locale 切换、错误收集
- `engine.ts`：保持原行为（本设计不修改匹配逻辑）

### 集成（e2e）

- 固定延迟规则：请求耗时 ≥ `delayMs`（容差 50ms）
- 异常触发：`probability = 100` 时必然失败，`probability = 0` 时必然成功
- 模板渲染：`{{now}}` 在响应体中可被解析为 ISO 字符串
- Faker locale：`zh_CN` 下 `{{faker.person.firstName}}` 命中中文字符集

### 手工

- UI 变量速查按钮插入 token 正确
- 渲染预览与真实响应一致
- `stop()` 期间悬挂的 sleep 不再阻塞进程退出

## 8. 依赖变更

- **新增**：`@faker-js/faker`（主进程依赖）
- **复用**：`dayjs`（若已存在；否则仅用 `Date` + 自定义格式化函数，避免引入新依赖）
- **不引入**：`handlebars` / `lodash.template` / 任何沙箱库

## 9. 兼容性

- 现有规则（`action` 只含 `status/headers/body`）继续生效，新字段全为可选
- 旧规则落库时无需迁移；反序列化时忽略未知字段
- TrafficEvent 新增 `renderWarnings` 为可选，前端旧版本忽略即可

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| Faker 实例构造重、locale 切换慢 | 单例缓存，按 locale 懒加载 |
| 模板解析失败导致 500 | 白名单 + 占位符保留 + renderWarnings |
| 长延迟请求阻塞 proxy 关闭 | AbortController 贯穿 sleep |
| TRUNCATE 在某些客户端表现为"卡死"而非报错 | 文档明示客户端差异；默认只写 1 字节后断 |
| 概率触发无法复现 | TrafficEvent 记录本次是否命中异常分支（`errorTriggered: boolean`） |

## 11. 里程碑

1. 类型 + 存储兼容（types / rules-store）
2. 模板引擎 + 单测
3. proxy-server 执行流改造
4. mockttp 异常映射落地 + e2e
5. RuleEditorModal UI 三区块
6. 变量速查 + 渲染预览（IPC）
7. 文档与用法指南更新
