# Mocker

Charles 式本地抓包与 Mock 工具（开发者自用）。

## 功能

- HTTP/HTTPS 抓包（HTTPS 白名单 MITM / 全量解密可切换）
- 实时流量列表与请求/响应详情（分面过滤 / 重放 / Copy as cURL / HAR 导入导出 / 响应体 gzip 视图 / 响应体独立窗口查看）
- 静态响应 Mock 规则（URL 精确/通配/正则 + method + query + 头 + 请求体包含）
- 错误模板、网络异常、延迟、动态数据（Faker）、序列响应
- 重定向（Map Local / Map Remote）与场景分组
- 弱网限速（下行带宽 + 延迟 ± 抖动，预设 + 自定义，即时生效）
- 根证书管理与手机扫码接入（Android / iOS）
- 监控模式三态切换（关 / 手机 / 电脑）：接管流量的唯一入口，一次只监控一边，切换时自动清理另一侧；「电脑」即一键接管系统代理（macOS / Windows）
- 上游代理：转发流量可经电脑已有代理（http / socks5 / pac），支持 curl 风格直连名单
- 实用工具：时间戳互转（任意时区）、gzip 压缩/解压、png/jpg 批量转 WebP

## 前置条件

- Node.js ≥ 20（含 npm）；macOS 或 Windows（暂不支持 Linux）
- 默认占用端口 `8888`（代理）/ `8899`（实时推送），需空闲；同机仅允许一个实例
- 手机 USB 抓包（可选）：安装 [adb platform-tools](https://developer.android.com/tools/adb) 并加入 `PATH`，手机开启 USB 调试
  - macOS：`brew install android-platform-tools`
  - Windows：从 Android 官网下载 platform-tools 解压，把目录加入 `PATH` 后重启应用

## 运行

### 安装依赖（含 Electron 二进制下载）

`npm install` 会随依赖下载 Electron 完整二进制（约 100 MB），国内网络直连 GitHub 常超时。先选一种加速方式，再执行安装：

**方式一：国内镜像（推荐）**

```bash
# 写入项目 .npmrc，macOS / Windows 通用，一劳永逸
echo "electron_mirror=https://npmmirror.com/mirrors/electron/" >> .npmrc
```

或仅在当前终端生效：

```bash
# macOS / Linux
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
```

```bat
:: Windows CMD
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
```

```powershell
# Windows PowerShell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
```

**方式二：走本机已有代理下载（如 Clash，端口按实际改）**

```bash
# macOS / Linux
export ELECTRON_GET_USE_PROXY=1
export HTTPS_PROXY=http://127.0.0.1:7890
```

```bat
:: Windows CMD
set ELECTRON_GET_USE_PROXY=1
set HTTPS_PROXY=http://127.0.0.1:7890
```

然后安装并启动：

```bash
npm install
npm run dev
```

> 安装中断过没关系，直接重跑 `npm install`，会重新下载 Electron 二进制。

### macOS

```bash
npm install
npm run dev
```

系统代理经 `networksetup` 设置，无需管理员权限；仅安装根证书时需要输入管理员密码。

### Windows

在 PowerShell 或 CMD 中：

```bat
npm install
npm run dev
```

系统代理经注册表（HKCU）设置，无需管理员身份；首次启动若防火墙弹窗，选「允许」以便手机经局域网接入。

### 运行打包产物

```bash
npm run build && npx electron .
```

## 使用说明

1. 启动后代理自动运行（默认 `8888`）。状态栏「监控」三态选择是接管流量的**唯一入口**：
   - **关**：不接管任何流量
   - **手机**：一键建立 adb 隧道并设置手机代理（需数据线 + USB 调试；设备不在线只提示，不影响切换）
   - **电脑**：接管系统代理——浏览器/系统流量要经代理才能被抓到；代理没启动会自动启动
   切换时自动清理另一侧（如电脑切手机会自动还原系统代理）；应用退出时自动还原系统代理与手机代理。
   设置页不再单独提供系统代理开关；「设置 → 保存并重启代理」只负责让端口 / HTTPS 模式 / 白名单 / 上游代理生效，重启后会按归属自动恢复系统代理（由第三方工具如 Clash 设置的不会被改动）
2. 「流量」页实时查看请求，点击某行看请求/响应详情
3. 「规则」页新建 Mock 规则，保存即生效，无需重启

### 上游代理

「设置 → 上游代理」填入电脑上已有代理（如 Clash）的地址，未命中 Mock 规则的流量将经它出网：

- URL 支持 `http://` `https://` `socks5://` `pac+http://`，可含账号密码；留空 = 不走上游
- 「直连名单」：命中的主机绕过上游直连。逗号分隔，curl 风格：`example.com` 匹配本域及子域、`example.com:443` 限端口、`10.0.0.1` 精确 IP
- 点「保存并重启代理」生效（自动重启，秒级）；手机/电脑两种模式的转发都经过上游

### 抓包转规则

在「流量」页选中一条请求，详情区点「转为规则」，即可用该请求的 URL、状态码、`content-type` 与响应体预填一个新建规则窗，改完保存即生效。URL 默认按**精确全 URL（含 query）**匹配；响应体原样拷贝、不截断。

详情区还有「转为 MapLocal」：把选中请求的响应体落盘到 `userData/maplocal/`，再打开预填好的 Map Local 编辑窗（精确 URL + method 匹配，`action` 固定为 mapLocal）。文件名由 `host_path__URL哈希前8位.扩展名` 组成（扩展名按响应 `content-type` 推断），同一条请求重复转换会覆盖同一个文件；想改内容直接改盘上文件即可。

### 规则匹配要点

- 参与匹配的是 **URL 模式** 字段；「名称」仅是标签，不影响匹配
- 通配模式是**整串匹配**：`*` 匹配任意字符，`?` 匹配单个字符；不含通配符等同精确匹配
- 想 mock 整站写 `http://www.example.com*`（浏览器访问首页的 URL 带尾部 `/`，不带 `*` 的模式不会命中）
- 命中后流量行带 MOCK 标记，详情中显示 mock 的响应内容

### HTTPS 抓包

1. 「设置」页底部「安装根证书」区块，复制对应系统的命令执行：
   - macOS（需管理员密码）：`sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "$HOME/Library/Application Support/mocker/certs/ca.pem"`
   - Windows（管理员 CMD）：`certutil -addstore -f ROOT "%APPDATA%\mocker\certs\ca.pem"`
2. 白名单模式（默认）：仅解密名单内域名，其余直连透传；全量解密模式：解密全部 HTTPS
3. 证书未信任时，HTTPS 请求会证书报错或透传，规则不会命中

### 快速验证

```bash
# 直接经代理请求，返回规则配置的 mock 内容即说明生效
curl -x http://127.0.0.1:8888 "http://www.example.com/"
```

注意：同时只能运行一个应用实例（占用 8888 / 8899 端口）。

### 异常 Mock（错误模板 / 网络异常 / 延迟）

在规则编辑器的「行为模拟」区块配置，命中规则后按设定模拟服务端/网络异常。

**HTTP 错误模板**（返回真实的 HTTP 错误响应）

「错误模板」下拉选择预设后，状态码与响应体自动预填。共 14 个 HTTP 预设：

| 状态码 | 说明 | 附加响应头 |
|--------|------|-----------|
| 400 Bad Request | 请求参数错误 | — |
| 401 Unauthorized | 未授权，请重新登录 | — |
| 403 Forbidden | 无权访问该资源 | — |
| 404 Not Found | 请求的资源不存在 | — |
| 405 Method Not Allowed | 请求方法不允许 | — |
| 408 Request Timeout | 请求超时 | — |
| 409 Conflict | 资源冲突 | — |
| 422 Unprocessable Entity | 请求数据无法处理 | — |
| 429 Too Many Requests | 限流 | `retry-after: 60` |
| 500 Internal Server Error | 服务器内部错误 | — |
| 501 Not Implemented | 功能未实现 | — |
| 502 Bad Gateway | 网关错误 | — |
| 503 Service Unavailable | 服务暂不可用 | `retry-after: 30` |
| 504 Gateway Timeout | 网关超时 | — |

响应体统一为机器可读的 JSON（`code` 为大写错误码）：

```json
{ "error": { "code": "NOT_FOUND", "message": "请求的资源不存在" } }
```

**连接级异常**（不返回 HTTP 响应）

模板下拉里另有 5 个连接级预设（Connection reset / timed out / Host not found / Connection refused / Response truncated）。选中后请求在连接层直接失败，客户端看到的是网络错误而非 HTTP 响应，此时编辑器的状态码与响应体会置灰，取消勾选「网络异常」即恢复。

**手动配置网络异常**

不用模板时，勾选「命中时按概率触发网络异常」可手动配置：

- **异常概率**：0–100%（支持小数）。按概率随机触发，可用于「部分请求失败」的弱网/抖动模拟
- **异常类型**：同上 5 种连接级异常，另支持 `HTTP_STATUS`——连接不断开，手动指定一个错误状态码返回

**组合行为**

- 命中规则且概率触发异常时，立即返回异常（延迟不参与）；未触发时走正常 mock 响应（状态码/响应体/延迟照常）
- 「延迟（ms）」（上限 300000）可与错误模板、概率叠加，模拟慢接口或客户端超时
- 手工修改模板预填的任意字段（状态码/响应体/响应头/网络异常），模板下拉自动回到「无（自定义）」，已填值保留

**验证**

```bash
# 命中 503 模板的规则，返回模板状态码 + retry-after + JSON 错误体
curl -i -x http://127.0.0.1:8888 "http://api.example.com/orders"
# HTTP/1.1 503 Service Unavailable
# retry-after: 30
#
# {
#   "error": { "code": "SERVICE_UNAVAILABLE", "message": "服务暂不可用" }
# }

# 连接级异常在 curl 里表现为连接错误（Connection reset 等），没有 HTTP 状态码
```

### Faker 速查

在「动态数据」区块的「变量速查」行，点击「Faker 速查…」打开分类化、可搜索的速查对话框。点击任意方法右侧的「插入」按钮即可把 `{{faker.<模块>.<方法>}}` 插入到响应体光标位置。完整文档见 https://fakerjs.dev/api/ 。

### 表格编辑

请求头、响应头与请求体（form-data / x-www-form-urlencoded）均改为 Postman 风格的可编辑表格：每行含 ✓ / 名称 / 值 / 描述 / ×，未勾选的行不参与匹配；请求体额外支持 `none / raw / form-data / x-www-form-urlencoded` 四种模式 tabs，raw 模式可选「包含 / 完全相等 / JSON 深度相等」三种匹配策略。

### 流量操作

「流量」页工具栏与详情区提供六个日常操作：

- **分面过滤**：方法下拉、状态码下拉（2xx–5xx、错误）、域名输入、全文搜索框（URL + 请求/响应头 + 请求/响应体），条件 AND 组合；「清除」一键还原
- **重放 / 编辑后重发**：详情区「重放」原样重发选中请求；「编辑后重发…」打开弹窗可改方法、URL、请求头与请求体（none / raw / form-data / urlencoded）再发。重放遵循与代理一致的命中顺序：先匹配重定向（Map Local / Map Remote），再匹配 Mock 规则（含延迟 / 异常 / 模板）；新条目带「重放」角标，可继续链式重放
- **Copy as cURL**：详情区复制选中请求为 cURL 命令，方言可选 bash / cmd / PowerShell（默认跟随当前系统），hop-by-hop 头自动省略
- **响应体多视图**：详情区响应体可在「原始 / gzip 解压 / gzip 压缩」三个小 tab 间切换，每个视图各自带复制按钮，压缩视图另有「复制 base64」。解压与压缩都是派生视图，不改写抓到的响应体本身；解压 tab 仅在响应体嗅探到 gzip 魔数时可用（原始字节或 base64 形式，后者更可靠，因为抓包链路已自动解过一层 `content-encoding`）。压缩视图给出原始/压缩后字节数与压缩率，hex dump 最多渲染前 4 KiB，但复制的是完整内容；响应体超过 5 MiB 时不做压缩
- **响应体新窗口**：详情区「新窗口打开」把当前响应体交给一个独立的系统窗口（可拖到另一块屏幕），窗口里是**快照**，不随主窗口选中行变化。三个视图：**文本**（JSON 自动格式化 + 按嵌套深度着色 + 行号）、**树视图**（只读，逐层展开/收起；默认只展开前两层且子项 ≤ 50 的容器，几万字段的响应体全展开会一次渲染出几万个 DOM 节点）、**路径映射表**（把对象拍平成「路径 → 类型 → 值」，可按路径搜索、一键复制路径）。嗅探到 gzip 时自动解压并默认显示解压结果，可随时切回原始内容。与详情区不同，弹窗**不做 500 KB 截断**：文本与路径表都是等高行虚拟滚动，只渲染视口内的行，十几万行也能滚到底；超过 100 KB 时关闭语法高亮以换取渲染速度，内容不受影响
- **HAR 导入 / 导出**：「导出 HAR」把当前过滤结果存为 HAR 1.2 文件（保留 mock 标记）；「导入 HAR」加载外部 HAR 文件并替换当前流量列表查看，导入条目带「导入」角标，同样支持转规则 / 转 MapLocal

### 重定向

「重定向」标签页管理 Map Local / Map Remote 规则，与普通 Mock 规则平级，单独存储：

- **Map Local**：匹配命中后直接返回本地文件的内容，Content-Type 按扩展名推断（`.html/.json/.css/.js/.png` 等）；文件不存在返回 404 + 错误
- **Map Remote**：匹配命中后改 host（保留 path/query/method/body）转发上游，mock 规则不再生效；HTTPS 走系统 TLS

重定向规则支持与 mock 规则同样的匹配字段（URL 模式/方法/请求头）、启用开关、场景归属。

### 场景（规则/重定向分组）

场景内嵌在「规则」与「重定向」页中，按场景分组展示，不再有独立标签页：

- **分组小节**：每场景一组，组头含拖拽把手⠿、组开关、条目数；非内置组可重命名（级联更新引用）、删除（确认时选择条目去向：其他场景或未分组）
- **「默认」组**：内置场景，不可删除、不可改名，可开关；缺失时启动自动补种
- **「未分组」**：置顶展示未挂场景的条目，不受任何组开关控制（永远生效）；无条目时不渲染
- **组内新建**：每组「+ 新建规则 / + 新建重定向」自动预挂本场景
- **拖拽与排序**：组头⠿拖到另一组上换序、或组头 ↑↓ 按钮交换顺序（持久化）；规则/重定向行拖到目标组改挂场景，优先级不变；每行「移动到…」下拉等效
- **收起/展开**：组头 ▾/▸ 折叠分组内容
- **生效语义**：条目最终启用 = `rule.enabled AND (scenario?.enabled ?? true)`；关闭组开关一键停掉整组
- **命中语义**：重定向先于一切 Mock；Mock 跨场景全局按优先级取第一个命中，场景只影响整组有效性

适用场景：「测试 A」开一组规则、「线上模拟」开另一组，一键切换互不干扰。

### 序列响应

规则的「行为模拟」区块支持切换为「序列响应」模式：每条规则可挂一组响应（status + headers + body），每次命中按顺序返回下一条；到达末尾后固定返回最后一条，不循环。计数器仅存内存，应用退出清零。

适用场景：分页接口先返首页再返空页、登录态校验先 200 再 401、错误恢复先 5xx 再 200 等。

### 弱网限速

「设置 → 弱网限速」开启后，所有经过代理的响应流量按「下行带宽 + 延迟 ± 抖动」变慢，内置 3G / 慢速 3G / 56K 拨号 / 弱 WiFi 预设，数值可自定义（改数值后预设变为「自定义」）。保存即时生效，无需重启代理；状态栏常驻限速标记（点击跳设置页），抓包详情显示每次实际叠加的「限速 +nms」。

适用场景：验证 loading 态、超时重试、弱网降级逻辑。

局限：仅对代理可见的流量生效——白名单外的 HTTPS 走盲隧道，内容不可见，无法限速（白名单内被解密的流量不受影响）；只模拟下行方向；Replay 不限速。

### 实用工具

顶部「实用工具」tab（位于「重定向」与「设备接入」之间）收纳三个与抓包无关但调试常用的小工具，全部本地计算，不联网。

**时间戳**：秒 / 毫秒时间戳与「年-月-日 时:分:秒.毫秒」标准时间双向转换，可指定任意 IANA 时区（自动识别秒还是毫秒，也可手动指定）。偏移保留秒精度，1900 年前的 LMT 时区（如上海 1850 年为 `+08:05:43`）也能精确往返。仅支持公元 1000-9999 年，超范围直接报错而非输出歧义年份。

**gzip**：文件模式对任意文件做 gzip 压缩 / 解压，显示压缩前后体积与压缩率；文本模式在原始文本与 base64 之间互转，纯渲染进程计算不落盘。解压上限 256 MB，超限中止并提示疑似解压炸弹。文件在主进程用异步 zlib 处理，不会冻住抓包。

**图片转 WebP**：png / jpg 批量转 webp，质量 1-100 可调（默认 80），按源目录结构镜像写入所选输出文件夹，**源图不会被修改**。用 Electron 自带的 Chromium 编码器，无需安装任何额外依赖。

已知限制：

- 边长超过 16383px 的图片编码会失败
- CMYK 色彩空间的 JPEG（部分 Photoshop 导出）可能解码失败
- ICC 色彩配置文件可能不被保留；PNG 透明通道会保留
- 不处理 GIF、动画与 webp 源文件
- 单次扫描上限 5000 张，超出请选更小的子目录

单张失败只会记在明细表里标红，不中断整批。

## 开发

- `npm install`
- `npm run dev` 启动开发模式
- `npm test` 单元/集成测试
- `npm run test:e2e` E2E 冒烟
- `npm run typecheck` 类型检查

## 手机接入

1. 手机与电脑同网段，设置系统代理为 `电脑IP:8888`
2. 手机浏览器访问 `http://电脑IP:8888` 按指引安装证书
3. HTTPS 抓包：在「设置」中把目标域名加入白名单

**USB 直连（Android，不同网段可用）**：手机与电脑不在同一网络时，用数据线 + USB 调试把手机流量转到电脑代理——「设备接入」页的「Android USB 直连」区块可一键建立隧道、设置/恢复手机代理。用完务必恢复手机网络，否则手机会断网。

## 已知限制

见「设备接入」页说明：Android 7+ 用户证书、SSL Pinning、iOS 私有中继、HTTP/3。

另：用 `curl -x` 经代理请求**本机回环地址的上游**可能挂起（mockttp 透传与 curl 的既有兼容问题，与限速无关）；浏览器与编程客户端（fetch/undici）不受影响。

## 文档

- [规则增强用法（时延/动态数据/网络异常）](docs/guide-enhancements.md)

## 设计文档

- 总体设计：`docs/superpowers/specs/2026-09-01-mocker-design.md`
- 各功能专项设计见 `docs/superpowers/specs/`（规则增强、抓包转规则、流量操作、场景内嵌、规则引擎扩展等）
