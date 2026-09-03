# Mock 增强三件套设计：错误模板 / Faker 速查 / Postman 式请求编辑

> 日期：2026-09-04
> 范围：`src/shared/types.ts`、`src/shared/error-templates.ts`（新）、`src/shared/faker-catalog.ts`（新）、`src/main/rules/matcher.ts`、`src/main/storage/rules-store.ts`、`src/renderer/src/components/RuleEditorModal.tsx`、`src/renderer/src/components/EditableTable.tsx`（新）、`src/renderer/src/components/FakerCatalogModal.tsx`（新）
> 状态：设计中，待实施

## 1. 目标

本次增强一次性解决三类体验短板：

1. **错误模板**：在规则编辑器的「行为模拟」区块内提供一键填入的 HTTP 4XX / 5XX 与连接级异常模板，免去用户手抄 status + 错误体。
2. **Faker 速查**：新增分类化、可搜索的 Faker 方法速查 Modal，点击即插入模板片段；底部链接到 fakerjs.dev 官方文档。
3. **Postman 式请求编辑**：请求头 / 响应头 / 请求体全部改为 Postman 风格的表格 + Tabs，告别 `k: v` 文本框。

非目标（YAGNI，明确不做）：
- 用户自定义错误模板（B 方案升级路径，留待后续）
- form-data 文件上传匹配
- Query 参数表格化
- 规则导入/导出
- 请求体语法高亮（C 方案升级路径）

## 2. 现状与约束

- `RuleAction`（src/shared/types.ts:96-103）已含 `status`、`headers`、`body`、`delayMs`、`fakerLocale`、`networkError`。
- `NetworkError`（src/shared/types.ts:90-94）已支持 `ECONNRESET` / `ETIMEDOUT` / `ENOTFOUND` / `ECONNREFUSED` / `TRUNCATE` / `HTTP_STATUS`。
- `src/main/rules/network-error.ts` 将 `NetworkError` 解析为 mockttp 可执行的 `close` / `reset` / `respond`，proxy 引擎无需改动。
- `match.headers`（Record）与 `match.bodyContains`（string）都是文本形态，前端用 textarea 编辑。
- `matchRule`（src/main/rules/matcher.ts:11-19）对所有字段做 AND 匹配，body 仅支持 `includes`。
- `RuleEditorModal` 使用纯 CSS + 原生 `<input>`/`<textarea>`/`<select>`，无 UI 库。
- rules 落盘走 `src/main/storage/rules-store.ts`，JSON 存储于用户数据目录，目前无 schemaVersion 字段。

## 3. 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│  渲染进程（RuleEditorModal）                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ 错误模板下拉 │  │ Faker 速查   │  │ 请求头/响应头    │  │
│  │ (硬编码预设) │  │ Modal        │  │ EditableTable    │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ 请求体 Tabs（none / raw / form-data / urlencoded）   │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                          │ 保存 (RuleInput)
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  主进程                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ rules-store  │→ │ matcher      │→ │ proxy-server     │  │
│  │ (迁移+落盘)  │  │ (HeaderRow + │  │ (零改动)         │  │
│  │              │  │  RuleBody)   │  │                  │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

设计原则：
- **数据层扩展，不破坏旧结构**：matcher 保留兼容分支，迁移函数在加载时一次性转换。
- **proxy 引擎零改动**：错误模板只是预填 `status` / `body` / `networkError`，不引入新字段。
- **纯渲染层 UI 升级**：错误模板下拉、Faker Modal、EditableTable 全在 renderer。

## 4. 数据模型

### 4.1 新增共享类型（src/shared/types.ts）

```ts
export interface HeaderRow {
  enabled: boolean;
  name: string;
  value: string;
  description?: string;
}

export type BodyMode = 'none' | 'raw' | 'form-data' | 'urlencoded';
export type BodyMatchStrategy = 'contains' | 'equals' | 'json-deep';

export interface RuleBody {
  mode: BodyMode;
  raw?: string;
  rawContentType?: string;      // 默认 'application/json'
  form?: HeaderRow[];           // form-data / urlencoded 共用
  matchStrategy?: BodyMatchStrategy;  // 默认 'contains'，仅 mode='raw' 生效
}

export interface RuleMatch {
  urlType: UrlPatternType;
  urlPattern: string;
  method: HttpMethod;
  query?: Record<string, string>;
  headers?: Record<string, string> | HeaderRow[];  // 旧格式兼容
  bodyContains?: string;                           // 旧格式兼容
  body?: RuleBody;                                 // 新增
}
```

`RuleAction` 不变（错误模板只预填现有字段）。

### 4.2 错误模板常量（src/shared/error-templates.ts，新）

```ts
export type ErrorTemplateCategory = 'http-4xx' | 'http-5xx' | 'connection';

export interface ErrorTemplate {
  id: string;
  category: ErrorTemplateCategory;
  label: string;
  description: string;
  payload:
    | { kind: 'http'; status: number; body: string; headers?: Record<string, string> }
    | { kind: 'connection'; networkError: NetworkError };
}

export const ERROR_TEMPLATES: ErrorTemplate[] = [ /* 见附录 A */ ];
```

### 4.3 Faker 速查目录（src/shared/faker-catalog.ts，新）

```ts
export interface FakerEntry {
  path: string;       // 'faker.person.firstName'
  label: string;      // '名（中文 locale 下为中文姓名）'
  snippet: string;    // '{{faker.person.firstName}}'
  example: string;    // '张伟'
  args?: string;      // 可选参数说明
}
export interface FakerCategory { id: string; label: string; entries: FakerEntry[] }
export const FAKER_CATALOG: FakerCategory[] = [ /* 见附录 B */ ];
```

## 5. 错误模板

### 5.1 UI 位置

`RuleEditorModal` 的「行为模拟」`<details>` 区块内，**置顶行**：

```
┌──────────────────────────────────────────────────────┐
│ 行为模拟                                             │
│ 错误模板   [▼ 无（自定义）        ]                  │
│ 延迟（ms） [____0____]                                │
│ 网络异常   [ ] 命中时按概率触发网络异常               │
│ ...                                                  │
└──────────────────────────────────────────────────────┘
```

`<select>` 内用 `<optgroup>` 分组：`── 4XX ──` / `── 5XX ──` / `── 连接异常 ──`，首项固定为 `无（自定义）`。

### 5.2 选中模板的行为

**HTTP 类模板**：
1. 自动取消勾选「网络异常」（连接异常互斥）
2. 写入 `status = template.payload.status`
3. 写入 `body = template.payload.body`
4. 写入 `headers['content-type'] = 'application/json'`（合并，不覆盖其他响应头）
5. 响应状态码、响应体输入框保持可编辑

**连接级模板**：
1. 自动勾选「网络异常」并设 `probability = 100`
2. 自动选中 `type` 为对应项
3. 禁用响应状态码与响应体（灰显 + `disabled` 属性，连接中断无响应）

### 5.3 手工编辑回写

- 用户选中模板后若手工修改响应状态码 / 响应体 / 异常类型 / 异常概率中的任意一项 → 下拉自动回到 `无（自定义）`，但保留用户已填入的值
- 实现：`selectedTemplateId` 是「触发预填」的一次性信号；通过 `useEffect` 监听切换，通过 `onChange` 检测手编后重置

### 5.4 完整模板列表

见**附录 A**。

## 6. Faker 速查 Modal

### 6.1 入口

`RuleEditorModal` 「动态数据」区块的「变量速查」行末尾新增按钮 `Faker 速查…`，样式略突出。

### 6.2 Modal 布局

- 宽 680px，最大高 80vh，主体区域滚动
- 顶部搜索框（自动聚焦，150ms 防抖）
- 中部 tab：12 个分类（person / internet / location / date / number / string / finance / company / phone / commerce / image / color / lorem），搜索词非空时自动切到「搜索结果」视图
- 每条目显示 `path` / `label` / `example` / 「插入」按钮
- 底部帮助区：语法 `{{faker.<模块>.<方法>[:参数]}}` + 官方文档链接 `https://fakerjs.dev/api/`（`window.open` 新窗口）

### 6.3 插入行为

- 响应体 `<textarea>` 通过 `ref` 拿 `selectionStart`，点击插入 → 在光标处插入 `snippet`，光标后移到 snippet 末尾
- 插入后**不关闭** Modal，方便连续插入
- 右上角 ✕ 或点击蒙层关闭；关闭不清空响应体

### 6.4 完整分类与方法列表

见**附录 B**。

## 7. 请求头 / 请求体表格

### 7.1 EditableTable 通用组件（src/renderer/src/components/EditableTable.tsx，新）

```tsx
interface EditableTableProps {
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
  columns: {
    enabled?: boolean;         // 默认 true
    namePlaceholder?: string;
    valuePlaceholder?: string;
    description?: boolean;     // 默认 true
  };
}
```

列固定顺序：**[✓] | 名称 | 值 | 描述 | [×]**

交互规则：
- Tab 顺序：enabled → name → value → description → 下一行 name
- 最后一行任意单元格非空时，自动追加空行（Postman 体验）
- 行右侧 `×` 按钮删除行；至少保留一行空行
- 未勾选 enabled 的行半透明 + 文本划掉，不参与匹配
- Enter 在 value / description 单元格跳到下一行同列
- 空表格默认显示一行空行

### 7.2 请求头表格

替换 `RuleEditorModal` 中的「请求头（每行 k: v）」textarea：

```
请求头
┌─────┬──────────────────┬──────────────────────┬─────────────────────┬───┐
│ ✓  │ Authorization    │ Bearer {{uuid}}      │ JWT 鉴权             │ × │
│ ✓  │ Content-Type     │ application/json     │                     │ × │
│    │ X-Deprecated     │ legacy               │ 已废弃，仅留档       │ × │
│    │                  │                      │                     │   │ ← 自动空行
└─────┴──────────────────┴──────────────────────┴─────────────────────┴───┘
                                     [+ 添加行]
```

### 7.3 响应头表格

顺手一并升级（组件已抽好，零额外成本）。与请求头表格结构完全一致。

### 7.4 请求体 Tabs

替换原「请求体包含」单行 input：

```
请求体
┌──────────┬──────────┬──────────────┬──────────────┐
│ ○ none   │ ● raw    │ ○ form-data  │ ○ x-www-form │
└──────────┴──────────┴──────────────┴──────────────┘
┌──────────────────────────────────────────────────────────┐
│ 内容类型: [application/json ▼]                            │
│ 匹配策略: [包含 ▼]  (包含 / 完全相等 / JSON 深度相等)    │
│                                                          │
│  <textarea monospace, 8 行>                              │
└──────────────────────────────────────────────────────────┘
```

| mode | UI | 匹配行为 |
|---|---|---|
| `none` | 空白提示「此规则不匹配请求体」 | 跳过 body 匹配 |
| `raw` | textarea (monospace, 8 行) + 内容类型下拉 + 匹配策略下拉 | contains / equals / json-deep |
| `form-data` | EditableTable（3 列：enabled / name / value） | 请求体解析为 form，所有 enabled 行 k=v 必须存在 |
| `urlencoded` | 同 form-data 表格 | 同上（Content-Type 不同） |

### 7.5 匹配策略说明

| 策略 | 含义 | 适用 |
|---|---|---|
| `contains`（默认） | 请求体文本包含 raw 字符串 | 旧行为兼容、模糊匹配 |
| `equals` | 请求体文本与 raw 完全相等 | 精确回归测试 |
| `json-deep` | 双方 JSON.parse 后深度比较（键序无关） | JSON 接口精确匹配 |

仅当 `mode === 'raw'` 时显示策略下拉；form / urlencoded 固定为「字段全部存在」语义。

## 8. 数据迁移

### 8.1 策略

`src/main/storage/rules-store.ts` 在加载时按条执行 `migrateRule`：

```ts
function migrateRule(raw: unknown): MockRule {
  const r = raw as any;
  if (r.match?.headers && !Array.isArray(r.match.headers)) {
    r.match.headers = Object.entries(r.match.headers).map(([name, value]) => ({
      enabled: true, name, value: String(value), description: '',
    }));
  }
  if (r.match?.bodyContains && !r.match?.body) {
    r.match.body = {
      mode: 'raw',
      raw: r.match.bodyContains,
      matchStrategy: 'contains',
    };
    delete r.match.bodyContains;
  }
  return r as MockRule;
}
```

- 加载全部规则 → 逐条迁移 → 批量写回（带 `schemaVersion: 2`）
- 迁移前备份 `rules.json` → `rules.json.bak`（首次启动 v2 时一次）
- 单条失败跳过 + 记 warn 日志，不影响其他规则

### 8.2 matcher 兼容层

`src/main/rules/matcher.ts` 过渡期同时接受两种格式：

```ts
function matchHeaders(expected, actual) {
  if (Array.isArray(expected)) {
    return expected.filter(r => r.enabled).every(row => {
      const actualLower = new Map(Object.entries(actual).map(([k, v]) => [k.toLowerCase(), v]));
      return actualLower.get(row.name.toLowerCase()) === row.value;
    });
  }
  // Record 旧格式：保留原逻辑
  ...
}
```

`matchBody(body?: RuleBody, bodyContains?: string, reqBody: string)` 按字段类型分发。下个 minor 版本移除旧格式兼容分支。

## 9. 验证矩阵

| 层级 | 覆盖点 |
|---|---|
| 单元测试 (vitest) | ① 迁移函数：旧→新、已迁移数据幂等、字段缺失容错 ② matcher：HeaderRow 的 enabled 过滤、body 三种策略 ③ 错误模板应用：HTTP 模板写 status/body、连接模板启 networkError |
| 组件测试 | ① RuleEditorModal：选模板→字段回填；手编→下拉回「自定义」 ② EditableTable：加行/删行/启禁用/自动空行 ③ FakerModal：插入到光标、搜索过滤 |
| E2E (playwright) | ① 新建含错误模板的规则 → 命中 → 流量事件显示 404 ② 表格编辑完整流程 ③ Faker 插入 + 渲染预览 ④ 从旧 rules.json 启动 → 迁移成功 |
| 代理实跑 | 起 proxy → 用 curl 命中新 body 匹配规则 → 验证 contains/equals/json-deep 行为 |

现有 e2e 套件（capture-to-rule 等）需跟进更新到 HeaderRow 结构。

## 10. 交付拆分

按风险与依赖关系分三个 PR，按顺序合入 `master`：

| PR | 内容 | 依赖 | 估算改动 |
|---|---|---|---|
| PR1：数据模型 + 错误模板 | types 扩展、error-templates.ts、迁移逻辑、RuleEditorModal 错误模板区块、matcher 升级 | 无 | ~700 行 |
| PR2：Faker 速查 + 表格 | faker-catalog.ts、FakerCatalogModal、EditableTable、请求头/响应头表格、请求体 tabs | PR1 | ~1200 行 |
| PR3：文档 | README 新增「错误模板」「Faker 速查」「表格编辑」三节 + 模板附录 | PR2 | ~150 行 |

## 11. 风险与回退

| 风险 | 缓解 |
|---|---|
| 迁移失败导致规则丢失 | 首次启动备份 `.bak`；迁移失败单条跳过 + 日志；回退旧版本仍可读取 |
| 新 matcher 误命中 | 兼容层保留旧格式分支；单元测试覆盖新旧两路 |
| FakerModal 遮挡主表单时数据丢失 | Modal 是 React Portal，主表单状态由 `useState` 保持，不随 Modal 卸载丢失 |
| EditableTable 大量行性能 | 当前规则场景行数 < 50，无优化必要；如未来膨胀可换虚拟化 |

---

## 附录 A：完整错误模板列表

| id | category | label | 预填内容 |
|---|---|---|---|
| `http-400` | http-4xx | 400 Bad Request | status=400, body=`{"error":{"code":"BAD_REQUEST","message":"请求参数错误"}}` |
| `http-401` | http-4xx | 401 Unauthorized | status=401, body=`{"error":{"code":"UNAUTHORIZED","message":"未授权，请重新登录"}}` |
| `http-403` | http-4xx | 403 Forbidden | status=403, body=`{"error":{"code":"FORBIDDEN","message":"无权访问该资源"}}` |
| `http-404` | http-4xx | 404 Not Found | status=404, body=`{"error":{"code":"NOT_FOUND","message":"请求的资源不存在"}}` |
| `http-405` | http-4xx | 405 Method Not Allowed | status=405, body=`{"error":{"code":"METHOD_NOT_ALLOWED","message":"请求方法不允许"}}` |
| `http-408` | http-4xx | 408 Request Timeout | status=408, body=`{"error":{"code":"REQUEST_TIMEOUT","message":"请求超时"}}` |
| `http-409` | http-4xx | 409 Conflict | status=409, body=`{"error":{"code":"CONFLICT","message":"资源冲突"}}` |
| `http-422` | http-4xx | 422 Unprocessable Entity | status=422, body=`{"error":{"code":"UNPROCESSABLE","message":"请求数据无法处理"}}` |
| `http-429` | http-4xx | 429 Too Many Requests | status=429, body=`{"error":{"code":"RATE_LIMIT","message":"请求过于频繁，请稍后重试"}}`, headers=`{"retry-after":"60"}` |
| `http-500` | http-5xx | 500 Internal Server Error | status=500, body=`{"error":{"code":"INTERNAL_ERROR","message":"服务器内部错误"}}` |
| `http-501` | http-5xx | 501 Not Implemented | status=501, body=`{"error":{"code":"NOT_IMPLEMENTED","message":"功能未实现"}}` |
| `http-502` | http-5xx | 502 Bad Gateway | status=502, body=`{"error":{"code":"BAD_GATEWAY","message":"网关错误"}}` |
| `http-503` | http-5xx | 503 Service Unavailable | status=503, body=`{"error":{"code":"SERVICE_UNAVAILABLE","message":"服务暂不可用"}}`, headers=`{"retry-after":"30"}` |
| `http-504` | http-5xx | 504 Gateway Timeout | status=504, body=`{"error":{"code":"GATEWAY_TIMEOUT","message":"网关超时"}}` |
| `conn-econnreset` | connection | Connection reset | networkError={type:'ECONNRESET', probability:100} |
| `conn-etimedout` | connection | Connection timed out | networkError={type:'ETIMEDOUT', probability:100} |
| `conn-enotfound` | connection | Host not found | networkError={type:'ENOTFOUND', probability:100} |
| `conn-econnrefused` | connection | Connection refused | networkError={type:'ECONNREFUSED', probability:100} |
| `conn-truncate` | connection | Response truncated | networkError={type:'TRUNCATE', probability:100} |

## 附录 B：Faker 速查目录完整清单

共 13 个分类，约 45 条常用方法。每条含 `path` / `label` / `snippet` / `example`。

### B.1 person（人员）

| path | label | example |
|---|---|---|
| faker.person.firstName | 名（中文 locale 下为中文姓名） | 张伟 |
| faker.person.lastName | 姓 | 李 |
| faker.person.fullName | 全名 | 张伟 |
| faker.person.sex | 性别 | male |
| faker.person.jobTitle | 职位 | 高级软件工程师 |
| faker.person.avatar | 头像 URL | https://avatars.githubusercontent.com/... |

### B.2 internet（网络）

| path | label | example |
|---|---|---|
| faker.internet.email | 邮箱 | zhangwei@example.org |
| faker.internet.userName | 用户名 | zhangwei99 |
| faker.internet.password | 密码（默认 15 位） | aB3$kL9!mN2@pQ7 |
| faker.internet.url | URL | https://wonderful-lake.name |
| faker.internet.ip | IPv4 地址 | 203.0.113.42 |
| faker.internet.domainName | 域名 | example.com |

### B.3 location（位置）

| path | label | example |
|---|---|---|
| faker.location.city | 城市 | 北京市 |
| faker.location.country | 国家 | 中国 |
| faker.location.zipCode | 邮编 | 100000 |
| faker.location.streetAddress | 街道地址 | 长安街 1 号 |
| faker.location.latitude | 纬度 | 39.9042 |
| faker.location.longitude | 经度 | 116.4074 |

### B.4 date（日期）

| path | label | example |
|---|---|---|
| faker.date.past | 过去日期 | 2024-03-15T08:30:00.000Z |
| faker.date.future | 未来日期 | 2027-11-22T14:20:00.000Z |
| faker.date.recent | 最近几天 | 2026-09-03T19:10:00.000Z |
| faker.date.birthdate | 出生日期 | 1990-06-18T00:00:00.000Z |

### B.5 number（数字）

| path | label | example | args |
|---|---|---|---|
| faker.number.int | 整数 | 42 | min, max |
| faker.number.float | 浮点数 | 3.14 | min, max, fractionDigits |
| faker.number.bigint | 大整数 | 9007199254740991n | min, max |

### B.6 string（字符串）

| path | label | example |
|---|---|---|
| faker.string.uuid | UUID | 123e4567-e89b-12d3-a456-426614174000 |
| faker.string.nanoid | Nano ID | a1B2_c3D4 |
| faker.string.alpha | 字母串 | abcXYZ |
| faker.string.alphanumeric | 字母数字串 | aB3cD4 |

### B.7 finance（金融）

| path | label | example |
|---|---|---|
| faker.finance.amount | 金额 | 1234.56 |
| faker.finance.currencyCode | 货币代码 | CNY |
| faker.finance.creditCardNumber | 信用卡号 | 4111-1111-1111-1111 |
| faker.finance.iban | IBAN | DE89370400440532013000 |

### B.8 company（公司）

| path | label | example |
|---|---|---|
| faker.company.name | 公司名 | 腾讯科技有限公司 |
| faker.company.catchPhrase | 口号 | Innovative holistic synergy |
| faker.company.bs | 商业描述 | leverage scalable platforms |

### B.9 phone（电话）

| path | label | example |
|---|---|---|
| faker.phone.number | 电话号码 | 138-1234-5678 |

### B.10 commerce（商业）

| path | label | example |
|---|---|---|
| faker.commerce.productName | 商品名 | 智能无线鼠标 |
| faker.commerce.price | 价格 | 299.99 |
| faker.commerce.productDescription | 商品描述 | 高性能低功耗 |

### B.11 image（图片）

| path | label | example |
|---|---|---|
| faker.image.url | 随机图片 URL | https://loremflickr.com/640/480 |
| faker.image.avatar | 头像 | https://avatars.githubusercontent.com/... |

### B.12 color（颜色）

| path | label | example |
|---|---|---|
| faker.color.human | 人可读颜色名 | teal |
| faker.color.rgb | RGB 十六进制 | #3a7b9c |
| faker.color.hex | Hex 颜色 | #ff5733 |

### B.13 lorem（文本）

| path | label | example |
|---|---|---|
| faker.lorem.word | 单词 | lorem |
| faker.lorem.words | 多个单词 | lorem ipsum dolor |
| faker.lorem.sentence | 句子 | Lorem ipsum dolor sit amet. |
| faker.lorem.paragraph | 段落 | Lorem ipsum dolor sit amet, consectetur... |
