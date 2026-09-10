# 实用工具面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在「设备接入」tab 左侧新增「实用工具」tab，提供时间戳互转、gzip 压缩解压、图片批量转 WebP 三个调试工具。

**Architecture:** 时间戳工具纯渲染进程（`Intl` 足够，零 IPC）；gzip 分两处——文件模式在主进程用 Node `zlib`（需 fs 与流式），文本模式复用姊妹 spec 的渲染进程 `body-codec.ts`（零 IPC）；WebP 编码用 Electron 自带 Chromium 编码器（`OffscreenCanvas`）在渲染进程完成，主进程负责目录扫描、读源图、镜像写入。全程零新增 npm 依赖。

**Tech Stack:** Electron 44 + React 19 + TypeScript + electron-vite；vitest（node 环境）；Playwright（启动真实 Electron，不 mock api）。

**对应 spec:** `docs/superpowers/specs/2026-09-11-utility-tools-design.md`

---

## 并发协调（开工前必读）

同一工作树里有另一个会话在并行推进 `docs/superpowers/plans/2026-09-11-response-body-gzip-views.md`（未提交）。分工边界：

| 文件 | 归属 | 本计划动作 |
|---|---|---|
| `src/renderer/src/lib/body-codec.ts` | **对方创建**（其 Task 2-4） | 绝不创建，仅 Task 9 依赖 |
| `src/renderer/src/lib/body-format.ts` | 对方创建（其 Task 1） | 不碰 |
| `src/renderer/src/components/ResponseBodyViews.tsx` | 对方创建（其 Task 5） | 不碰 |
| `src/renderer/src/components/TrafficDetail.tsx` | 对方修改（其 Task 6） | 不碰 |
| `src/renderer/src/styles.css` | 对方修改（其 Task 5） | 不碰（本计划不新增 CSS 类） |
| `README.md` | **双方都改** | 见 Task 10，只增独立小节 |
| `src/renderer/src/App.tsx` | 本计划独占 | 修改 |
| `src/shared/{api,types}.ts`、`src/preload/index.ts`、`src/main/ipc.ts` | 本计划独占（对方是纯渲染进程改动） | 修改 |

**每个 Task 提交前必须 `git status --short` 确认只 stage 自己列出的文件。** 对方可能在任意时刻提交或修改文件，`git add -A` / `git add .` 一律禁止。

## 已实测确认的前提（不要在实现时重新怀疑这些）

以下均已在本机 Node v26 / Electron 44.1.0 实测：

1. `Intl.supportedValuesOf('timeZone')` 返回 **418 个地理时区，完全不含 `UTC` / `GMT` / `Etc/UTC` 任何条目**。但 `Intl.DateTimeFormat` 接受 `'UTC'` 作为合法 timeZone。因此时区列表必须显式并入 `UTC`，最终 419 项。
2. **1900 年前多数时区使用 LMT（地方平太阳时），偏移带秒精度**，如上海 1850 年为 `+08:05:43`。偏移量若四舍五入到分钟，往返会差 17 秒。必须保留秒精度。
3. `hour12: false` 在部分 ICU 版本下把午夜输出为 `"24"`，需 `% 24` 归一。
4. 正则可选捕获组未参与匹配时值为 `undefined`（不是 `''`），`m[7].padEnd(...)` 会抛 TypeError。必须 `m[7] || '0'`。
5. `zlib.gunzip(buf, { maxOutputLength })`（同步与 `promisify` 异步版**都**支持）会在超限时抛 `code === 'ERR_BUFFER_TOO_LARGE'`，**无需手写流式解压**。实测 2MB 全 `a` 数据 gzip 后仅 1973 字节。
6. zlib 错误码：非 gzip → `Z_DATA_ERROR` / `"incorrect header check"`；截断 → `Z_BUF_ERROR` / `"unexpected end of file"`；空输入 → `Z_BUF_ERROR`。魔数前置校验能给出比这些更好的文案。
7. **主进程跑着 mockttp 代理，任何同步重活都会冻住抓包**。gzip 与全部 fs 操作必须用异步版（`promisify(zlib.gzip)` / `fs.promises`）。
8. `contextBridge` 支持 `ArrayBuffer` / TypedArray / `Blob`，经结构化克隆**复制**传递（已查官方文档确认）。本项目此前无二进制 IPC，Task 5 用 e2e 实测验证。
9. **`src/shared/**` 同时被 `tsconfig.web.json` 与 `tsconfig.node.json` 收录；`tests/**` 只属 node config（`types: ["node"]`，无 DOM lib）**。因此：
   - `src/renderer/src/lib/datetime.ts` 会被 `tests/datetime.test.ts` 间接拉进 node program 做 typecheck → **该文件不得使用任何 DOM API**（现实现仅用 `Intl`/`Date`/`Math`/`RegExp`，安全）
   - `src/renderer/src/lib/webp.ts` 用了 `OffscreenCanvas` / `createImageBitmap` / `Blob` → **绝不可被 `tests/**` 下任何文件 import**，否则 `npm run typecheck` 必挂。它只能由 e2e 覆盖。
10. `Uint8Array` 在 TS 5.7+ 泛型化为 `Uint8Array<ArrayBufferLike>`，而 DOM API（`Blob` 构造、`ReadableStream`）要求 `Uint8Array<ArrayBuffer>`。跨边界处用 `new Uint8Array(x)` 复制一份即可满足类型（对方会话的探针文件正是为此而写）。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/renderer/src/lib/datetime.ts` | 创建 | 时间戳 ↔ 时区标准时间全部纯逻辑。无 DOM、无 React、无 IPC |
| `src/renderer/src/lib/format-bytes.ts` | 创建 | `formatBytes` / `formatRatio`，gzip 与 webp 两处 UI 共用 |
| `src/renderer/src/lib/webp.ts` | 创建 | `encodeWebp`：Chromium canvas 编码。仅 e2e 可测 |
| `src/main/tools/gzip.ts` | 创建 | 异步 gzip / gunzip + 魔数校验 + 解压上限 |
| `src/main/tools/image-scan.ts` | 创建 | 递归扫描、outName 生成与撞名处理、路径收敛读写 |
| `src/shared/types.ts` | 修改 | 新增 `GzipMode` / `GzipFileResult` / `ScannedImage` / `WebpWriteResult` |
| `src/shared/api.ts` | 修改 | `Api` 接口新增 5 个方法 |
| `src/preload/index.ts` | 修改 | 5 个 `ipcRenderer.invoke` 桥接 |
| `src/main/ipc.ts` | 修改 | 5 个 handler |
| `src/renderer/src/App.tsx` | 修改 | `Tab` 加 `'tools'`，按钮插在 redirects 与 device 之间 |
| `src/renderer/src/components/ToolsPanel.tsx` | 创建 | `.panel` 容器 + `.tab-row` 二级导航 |
| `src/renderer/src/components/TimestampTool.tsx` | 创建 | 时间戳 UI |
| `src/renderer/src/components/GzipTool.tsx` | 创建 | gzip UI（Task 7 文件模式，Task 9 加文本模式） |
| `src/renderer/src/components/WebpTool.tsx` | 创建 | WebP 批量转换 UI |
| `tests/datetime.test.ts` | 创建 | 时区换算单测 |
| `tests/gzip.test.ts` | 创建 | 主进程文件模式单测 |
| `tests/image-scan.test.ts` | 创建 | 扫描与命名单测 |
| `tests/format-bytes.test.ts` | 创建 | 字节格式化单测 |
| `e2e/tools.spec.ts` | 创建 | tab 顺序、时间戳、gzip、webp 真实产物 |
| `README.md` | 修改 | 「实用工具」小节 |

**任务顺序设计**：Task 1-4 是四个互不依赖的纯逻辑模块（可并行）；Task 5 集中接线全部 IPC 并用 e2e 一次性验证两个最大未知数（二进制过 contextBridge、canvas 能编 webp）；Task 6-8 做 UI；Task 9 是唯一有外部门禁的任务，放最后。

---

### Task 1: 时间戳纯逻辑 `datetime.ts`

**Files:**
- Create: `src/renderer/src/lib/datetime.ts`
- Test: `tests/datetime.test.ts`

- [x] **Step 1: 写失败的测试**

创建 `tests/datetime.test.ts`：

```ts
import { describe, expect, test } from 'vitest';
import {
  detectTimestampUnit,
  formatTimestamp,
  listTimeZones,
  parseZonedDateTime,
  toMillis,
} from '../src/renderer/src/lib/datetime';

/** 现实窗口：1900-2100，LMT 与 4 位年份边界都安全落在内部 */
const LO = Date.UTC(1900, 0, 1);
const HI = Date.UTC(2100, 11, 31, 23, 59, 59, 999);
const ZONES = [
  'UTC',
  'Asia/Shanghai',
  'America/New_York',
  'Europe/London',
  'Pacific/Kiritimati',
  'Pacific/Niue',
  'Asia/Kathmandu',
  'Australia/Lord_Howe',
  'Antarctica/Troll',
];
const VALUES = [0, 1, -1, 999, 1000, -1000, 1789000000123, LO, HI, Date.UTC(1969, 6, 20, 20, 17, 40)];

describe('detectTimestampUnit', () => {
  test('1e11 以下判为秒，以上判为毫秒', () => {
    expect(detectTimestampUnit(1789000000)).toBe('s');
    expect(detectTimestampUnit(1789000000123)).toBe('ms');
    expect(detectTimestampUnit(0)).toBe('s');
  });

  test('负值按绝对值判定', () => {
    expect(detectTimestampUnit(-1789000000)).toBe('s');
    expect(detectTimestampUnit(-1789000000123)).toBe('ms');
  });
});

describe('toMillis', () => {
  test('auto 走自动识别，显式单位强制换算', () => {
    expect(toMillis(1789000000, 'auto')).toBe(1789000000000);
    expect(toMillis(1789000000, 'ms')).toBe(1789000000);
    expect(toMillis(1789000000123, 's')).toBe(1789000000123000);
  });
});

describe('formatTimestamp', () => {
  test('已知答案：UTC / 上海 / 纽约', () => {
    const ms = 1789000000123;
    expect(formatTimestamp(ms, 'UTC')).toEqual({
      ok: true,
      value: expect.objectContaining({
        standard: '2026-09-10 00:26:40.123',
        iso: '2026-09-10T00:26:40.123+00:00',
        offsetSeconds: 0,
      }),
    });
    expect(formatTimestamp(ms, 'Asia/Shanghai')).toEqual({
      ok: true,
      value: expect.objectContaining({
        standard: '2026-09-10 08:26:40.123',
        iso: '2026-09-10T08:26:40.123+08:00',
        offsetMinutes: 480,
      }),
    });
    expect(formatTimestamp(ms, 'America/New_York')).toEqual({
      ok: true,
      value: expect.objectContaining({ iso: '2026-09-09T20:26:40.123-04:00', offsetMinutes: -240 }),
    });
  });

  test('拆分 parts 与 standard 自洽', () => {
    const r = formatTimestamp(1789000000123, 'UTC');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.parts).toEqual({
      year: 2026, month: 9, day: 10, hour: 0, minute: 26, second: 40, millis: 123,
    });
    expect(r.value.millis).toBe(123);
  });

  test('拒绝非有限值与超出 Date 范围', () => {
    expect(formatTimestamp(NaN, 'UTC').ok).toBe(false);
    expect(formatTimestamp(Infinity, 'UTC').ok).toBe(false);
    expect(formatTimestamp(9e15, 'UTC').ok).toBe(false);
  });

  test('4 位年份窗口外报错而非输出歧义年份', () => {
    // -8.64e15 是公元 271822 年 BC，格式化会丢掉纪元符号，必须拒绝
    const r = formatTimestamp(-8.64e15, 'UTC');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('1000-9999');
  });
});

describe('parseZonedDateTime', () => {
  test('支持 - 与 / 分隔、T 与空格分隔、秒与毫秒可省略', () => {
    const want = Date.UTC(2026, 8, 11, 14, 30, 5);
    expect(parseZonedDateTime('2026-09-11 14:30:05', 'UTC')).toEqual({ ok: true, ms: want });
    expect(parseZonedDateTime('2026/09/11 14:30:05', 'UTC')).toEqual({ ok: true, ms: want });
    expect(parseZonedDateTime('2026-09-11T14:30:05', 'UTC')).toEqual({ ok: true, ms: want });
    expect(parseZonedDateTime('2026-09-11 14:30', 'UTC')).toEqual({ ok: true, ms: Date.UTC(2026, 8, 11, 14, 30) });
  });

  test('毫秒不足 3 位按右侧补零', () => {
    expect(parseZonedDateTime('2026-09-11 14:30:05.1', 'UTC')).toEqual({
      ok: true, ms: Date.UTC(2026, 8, 11, 14, 30, 5, 100),
    });
    expect(parseZonedDateTime('2026-09-11 14:30:05.12', 'UTC')).toEqual({
      ok: true, ms: Date.UTC(2026, 8, 11, 14, 30, 5, 120),
    });
  });

  test('非法输入返回结构化错误而非抛异常', () => {
    for (const bad of ['nope', '', '   ', '2026-13-11 14:30:05', '2026-09-11 24:30:05', '275760-09-13 00:00:00']) {
      const r = parseZonedDateTime(bad, 'UTC');
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    }
  });
});

describe('往返一致', () => {
  test('9 个时区 × 10 个时间戳全部精确往返', () => {
    for (const zone of ZONES) {
      for (const ms of VALUES) {
        const f = formatTimestamp(ms, zone);
        expect(f.ok, `${zone} ${ms}`).toBe(true);
        if (!f.ok) continue;
        expect(parseZonedDateTime(f.value.standard, zone), `${zone} ${ms} ${f.value.standard}`).toEqual({ ok: true, ms });
      }
    }
  });

  test('全部 418+1 个时区在现代值与 1850 年 LMT 值上往返', () => {
    for (const zone of listTimeZones()) {
      for (const ms of [1789000000123, Date.UTC(1850, 5, 15, 12, 0, 0)]) {
        const f = formatTimestamp(ms, zone.id);
        if (!f.ok) continue;
        expect(parseZonedDateTime(f.value.standard, zone.id), `${zone.id} ${ms}`).toEqual({ ok: true, ms });
      }
    }
  });

  test('LMT 保留秒精度：上海 1850 年偏移为 +08:05:43', () => {
    const ms = Date.UTC(1850, 5, 15, 12, 0, 0);
    const r = formatTimestamp(ms, 'Asia/Shanghai');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 四舍五入到分钟会让往返差 17 秒，这条断言钉住秒精度
    expect(r.value.iso.endsWith('+08:05:43')).toBe(true);
    expect(r.value.offsetSeconds).toBe(29143);
    expect(parseZonedDateTime(r.value.standard, 'Asia/Shanghai')).toEqual({ ok: true, ms });
  });

  test('DST：纽约 2026 春进 03:30 为 EDT(-240)，01:30 为 EST(-300)', () => {
    const spring = parseZonedDateTime('2026-03-08 03:30:00', 'America/New_York');
    expect(spring.ok).toBe(true);
    if (spring.ok) {
      const f = formatTimestamp(spring.ms, 'America/New_York');
      expect(f.ok && f.value.offsetMinutes).toBe(-240);
    }
    const before = parseZonedDateTime('2026-03-08 01:30:00', 'America/New_York');
    expect(before.ok).toBe(true);
    if (before.ok) {
      const f = formatTimestamp(before.ms, 'America/New_York');
      expect(f.ok && f.value.offsetMinutes).toBe(-300);
    }
  });

  test('DST 回拨的歧义时刻可解析且不抛异常', () => {
    const r = parseZonedDateTime('2026-11-01 01:30:00', 'America/New_York');
    expect(r.ok).toBe(true);
  });
});

describe('listTimeZones', () => {
  test('显式并入 UTC（supportedValuesOf 不含任何 UTC/GMT 条目）', () => {
    const zones = listTimeZones();
    expect(zones.length).toBe(Intl.supportedValuesOf('timeZone').length + 1);
    expect(zones.some((z) => z.id === 'UTC')).toBe(true);
    expect(zones.filter((z) => z.id === 'UTC')).toHaveLength(1);
  });

  test('本地时区置顶、UTC 次之，其余按 id 排序', () => {
    const zones = listTimeZones();
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(zones[0]!.id).toBe(local);
    expect(zones[1]!.id).toBe('UTC');
    const rest = zones.slice(2).map((z) => z.id);
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b)));
  });

  test('每项带 UTC 偏移标签', () => {
    for (const z of listTimeZones()) {
      expect(z.offsetLabel, z.id).toMatch(/^UTC[+-]\d{2}:\d{2}(:\d{2})?$/);
    }
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/datetime.test.ts`
Expected: FAIL — `Cannot find module '../src/renderer/src/lib/datetime'`

- [x] **Step 3: 建实现文件**

创建 `src/renderer/src/lib/datetime.ts`。**此文件不得引用任何 DOM API**（会被 `tests/**` 间接拉进无 DOM lib 的 node typecheck）：

```ts
export type TimestampUnit = 's' | 'ms';
export type UnitChoice = TimestampUnit | 'auto';

export interface ZoneOption {
  id: string;
  /** 形如 `UTC+08:00`，LMT 时区可能是 `UTC+08:05:43` */
  offsetLabel: string;
}

export interface ZonedDateTime {
  /** `2026-09-10 08:26:40.123` */
  standard: string;
  /** `2026-09-10T08:26:40.123+08:00` */
  iso: string;
  offsetSeconds: number;
  offsetMinutes: number;
  millis: number;
  parts: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    millis: number;
  };
}

export type FormatResult = { ok: true; value: ZonedDateTime } | { ok: false; error: string };
export type ParseResult = { ok: true; ms: number } | { ok: false; error: string };

const MS_MAX = 8.64e15;
/** 当前秒级约 1.7e9、毫秒级约 1.7e12，1e11 阈值两侧余量都超过一个数量级 */
const UNIT_THRESHOLD = 1e11;
/** 只接受 4 位年份：更早/更晚的年份格式无纪元符号，往返会产生歧义 */
const ZONED_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/;

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function zoneParts(ms: number, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(ms))) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    // hour12:false 在部分 ICU 版本把午夜输出为 "24"
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

// 保留秒精度：1900 年前多数时区用 LMT（上海 1850 年为 +08:05:43），舍入到分钟会让往返差 17 秒
function zoneOffsetSeconds(ms: number, timeZone: string): number {
  const p = zoneParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 1000);
}

function offsetToIso(offSec: number): string {
  const sign = offSec < 0 ? '-' : '+';
  const a = Math.abs(offSec);
  const ss = a % 60;
  return `${sign}${pad(Math.floor(a / 3600))}:${pad(Math.floor((a % 3600) / 60))}${ss === 0 ? '' : `:${pad(ss)}`}`;
}

export function detectTimestampUnit(value: number): TimestampUnit {
  return Math.abs(value) < UNIT_THRESHOLD ? 's' : 'ms';
}

export function toMillis(value: number, unit: UnitChoice): number {
  const u = unit === 'auto' ? detectTimestampUnit(value) : unit;
  return u === 's' ? value * 1000 : value;
}

export function formatTimestamp(ms: number, timeZone: string): FormatResult {
  if (!Number.isFinite(ms) || Math.abs(ms) > MS_MAX) {
    return { ok: false, error: `时间戳超出有效范围 ±${MS_MAX} 毫秒` };
  }
  const p = zoneParts(ms, timeZone);
  if (p.year < 1000 || p.year > 9999) {
    return { ok: false, error: '标准时间格式仅支持公元 1000-9999 年' };
  }
  const millis = ((Math.floor(ms) % 1000) + 1000) % 1000;
  const date = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  const time = `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}.${pad(millis, 3)}`;
  const offsetSeconds = zoneOffsetSeconds(ms, timeZone);
  return {
    ok: true,
    value: {
      standard: `${date} ${time}`,
      iso: `${date}T${time}${offsetToIso(offsetSeconds)}`,
      offsetSeconds,
      offsetMinutes: Math.round(offsetSeconds / 60),
      millis,
      parts: { ...p, millis },
    },
  };
}

export function parseZonedDateTime(text: string, timeZone: string): ParseResult {
  const m = text.trim().match(ZONED_RE);
  if (!m) return { ok: false, error: '无法解析，需形如 2026-09-11 14:30:05.123' };
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23) {
    return { ok: false, error: '月/日/时取值不合法' };
  }
  // 可选捕获组未参与匹配时是 undefined 而非空串，必须兜底
  const millis = Number((m[7] || '0').padEnd(3, '0'));
  const guess = Date.UTC(Number(m[1]), month - 1, day, hour, Number(m[5]), Number(m[6] || '0'), millis);
  if (Number.isNaN(guess)) return { ok: false, error: '日期不存在' };
  // 两遍收敛：第一遍拿粗略偏移，第二遍用修正后的时刻重算，覆盖 DST 切换点
  const first = guess - zoneOffsetSeconds(guess, timeZone) * 1000;
  return { ok: true, ms: guess - zoneOffsetSeconds(first, timeZone) * 1000 };
}

export function listTimeZones(): ZoneOption[] {
  const now = Date.now();
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // supportedValuesOf 只返回地理时区，不含 UTC/GMT 任何条目，必须显式补上
  const ids = new Set<string>([local, 'UTC', ...Intl.supportedValuesOf('timeZone')]);
  const rank = (id: string): number => (id === local ? 0 : id === 'UTC' ? 1 : 2);
  return [...ids]
    .map((id) => ({ id, offsetLabel: `UTC${offsetToIso(zoneOffsetSeconds(now, id))}` }))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/datetime.test.ts`
Expected: PASS，全部 test 通过（`listTimeZones` 那条断言 419 项）

- [x] **Step 5: 跑 typecheck 确认 datetime.ts 在无 DOM lib 下也干净**

Run: `npm run typecheck`
Expected: 两个 tsconfig 均无报错。若报 `OffscreenCanvas` / `Blob` 之类找不到，说明误加了 DOM API

- [x] **Step 6: 提交**

```bash
git status --short
git add src/renderer/src/lib/datetime.ts tests/datetime.test.ts
git commit -m "feat(tools): timezone-aware timestamp conversion logic

秒/毫秒自动识别、IANA 时区格式化与反向解析，两遍 offset 收敛覆盖 DST。
偏移保留秒精度，否则 1900 年前的 LMT 时区往返会差十几秒。
supportedValuesOf 不含任何 UTC 条目，显式并入。"
```

---

### Task 2: tab 接线 + ToolsPanel + 时间戳 UI

**Files:**
- Create: `src/renderer/src/components/ToolsPanel.tsx`
- Create: `src/renderer/src/components/TimestampTool.tsx`
- Modify: `src/renderer/src/App.tsx:11,28,35`
- Test: `e2e/tools.spec.ts`（创建，本 Task 只写 tab 顺序与时间戳两块）

- [x] **Step 1: 写失败的 e2e**

创建 `e2e/tools.spec.ts`：

```ts
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { test, expect } from '@playwright/test';

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'] });
  win = await app.firstWindow();
});

test.afterAll(async () => {
  await app.close();
});

test('实用工具 tab 位于设备接入左侧', async () => {
  await win.waitForSelector('[data-testid="tools-tab"]');
  const order = await win.$$eval('.tabs button', (btns) => btns.map((b) => b.getAttribute('data-testid')));
  expect(order).toEqual([
    'traffic-tab',
    'rules-tab',
    'redirects-tab',
    'tools-tab',
    'device-tab',
    'settings-tab',
  ]);
});

test('时间戳正向转换（指定时区）', async () => {
  await win.getByTestId('tools-tab').click();
  await win.getByTestId('tool-tab-timestamp').click();

  await win.getByTestId('ts-zone').selectOption('UTC');
  await win.getByTestId('ts-unit').selectOption('ms');
  await win.getByTestId('ts-input').fill('1789000000123');

  await expect(win.getByTestId('ts-standard')).toHaveText('2026-09-10 00:26:40.123');
  await expect(win.getByTestId('ts-iso')).toHaveText('2026-09-10T00:26:40.123+00:00');

  await win.getByTestId('ts-zone').selectOption('Asia/Shanghai');
  await expect(win.getByTestId('ts-standard')).toHaveText('2026-09-10 08:26:40.123');
  await expect(win.getByTestId('ts-offset')).toHaveText('UTC+08:00');
});

test('时间戳自动识别秒与毫秒', async () => {
  await win.getByTestId('ts-zone').selectOption('UTC');
  await win.getByTestId('ts-unit').selectOption('auto');

  await win.getByTestId('ts-input').fill('1789000000');
  await expect(win.getByTestId('ts-detected')).toHaveText('识别为：秒');
  await expect(win.getByTestId('ts-standard')).toHaveText('2026-09-10 00:26:40.000');

  await win.getByTestId('ts-input').fill('1789000000123');
  await expect(win.getByTestId('ts-detected')).toHaveText('识别为：毫秒');
  await expect(win.getByTestId('ts-standard')).toHaveText('2026-09-10 00:26:40.123');
});

test('时间戳反向解析回到同一毫秒值', async () => {
  await win.getByTestId('ts-zone').selectOption('Asia/Shanghai');
  await win.getByTestId('dt-input').fill('2026-09-10 08:26:40.123');

  await expect(win.getByTestId('dt-ms')).toHaveText('1789000000123');
  await expect(win.getByTestId('dt-s')).toHaveText('1789000000');
});

test('非法输入行内报错且不崩', async () => {
  await win.getByTestId('ts-input').fill('abc');
  await expect(win.getByTestId('ts-error')).toContainText('请输入数字时间戳');

  await win.getByTestId('dt-input').fill('not a date');
  await expect(win.getByTestId('dt-error')).toContainText('无法解析');
});
```

- [x] **Step 2: 跑 e2e 确认失败**

Run: `npx playwright test e2e/tools.spec.ts`
Expected: FAIL — `waitForSelector('[data-testid="tools-tab"]')` 超时（tab 尚不存在）

- [x] **Step 3: 改 App.tsx 接线 tab**

`src/renderer/src/App.tsx` 三处改动。第 11 行：

```tsx
type Tab = 'traffic' | 'rules' | 'redirects' | 'tools' | 'device' | 'settings';
```

第 7 行后加 import（与现有 import 同段）：

```tsx
import ToolsPanel from './components/ToolsPanel';
```

第 27 行（`redirects-tab` 按钮）之后、`device-tab` 之前插入：

```tsx
        <button data-testid="tools-tab" className={tab === 'tools' ? 'active' : ''} onClick={() => setTab('tools')}>实用工具</button>
```

第 34 行（`redirects` 渲染）之后插入：

```tsx
        {tab === 'tools' && <ToolsPanel />}
```

- [x] **Step 4: 建 ToolsPanel.tsx**

创建 `src/renderer/src/components/ToolsPanel.tsx`。本 Task 只挂时间戳一项，gzip 与 webp 分别在 Task 7 / Task 8 追加（避免造占位组件）：

```tsx
import { useState } from 'react';
import TimestampTool from './TimestampTool';

type ToolKey = 'timestamp';

const TOOLS: { key: ToolKey; label: string }[] = [{ key: 'timestamp', label: '时间戳' }];

export default function ToolsPanel() {
  const [tool, setTool] = useState<ToolKey>('timestamp');
  return (
    <div className="panel" data-testid="tools-panel">
      <h2>实用工具</h2>
      <div className="tab-row">
        {TOOLS.map((t) => (
          <button
            key={t.key}
            data-testid={`tool-tab-${t.key}`}
            className={tool === t.key ? 'active' : ''}
            onClick={() => setTool(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tool === 'timestamp' && <TimestampTool />}
    </div>
  );
}
```

- [x] **Step 5: 建 TimestampTool.tsx**

创建 `src/renderer/src/components/TimestampTool.tsx`。两个方向各自独立受控，改一边同步另一边（单向写入，不成环）：

```tsx
import { useMemo, useState } from 'react';
import {
  detectTimestampUnit,
  formatTimestamp,
  listTimeZones,
  parseZonedDateTime,
  toMillis,
  type UnitChoice,
} from '../lib/datetime';

function offsetLabel(offsetSeconds: number): string {
  const sign = offsetSeconds < 0 ? '-' : '+';
  const a = Math.abs(offsetSeconds);
  const pad = (n: number) => String(n).padStart(2, '0');
  const ss = a % 60;
  return `UTC${sign}${pad(Math.floor(a / 3600))}:${pad(Math.floor((a % 3600) / 60))}${ss === 0 ? '' : `:${pad(ss)}`}`;
}

export default function TimestampTool() {
  const zones = useMemo(() => listTimeZones(), []);
  const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [unit, setUnit] = useState<UnitChoice>('auto');
  const [tsInput, setTsInput] = useState(() => String(Date.now()));
  const [dtInput, setDtInput] = useState('');
  const [zoneQuery, setZoneQuery] = useState('');

  const tsResult = useMemo(() => {
    const raw = tsInput.trim();
    if (raw === '') return { ok: false as const, error: '请输入数字时间戳' };
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false as const, error: '请输入数字时间戳' };
    return formatTimestamp(toMillis(n, unit), timeZone);
  }, [tsInput, unit, timeZone]);

  const dtResult = useMemo(() => {
    if (dtInput.trim() === '') return null;
    return parseZonedDateTime(dtInput, timeZone);
  }, [dtInput, timeZone]);

  const detected = useMemo(() => {
    const n = Number(tsInput.trim());
    if (tsInput.trim() === '' || !Number.isFinite(n)) return '';
    return unit === 'auto' ? `识别为：${detectTimestampUnit(n) === 's' ? '秒' : '毫秒'}` : '';
  }, [tsInput, unit]);

  const filteredZones = useMemo(() => {
    const q = zoneQuery.trim().toLowerCase();
    if (q === '') return zones;
    return zones.filter((z) => z.id.toLowerCase().includes(q) || z.offsetLabel.toLowerCase().includes(q));
  }, [zones, zoneQuery]);

  // 改时间戳 → 同步标准时间；改标准时间 → 同步时间戳。各自单向，不会互相触发成环
  const onTsChange = (v: string) => {
    setTsInput(v);
    const raw = v.trim();
    const n = Number(raw);
    if (raw !== '' && Number.isFinite(n)) {
      const r = formatTimestamp(toMillis(n, unit), timeZone);
      if (r.ok) setDtInput(r.value.standard);
    }
  };

  const onDtChange = (v: string) => {
    setDtInput(v);
    if (v.trim() !== '') {
      const r = parseZonedDateTime(v, timeZone);
      if (r.ok) setTsInput(String(r.ms));
    }
  };

  const onZoneChange = (z: string) => {
    setTimeZone(z);
    const n = Number(tsInput.trim());
    if (tsInput.trim() !== '' && Number.isFinite(n)) {
      const r = formatTimestamp(toMillis(n, unit), z);
      if (r.ok) setDtInput(r.value.standard);
    }
  };

  const now = () => onTsChange(String(Date.now()));

  return (
    <div className="form-grid" style={{ maxWidth: 720 }}>
      <label htmlFor="ts-input">时间戳</label>
      <div className="form-row">
        <input
          id="ts-input"
          data-testid="ts-input"
          value={tsInput}
          onChange={(e) => onTsChange(e.target.value)}
          placeholder="1789000000123"
        />
        <select data-testid="ts-unit" value={unit} onChange={(e) => setUnit(e.target.value as UnitChoice)}>
          <option value="auto">自动</option>
          <option value="s">秒</option>
          <option value="ms">毫秒</option>
        </select>
        <button data-testid="ts-now" onClick={now}>现在</button>
      </div>

      <label htmlFor="ts-zone">时区</label>
      <div>
        <input
          data-testid="ts-zone-filter"
          value={zoneQuery}
          onChange={(e) => setZoneQuery(e.target.value)}
          placeholder="过滤时区（如 Shanghai 或 UTC+08）"
        />
        <select
          id="ts-zone"
          data-testid="ts-zone"
          value={timeZone}
          onChange={(e) => onZoneChange(e.target.value)}
          size={8}
          style={{ width: '100%', marginTop: 6 }}
        >
          {filteredZones.map((z) => (
            <option key={z.id} value={z.id}>
              {z.id}（{z.offsetLabel}）
            </option>
          ))}
        </select>
      </div>

      <label>标准时间</label>
      <div>
        {tsResult.ok ? (
          <>
            <div className="preview" data-testid="ts-standard">{tsResult.value.standard}</div>
            <div className="form-note">
              ISO 8601：<code data-testid="ts-iso">{tsResult.value.iso}</code>
              {' · '}偏移：<span data-testid="ts-offset">{offsetLabel(tsResult.value.offsetSeconds)}</span>
              {detected && <> · <span data-testid="ts-detected">{detected}</span></>}
            </div>
            <div className="form-note">
              {tsResult.value.parts.year} 年 {tsResult.value.parts.month} 月 {tsResult.value.parts.day} 日
              {' '}{tsResult.value.parts.hour} 时 {tsResult.value.parts.minute} 分
              {' '}{tsResult.value.parts.second} 秒 {tsResult.value.parts.millis} 毫秒
            </div>
          </>
        ) : (
          <div className="text-err" data-testid="ts-error">{tsResult.error}</div>
        )}
      </div>

      <label htmlFor="dt-input">反向：标准时间</label>
      <input
        id="dt-input"
        data-testid="dt-input"
        value={dtInput}
        onChange={(e) => onDtChange(e.target.value)}
        placeholder="2026-09-10 08:26:40.123"
      />

      <label>反向结果</label>
      <div>
        {dtResult === null && <span className="muted">输入标准时间后显示对应时间戳</span>}
        {dtResult && !dtResult.ok && <span className="text-err" data-testid="dt-error">{dtResult.error}</span>}
        {dtResult?.ok && (
          <div className="form-note">
            毫秒：<code data-testid="dt-ms">{dtResult.ms}</code>
            {' · '}秒：<code data-testid="dt-s">{Math.trunc(dtResult.ms / 1000)}</code>
          </div>
        )}
      </div>

      <label />
      <div className="form-note">
        支持公元 1000-9999 年；更早的年份格式无纪元符号，往返会歧义，故直接报错。
        1900 年前多数时区使用 LMT（地方平太阳时），偏移带秒精度，本工具如实显示。
      </div>
    </div>
  );
}
```

- [x] **Step 6: 跑 typecheck**

Run: `npm run typecheck`
Expected: 无报错

- [x] **Step 7: 跑 e2e 确认通过**

Run: `npm run test:e2e -- e2e/tools.spec.ts`
Expected: PASS，5 个 test 全绿

- [x] **Step 8: 跑全量单测确认无回归**

Run: `npm test`
Expected: PASS（含 Task 1 的 datetime 与既有全部测试）

- [x] **Step 9: 提交**

```bash
git status --short
git add src/renderer/src/App.tsx src/renderer/src/components/ToolsPanel.tsx src/renderer/src/components/TimestampTool.tsx e2e/tools.spec.ts
git commit -m "feat(ui): utility tools tab with timezone timestamp converter

新 tab 插在重定向与设备接入之间。ToolsPanel 用现有 .tab-row 做二级导航，
本提交只挂时间戳一项，gzip 与 webp 后续任务追加，不留占位组件。"
```

---

### Task 3: 图片扫描主进程模块 `image-scan.ts`

**Files:**
- Create: `src/main/tools/image-scan.ts`
- Test: `tests/image-scan.test.ts`

- [x] **Step 1: 写失败的测试**

创建 `tests/image-scan.test.ts`：

```ts
import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_SCAN_LIMIT, readImage, scanImages, writeWebp } from '../src/main/tools/image-scan';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mocker-scan-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const touch = async (rel: string, content = 'x') => {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
};

describe('scanImages', () => {
  test('空目录返回空数组', async () => {
    expect(await scanImages(root)).toEqual([]);
  });

  test('递归收集 png/jpg/jpeg，忽略其它扩展名', async () => {
    await touch('a.png');
    await touch('sub/b.jpg');
    await touch('sub/deep/c.jpeg');
    await touch('skip.gif');
    await touch('skip.webp');
    await touch('notes.txt');

    const r = await scanImages(root);
    expect(r.map((f) => f.relPath).sort()).toEqual(['a.png', 'sub/b.jpg', 'sub/deep/c.jpeg']);
  });

  test('扩展名大小写不敏感', async () => {
    await touch('A.PNG');
    await touch('B.JpG');
    const r = await scanImages(root);
    expect(r.map((f) => f.relPath).sort()).toEqual(['A.PNG', 'B.JpG']);
    expect(r.map((f) => f.ext).sort()).toEqual(['.jpg', '.png']);
  });

  test('relPath 用 POSIX 分隔符，size 为真实字节数', async () => {
    await touch('sub/dir/pic.png', 'hello');
    const r = await scanImages(root);
    expect(r).toEqual([{ relPath: 'sub/dir/pic.png', ext: '.png', size: 5, outName: 'sub/dir/pic.webp' }]);
  });

  test('outName 把原扩展名替换为 .webp', async () => {
    await touch('a/b.jpeg');
    const r = await scanImages(root);
    expect(r[0]!.outName).toBe('a/b.webp');
  });

  test('同目录 b.png 与 b.jpg 撞名时两个都保留原扩展名', async () => {
    await touch('d/b.png');
    await touch('d/b.jpg');
    const r = await scanImages(root);
    expect(r.map((f) => f.outName).sort()).toEqual(['d/b.jpg.webp', 'd/b.png.webp']);
  });

  test('不撞名时不受其它目录同名文件影响', async () => {
    await touch('x/b.png');
    await touch('y/b.jpg');
    const r = await scanImages(root);
    expect(r.map((f) => f.outName).sort()).toEqual(['x/b.webp', 'y/b.webp']);
  });

  test('超过 limit 抛可操作的错误', async () => {
    for (let i = 0; i < 5; i++) await touch(`p${i}.png`);
    await expect(scanImages(root, 4)).rejects.toThrow(/超过 4 张/);
    expect((await scanImages(root, 5)).length).toBe(5);
  });

  test('limit 默认为 5000', () => {
    expect(DEFAULT_SCAN_LIMIT).toBe(5000);
  });
});

describe('readImage', () => {
  test('读到真实字节', async () => {
    await touch('a.png', 'PNGDATA');
    const bytes = await readImage(root, 'a.png');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(bytes).toString('utf8')).toBe('PNGDATA');
  });

  test('拒绝越出源目录的 relPath', async () => {
    await touch('a.png');
    await expect(readImage(root, '../secret.png')).rejects.toThrow(/越界/);
    await expect(readImage(root, '/etc/passwd')).rejects.toThrow(/越界/);
  });
});

describe('writeWebp', () => {
  test('自动建父目录并镜像结构', async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'mocker-out-'));
    try {
      const p = await writeWebp(out, 'sub/dir/a.webp', new Uint8Array([1, 2, 3]));
      expect(p).toBe(path.join(out, 'sub/dir/a.webp'));
      expect(Buffer.from(await fs.readFile(p))).toEqual(Buffer.from([1, 2, 3]));
    } finally {
      await fs.rm(out, { recursive: true, force: true });
    }
  });

  test('拒绝越出输出目录的 outName', async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'mocker-out-'));
    try {
      await expect(writeWebp(out, '../evil.webp', new Uint8Array([1]))).rejects.toThrow(/越界/);
    } finally {
      await fs.rm(out, { recursive: true, force: true });
    }
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/image-scan.test.ts`
Expected: FAIL — `Cannot find module '../src/main/tools/image-scan'`

- [x] **Step 3: 建实现文件**

创建 `src/main/tools/image-scan.ts`：

```ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ScannedImage } from '../../shared/types';

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg'] as const;
export const DEFAULT_SCAN_LIMIT = 5000;

/** 把 relPath 的原扩展名换成 .webp；a/b.png -> a/b.webp */
function webpName(relPath: string): string {
  return relPath.replace(/\.[^.]+$/, '.webp');
}

/** dir 与 relPath 都来自渲染进程 IPC，resolve 后必须仍落在 dir 内 */
function resolveInside(dir: string, rel: string): string {
  const root = path.resolve(dir);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('路径越界，拒绝访问源目录之外的文件');
  }
  return abs;
}

export async function scanImages(dir: string, limit = DEFAULT_SCAN_LIMIT): Promise<ScannedImage[]> {
  const found: { relPath: string; ext: string; size: number }[] = [];

  const walk = async (abs: string, rel: string): Promise<void> => {
    let entries: Awaited<ReturnType<typeof fs.readdir>>;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return; // 无权限或已消失的子目录直接跳过，不让整批失败
    }
    for (const e of entries) {
      // 超限即停：否则防卡死的 limit 起不到作用（用户误选家目录时仍会走完整棵树）
      if (found.length > limit) return;
      const relChild = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        await walk(path.join(abs, e.name), relChild);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!(IMAGE_EXTENSIONS as readonly string[]).includes(ext)) continue;
      const st = await fs.stat(path.join(abs, e.name));
      found.push({ relPath: relChild, ext, size: st.size });
    }
  };

  await walk(path.resolve(dir), '');
  if (found.length > limit) {
    throw new Error(`匹配图片超过 ${limit} 张，请选择更小的子目录`);
  }

  // 同目录下 a.png 与 a.jpg 都会映射到 a.webp，撞名的一组全部保留原扩展名，避免静默互相覆盖
  const counts = new Map<string, number>();
  for (const f of found) {
    const n = webpName(f.relPath);
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  return found.map((f) => ({
    ...f,
    outName: counts.get(webpName(f.relPath))! > 1 ? `${f.relPath}.webp` : webpName(f.relPath),
  }));
}

export async function readImage(dir: string, relPath: string): Promise<Uint8Array> {
  return new Uint8Array(await fs.readFile(resolveInside(dir, relPath)));
}

export async function writeWebp(outDir: string, outName: string, bytes: Uint8Array): Promise<string> {
  const abs = resolveInside(outDir, outName);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, bytes);
  return abs;
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/image-scan.test.ts`
Expected: PASS

注意：`ScannedImage` 类型此时还不存在（Task 5 才加进 `shared/types.ts`），typecheck 会报错。本 Step 只跑 vitest（不做类型检查）即可通过；若要让 typecheck 也过，把 Task 5 Step 3 里 `ScannedImage` 的定义提前到本文件顶部临时声明，Task 5 时删除。**推荐做法：本 Task 直接顺手把 `ScannedImage` 加进 `src/shared/types.ts`**，Task 5 只加其余类型：

在 `src/shared/types.ts` 末尾追加：

```ts
export interface ScannedImage {
  /** POSIX 风格相对路径，如 `sub/a.png` */
  relPath: string;
  /** 小写扩展名含点，如 `.png` */
  ext: string;
  size: number;
  /** 相对输出目录的写入名，如 `sub/a.webp`；同目录撞名时为 `sub/a.png.webp` */
  outName: string;
}
```

- [x] **Step 5: 跑 typecheck**

Run: `npm run typecheck`
Expected: 无报错

- [x] **Step 6: 提交**

```bash
git status --short
git add src/main/tools/image-scan.ts src/shared/types.ts tests/image-scan.test.ts
git commit -m "feat(main): recursive image scan with webp output naming

扫描 png/jpg 并算好镜像输出名，同目录 a.png 与 a.jpg 撞名时保留原扩展名，
避免静默互相覆盖。超过 limit 提前停止遍历，否则防卡死不生效。
dir 与 relPath 来自渲染进程 IPC，读写前都校验落在目录内。"
```

---

### Task 4: gzip 文件模式主进程模块

**Files:**
- Create: `src/main/tools/gzip.ts`
- Create: `src/renderer/src/lib/format-bytes.ts`
- Test: `tests/gzip.test.ts`
- Test: `tests/format-bytes.test.ts`

- [x] **Step 1: 写失败的测试**

创建 `tests/gzip.test.ts`：

```ts
import { describe, expect, test } from 'vitest';
import * as zlib from 'node:zlib';
import { gzipCompressBytes, gzipDecompressBytes, MAX_GUNZIP_BYTES } from '../src/main/tools/gzip';

describe('gzipCompressBytes', () => {
  test('产物带 gzip 魔数', async () => {
    const out = await gzipCompressBytes(new TextEncoder().encode('hello'));
    expect(out[0]).toBe(0x1f);
    expect(out[1]).toBe(0x8b);
  });

  test('高压缩比数据确实变小', async () => {
    const raw = Buffer.alloc(2_000_000, 0x61);
    const out = await gzipCompressBytes(raw);
    expect(out.length).toBeLessThan(10_000);
  });
});

describe('往返', () => {
  test('文本往返一致', async () => {
    const text = 'hello 世界 {"a":1}';
    const raw = new TextEncoder().encode(text);
    const back = await gzipDecompressBytes(await gzipCompressBytes(raw));
    expect(new TextDecoder().decode(back)).toBe(text);
  });

  test('二进制字节精确往返（含 gzip 魔数字节本身）', async () => {
    const raw = Uint8Array.from([0, 1, 128, 254, 255, 0x1f, 0x8b]);
    const back = await gzipDecompressBytes(await gzipCompressBytes(raw));
    expect(Buffer.from(back)).toEqual(Buffer.from(raw));
  });

  test('空输入往返得到空输出', async () => {
    const back = await gzipDecompressBytes(await gzipCompressBytes(new Uint8Array(0)));
    expect(back.length).toBe(0);
  });
});

describe('解压校验', () => {
  test('缺少魔数时报明确文案而非 zlib 原始错误', async () => {
    await expect(gzipDecompressBytes(new TextEncoder().encode('plain text'))).rejects.toThrow(/不是有效的 gzip 数据/);
  });

  test('空输入报魔数错误', async () => {
    await expect(gzipDecompressBytes(new Uint8Array(0))).rejects.toThrow(/不是有效的 gzip 数据/);
  });

  test('只有魔数的截断数据报不完整', async () => {
    await expect(gzipDecompressBytes(Uint8Array.from([0x1f, 0x8b, 0x08, 0x00]))).rejects.toThrow(/不完整/);
  });

  test('魔数正确但内容损坏报数据损坏', async () => {
    const gz = await gzipCompressBytes(new TextEncoder().encode('hello world'));
    gz[20] = gz[20]! ^ 0xff;
    await expect(gzipDecompressBytes(gz)).rejects.toThrow(/损坏|不完整/);
  });

  test('解压炸弹被上限拦截', async () => {
    // 2MB 重复字节 gzip 后不到 2KB，是典型炸弹形状
    const bomb = await gzipCompressBytes(Buffer.alloc(2_000_000, 0x61));
    expect(bomb.length).toBeLessThan(10_000);
    await expect(gzipDecompressBytes(bomb, 1_000_000)).rejects.toThrow(/上限|炸弹/);
  });

  test('上限内正常解压', async () => {
    const bomb = await gzipCompressBytes(Buffer.alloc(2_000_000, 0x61));
    expect((await gzipDecompressBytes(bomb, 5_000_000)).length).toBe(2_000_000);
  });

  test('默认上限为 256MB', () => {
    expect(MAX_GUNZIP_BYTES).toBe(256 * 1024 * 1024);
  });

  test('产物可被 Node zlib 直接解开（格式兼容）', async () => {
    const out = await gzipCompressBytes(new TextEncoder().encode('compat'));
    expect(zlib.gunzipSync(out).toString('utf8')).toBe('compat');
  });
});
```

创建 `tests/format-bytes.test.ts`：

```ts
import { describe, expect, test } from 'vitest';
import { formatBytes, formatRatio } from '../src/renderer/src/lib/format-bytes';

describe('formatBytes', () => {
  test('分档显示', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
    expect(formatBytes(3.5 * 1024 * 1024)).toBe('3.50 MB');
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.00 GB');
  });

  test('千位分隔用于 B 档', () => {
    expect(formatBytes(12345)).toBe('12.1 KB');
  });
});

describe('formatRatio', () => {
  test('百分比保留一位小数', () => {
    expect(formatRatio(2310, 12345)).toBe('18.7%');
    expect(formatRatio(100, 100)).toBe('100.0%');
  });

  test('原体积为 0 时返回占位而非 NaN/Infinity', () => {
    expect(formatRatio(0, 0)).toBe('—');
    expect(formatRatio(10, 0)).toBe('—');
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/gzip.test.ts tests/format-bytes.test.ts`
Expected: FAIL — 两个模块都找不到

- [x] **Step 3: 建实现文件**

创建 `src/main/tools/gzip.ts`：

```ts
import * as zlib from 'node:zlib';
import { promisify } from 'node:util';

// 主进程跑着 mockttp 代理，同步解压大文件会冻住抓包，必须用异步版
const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);

export const MAX_GUNZIP_BYTES = 256 * 1024 * 1024;

export async function gzipCompressBytes(buf: Uint8Array, level = 9): Promise<Buffer> {
  return Buffer.from(await gzipAsync(Buffer.from(buf), { level }));
}

export async function gzipDecompressBytes(buf: Uint8Array, maxOutputBytes = MAX_GUNZIP_BYTES): Promise<Buffer> {
  // 魔数前置校验：zlib 只会给 "incorrect header check"，不如直说
  if (buf.length < 2 || buf[0] !== 0x1f || buf[1] !== 0x8b) {
    throw new Error('不是有效的 gzip 数据（缺少 1f 8b 魔数）');
  }
  try {
    // maxOutputLength 由 zlib 原生强制，超限抛 ERR_BUFFER_TOO_LARGE，无需手写流式解压
    return Buffer.from(await gunzipAsync(Buffer.from(buf), { maxOutputLength: maxOutputBytes }));
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error(
        `解压结果超过 ${Math.round(maxOutputBytes / 1024 / 1024)} MB 上限，已中止（疑似解压炸弹）`,
      );
    }
    if (e.code === 'Z_DATA_ERROR') throw new Error('gzip 数据损坏或不是 gzip 格式');
    if (e.code === 'Z_BUF_ERROR') throw new Error('gzip 数据不完整（被截断）');
    throw err;
  }
}
```

创建 `src/renderer/src/lib/format-bytes.ts`（无 DOM API，可被 `tests/**` 安全 import）：

```ts
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** out/in 占比；in 为 0 时无意义，返回占位而非 NaN */
export function formatRatio(out: number, input: number): string {
  if (!Number.isFinite(input) || input <= 0) return '—';
  return `${((out / input) * 100).toFixed(1)}%`;
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/gzip.test.ts tests/format-bytes.test.ts`
Expected: PASS

若 `formatBytes(12345)` 断言失败，核对：12345/1024 = 12.055 → `12.1 KB`。

- [x] **Step 5: 跑 typecheck**

Run: `npm run typecheck`
Expected: 无报错

- [x] **Step 6: 提交**

```bash
git status --short
git add src/main/tools/gzip.ts src/renderer/src/lib/format-bytes.ts tests/gzip.test.ts tests/format-bytes.test.ts
git commit -m "feat(main): async gzip with magic check and decompression cap

用 promisify(zlib) 而非同步版：主进程跑着 mockttp 代理，同步解压大文件
会冻住抓包。上限交给 zlib 原生 maxOutputLength 强制，无需手写流式解压。
魔数前置校验给出比 'incorrect header check' 更有用的文案。"
```

---

### Task 5: 类型 + API + preload + IPC 接线 + 能力验证 e2e

这是**风险闸门**：一次性接完 5 个 channel，并用 e2e 实测两个未验证过的能力——二进制经 contextBridge 往返、Chromium canvas 能编出合法 WebP。两者任一失败都在这里暴露，而不是等到 UI 写完。

**Files:**
- Modify: `src/shared/types.ts`（追加 `GzipMode` / `GzipFileResult` / `WebpWriteResult`）
- Modify: `src/shared/api.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/ipc.ts`
- Test: `e2e/tools.spec.ts`（追加）

- [x] **Step 1: 写失败的 e2e（能力验证）**

在 `e2e/tools.spec.ts` 末尾追加。文件顶部 import 改为：

```ts
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { test, expect } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
```

追加内容：

```ts
/** 用渲染进程 canvas 造一张真实 PNG，避免在测试里手写 PNG 编码器 */
async function makePng(win: Page, abs: string, px = 8, color = '#ff0000'): Promise<void> {
  const base64 = await win.evaluate(
    async ([size, fill]) => {
      const c = new OffscreenCanvas(size, size);
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, size, size);
      const buf = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode(...buf.subarray(i, i + 8192));
      return btoa(bin);
    },
    [px, color] as [number, string],
  );
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, Buffer.from(base64, 'base64'));
}

test('能力验证：二进制经 contextBridge 往返无损', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mocker-bin-'));
  try {
    // 含 0x00 与 0xff 的字节，任何编码降级都会在这里露馅
    const payload = Uint8Array.from(Array.from({ length: 300 }, (_, i) => (i * 7 + 13) % 256));
    await fs.writeFile(path.join(dir, 'a.png'), payload);

    const scanned = await win.evaluate(async (d) => window.api.scanImages(d), dir);
    expect(scanned).toEqual([{ relPath: 'a.png', ext: '.png', size: 300, outName: 'a.webp' }]);

    const read = await win.evaluate(
      async ([d, rel]) => {
        const b = await window.api.readImage(d, rel);
        // 在渲染进程内就地校验，证明主进程 -> 渲染进程方向无损
        return { ctor: b.constructor.name, len: b.length, head: Array.from(b.slice(0, 8)), sum: b.reduce((a, x) => a + x, 0) };
      },
      [dir, 'a.png'] as [string, string],
    );
    expect(read.len).toBe(300);
    expect(read.sum).toBe(payload.reduce((a, x) => a + x, 0));

    const written = await win.evaluate(
      async ([d, name, bytes]) => window.api.writeWebp(d, name, bytes),
      [dir, 'out/round.webp', Array.from(payload)] as [string, string, number[]],
    );
    expect(written.bytes).toBe(300);
    expect(Buffer.from(await fs.readFile(path.join(dir, 'out/round.webp')))).toEqual(Buffer.from(payload));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('能力验证：Chromium canvas 能编出合法 WebP', async () => {
  const webp = await win.evaluate(async () => {
    const c = new OffscreenCanvas(16, 16);
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#3b6ef6';
    ctx.fillRect(0, 0, 16, 16);
    const blob = await c.convertToBlob({ type: 'image/webp', quality: 0.8 });
    const buf = new Uint8Array(await blob.arrayBuffer());
    const ascii = (from: number, to: number) =>
      Array.from(buf.slice(from, to)).map((n) => String.fromCharCode(n)).join('');
    return { type: blob.type, size: buf.length, riff: ascii(0, 4), webp: ascii(8, 12) };
  });
  expect(webp.type).toBe('image/webp');
  expect(webp.riff).toBe('RIFF');
  expect(webp.webp).toBe('WEBP');
  expect(webp.size).toBeGreaterThan(20);
});

test('能力验证：gzip 文件模式经 IPC 往返', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mocker-gz-'));
  try {
    const src = path.join(dir, 'payload.txt');
    const text = 'hello mocker 世界 '.repeat(500);
    await fs.writeFile(src, text, 'utf8');

    const r = await win.evaluate(
      async ([mode, p]) => window.api.gzipFile(mode, p),
      ['compress', src] as [string, string],
    );
    // 保存对话框在无人值守 e2e 里会被取消，只断言不抛错与入参体积正确
    expect(r.inputBytes).toBe(Buffer.byteLength(text, 'utf8'));
    expect(typeof r.saved).toBe('boolean');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('openDirectoryDialog 取消时返回 null 而非抛错', async () => {
  expect(await win.evaluate(async () => window.api.openDirectoryDialog())).toBeNull();
});
```

- [x] **Step 2: 跑 e2e 确认失败**

Run: `npx playwright test e2e/tools.spec.ts`
Expected: FAIL — `window.api.scanImages is not a function`（原有 5 个 test 仍应 PASS）

- [x] **Step 3: 追加 shared 类型**

在 `src/shared/types.ts` 末尾追加（`ScannedImage` 已在 Task 3 加过，不要重复）：

```ts
export type GzipMode = 'compress' | 'decompress';

export interface GzipFileResult {
  /** 用户在保存对话框点了取消则为 false，此时无 filePath */
  saved: boolean;
  filePath?: string;
  inputBytes: number;
  outputBytes: number;
}

export interface WebpWriteResult {
  path: string;
  bytes: number;
}
```

- [x] **Step 4: 扩展 Api 接口**

`src/shared/api.ts`：第 1 行 import 追加类型：

```ts
import type { AdbOpResult, AdbStatus, CertInfo, CertInstallCommands, GzipFileResult, GzipMode, MapLocalSaveInput, MockRule, MonitorMode, ProxyStatus, RedirectRule, RenderContext, ReplayRequest, RuleAction, RuleInput, RulePatch, Scenario, ScannedImage, Settings, TrafficEvent, WebpWriteResult } from './types';
```

在 `openFileDialog()` 之后（第 41 行附近）插入：

```ts
  openDirectoryDialog(): Promise<string | null>;
  gzipFile(mode: GzipMode, inputPath: string): Promise<GzipFileResult>;
  scanImages(dir: string): Promise<ScannedImage[]>;
  readImage(dir: string, relPath: string): Promise<Uint8Array>;
  writeWebp(outDir: string, outName: string, bytes: Uint8Array): Promise<WebpWriteResult>;
```

- [x] **Step 5: 加 preload 桥接**

`src/preload/index.ts`：第 3 行 import 追加 `GzipMode`：

```ts
import type { AdbOpResult, AdbStatus, GzipMode, MonitorMode, RedirectRule, RenderContext, ReplayRequest, RuleAction, RuleInput, RulePatch, Settings, TrafficEvent, MapLocalSaveInput } from '../shared/types';
```

在 `openFileDialog` 那行（第 41 行）之后插入：

```ts
  openDirectoryDialog: () => ipcRenderer.invoke('dialog:open-directory'),
  gzipFile: (mode: GzipMode, inputPath: string) => ipcRenderer.invoke('tools:gzip-file', mode, inputPath),
  scanImages: (dir: string) => ipcRenderer.invoke('tools:scan-images', dir),
  readImage: (dir: string, relPath: string) => ipcRenderer.invoke('tools:read-image', dir, relPath),
  writeWebp: (outDir: string, outName: string, bytes: Uint8Array) =>
    ipcRenderer.invoke('tools:write-webp', outDir, outName, bytes),
```

- [x] **Step 6: 注册 main handler**

`src/main/ipc.ts`：顶部 import 区追加：

```ts
import * as path from 'node:path';
import { gzipCompressBytes, gzipDecompressBytes } from './tools/gzip';
import { readImage, scanImages, writeWebp } from './tools/image-scan';
import type { GzipMode } from '../shared/types';
```

在 `dialog:open-file` handler（第 194-200 行）之后插入：

```ts
  ipcMain.handle('dialog:open-directory', async () => {
    const { canceled, filePaths } = await showOpenDialog({ properties: ['openDirectory'] });
    if (canceled || filePaths.length === 0) return null;
    return filePaths[0]!;
  });

  ipcMain.handle('tools:gzip-file', async (_e, mode: GzipMode, inputPath: string) => {
    const input = await fs.promises.readFile(inputPath);
    const output = mode === 'compress' ? await gzipCompressBytes(input) : await gzipDecompressBytes(input);
    const base = path.basename(inputPath);
    const defaultPath =
      mode === 'compress'
        ? base.endsWith('.gz')
          ? base
          : `${base}.gz`
        : base.replace(/\.gz$/i, '') || `${base}.out`;
    const { canceled, filePath } = await showSaveDialog({
      defaultPath,
      filters: [{ name: mode === 'compress' ? 'Gzip' : 'All Files', extensions: mode === 'compress' ? ['gz'] : ['*'] }],
    });
    if (canceled || !filePath) {
      return { saved: false as const, inputBytes: input.length, outputBytes: output.length };
    }
    await fs.promises.writeFile(filePath, output);
    return { saved: true as const, filePath, inputBytes: input.length, outputBytes: output.length };
  });

  ipcMain.handle('tools:scan-images', (_e, dir: string) => scanImages(dir));
  ipcMain.handle('tools:read-image', (_e, dir: string, relPath: string) => readImage(dir, relPath));
  ipcMain.handle(
    'tools:write-webp',
    async (_e, outDir: string, outName: string, bytes: Uint8Array) => {
      const p = await writeWebp(outDir, outName, bytes);
      return { path: p, bytes: bytes.length };
    },
  );
```

- [x] **Step 7: 跑 typecheck**

Run: `npm run typecheck`
Expected: 无报错。若 `Api` 接口与 preload 实现不匹配会在此暴露

- [x] **Step 8: 跑 e2e 确认通过**

Run: `npm run test:e2e -- e2e/tools.spec.ts`
Expected: PASS，9 个 test 全绿

**若「二进制经 contextBridge 往返无损」失败**：这是 spec 里预设的回退触发点。把 `readImage` 与 `writeWebp` 的字节改为 base64 字符串传输——`shared/api.ts` 签名改成 `Promise<string>` / `bytes: string`，main 侧 `buf.toString('base64')` 与 `Buffer.from(b64, 'base64')`，渲染进程侧用 `Uint8Array.from(atob(s), (c) => c.charCodeAt(0))` 与 `btoa` 分块编码。代价是 +33% 体积，但确定可行。改完重跑本 Step 与 Step 7。

**若「Chromium canvas 能编出合法 WebP」失败**：说明该 Electron 构建未启用 WebP 编码，零依赖方案不成立。停止后续 Task，回到 spec 的「WebP 编码引擎」一节改选 `sharp`，并重新评估安装体积与镜像问题。

- [x] **Step 9: 跑全量单测与全量 e2e 确认无回归**

Run: `npm test && npm run test:e2e`
Expected: PASS。`ipc.ts` 改动涉及既有 handler 注册，务必跑全量 e2e

- [x] **Step 10: 提交**

```bash
git status --short
git add src/shared/types.ts src/shared/api.ts src/preload/index.ts src/main/ipc.ts e2e/tools.spec.ts
git commit -m "feat(main): wire 5 utility-tool IPC channels with binary e2e proof

新增 dialog:open-directory / tools:gzip-file / tools:scan-images /
tools:read-image / tools:write-webp。

e2e 实测两个此前未验证的能力：二进制经 contextBridge 往返无损、
Chromium canvas 能编出带 RIFF/WEBP 魔数的合法产物。PNG 夹具由渲染
进程 canvas 生成，避免在测试里手写 PNG 编码器。"
```

---

### Task 6: WebP 编码渲染进程模块

**Files:**
- Create: `src/renderer/src/lib/webp.ts`

**没有 vitest 单测，这是刻意的**：`webp.ts` 用了 `OffscreenCanvas` / `createImageBitmap` / `Blob`，而 `tests/**` 属 `tsconfig.node.json`（`types: ["node"]`，无 DOM lib）。一旦被 `tests/**` import，`npm run typecheck` 必挂。该模块只由 Task 8 的 e2e 覆盖。

- [x] **Step 1: 建实现文件**

创建 `src/renderer/src/lib/webp.ts`：

```ts
export interface WebpEncodeResult {
  bytes: Uint8Array;
  width: number;
  height: number;
}

/** Chromium WebP 编码器的边长上限，超出会直接失败 */
const MAX_DIMENSION = 16383;

function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  return null;
}

/**
 * quality 取值 0-1（canvas 约定）。调用方 UI 用 0-100 滑块，传入前自行除以 100。
 */
export async function encodeWebp(bytes: Uint8Array, quality: number): Promise<WebpEncodeResult> {
  const mime = sniffMime(bytes);
  if (!mime) throw new Error('不是 png 或 jpg 数据（魔数不匹配）');

  let bitmap: ImageBitmap;
  try {
    // new Uint8Array(bytes) 复制一份以满足 Blob 对 Uint8Array<ArrayBuffer> 的类型要求
    bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mime }));
  } catch {
    throw new Error('图片解码失败（可能是 CMYK JPEG、动图或文件损坏）');
  }

  try {
    if (bitmap.width > MAX_DIMENSION || bitmap.height > MAX_DIMENSION) {
      throw new Error(`图片尺寸 ${bitmap.width}x${bitmap.height} 超过 Chromium 编码上限 ${MAX_DIMENSION}px`);
    }
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建 OffscreenCanvas 2D 上下文');
    // 不填背景色：PNG 透明通道因此得以保留
    ctx.drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      width: bitmap.width,
      height: bitmap.height,
    };
  } finally {
    bitmap.close();
  }
}
```

- [x] **Step 2: 跑 typecheck**

Run: `npm run typecheck`
Expected: 无报错。`tsconfig.web.json` 的 `lib: ["ES2022","DOM","DOM.Iterable"]` 提供 `OffscreenCanvas` / `ImageBitmap` 类型

若报 `Uint8Array<ArrayBufferLike>` 不能赋给 `BlobPart`，说明需要保留 Step 1 里 `new Uint8Array(bytes)` 那次复制，不要图省事去掉。

- [x] **Step 3: 确认没有测试文件误 import 它**

Run: `grep -rn "lib/webp" tests/ || echo "OK: tests/ 未引用 webp.ts"`
Expected: `OK: tests/ 未引用 webp.ts`

- [x] **Step 4: 提交**

```bash
git status --short
git add src/renderer/src/lib/webp.ts
git commit -m "feat(ui): webp encoder on Chromium canvas

用 Electron 自带 Chromium 编码器，零新增依赖。魔数嗅探设定 Blob MIME，
不填背景色以保留 PNG 透明通道。刻意不配 vitest 单测：本模块依赖 DOM
lib，被 tests/ 引用会让 node tsconfig 的 typecheck 失败，改由 e2e 覆盖。"
```

---

### Task 7: GzipTool 文件模式 UI

**Files:**
- Create: `src/renderer/src/components/GzipTool.tsx`
- Modify: `src/renderer/src/components/ToolsPanel.tsx`
- Test: `e2e/tools.spec.ts`（追加）

- [x] **Step 1: 写失败的 e2e**

在 `e2e/tools.spec.ts` 末尾追加：

```ts
test('gzip 工具：选文件后显示体积，未选时按钮禁用', async () => {
  await win.getByTestId('tools-tab').click();
  await win.getByTestId('tool-tab-gzip').click();
  await win.getByTestId('gzip-mode-file').click();

  await expect(win.getByTestId('gzip-compress')).toBeDisabled();
  await expect(win.getByTestId('gzip-decompress')).toBeDisabled();
  await expect(win.getByTestId('gzip-path')).toHaveText('');
});

test('gzip 工具：文件模式错误经 IPC 冒泡到界面', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mocker-gzui-'));
  try {
    const bad = path.join(dir, 'not-gzip.txt');
    await fs.writeFile(bad, 'plain text', 'utf8');
    // 直接打 IPC：保存对话框在无人值守环境会取消，这里验证的是错误传播链路
    await expect(
      win.evaluate(async (p) => window.api.gzipFile('decompress', p), bad),
    ).rejects.toThrow(/不是有效的 gzip 数据/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
```

- [x] **Step 2: 跑 e2e 确认失败**

Run: `npx playwright test e2e/tools.spec.ts -g "gzip 工具"`
Expected: FAIL — `tool-tab-gzip` 找不到

- [x] **Step 3: 建 GzipTool.tsx**

创建 `src/renderer/src/components/GzipTool.tsx`。本 Task 只做文件模式，文本模式在 Task 9 追加：

```tsx
import { useState } from 'react';
import { api } from '../lib/api';
import { formatBytes, formatRatio } from '../lib/format-bytes';
import type { GzipFileResult } from '../../../shared/types';

/** DecompressionStream 等 API 抛的错可能 message 为空串，必须逐级回退 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || String(err);
  return String(err);
}

export default function GzipTool() {
  const [inputPath, setInputPath] = useState('');
  const [result, setResult] = useState<GzipFileResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const pick = async () => {
    // 复用现有单文件选择器；gzip 输入是文件不是目录
    const p = await api.openFileDialog();
    if (p) {
      setInputPath(p);
      setResult(null);
      setError('');
    }
  };

  const run = async (mode: 'compress' | 'decompress') => {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const r = await api.gzipFile(mode, inputPath);
      setResult(r);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form-grid" style={{ maxWidth: 720 }}>
      <label htmlFor="gzip-input">输入文件</label>
      <div className="form-row">
        <input id="gzip-input" data-testid="gzip-path" value={inputPath} readOnly placeholder="尚未选择文件" />
        <button data-testid="gzip-pick" onClick={pick} disabled={busy}>选择文件</button>
      </div>

      <label>操作</label>
      <div className="toolbar" style={{ padding: 0 }}>
        <button
          data-testid="gzip-compress"
          className="primary"
          disabled={inputPath === '' || busy}
          onClick={() => run('compress')}
        >
          压缩为 .gz
        </button>
        <button
          data-testid="gzip-decompress"
          disabled={inputPath === '' || busy}
          onClick={() => run('decompress')}
        >
          解压 .gz
        </button>
      </div>

      <label>结果</label>
      <div>
        {busy && <span className="muted">处理中…</span>}
        {error && <span className="text-err" data-testid="gzip-error">{error}</span>}
        {result && !error && !busy && (
          <div className="form-note" data-testid="gzip-result">
            {result.saved ? (
              <>
                已写入 <code>{result.filePath}</code>
                <br />
                {formatBytes(result.inputBytes)} → {formatBytes(result.outputBytes)}
                （{formatRatio(result.outputBytes, result.inputBytes)}）
              </>
            ) : (
              <span className="muted">已取消保存。原体积 {formatBytes(result.inputBytes)}，结果体积 {formatBytes(result.outputBytes)}</span>
            )}
          </div>
        )}
      </div>

      <label />
      <div className="form-note">
        解压上限 256 MB，超限会中止并报「疑似解压炸弹」。文件在主进程用异步 zlib 处理，不阻塞抓包。
      </div>
    </div>
  );
}
```

- [x] **Step 4: ToolsPanel 挂上 gzip**

`src/renderer/src/components/ToolsPanel.tsx` 三处改动：

import 区加：

```tsx
import GzipTool from './GzipTool';
```

`ToolKey` 与 `TOOLS` 改为：

```tsx
type ToolKey = 'timestamp' | 'gzip';

const TOOLS: { key: ToolKey; label: string }[] = [
  { key: 'timestamp', label: '时间戳' },
  { key: 'gzip', label: 'gzip' },
];
```

渲染区在 `{tool === 'timestamp' && <TimestampTool />}` 之后加：

```tsx
      {tool === 'gzip' && <GzipTool />}
```

- [x] **Step 5: 跑 typecheck**

Run: `npm run typecheck`
Expected: 无报错

- [x] **Step 6: 跑 e2e 确认通过**

Run: `npm run test:e2e -- e2e/tools.spec.ts`
Expected: PASS，11 个 test 全绿

- [ ] **Step 7: 起 dev 手工验证一遍**

Run: `npm run dev`

手工核对（无人值守 e2e 覆盖不到保存对话框）：
1. 实用工具 → gzip → 选一个真实文本文件 → 「压缩为 .gz」→ 保存对话框弹出、默认名带 `.gz` → 保存后结果行显示路径与 `原体积 → 结果体积（比例）`
2. 选刚生成的 `.gz` → 「解压 .gz」→ 默认名去掉 `.gz` → 解压内容与原文件一致
3. 选一个非 gzip 文件 → 「解压 .gz」→ 红色错误行显示「不是有效的 gzip 数据（缺少 1f 8b 魔数）」，界面不崩
4. 在保存对话框点「取消」→ 显示「已取消保存」而非报错
5. 处理大文件时切到「流量」tab 确认抓包未卡顿（验证异步 zlib 生效）

确认后关掉 dev。

- [x] **Step 8: 提交**

```bash
git status --short
git add src/renderer/src/components/GzipTool.tsx src/renderer/src/components/ToolsPanel.tsx e2e/tools.spec.ts
git commit -m "feat(ui): gzip file mode in utility tools

文件模式走主进程 IPC，显示压缩前后体积与压缩率。错误文案按
message -> name -> String(e) 回退，因为 DecompressionStream 类错误
的 message 可能是空串。文本模式待 body-codec.ts 落地后追加。"
```

---

### Task 8: WebpTool 批量转换 UI

**Files:**
- Create: `src/renderer/src/components/WebpTool.tsx`
- Modify: `src/renderer/src/components/ToolsPanel.tsx`
- Test: `e2e/tools.spec.ts`（追加）

- [ ] **Step 1: 写失败的 e2e（真实产物校验）**

在 `e2e/tools.spec.ts` 末尾追加。这条测试是零依赖方案的核心安全网——它验证真实 png 经完整 IPC 链路后产出合法 WebP：

```ts
test('WebP：真实 png 经 readImage + canvas 编码 + writeWebp 产出合法产物', async () => {
  const src = await fs.mkdtemp(path.join(os.tmpdir(), 'mocker-webp-src-'));
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'mocker-webp-out-'));
  try {
    await makePng(win, path.join(src, 'nested/red.png'), 8, '#ff0000');
    await makePng(win, path.join(src, 'blue.jpg'), 8, '#0000ff');

    const scanned = await win.evaluate(async (d) => window.api.scanImages(d), src);
    expect(scanned.map((f) => f.relPath).sort()).toEqual(['blue.jpg', 'nested/red.png']);
    expect(scanned.map((f) => f.outName).sort()).toEqual(['blue.webp', 'nested/red.webp']);

    // 走与 UI 完全相同的三步链路
    const results = await win.evaluate(
      async ([srcDir, outDir, files]) => {
        const mod = await import('/src/lib/webp.ts').catch(() => null);
        void mod;
        return files;
      },
      [src, out, scanned] as [string, string, typeof scanned],
    );
    void results;

    for (const f of scanned) {
      const encoded = await win.evaluate(
        async ([srcDir, relPath]) => {
          const bytes = await window.api.readImage(srcDir, relPath);
          const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' });
          const bmp = await createImageBitmap(blob);
          const c = new OffscreenCanvas(bmp.width, bmp.height);
          c.getContext('2d')!.drawImage(bmp, 0, 0);
          const outBlob = await c.convertToBlob({ type: 'image/webp', quality: 0.8 });
          bmp.close();
          return Array.from(new Uint8Array(await outBlob.arrayBuffer()));
        },
        [src, f.relPath] as [string, string],
      );
      await win.evaluate(
        async ([outDir, outName, bytes]) => window.api.writeWebp(outDir, outName, Uint8Array.from(bytes)),
        [out, f.outName, encoded] as [string, string, number[]],
      );
    }

    for (const rel of ['nested/red.webp', 'blue.webp']) {
      const buf = await fs.readFile(path.join(out, rel));
      expect(buf.subarray(0, 4).toString('ascii'), rel).toBe('RIFF');
      expect(buf.subarray(8, 12).toString('ascii'), rel).toBe('WEBP');
      expect(buf.length).toBeGreaterThan(20);
    }
  } finally {
    await fs.rm(src, { recursive: true, force: true });
    await fs.rm(out, { recursive: true, force: true });
  }
});

test('WebP UI：未选目录时开始按钮禁用，选定后显示扫描数量', async () => {
  await win.getByTestId('tools-tab').click();
  await win.getByTestId('tool-tab-webp').click();

  await expect(win.getByTestId('webp-start')).toBeDisabled();
  await expect(win.getByTestId('webp-src')).toHaveText('');
  await expect(win.getByTestId('webp-out')).toHaveText('');
  await expect(win.getByTestId('webp-quality')).toHaveValue('80');
});
```

- [ ] **Step 2: 跑 e2e 确认失败**

Run: `npx playwright test e2e/tools.spec.ts -g "WebP"`
Expected: FAIL — `tool-tab-webp` 找不到（链路那条可能已通过，因为 Task 5 已接完 IPC）

- [ ] **Step 3: 建 WebpTool.tsx**

创建 `src/renderer/src/components/WebpTool.tsx`：

```tsx
import { useState } from 'react';
import { api } from '../lib/api';
import { formatBytes, formatRatio } from '../lib/format-bytes';
import { encodeWebp } from '../lib/webp';
import { errorMessage } from './GzipTool';
import type { ScannedImage } from '../../../shared/types';

interface RowResult {
  relPath: string;
  ok: boolean;
  inputBytes: number;
  outputBytes: number;
  error?: string;
}

/** 并发上限：canvas 编解码吃内存，过高会让渲染进程峰值失控 */
const CONCURRENCY = 3;

export default function WebpTool() {
  const [srcDir, setSrcDir] = useState('');
  const [outDir, setOutDir] = useState('');
  const [files, setFiles] = useState<ScannedImage[]>([]);
  const [quality, setQuality] = useState(80);
  const [rows, setRows] = useState<RowResult[]>([]);
  const [done, setDone] = useState(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  const pickSrc = async () => {
    setError('');
    try {
      const d = await api.openDirectoryDialog();
      if (!d) return;
      setSrcDir(d);
      setFiles(await api.scanImages(d));
      setRows([]);
      setDone(0);
    } catch (err) {
      setError(errorMessage(err));
      setFiles([]);
    }
  };

  const pickOut = async () => {
    const d = await api.openDirectoryDialog();
    if (d) setOutDir(d);
  };

  const convertOne = async (f: ScannedImage): Promise<RowResult> => {
    try {
      const src = await api.readImage(srcDir, f.relPath);
      // UI 用 0-100 滑块，canvas 的 quality 取值域是 0-1
      const encoded = await encodeWebp(src, quality / 100);
      await api.writeWebp(outDir, f.outName, encoded.bytes);
      return { relPath: f.relPath, ok: true, inputBytes: f.size, outputBytes: encoded.bytes.length };
    } catch (err) {
      return { relPath: f.relPath, ok: false, inputBytes: f.size, outputBytes: 0, error: errorMessage(err) };
    }
  };

  const start = async () => {
    setRunning(true);
    setError('');
    setRows([]);
    setDone(0);
    const collected: RowResult[] = [];
    let cursor = 0;
    // 固定 CONCURRENCY 个 worker 拉同一个游标，单张失败不中断整批
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = cursor++;
        if (i >= files.length) return;
        const r = await convertOne(files[i]!);
        collected[i] = r;
        setDone(i + 1);
        setRows([...collected.filter(Boolean)]);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRows(collected.filter(Boolean));
      setRunning(false);
    }
  };

  const okCount = rows.filter((r) => r.ok).length;
  const inTotal = rows.reduce((a, r) => a + r.inputBytes, 0);
  const outTotal = rows.reduce((a, r) => a + r.outputBytes, 0);
  const ready = srcDir !== '' && outDir !== '' && files.length > 0 && !running;

  return (
    <div className="form-grid" style={{ maxWidth: 860 }}>
      <label htmlFor="webp-src-input">源文件夹</label>
      <div className="form-row">
        <input id="webp-src-input" data-testid="webp-src" value={srcDir} readOnly placeholder="尚未选择" />
        <button data-testid="webp-pick-src" onClick={pickSrc} disabled={running}>选择文件夹</button>
      </div>

      <label>扫描结果</label>
      <div className="form-note" data-testid="webp-count">
        {srcDir === '' ? '选择文件夹后显示' : `扫描到 ${files.length} 张 png/jpg`}
      </div>

      <label htmlFor="webp-q">质量</label>
      <div className="form-row">
        <input
          id="webp-q"
          data-testid="webp-quality"
          type="range"
          min={1}
          max={100}
          value={quality}
          onChange={(e) => setQuality(Number(e.target.value))}
          disabled={running}
        />
        <span data-testid="webp-quality-value">{quality}</span>
      </div>

      <label htmlFor="webp-out-input">输出文件夹</label>
      <div className="form-row">
        <input id="webp-out-input" data-testid="webp-out" value={outDir} readOnly placeholder="尚未选择" />
        <button data-testid="webp-pick-out" onClick={pickOut} disabled={running}>选择文件夹</button>
      </div>

      <label />
      <div className="toolbar" style={{ padding: 0 }}>
        <button data-testid="webp-start" className="primary" disabled={!ready} onClick={start}>
          {running ? `转换中 ${done}/${files.length}` : '开始转换'}
        </button>
        {files.length > 0 && (
          <span className="muted" data-testid="webp-progress">
            {done}/{files.length}
          </span>
        )}
      </div>

      {error && (
        <>
          <label />
          <div className="text-err" data-testid="webp-error">{error}</div>
        </>
      )}

      {rows.length > 0 && (
        <>
          <label>汇总</label>
          <div className="form-note" data-testid="webp-summary">
            成功 {okCount} / 失败 {rows.length - okCount} ·{' '}
            {formatBytes(inTotal)} → {formatBytes(outTotal)}（{formatRatio(outTotal, inTotal)}）
          </div>

          <label>明细</label>
          <div style={{ maxHeight: 320, overflowY: 'auto', width: '100%' }}>
            <table className="rules-table" data-testid="webp-rows">
              <thead>
                <tr>
                  <th>文件</th>
                  <th>原体积</th>
                  <th>WebP</th>
                  <th>占比</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.relPath}>
                    <td title={r.relPath}>{r.relPath}</td>
                    <td>{formatBytes(r.inputBytes)}</td>
                    <td>{r.ok ? formatBytes(r.outputBytes) : '—'}</td>
                    <td>{r.ok ? formatRatio(r.outputBytes, r.inputBytes) : '—'}</td>
                    <td className={r.ok ? 'text-ok' : 'text-err'}>{r.ok ? '成功' : r.error}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <label />
      <div className="form-note">
        源图不会被修改，输出按源目录结构镜像写入所选文件夹。已知限制：边长超过 16383px 会编码失败；
        CMYK JPEG 可能解码失败；ICC 色彩配置文件可能不保留；PNG 透明通道会保留；不处理 GIF 与动画。
        单张失败只记在明细里，不中断整批。
      </div>
    </div>
  );
}
```

- [ ] **Step 4: ToolsPanel 挂上 webp**

`src/renderer/src/components/ToolsPanel.tsx`：

import 区加：

```tsx
import WebpTool from './WebpTool';
```

`ToolKey` 与 `TOOLS` 改为：

```tsx
type ToolKey = 'timestamp' | 'gzip' | 'webp';

const TOOLS: { key: ToolKey; label: string }[] = [
  { key: 'timestamp', label: '时间戳' },
  { key: 'gzip', label: 'gzip' },
  { key: 'webp', label: '图片转 WebP' },
];
```

渲染区在 `{tool === 'gzip' && <GzipTool />}` 之后加：

```tsx
      {tool === 'webp' && <WebpTool />}
```

- [ ] **Step 5: 跑 typecheck**

Run: `npm run typecheck`
Expected: 无报错

- [ ] **Step 6: 跑 e2e 确认通过**

Run: `npm run test:e2e -- e2e/tools.spec.ts`
Expected: PASS，13 个 test 全绿

- [ ] **Step 7: 跑全量单测与全量 e2e**

Run: `npm test && npm run test:e2e`
Expected: PASS

- [ ] **Step 8: 起 dev 手工验证批量转换**

Run: `npm run dev`

准备一个含 3-5 张 png/jpg（其中至少一张放在子目录）的临时文件夹，手工核对：
1. 实用工具 → 图片转 WebP → 选源文件夹 → 显示「扫描到 N 张 png/jpg」
2. 拖质量滑块，右侧数字同步变化
3. 选输出文件夹 → 「开始转换」→ 按钮文案变「转换中 x/N」，进度数字递增
4. 完成后汇总行显示成功/失败数与总体积变化；明细表每行有原体积、WebP 体积、占比
5. 到输出文件夹确认子目录结构被镜像，`.webp` 文件能在预览里正常打开
6. 把质量调到 5 重跑一次，确认输出被覆盖且体积明显变小
7. 源文件夹里的原图确认未被修改或删除

再验证失败路径：往源文件夹塞一个改名为 `.png` 的文本文件，重跑，确认它在明细表里标红且不中断其它图片。

确认后关掉 dev。

- [ ] **Step 9: 提交**

```bash
git status --short
git add src/renderer/src/components/WebpTool.tsx src/renderer/src/components/ToolsPanel.tsx e2e/tools.spec.ts
git commit -m "feat(ui): batch png/jpg to webp conversion

渲染进程 canvas 编码，主进程负责扫描与镜像写入，并发 3，单张失败不中断
整批。e2e 用真实 png 走完 readImage -> encode -> writeWebp 全链路，断言
产物 RIFF/WEBP 魔数，这是零依赖方案的核心安全网。"
```

---

### Task 9: gzip 文本模式（外部门禁）

**门禁：开工前必须确认前置条件已满足。** 本 Task 依赖另一会话产出的 `body-codec.ts`。

**Files:**
- Modify: `src/renderer/src/components/GzipTool.tsx`
- Depends on: `src/renderer/src/lib/body-codec.ts`（**对方创建，本计划不得创建**）
- Test: `e2e/tools.spec.ts`（追加）

- [ ] **Step 1: 门禁检查**

Run:

```bash
ls src/renderer/src/lib/body-codec.ts 2>/dev/null || echo "BLOCKED: body-codec.ts 尚未落地"
grep -n "export async function gzipCompress\|export async function gunzipText\|export function toBase64\|export function gzipDecodeBytes" src/renderer/src/lib/body-codec.ts 2>/dev/null
grep -n "bytes: Uint8Array" src/renderer/src/lib/body-codec.ts 2>/dev/null
git log --oneline -5
```

Expected（全部满足才继续）：
- `body-codec.ts` 存在
- 四个导出函数都在：`gzipCompress` / `gunzipText` / `toBase64` / `gzipDecodeBytes`
- `CompressResult` 含 `bytes: Uint8Array` 字段（**不是** `hex` / `base64`；对方已改过这个契约）

**若 BLOCKED**：停止本 Task，先让 `2026-09-11-response-body-gzip-views.md` 的 Task 2-4 落地，或把该模块的实现搬到这里作为本 Task 的第一步（需与对方会话协调，避免两边都写）。Task 1-8 的产出已经完整可用，本 Task 未做不影响交付前两个工具与 gzip 文件模式。

- [ ] **Step 2: 写失败的 e2e**

在 `e2e/tools.spec.ts` 末尾追加：

```ts
test('gzip 文本模式：文本 -> base64 -> 文本 往返一致', async () => {
  await win.getByTestId('tools-tab').click();
  await win.getByTestId('tool-tab-gzip').click();
  await win.getByTestId('gzip-mode-text').click();

  const text = 'hello mocker 世界 {"a":1}';
  await win.getByTestId('gzip-text-input').fill(text);
  await win.getByTestId('gzip-text-compress').click();

  const b64 = await win.getByTestId('gzip-text-output').inputValue();
  expect(b64.length).toBeGreaterThan(0);
  // base64 解出来必须以 gzip 魔数开头
  const magic = Buffer.from(b64, 'base64').subarray(0, 2);
  expect(Array.from(magic)).toEqual([0x1f, 0x8b]);

  // 反向：清空后粘回 base64 解压
  await win.getByTestId('gzip-text-input').fill(b64);
  await win.getByTestId('gzip-text-decompress').click();
  await expect(win.getByTestId('gzip-text-output')).toHaveValue(text);
});

test('gzip 文本模式：非法 base64 解压行内报错不崩', async () => {
  await win.getByTestId('gzip-mode-text').click();
  await win.getByTestId('gzip-text-input').fill('not base64 gzip at all');
  await win.getByTestId('gzip-text-decompress').click();
  // DecompressionStream 抛的是 message 为空串的 TypeError，文案必须靠 name 回退
  await expect(win.getByTestId('gzip-text-error')).not.toHaveText('');
});
```

- [ ] **Step 3: 跑 e2e 确认失败**

Run: `npx playwright test e2e/tools.spec.ts -g "gzip 文本模式"`
Expected: FAIL — `gzip-mode-text` 找不到

- [ ] **Step 4: 改造 GzipTool.tsx 加入文本模式**

`src/renderer/src/components/GzipTool.tsx`：import 区加（`body-codec` 的实际导出名以 Step 1 门禁核对结果为准）：

```tsx
import { gzipCompress, gzipDecodeBytes, gunzipText, toBase64 } from '../lib/body-codec';
```

组件体最前面加子模式 state：

```tsx
  const [mode, setMode] = useState<'file' | 'text'>('file');
  const [textInput, setTextInput] = useState('');
  const [textOutput, setTextOutput] = useState('');
  const [textError, setTextError] = useState('');
  const [textBusy, setTextBusy] = useState(false);

  const runText = async (action: 'compress' | 'decompress') => {
    setTextBusy(true);
    setTextError('');
    setTextOutput('');
    try {
      if (action === 'compress') {
        // gzipCompress 返回原始 bytes，base64 需自行组合（对方已把 hex/base64 从返回值里去掉）
        const r = await gzipCompress(textInput);
        setTextOutput(toBase64(r.bytes));
      } else {
        setTextOutput(await gunzipText(gzipDecodeBytes(textInput, 'base64')));
      }
    } catch (err) {
      setTextError(errorMessage(err));
    } finally {
      setTextBusy(false);
    }
  };
```

`return` 的最外层改成先渲染子模式切换，再按 mode 分支。把现有 `<div className="form-grid" …>` 整体包进 fragment：

```tsx
  return (
    <>
      <div className="tab-row">
        <button
          data-testid="gzip-mode-file"
          className={mode === 'file' ? 'active' : ''}
          onClick={() => setMode('file')}
        >
          文件模式
        </button>
        <button
          data-testid="gzip-mode-text"
          className={mode === 'text' ? 'active' : ''}
          onClick={() => setMode('text')}
        >
          文本模式
        </button>
      </div>

      {mode === 'file' && (
        <div className="form-grid" style={{ maxWidth: 720 }}>
          {/* ……原有文件模式内容原样保留…… */}
        </div>
      )}

      {mode === 'text' && (
        <div className="form-grid" style={{ maxWidth: 720 }}>
          <label htmlFor="gzip-text-in">输入</label>
          <textarea
            id="gzip-text-in"
            data-testid="gzip-text-input"
            rows={6}
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            placeholder="压缩：填原始文本；解压：填 gzip 的 base64"
          />

          <label>操作</label>
          <div className="toolbar" style={{ padding: 0 }}>
            <button
              data-testid="gzip-text-compress"
              className="primary"
              disabled={textInput === '' || textBusy}
              onClick={() => runText('compress')}
            >
              压缩 → base64
            </button>
            <button
              data-testid="gzip-text-decompress"
              disabled={textInput === '' || textBusy}
              onClick={() => runText('decompress')}
            >
              解压 base64 → 文本
            </button>
          </div>

          <label htmlFor="gzip-text-out">结果</label>
          <textarea id="gzip-text-out" data-testid="gzip-text-output" rows={6} value={textOutput} readOnly />

          {textError && (
            <>
              <label />
              <div className="text-err" data-testid="gzip-text-error">{textError}</div>
            </>
          )}

          <label />
          <div className="form-note">
            纯渲染进程计算（Chromium 的 CompressionStream），不经过 IPC，也不落盘。
            二进制用 base64 表示，与 HAR 对二进制 body 的处理一致。
          </div>
        </div>
      )}
    </>
  );
```

- [ ] **Step 5: 跑 typecheck**

Run: `npm run typecheck`
Expected: 无报错。若 `body-codec` 的导出签名与 Step 4 写的不一致，以门禁核对到的实际签名为准调整调用处

- [ ] **Step 6: 跑 e2e 确认通过**

Run: `npm run test:e2e -- e2e/tools.spec.ts`
Expected: PASS，15 个 test 全绿

- [ ] **Step 7: 提交**

```bash
git status --short
git add src/renderer/src/components/GzipTool.tsx e2e/tools.spec.ts
git commit -m "feat(ui): gzip text mode reusing body-codec

文本模式直接复用姊妹 spec 落地的渲染进程 body-codec，零 IPC、不重复造
gzip。gzipCompress 返回原始 bytes，base64 由调用方 toBase64 组合。
错误文案靠 name 回退，因为 DecompressionStream 失败时 message 是空串。"
```

---

### Task 10: README 与全量校验

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 确认与对方会话的 README 改动不冲突**

Run:

```bash
git status --short README.md
git log --oneline -3 -- README.md
grep -n "^### " README.md
```

若 `README.md` 已有未提交改动（对方 Task 8 正在改），**先让对方提交**，或 `git stash push README.md` 暂存后再改，改完 `git stash pop` 手工合并。不要直接覆盖。

- [ ] **Step 2: 加「实用工具」小节**

在 `README.md` 的 `### 弱网限速`（第 263 行附近）之后、`## 开发`（第 271 行）之前插入一个**独立小节**，不动其它小节内容：

```markdown
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
```

- [ ] **Step 3: 更新功能列表**

`README.md` 的 `## 功能`（第 5 行）列表末尾追加一行：

```markdown
- 实用工具：时间戳互转（任意时区）、gzip 压缩/解压、png/jpg 批量转 WebP
```

- [ ] **Step 4: 全量校验**

Run:

```bash
npm run typecheck && npm test && npm run test:e2e
```

Expected: 三条命令全部 PASS。e2e 会跑全部 spec（含对方若已落地的 `traffic-body-views.spec.ts`）

- [ ] **Step 5: 最后手工过一遍三个工具**

Run: `npm run dev`

按顺序点一遍：时间戳（正反向 + 换时区 + 「现在」按钮）、gzip（文件模式压缩解压 + 文本模式往返）、WebP（批量转换 + 改质量重跑）。确认 tab 顺序是 流量 / 规则 / 重定向 / 实用工具 / 设备接入 / 设置。

- [ ] **Step 6: 提交**

```bash
git status --short
git add README.md
git commit -m "docs: utility tools section in README

三个工具的用途、时区精度说明、webp 与 gzip 的已知限制与上限。"
```

---

## Self-Review 结果

**1. Spec 覆盖检查**

| Spec 章节 | 实现 Task |
|---|---|
| 1. Tab 接入 | Task 2 |
| 2. 面板结构（4 个组件、复用现有 CSS 类） | Task 2 / 7 / 8 |
| 3. 时间戳工具（4 个函数 + 双向 UI + 边界） | Task 1（逻辑）+ Task 2（UI） |
| 4.1 gzip 文本模式复用 body-codec | Task 9 |
| 4.2 gzip 文件模式（魔数 + 256MB 上限 + 异步） | Task 4（逻辑）+ Task 5（IPC）+ Task 7（UI） |
| 5. image-scan（递归 / limit / outName / 路径收敛） | Task 3 |
| 5. webp.ts 编码器 | Task 6 |
| 5. 批量流程（并发 3 / 进度 / 逐条归因 / 汇总） | Task 8 |
| 5. UI 明写的已知限制 | Task 8 Step 3 的 form-note + Task 10 README |
| 6. API 接线（5 个 channel） | Task 5 |
| 7. 测试（3 个 vitest + e2e + typecheck） | Task 1 / 3 / 4 / 5 / 7 / 8 / 9 / 10 |
| 8. README 文档 | Task 10 |
| 关键技术决策：二进制 contextBridge 验证与回退方案 | Task 5 Step 8 |

无遗漏。相对 spec 的两处**收紧**（均为改进，已在 Task 内说明）：

- spec 列了 `ImageScanResult` 类型，实际 `tools:scan-images` 直接返回 `ScannedImage[]`——没有第二个字段，包一层是多余抽象
- spec 说解压「流式解压并在超限时中止」，实测 `zlib` 原生 `maxOutputLength` 已提供同一保证，无需手写流式（见前提 5）

**2. 占位符扫描**：无 TBD / TODO / 「适当处理错误」/「类似 Task N」。Task 9 Step 4 的文件模式注释 `……原有文件模式内容原样保留……` 是有意的——那是 Task 7 已写出的完整代码，此处只标注包裹位置，不重复贴。

**3. 类型一致性检查**

| 符号 | 定义处 | 使用处 | 一致 |
|---|---|---|---|
| `ScannedImage{relPath,ext,size,outName}` | Task 3 Step 4（`shared/types.ts`） | Task 3 测试、Task 5 e2e、Task 8 `WebpTool` | ✓ |
| `GzipMode` / `GzipFileResult` / `WebpWriteResult` | Task 5 Step 3 | Task 5 Step 4-6、Task 7 `GzipTool` | ✓ |
| `detectTimestampUnit` / `toMillis` / `formatTimestamp` / `parseZonedDateTime` / `listTimeZones` | Task 1 Step 3 | Task 1 测试、Task 2 `TimestampTool` | ✓ |
| `UnitChoice` / `TimestampUnit` | Task 1 Step 3 | Task 2 `TimestampTool` | ✓ |
| `ZonedDateTime{standard,iso,offsetSeconds,offsetMinutes,millis,parts}` | Task 1 Step 3 | Task 1 测试、Task 2 | ✓ |
| `gzipCompressBytes` / `gzipDecompressBytes` / `MAX_GUNZIP_BYTES` | Task 4 Step 3 | Task 4 测试、Task 5 Step 6 | ✓ |
| `scanImages` / `readImage` / `writeWebp` / `DEFAULT_SCAN_LIMIT` | Task 3 Step 3 | Task 3 测试、Task 5 Step 6 | ✓ |
| `encodeWebp` / `WebpEncodeResult` | Task 6 Step 1 | Task 8 `WebpTool` | ✓ |
| `formatBytes` / `formatRatio` | Task 4 Step 3 | Task 4 测试、Task 7、Task 8 | ✓ |
| `errorMessage` | Task 7 Step 3（`GzipTool.tsx` 导出） | Task 8 `WebpTool`、Task 9 | ✓ |
| `api.{openDirectoryDialog,gzipFile,scanImages,readImage,writeWebp}` | Task 5 Step 4 | Task 5 e2e、Task 7、Task 8 | ✓ |
| IPC channel 名 ×5 | Task 5 Step 6 | Task 5 Step 5 preload | ✓ |

`errorMessage` 从 `GzipTool.tsx` 导出供 `WebpTool.tsx` 复用，避免第三份实现。若 review 时觉得从组件文件导出工具函数不妥，可移到 `lib/format-bytes.ts` 旁新建 `lib/error-message.ts`，但需同步改 Task 8 / Task 9 的 import。

**4. 已知残留风险（实现时注意）**

- `OffscreenCanvas` / `createImageBitmap` / canvas WebP 编码能力**无法在 Node 里预验证**，只能靠 Task 5 Step 8 的 e2e。这是零依赖方案唯一的硬赌注，已放在 UI 开发之前，失败即触发 spec 里的 `sharp` 回退。
- Task 8 e2e 的 `win.evaluate` 里那段 `await import('/src/lib/webp.ts')` 是**故意的死代码占位**——dev server 下渲染进程模块无法从 evaluate 直接 import，所以改为在 evaluate 内联同样的 canvas 逻辑来验证链路。实现时应**删掉那 5 行** `const mod = …` / `void mod` / `void results`，它们在 plan 里只是为了说明为什么内联。删掉后测试逻辑不变。
- Task 9 的 `body-codec` 导出名以门禁实际核对为准；对方仍在修订该 spec，签名可能继续变。
