# 模板编辑器代码补全 设计文档

日期：2026-09-02
状态：已确认（用户选定 CodeMirror 6 方案）
前置：`docs/superpowers/specs/2026-09-02-mock-enhancements-design.md`

## 1. 背景与目标

规则编辑弹窗的响应体目前是普通 textarea，模板提示只有 6 个速查按钮，用户无法发现和快速输入全量模板变量（内置变量、req.* 字段、Faker 数百个方法）。

目标：把响应体升级为 VSCode 风格的代码编辑体验——JSON 语法高亮 + 输入 `{{` 弹出补全列表（模糊过滤、键盘导航、每项带说明），候选覆盖模板引擎支持的**全量** token。

### 非目标

- 响应头字段不接编辑器（内容短，维持 textarea）。
- 不做补全参数签名提示（signature help）；带参方法在候选详情文本里给出写法示例。
- 不做 `{{}}` 之外的 JSON 结构智能补全（键名/值类型提示）。

## 2. 方案选型记录

| 方案 | 结论 |
|---|---|
| CodeMirror 6 | **选定**。约 +300KB，无 worker 配置，补全弹窗/模糊过滤/文档提示齐全，主题可完全贴合现有深色 UI |
| Monaco Editor | 否决。+5~10MB、需 worker 配置，JSON 语言服务会把未加引号的模板占位符（如 `{ "age": {{random.int:18:60}} }`）标红 |
| 自研补全弹层 | 否决。光标定位/键盘导航/滚动跟随成本高，手感差 |

## 3. 目录（catalog）数据源

补全候选的数据结构（shared/types.ts）：

```ts
export interface TemplateCatalogItem {
  /** 完整 token，如 faker.person.firstName、req.query.id */
  token: string;
  /** 展示名，默认同 token */
  label: string;
  /** 说明文本：中文含义、参数写法、示例输出 */
  detail: string;
}
```

### 3.1 主进程生成（新文件 src/main/rules/catalog.ts）

- **Faker 部分**：运行时枚举已安装的 faker 实例（`FAKERS.en`，各 locale 方法路径一致，枚举一次即可）：遍历模块对象 → 收集函数属性，得到 `模块.方法` 全集；过滤 `FAKER_BLOCKLIST`（helpers.fake）与 `DANGEROUS_KEYS`（__proto__/constructor/prototype）。结果模块级缓存（首次调用时构建）。
- **内置变量部分**：静态清单，与 template.ts 实现一一对应，detail 给参数写法与示例：
  - `now`（可选 `:iso` / `:ms` / 自定义格式如 `YYYY-MM-DD HH:mm`）
  - `uuid`
  - `random.int:min:max`、`random.float:min:max:fractionDigits`、`random.choice:a:b:c`、`random.string:len`
- **请求字段部分**：静态清单：`req.method` / `req.url` / `req.host` / `req.path` / `req.query.<name>` / `req.header.<name>` / `req.body` / `req.body.json.<path>`。query/header/json 路径类条目 detail 注明需替换为实际键名。
- 常用 faker 方法配中文注释（firstName 名、lastName 姓、email 邮箱、phoneNumber 手机号等，清单在实现计划中固化，约 30 条）；其余方法 detail 为完整路径本身。

### 3.2 IPC

- 新通道 `template:catalog`，无参数，返回 `TemplateCatalogItem[]`。
- main：`ipcMain.handle('template:catalog', () => buildCatalog())`。
- shared/api.ts + preload/index.ts 增加 `templateCatalog(): Promise<TemplateCatalogItem[]>`。
- 渲染层在弹窗首次需要时拉取一次，模块级缓存（同一会话内所有弹窗复用）。

## 4. 渲染层组件

### 4.1 TemplateEditor.tsx（新文件）

封装 CodeMirror 6，依赖固定为三个直接依赖：`codemirror`（提供 basicSetup：高亮、括号自动闭合、键位绑定）、`@codemirror/lang-json`（JSON 语法）、`@codemirror/autocomplete`（补全源与弹窗）。

- Props：`value: string`、`onChange(next: string)`、`catalog: TemplateCatalogItem[]`。
- 行为：受控组件语义（外部 value 变化且与编辑器内容不一致时重设文档）；JSON 高亮；深色主题（背景 #26272e、边框 #4a4b55、文本 #e2e2e8，与现有 input 一致）；高度与原 textarea 相当（约 8 行，可拉伸）。
- 暴露 `insertAtCursor(text: string)` 给速查按钮：在光标处插入并聚焦。

### 4.2 补全交互

- 触发：输入 `{{` 自动弹出；在 `{{` 与 `}}` 之间继续输入时按前缀模糊过滤（CodeMirror autocomplete 自带 fuzzy match）。
- 候选项：`label` 为去掉 `{{` 后的 token（如 `faker.person.firstName`），`detail` 为说明文本；补全作用域限定在 `{{` 与 `}}` 之间，插入文本仅为 token 本身。`}}` 由 basicSetup 的 closeBrackets 在输入 `{{` 时自动补上，插入后光标位于 token 与 `}}` 之间。
- 键盘：↑↓ 选择、Tab/Enter 插入、Esc 关闭（CodeMirror 默认行为）。
- 花括号内不再触发 JSON 语法补全；`{{` 之外不触发模板补全。

### 4.3 RuleEditorModal.tsx 变更

- 响应体 textarea 替换为 `<TemplateEditor>`；state 与校验逻辑不变。
- 速查按钮保留，`insertSnippet` 改为调用编辑器实例的 `insertAtCursor`。
- 渲染预览按钮与告警展示不变（预览仍走 `template:preview`）。
- catalog 拉取失败时：编辑器仍渲染，补全源退化为渲染层静态内置清单（now/uuid/random/req.*，硬编码于 TemplateEditor 同文件或独立 constants），并 `setError` 一次性提示"模板目录加载失败，仅内置变量可用"。

## 5. 数据流总览

```
弹窗打开 → template:catalog(IPC) → main buildCatalog()
                                      ├─ 枚举 faker 实例（缓存）
                                      └─ 静态内置/req 清单
         ← TemplateCatalogItem[]（渲染层缓存）
输入 {{ → CodeMirror autocomplete → 过滤 catalog → 选中插入 {{token}}
保存 → rulesValidate（不变）
```

## 6. 错误处理

| 场景 | 行为 |
|---|---|
| catalog IPC 抛错 | 降级静态内置清单 + 一次性错误提示（见 4.3） |
| faker 枚举到异常属性 | 跳过非函数/危险键，不抛错 |
| 编辑器初始化失败（理论上不会） | 不做兜底，保持抛错可见 |

## 7. 依赖变更

- 新增：`codemirror`、`@codemirror/lang-json`、`@codemirror/autocomplete`。全部进 dependencies，无 native 模块。
- 预期渲染层 bundle：687KB → 约 1MB。

## 8. 测试策略

- **单元（vitest，main）**：`buildCatalog()` 包含 `faker.person.firstName`、不含 `faker.helpers.fake`、不含任何 DANGEROUS_KEYS 段；内置清单含 `now`/`uuid`/`random.int`；req 清单含 `req.body.json`；总数在合理量级（faker 方法 > 200）。
- **单元（vitest，纯函数）**：补全候选过滤/插入文本构造逻辑（若抽为纯函数）。
- **E2E（playwright）**：开新建规则弹窗 → 响应体输入 `{{` → 出现补全弹窗（断言 `.cm-tooltip-autocomplete` 可见）→ 输入 `uuid` 过滤 → Enter → 响应体值含 `{{uuid}}`；速查按钮在光标处插入。
- **手工**：中文注释候选展示、深色主题观感、8 行高度与拉伸、预览按钮仍工作。

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| CodeMirror 受控组件语义与 React 集成坑（外部 setValue 光标跳动） | 仅在 value !== view.state.doc 时重设；重设时保持选区末尾 |
| faker 枚举把内部属性（非 API 方法）也收进来 | 只收 `typeof === 'function'` 且键不在 DANGEROUS_KEYS；模块只收对象类型属性 |
| 弹窗（modal）内 autocomplete 浮层定位/溢出 | CodeMirror tooltip 默认 append 到编辑器容器，modal 设 overflow-y auto 已兼容；E2E 覆盖可见性 |
| bundle 增大影响启动 | 桌面应用本地加载，1MB 无感知；不做懒加载（YAGNI） |
