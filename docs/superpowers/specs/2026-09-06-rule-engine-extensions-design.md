# Mocker 规则引擎扩展设计文档（路线图第二期）

日期：2026-09-06
状态：已确认，待实现
路线图：第一期「流量操作」已合入 master（5c3d807/babc4ae）；第二期扩规则模型；第三期「代理干预」留待后续。

## 1. 目标与范围

扩展规则引擎四条独立能力：

| 功能 | 决议 |
|---|---|
| Map Local / Map Remote | 作为**独立的「重定向」规则区**（与现有 Mock 规则平级，单独一个 tab）；mapLocal 读本地文件返回；mapRemote 改 host 转发上游 |
| 场景化 mock | **命名分组 + 整组 enable** 语义：规则可选挂到某个场景；规则的最终 enabled = `rule.enabled AND (scenario?.enabled ?? true)` |
| 序列响应 | 计数器**随规则实例**：`RuleAction.kind === 'sequential'` 时返回 `responses[counter]`，命中后 `counter++`；末尾固定返回最后一项，不循环 |

非目标：字段级场景覆盖、客户端/会话级序列、networkError 与序列混用、并发改写、MIME 自动协商（用扩展名查表）。

## 2. 数据模型变更

`src/shared/types.ts`：

```ts
// 新增
export type RedirectActionKind = 'mapLocal' | 'mapRemote';

export interface RedirectRule {
  id: string;
  name: string;
  enabled: boolean;
  scenario?: string;             // 命名场景组，未挂时遵循规则本身 enabled
  priority: number;
  match: RuleMatch;              // 复用 {urlType,urlPattern,method,query,headers,body}
  action: RedirectActionKind;
  target: string;                // mapLocal: 本地文件绝对路径；mapRemote: host[:port]
}

export interface Scenario {
  name: string;                  // 唯一名（id 即 name）
  enabled: boolean;
}

export interface SequentialResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

// RuleAction 升级为可辨识联合；老数据（无 kind）按 'static' 处理
export type RuleAction =
  | {
      kind?: 'static';           // 缺省视为 static，向后兼容
      status: number;
      headers: Record<string, string>;
      body: string;
      delayMs?: number;
      fakerLocale?: string;
      networkError?: NetworkError;
    }
  | {
      kind: 'sequential';
      responses: SequentialResponse[];
      fakerLocale?: string;
    };

// TrafficEvent 加 sequenceIndex 字段（仅 sequential 命中时存在）
export interface TrafficEvent {
  // …existing fields…
  sequenceIndex?: number;
}
```

向后兼容：`RuleAction` 加 `kind?` 可选字段；旧规则的 JSON（无 kind）反序列化后 `kind === undefined`，运行时按 static 处理，存盘时自动补 `kind: 'static'`。

## 3. 存储

- `src/main/storage/redirects-store.ts`（新建）— 持久化重定向规则，独立 JSON
  - 文件：`<userData>/redirects.json`，数组 schema 同 `RedirectRule[]`
  - API：`load()` / `list()` / `add(input)` / `update(id, patch)` / `remove(id)` / `save()`
  - 失败语义：load 失败 → 警告日志 + 空数组（不阻断启动）
- `src/main/storage/scenarios-store.ts`（新建）— 名称 → enabled 字典
  - 文件：`<userData>/scenarios.json`，`Scenario[]`
  - API：`list()` / `add(name)` / `rename(oldName, newName)` / `setEnabled(name, bool)` / `remove(name)`
  - 删除时返回受影响条目数（用于 UI 提示），由调用方决定是否清空引用
- `RulesStore` schema 增加 `scenario?: string`（迁移逻辑：旧文件无该字段直接视为 undefined）
- `RedirectsStore` 同上

序列计数器：**不持久化**，仅内存 `Map<ruleId, number>`，应用退出即清零。

## 4. 匹配管道（proxy-server 重构）

`src/main/proxy/proxy-server.ts` 单请求处理顺序：

1. **重定向规则**（按 priority 升序）→ 命中后：
   - mapLocal：`fs.readFile(target)`；失败 → 404 + event.error = `map-local: <原因>`
   - mapRemote：构造上游 URL（保留 path/query/method/body/headers，去 hop-by-hop），用 Node `http/https` 直连（与 ReplayService 同样的 setTimeout/retry/abort 语义）；mock 规则**不适用**
   - event 字段：`mocked: true, matchedRuleId: <redirectId>, origin: 'capture'`；type 通过 matchedRuleId 反查 rule 表区分
2. **mock 规则**（按 priority 升序）→ 命中后交给 `computeMockResult`；sequential 分支特殊处理
3. 未命中 → 透传上游（保持现状）

`computeMockResult`（`src/main/rules/apply-rule.ts`）增加分支：

```ts
if (matched.action.kind === 'sequential') {
  // 取当前序号（只增不减）：counter = max(current, 0)；idx = min(counter, last)
  // 渲染 body / headers（应用 fakerLocale）；返回 { status, headers, body, warnings, networkError: null }
  // 调用方负责 advance：computeMockResult 只读取
}
```

计数器管理放在 proxy-server 一处：

```ts
private seqCounters = new Map<string, number>(); // ruleId → index

private nextSeqIndex(ruleId: string, total: number): number {
  const cur = this.seqCounters.get(ruleId) ?? 0;
  const idx = Math.min(cur, total - 1);
  this.seqCounters.set(ruleId, cur + 1);
  return idx;
}

resetSequenceCounter(ruleId: string): void {
  this.seqCounters.delete(ruleId);
}
```

计数器与 `computeMockResult` 解耦：`computeMockResult` 接 `sequenceIndex` 参数，proxy 在调用前算好。事件发出时附 `sequenceIndex`。

### 启用叠加

```ts
export function ruleEffective(rule: { enabled: boolean; scenario?: string }, scenarios: Map<string, Scenario>): boolean {
  if (!rule.enabled) return false;
  if (rule.scenario === undefined) return true;
  const s = scenarios.get(rule.scenario);
  return s ? s.enabled : true;
}
```

proxy-server 收到规则列表时按此过滤；RuleEditorModal 编辑表单里显示「场景」单选下拉。

## 5. Map Local / Map Remote 实现

`src/main/rules/redirect.ts`（新建）：

```ts
export function mimeForPath(p: string): string;   // 扩展名查表
export async function resolveMapLocal(target: string): Promise<
  | { ok: true; content: Buffer; mime: string }
  | { ok: false; reason: string }
>;
export async function sendMapRemote(target: string, req: RequestDescription): Promise<
  { status: number; headers: Record<string,string>; body: string }
  | { error: string }
>;
```

MIME 表（常量）：
- `.html/.htm` → `text/html; charset=utf-8`
- `.json` → `application/json; charset=utf-8`
- `.js/.mjs` → `application/javascript; charset=utf-8`
- `.css` → `text/css; charset=utf-8`
- `.txt` → `text/plain; charset=utf-8`
- `.xml` → `application/xml; charset=utf-8`
- `.svg` → `image/svg+xml`
- `.png/.jpg/.jpeg/.gif/.webp` → 对应 image/*
- `.pdf` → `application/pdf`
- 其他 → `application/octet-stream`

mapRemote 的 hop-by-hop 去除与 ReplayService 一致（host / connection / content-length / accept-encoding）。超时 30s。

## 6. 场景 UI

`src/renderer/src/components/ScenariosPanel.tsx`（新建），主 tab 新增「场景」：
- 表格：名称 / 启用 / 操作（重命名 / 删除）
- 顶部「+ 新建场景」按钮（输入名）
- 删除前确认弹窗，显示「将影响 N 条规则」
- 重命名弹窗：输入新名；提交后 store 批量改写引用
- 编辑规则 / 重定向时「场景」单选：列出当前所有场景名 + `[无]`

## 7. 序列响应 UI

`src/renderer/src/components/RuleEditorModal.tsx` 现有「行为模拟」区块改造：

- 顶部加「响应模式」单选：`static` / `sequential`
- 选 `static` 时：现有 status/headers/body 三个区块（保持不变）
- 选 `sequential` 时：
  - 顺序列表，每行：状态码输入 + 内容预览（点开看完整 headers/body）
  - 顶部「+ 添加响应」按钮（追加空白响应）
  - 行尾删除按钮
  - 整序列共享 `fakerLocale`（下拉）
  - `delayMs` YAGNI 跳过；`networkError` YAGNI 跳过（sequential 不兼容）
- 规则详情旁「重置序号」按钮（仅当计数器 > 0 显示，proxy 暴露 IPC `rules:resetSequence(ruleId)`）
- 列表行也支持上下移动（YAGNI：先不做，保持追加顺序）

## 8. 重定向 UI

`src/renderer/src/components/RedirectsPanel.tsx`（新建），主 tab 新增「重定向」：
- 表格：启用 / 名称 / 匹配 / 类型（mapLocal / mapLocal）/ 目标 / 操作（编辑 / 删除 / ↑↓）
- 编辑 modal `RedirectEditorModal.tsx`（新建）：
  - 复用 RuleEditorModal 的匹配字段 + 头部行编辑
  - 类型下拉（mapLocal / mapRemote）
  - 目标输入框 + 「选择文件」按钮（mapLocal 时调 dialog.showOpenDialog）
  - 「场景」单选（同上）
  - 点击 mapLocal 时不渲染响应字段（target 即全部）

## 9. 平台兼容

- 文件 IO、路径处理都用 Node 内置（fs / path），跨平台一致
- MIME 表为纯常量
- 对话框使用现有 `showSaveDialog` / `showOpenDialog` 辅助（main/ipc.ts）
- 无平台分支

## 10. 错误处理

| 场景 | 行为 |
|---|---|
| mapLocal 文件不存在 | 404 + `event.error = 'map-local: ENOENT: <path>'` + 响应体 `File not found` |
| mapLocal 权限不足 | 403 + `event.error = 'map-local: EACCES'` |
| mapRemote 连接拒绝 | `event.error = 'ECONNREFUSED'`，无响应 |
| mapRemote 超时 | `event.error = 'replay-timeout'`（复用 ReplayService 同样的错误码），无响应 |
| 场景重命名冲突 | 拒绝，新名已存在则提示 |
| 场景删除仍有引用 | UI 弹窗展示影响条目数；确认后调用方清空引用 |
| store 读写失败 | main 进程 log 警告，UI 端得到空列表，无额外 toast（启动不阻断） |
| sequential 计算异常 | 不推进计数器，返回当前序号响应 |

## 11. 测试

- 单测：
  - `redirect.test.ts`：mime 推断、mapLocal 文件存在/不存在、mapRemote 转发（用本地 http 服务器）
  - `sequence.test.ts`：顺序取响应、末尾固定、不持久化
  - `scenarios-store.test.ts`：重命名级联引用、删除影响计数
  - `rule-effective.test.ts`：启用叠加各种组合
- E2E：
  - `map-local.spec.ts`：mapLocal 命中返回文件内容；文件不存在返回 404 + 错误
  - `scenarios.spec.ts`：场景切换影响 mock 命中；不挂场景规则不受影响
  - `sequence.spec.ts`：同一规则 3 次请求返回 3 个不同响应；末尾固定
- 平台：mime 与 fs 都是常量/跨平台 API，无平台分支
