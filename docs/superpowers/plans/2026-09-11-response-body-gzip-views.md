# 响应体视图（复制 / gzip 解压 / gzip 压缩）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在流量详情区为响应体增加三个派生视图（原始 / gzip 解压 / gzip 压缩）与各自的复制按钮，全程不改写抓到的响应体本身。

**Architecture:** 字节逻辑全部收在纯函数模块 `lib/body-codec.ts`（只用 `CompressionStream` / `DecompressionStream` / `TextEncoder` / `atob` / `btoa` 这些 Chromium 与 Node 24 共同提供的全局），视图状态机收在 `components/ResponseBodyViews.tsx`（tab 切换、懒计算、就地错误、复制）。`TrafficDetail.tsx` 只负责把响应体小节换成该组件。不动任何 main 进程代码与 `TrafficEvent` 结构。

**Tech Stack:** Electron 44 + React 19 + TypeScript 7 + vitest（`environment: 'node'`）+ Playwright（真 Electron）。

**Spec:** `docs/superpowers/specs/2026-09-11-response-body-gzip-views-design.md`

---

## 已实测确认的前提（不要在实现时重新怀疑这些）

以下都在 TypeScript 7.0.2 + `@types/node` 26.4.0 + Node 24 上实测过：

1. `tsconfig.web.json`（`lib: ["ES2022","DOM","DOM.Iterable"]`）与 `tsconfig.node.json`（`types: ["node"]`，无 DOM lib）**都能**编译 `CompressionStream` / `DecompressionStream` / `ReadableStream` / `atob` / `btoa` / `TextEncoder`。`@types/node` 用 `typeof globalThis extends { onmessage: any } ? {} : webstreams.X` 的条件声明在 DOM lib 存在时让位，因此同一份源码两边都通过。
2. `tests/**` 归 `tsconfig.node.json` 管，所以单测里 `import` 渲染层 lib 是既有做法（`tests/curl.test.ts` 就这么做）。
3. 流式写法 `oneShotStream(bytes).pipeThrough(new DecompressionStream('gzip'))` 在 Node 24 运行时可用，`TextEncoder` 编码 → gzip → gunzip → `TextDecoder('utf-8',{fatal:true})` 解码，含中文往返一致。
4. gzip 输出的 base64 以 `H4sI` 开头（魔数 `1f 8b 08` 的 base64），所以「取前 16 字符解码验魔数」的嗅探方式有效。
5. **`DecompressionStream` 解压失败抛出的是 `message` 为空字符串的 `TypeError`**。错误行文案必须按 `e.message` → `e.name` → `String(e)` 回退，否则会渲染成「gzip 解压失败：」后面一片空白。
6. `ReadableStream` 的泛型要写成 `ReadableStream<Uint8Array<ArrayBuffer>>`，配合 `readAll<T extends Uint8Array>` 才能同时满足两个 tsconfig 的 `pipeThrough` 类型匹配。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/renderer/src/lib/body-format.ts` | 新建 | `pretty()`：JSON 美化 + 500_000 字符显示截断（从 `TrafficDetail.tsx` 迁移） |
| `tests/body-format.test.ts` | 新建 | `pretty()` 单测 |
| `src/renderer/src/lib/body-codec.ts` | 新建 | gzip 嗅探、字节还原、压缩/解压、hex dump、base64 |
| `tests/body-codec.test.ts` | 新建 | body-codec 全部单测 |
| `src/renderer/src/components/ResponseBodyViews.tsx` | 新建 | 响应体视图状态机 + 复制交互 |
| `src/renderer/src/components/TrafficDetail.tsx` | 修改 | 删除本地 `pretty`，响应体小节改渲染 `ResponseBodyViews` |
| `src/renderer/src/styles.css` | 修改 | `.body-view-bar` / `.body-view-actions` / `.body-gzip-stats` / tab 禁用态 |
| `e2e/traffic-body-views.spec.ts` | 新建 | 三视图端到端断言 |
| `README.md` | 修改 | 「流量操作」小节补一条 |

组件层没有单测基础设施（仓库无 jsdom / testing-library，既有组件一律靠 e2e 覆盖），因此 `ResponseBodyViews` 的正确性由 Task 7 的 e2e 保证，这符合仓库现状。

---

### Task 1: 把 `pretty()` 迁到 `lib/body-format.ts`

**Files:**
- Create: `src/renderer/src/lib/body-format.ts`
- Create: `tests/body-format.test.ts`
- Modify: `src/renderer/src/components/TrafficDetail.tsx:1-16`（本任务先只改 import，删除本地函数在 Task 6 做）

- [ ] **Step 1: 写失败的测试**

创建 `tests/body-format.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { pretty } from '../src/renderer/src/lib/body-format';

describe('pretty', () => {
  it('合法 JSON 美化为两空格缩进', () => {
    expect(pretty('{"a":1,"b":[2]}')).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
  });

  it('非法 JSON 原样返回', () => {
    expect(pretty('not json')).toBe('not json');
  });

  it('undefined 与空串都返回空串', () => {
    expect(pretty(undefined)).toBe('');
    expect(pretty('')).toBe('');
  });

  it('超过 500_000 字符截断并追加提示行', () => {
    const out = pretty('x'.repeat(500_001));
    expect(out.endsWith('\n…（内容过长已截断）')).toBe(true);
    expect(out.length).toBe(500_000 + '\n…（内容过长已截断）'.length);
  });

  it('恰好 500_000 字符不截断', () => {
    expect(pretty('x'.repeat(500_000)).length).toBe(500_000);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/body-format.test.ts`
Expected: FAIL —— 无法解析 `../src/renderer/src/lib/body-format`

- [ ] **Step 3: 建实现文件**

创建 `src/renderer/src/lib/body-format.ts`（与 `TrafficDetail.tsx:6-16` 的现有实现逐字一致，只加一行说明为什么它不用于复制）：

```ts
const DISPLAY_LIMIT = 500_000;

/** 仅用于显示：会截断，复制路径不要走这里。 */
export function pretty(body: string | undefined): string {
  if (!body) return '';
  if (body.length > DISPLAY_LIMIT) {
    return body.slice(0, DISPLAY_LIMIT) + '\n…（内容过长已截断）';
  }
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/body-format.test.ts`
Expected: PASS，5 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add src/renderer/src/lib/body-format.ts tests/body-format.test.ts
git commit -m "refactor(ui): extract pretty body formatter into lib"
```

---

### Task 2: body-codec 嗅探与字节还原

**Files:**
- Create: `src/renderer/src/lib/body-codec.ts`
- Create: `tests/body-codec.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `tests/body-codec.test.ts`：

```ts
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { gzipDecodeBytes, sniffGzip } from '../src/renderer/src/lib/body-codec';

function gzipBase64(text: string): string {
  return Buffer.from(gzipSync(new TextEncoder().encode(text))).toString('base64');
}

/** 字节 → 每字节一个 code unit 的字符串，模拟「gzip 原始字节被当成文本存进 responseBody」。 */
function gzipRawString(text: string): string {
  return Buffer.from(gzipSync(new TextEncoder().encode(text))).toString('latin1');
}

describe('sniffGzip', () => {
  it('空串不命中', () => {
    expect(sniffGzip('')).toEqual({ detected: false });
  });

  it('raw-bytes：首两个 code unit 是 gzip 魔数时命中', () => {
    const body = gzipRawString('hello');
    expect(body.charCodeAt(0)).toBe(0x1f);
    expect(body.charCodeAt(1)).toBe(0x8b);
    expect(sniffGzip(body)).toEqual({ detected: true, via: 'raw-bytes' });
  });

  it('base64：gzip 的 base64 文本命中', () => {
    const body = gzipBase64('hello');
    expect(body.startsWith('H4sI')).toBe(true);
    expect(sniffGzip(body)).toEqual({ detected: true, via: 'base64' });
  });

  it('base64：首尾空白不影响命中', () => {
    expect(sniffGzip(`\n  ${gzipBase64('hello')}  \n`)).toEqual({ detected: true, via: 'base64' });
  });

  it('长 base64 串只读前缀即可判定', () => {
    const body = gzipBase64('x'.repeat(200_000));
    expect(body.length).toBeGreaterThan(16);
    expect(sniffGzip(body)).toEqual({ detected: true, via: 'base64' });
  });

  it('明文 JSON 不命中', () => {
    expect(sniffGzip('{"msg":"hello 世界"}')).toEqual({ detected: false });
  });

  it('全部落在 base64 字符集内的普通单词不命中', () => {
    expect(sniffGzip('hello')).toEqual({ detected: false });
  });

  it('长度不足 4 的 base64 前缀不命中且不抛错', () => {
    expect(sniffGzip('H4s')).toEqual({ detected: false });
  });

  it('只有一个字符时不抛错', () => {
    expect(sniffGzip('A')).toEqual({ detected: false });
  });
});

describe('gzipDecodeBytes', () => {
  it('base64 路径无损还原字节', () => {
    const original = gzipSync(new TextEncoder().encode('hello'));
    const b64 = Buffer.from(original).toString('base64');
    expect(gzipDecodeBytes(b64, 'base64')).toEqual(new Uint8Array(original));
  });

  it('base64 路径容忍首尾空白', () => {
    const b64 = gzipBase64('hello');
    expect(gzipDecodeBytes(`  ${b64}\n`, 'base64')).toEqual(gzipDecodeBytes(b64, 'base64'));
  });

  it('raw-bytes 路径按 UTF-8 编码字符串', () => {
    expect(gzipDecodeBytes('AB', 'raw-bytes')).toEqual(new Uint8Array([0x41, 0x42]));
  });

  it('raw-bytes 路径对中文按 UTF-8 多字节编码', () => {
    expect(gzipDecodeBytes('世', 'raw-bytes')).toEqual(new Uint8Array([0xe4, 0xb8, 0x96]));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/body-codec.test.ts`
Expected: FAIL —— 无法解析 `../src/renderer/src/lib/body-codec`

- [ ] **Step 3: 建实现文件**

创建 `src/renderer/src/lib/body-codec.ts`：

```ts
const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;
const BASE64_PREFIX_LEN = 16;
const BASE64_PREFIX_PATTERN = /^[A-Za-z0-9+/=]+$/;
const BASE64_MIN_PREFIX_LEN = 4;

export type GzipVia = 'raw-bytes' | 'base64';

export interface GzipSniffResult {
  detected: boolean;
  via?: GzipVia;
}

export interface CompressResult {
  rawBytes: number;
  gzippedBytes: number;
  ratio: number;
  bytes: Uint8Array;
}

/**
 * raw-bytes 路径只看前两个 code unit：0x1f 属 ASCII，UTF-8 解码后仍是 U+001F。
 * base64 路径只解码前缀，因此嗅探开销与响应体大小无关。
 */
export function sniffGzip(body: string): GzipSniffResult {
  if (body.length === 0) return { detected: false };
  if (body.charCodeAt(0) === GZIP_MAGIC_0 && body.charCodeAt(1) === GZIP_MAGIC_1) {
    return { detected: true, via: 'raw-bytes' };
  }
  const prefix = body.trim().slice(0, BASE64_PREFIX_LEN);
  if (prefix.length >= BASE64_MIN_PREFIX_LEN && BASE64_PREFIX_PATTERN.test(prefix)) {
    try {
      const bytes = base64ToBytes(prefix);
      if (bytes[0] === GZIP_MAGIC_0 && bytes[1] === GZIP_MAGIC_1) {
        return { detected: true, via: 'base64' };
      }
    } catch {
      return { detected: false };
    }
  }
  return { detected: false };
}

/** base64 路径无损；raw-bytes 路径有损——非法 UTF-8 字节在抓包时已被替换为 U+FFFD。 */
export function gzipDecodeBytes(body: string, via: GzipVia): Uint8Array {
  return via === 'base64' ? base64ToBytes(body.trim()) : new TextEncoder().encode(body);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/body-codec.test.ts`
Expected: PASS，13 个用例全绿

- [ ] **Step 5: 跑 typecheck 确认两个 tsconfig 都通过**

Run: `npm run typecheck`
Expected: 无输出，退出码 0

注意：此时 `CompressResult` 已声明但尚无使用方，`gzipCompress` 在 Task 4 补上。若 typecheck 报未使用类型，属误报——`export` 的接口不会触发未使用告警。

- [ ] **Step 6: 提交**

```bash
git add src/renderer/src/lib/body-codec.ts tests/body-codec.test.ts
git commit -m "feat(ui): gzip sniffing and byte recovery for response body views"
```

---

### Task 3: body-codec 文本表示（hex dump / base64）

**Files:**
- Modify: `src/renderer/src/lib/body-codec.ts`
- Modify: `tests/body-codec.test.ts`

- [ ] **Step 1: 追加失败的测试**

在 `tests/body-codec.test.ts` 顶部 import 改为：

```ts
import { gzipDecodeBytes, sniffGzip, toBase64, toHexDump } from '../src/renderer/src/lib/body-codec';
```

并在文件末尾追加：

```ts
describe('toHexDump', () => {
  it('空输入返回空串', () => {
    expect(toHexDump(new Uint8Array(0))).toBe('');
  });

  it('满 16 字节的行：8 位偏移 + 两段 8 字节 hex + ASCII 侧栏', () => {
    const bytes = new TextEncoder().encode('0123456789abcdef');
    expect(toHexDump(bytes)).toBe(
      '00000000  30 31 32 33 34 35 36 37  38 39 61 62 63 64 65 66  |0123456789abcdef|',
    );
  });

  it('末行不足 16 字节时 hex 区补齐对齐，ASCII 侧栏不补齐', () => {
    const full = toHexDump(new TextEncoder().encode('0123456789abcdef'));
    const short = toHexDump(new TextEncoder().encode('0123456789abcde'));
    expect(short.indexOf('|')).toBe(full.indexOf('|'));
    expect(short.length).toBe(full.length - 1);
    expect(short.endsWith('|0123456789abcde|')).toBe(true);
  });

  it('第二行偏移为 00000010', () => {
    const lines = toHexDump(new Uint8Array(17)).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]!.startsWith('00000010  00 ')).toBe(true);
  });

  it('不可打印字符在 ASCII 侧栏显示为点', () => {
    const bytes = new Uint8Array([0x00, 0x1f, 0x41, 0x7e, 0x7f, 0xff]);
    expect(toHexDump(bytes).endsWith('|..A~..|')).toBe(true);
  });

  it('maxBytes 截断并追加提示行', () => {
    const lines = toHexDump(new Uint8Array(64), 32).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('…（已截断，仅显示前 32 字节）');
  });

  it('maxBytes 不小于总长度时不追加提示行', () => {
    expect(toHexDump(new Uint8Array(32), 32).split('\n')).toHaveLength(2);
    expect(toHexDump(new Uint8Array(32), 999).split('\n')).toHaveLength(2);
  });
});

describe('toBase64', () => {
  it('已知向量', () => {
    expect(toBase64(new Uint8Array([0x1f, 0x8b, 0x08, 0x00]))).toBe('H4sIAA==');
  });

  it('空输入返回空串', () => {
    expect(toBase64(new Uint8Array(0))).toBe('');
  });

  it('超过分块阈值的大输入不爆栈且可解码回原字节', () => {
    const bytes = new Uint8Array(100_000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;
    const back = Uint8Array.from(atob(toBase64(bytes)), (c) => c.charCodeAt(0));
    expect(back).toEqual(bytes);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/body-codec.test.ts`
Expected: FAIL —— `toHexDump` / `toBase64` 未导出

- [ ] **Step 3: 追加实现**

在 `src/renderer/src/lib/body-codec.ts` 的常量区补两行：

```ts
const HEX_ROW_BYTES = 16;
const BASE64_CHUNK_BYTES = 8192;
```

并在 `base64ToBytes` 之前追加两个导出函数：

```ts
export function toHexDump(bytes: Uint8Array, maxBytes?: number): string {
  if (bytes.length === 0) return '';
  const limit = maxBytes === undefined ? bytes.length : Math.min(maxBytes, bytes.length);
  const lines: string[] = [];
  for (let offset = 0; offset < limit; offset += HEX_ROW_BYTES) {
    const row = bytes.subarray(offset, Math.min(offset + HEX_ROW_BYTES, limit));
    const hex: string[] = [];
    for (let i = 0; i < HEX_ROW_BYTES; i += 1) {
      const b = row[i];
      hex.push(b === undefined ? '  ' : b.toString(16).padStart(2, '0'));
    }
    const ascii = Array.from(row, (b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.')).join('');
    lines.push(
      `${offset.toString(16).padStart(8, '0')}  ${hex.slice(0, 8).join(' ')}  ${hex.slice(8).join(' ')}  |${ascii}|`,
    );
  }
  if (limit < bytes.length) lines.push(`…（已截断，仅显示前 ${limit} 字节）`);
  return lines.join('\n');
}

/** 分块避免 String.fromCharCode 的实参数量上限。 */
export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_BYTES) {
    bin += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK_BYTES));
  }
  return btoa(bin);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/body-codec.test.ts`
Expected: PASS，23 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add src/renderer/src/lib/body-codec.ts tests/body-codec.test.ts
git commit -m "feat(ui): hex dump and chunked base64 encoding for body codec"
```

---

### Task 4: body-codec 压缩与解压

**Files:**
- Modify: `src/renderer/src/lib/body-codec.ts`
- Modify: `tests/body-codec.test.ts`

- [ ] **Step 1: 追加失败的测试**

在 `tests/body-codec.test.ts` 顶部 import 改为：

```ts
import {
  gzipCompress,
  gzipDecodeBytes,
  gunzipText,
  sniffGzip,
  toBase64,
  toHexDump,
} from '../src/renderer/src/lib/body-codec';
```

并在文件末尾追加：

```ts
describe('gzipCompress / gunzipText', () => {
  it('压缩再解压得到原文（含中文多字节）', async () => {
    const text = '{"msg":"hello 世界","n":1}';
    const result = await gzipCompress(text);
    expect(await gunzipText(result.bytes)).toBe(text);
  });

  it('压缩输出是合法 gzip（魔数 1f 8b）', async () => {
    const result = await gzipCompress('hello');
    expect(result.bytes[0]).toBe(0x1f);
    expect(result.bytes[1]).toBe(0x8b);
  });

  it('统计字段自洽', async () => {
    const result = await gzipCompress('a'.repeat(1000));
    expect(result.rawBytes).toBe(1000);
    expect(result.gzippedBytes).toBe(result.bytes.byteLength);
    expect(result.gzippedBytes).toBeLessThan(result.rawBytes);
    expect(result.ratio).toBeCloseTo(result.gzippedBytes / 1000, 10);
  });

  it('rawBytes 按 UTF-8 字节数计而非字符数', async () => {
    expect((await gzipCompress('世界')).rawBytes).toBe(6);
  });

  it('空串 rawBytes 与 ratio 均为 0，且不抛错', async () => {
    const result = await gzipCompress('');
    expect(result.rawBytes).toBe(0);
    expect(result.ratio).toBe(0);
    expect(result.gzippedBytes).toBeGreaterThan(0);
  });

  it('对非 gzip 字节解压抛错', async () => {
    await expect(gunzipText(new TextEncoder().encode('plain text'))).rejects.toThrow();
  });

  it('对含 U+FFFD 的有损字节解压抛错', async () => {
    const lossy = new TextEncoder().encode(String.fromCharCode(0x1f, 0x8b, 0xfffd, 0xfffd));
    await expect(gunzipText(lossy)).rejects.toThrow();
  });

  it('对空字节数组解压抛错', async () => {
    await expect(gunzipText(new Uint8Array(0))).rejects.toThrow();
  });

  it('base64 命中的响应体可完整解出原文', async () => {
    const b64 = Buffer.from(gzipSync(new TextEncoder().encode('round trip'))).toString('base64');
    expect(sniffGzip(b64).via).toBe('base64');
    expect(await gunzipText(gzipDecodeBytes(b64, 'base64'))).toBe('round trip');
  });

  it('压缩结果可直接喂给 toHexDump 与 toBase64', async () => {
    const result = await gzipCompress('hello');
    expect(toHexDump(result.bytes, 4096).startsWith('00000000  1f 8b')).toBe(true);
    expect(toBase64(result.bytes).startsWith('H4sI')).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/body-codec.test.ts`
Expected: FAIL —— `gzipCompress` / `gunzipText` 未导出

- [ ] **Step 3: 追加实现**

在 `src/renderer/src/lib/body-codec.ts` 的 `gzipDecodeBytes` 之后追加：

```ts
export async function gunzipText(bytes: Uint8Array): Promise<string> {
  const out = await readAll(oneShotStream(bytes).pipeThrough(new DecompressionStream('gzip')));
  return new TextDecoder('utf-8', { fatal: true }).decode(out);
}

/** 只返回字节与统计；hex / base64 由视图层按渲染或复制的需要分别格式化。 */
export async function gzipCompress(text: string): Promise<CompressResult> {
  const raw = new TextEncoder().encode(text);
  const bytes = await readAll(oneShotStream(raw).pipeThrough(new CompressionStream('gzip')));
  return {
    rawBytes: raw.byteLength,
    gzippedBytes: bytes.byteLength,
    ratio: raw.byteLength === 0 ? 0 : bytes.byteLength / raw.byteLength,
    bytes,
  };
}

function oneShotStream(bytes: Uint8Array): ReadableStream<Uint8Array<ArrayBuffer>> {
  const copy = new Uint8Array(bytes);
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      if (copy.byteLength > 0) controller.enqueue(copy);
      controller.close();
    },
  });
}

async function readAll<T extends Uint8Array>(stream: ReadableStream<T>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.byteLength;
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/body-codec.test.ts`
Expected: PASS，33 个用例全绿

- [ ] **Step 5: 跑 typecheck**

Run: `npm run typecheck`
Expected: 无输出，退出码 0

若报 `ReadableStream<Uint8Array<ArrayBuffer>>` 与 `pipeThrough` 泛型不匹配，说明本地 TS lib 版本与前提 6 不符；改成 `ReadableStream<any>` 会让两个 tsconfig 都通过，但优先保留精确类型。

- [ ] **Step 6: 提交**

```bash
git add src/renderer/src/lib/body-codec.ts tests/body-codec.test.ts
git commit -m "feat(ui): gzip compress and decompress in body codec"
```

---

### Task 5: `ResponseBodyViews` 组件与样式

**Files:**
- Create: `src/renderer/src/components/ResponseBodyViews.tsx`
- Modify: `src/renderer/src/styles.css`（追加到文件末尾）

- [ ] **Step 1: 追加样式**

在 `src/renderer/src/styles.css` 末尾追加（`.body-tabs` / `.tab` / `.tab.active` 已存在于第 234-251 行，此处只补容器、按钮组、统计行与禁用态）：

```css
.body-view-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 0;
}
.body-view-bar .body-tabs {
  margin-bottom: 0;
}
.body-tabs .tab:disabled {
  opacity: 0.45;
  cursor: default;
}
.body-view-actions {
  display: flex;
  gap: 6px;
  margin-left: auto;
}
.body-view-actions button {
  font-size: 12px;
  padding: 3px 10px;
}
.body-view-actions button:disabled {
  opacity: 0.45;
  cursor: default;
}
.body-gzip-stats {
  font-size: 12px;
  color: #8a8b96;
  margin: 4px 0;
}
```

- [ ] **Step 2: 建组件**

创建 `src/renderer/src/components/ResponseBodyViews.tsx`：

```tsx
import { useEffect, useMemo, useState } from 'react';
import {
  gzipCompress,
  gzipDecodeBytes,
  gunzipText,
  sniffGzip,
  toBase64,
  toHexDump,
  type CompressResult,
} from '../lib/body-codec';
import { pretty } from '../lib/body-format';

type BodyView = 'raw' | 'gunzip' | 'gzip';

const GZIP_INPUT_MAX_BYTES = 5 * 1024 * 1024;
const HEX_RENDER_LIMIT = 4096;

type Calc<T> =
  | { status: 'idle' }
  | { status: 'ok'; value: T }
  | { status: 'error'; message: string }
  | { status: 'too-large'; message: string };

/** DecompressionStream 失败抛的是 message 为空的 TypeError，必须回退到 name。 */
function messageOf(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (e instanceof Error && e.name) return e.name;
  return String(e);
}

interface Props {
  body: string | undefined;
  eventId: string;
}

export default function ResponseBodyViews({ body, eventId }: Props) {
  const text = body ?? '';
  const [view, setView] = useState<BodyView>('raw');
  const [copied, setCopied] = useState<string | null>(null);
  const [gunzipCalc, setGunzipCalc] = useState<Calc<string>>({ status: 'idle' });
  const [gzipCalc, setGzipCalc] = useState<Calc<CompressResult>>({ status: 'idle' });

  const sniff = useMemo(() => sniffGzip(text), [text]);
  const empty = text.length === 0;

  useEffect(() => {
    setView('raw');
    setCopied(null);
    setGunzipCalc({ status: 'idle' });
    setGzipCalc({ status: 'idle' });
  }, [eventId]);

  useEffect(() => {
    if (view !== 'gunzip' || gunzipCalc.status !== 'idle' || !sniff.via) return;
    let cancelled = false;
    gunzipText(gzipDecodeBytes(text, sniff.via))
      .then((value) => {
        if (!cancelled) setGunzipCalc({ status: 'ok', value });
      })
      .catch((e: unknown) => {
        if (!cancelled) setGunzipCalc({ status: 'error', message: messageOf(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [view, gunzipCalc.status, sniff, text]);

  useEffect(() => {
    if (view !== 'gzip' || gzipCalc.status !== 'idle') return;
    const byteLength = new TextEncoder().encode(text).byteLength;
    if (byteLength > GZIP_INPUT_MAX_BYTES) {
      setGzipCalc({
        status: 'too-large',
        message: `响应体过大（${(byteLength / (1024 * 1024)).toFixed(1)} MB），不支持压缩查看`,
      });
      return;
    }
    let cancelled = false;
    gzipCompress(text)
      .then((value) => {
        if (!cancelled) setGzipCalc({ status: 'ok', value });
      })
      .catch((e: unknown) => {
        if (!cancelled) setGzipCalc({ status: 'error', message: messageOf(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [view, gzipCalc.status, text]);

  const copy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
    } catch {
      setCopied(null);
    }
  };
  const label = (key: string, base: string) => (copied === key ? '已复制' : base);
  const tabClass = (v: BodyView) => (view === v ? 'tab active' : 'tab');

  let actions: React.ReactNode = null;
  let content: React.ReactNode = null;

  if (view === 'raw') {
    actions = (
      <button type="button" data-testid="copy-body-raw" disabled={empty} onClick={() => copy('raw', text)}>
        {label('raw', '复制')}
      </button>
    );
    content = <pre data-testid="body-view-content">{pretty(text) || '（无）'}</pre>;
  } else if (view === 'gunzip') {
    if (!sniff.detected) {
      content = (
        <div className="muted" data-testid="body-view-content">
          未检测到 gzip 内容
        </div>
      );
    } else if (gunzipCalc.status === 'ok') {
      actions = (
        <button type="button" data-testid="copy-body-gunzip" onClick={() => copy('gunzip', gunzipCalc.value)}>
          {label('gunzip', '复制')}
        </button>
      );
      content = <pre data-testid="body-view-content">{pretty(gunzipCalc.value) || '（空）'}</pre>;
    } else if (gunzipCalc.status === 'error') {
      content = (
        <div className="text-err" data-testid="body-view-error">
          gzip 解压失败：{gunzipCalc.message}
        </div>
      );
    } else {
      content = <div className="muted">解压中…</div>;
    }
  } else if (gzipCalc.status === 'ok') {
    const r = gzipCalc.value;
    actions = (
      <>
        <button type="button" data-testid="copy-body-hex" onClick={() => copy('hex', toHexDump(r.bytes))}>
          {label('hex', '复制 hex')}
        </button>
        <button type="button" data-testid="copy-body-base64" onClick={() => copy('base64', toBase64(r.bytes))}>
          {label('base64', '复制 base64')}
        </button>
      </>
    );
    content = (
      <>
        <div className="body-gzip-stats" data-testid="body-gzip-stats">
          原始 {r.rawBytes.toLocaleString('en-US')} B → gzip {r.gzippedBytes.toLocaleString('en-US')} B（
          {(r.ratio * 100).toFixed(1)}%）
        </div>
        <pre data-testid="body-view-content">{toHexDump(r.bytes, HEX_RENDER_LIMIT)}</pre>
      </>
    );
  } else if (gzipCalc.status === 'error') {
    content = (
      <div className="text-err" data-testid="body-view-error">
        gzip 压缩失败：{gzipCalc.message}
      </div>
    );
  } else if (gzipCalc.status === 'too-large') {
    content = (
      <div className="text-warn" data-testid="body-view-error">
        {gzipCalc.message}
      </div>
    );
  } else {
    content = <div className="muted">压缩中…</div>;
  }

  return (
    <div className="body-view">
      <div className="body-view-bar">
        <div className="body-tabs">
          <button type="button" className={tabClass('raw')} data-testid="body-view-raw" onClick={() => setView('raw')}>
            原始
          </button>
          <button
            type="button"
            className={tabClass('gunzip')}
            data-testid="body-view-gunzip"
            disabled={!sniff.detected || empty}
            onClick={() => setView('gunzip')}
          >
            gzip 解压
          </button>
          <button
            type="button"
            className={tabClass('gzip')}
            data-testid="body-view-gzip"
            disabled={empty}
            onClick={() => setView('gzip')}
          >
            gzip 压缩
          </button>
        </div>
        <div className="body-view-actions">{actions}</div>
      </div>
      {content}
    </div>
  );
}
```

实现要点，改代码时不要偏离：

- 两个计算 effect 的守卫都是 `status !== 'idle'`，配合切换请求时的重置 effect，保证**每个视图每个请求最多算一次**
- 切换请求时重置 effect 先于计算 effect 声明，因此同一轮里计算 effect 看到的 `status` 仍是旧值（`ok`），守卫直接短路，不会用新 `text` 触发一次多余计算；随后重渲染 `view` 已回到 `raw`
- 每个异步分支都带 `cancelled` 标志，effect cleanup 时置位，避免请求快速切换时把旧结果写进新请求的 state
- `sniff.via` 为空时解压 effect 直接返回；该 tab 本身也 `disabled`，双重保险避免空转循环
- 复制按钮只在有内容可复制时渲染：解压失败 / 压缩失败 / 过大 三种情况下没有复制按钮

- [ ] **Step 3: 跑 typecheck**

Run: `npm run typecheck`
Expected: 无输出，退出码 0

若报 `React.ReactNode` 找不到，在文件顶部 import 行补 `import type { ReactNode } from 'react';` 并把两处 `React.ReactNode` 换成 `ReactNode`。

- [ ] **Step 4: 跑全量单测确认没有回归**

Run: `npm test`
Expected: 全部 PASS（此时组件还没被引用，不影响既有用例）

- [ ] **Step 5: 提交**

```bash
git add src/renderer/src/components/ResponseBodyViews.tsx src/renderer/src/styles.css
git commit -m "feat(ui): response body view switcher with gzip and copy actions"
```

---

### Task 6: 接线 `TrafficDetail`

**Files:**
- Modify: `src/renderer/src/components/TrafficDetail.tsx:1-16`（删除本地 `pretty`，改 import）
- Modify: `src/renderer/src/components/TrafficDetail.tsx:129-130`（响应体小节）

- [ ] **Step 1: 替换文件头**

把 `TrafficDetail.tsx` 第 1-16 行整体替换为：

```tsx
import { useEffect, useState } from 'react';
import type { TrafficEvent } from '../../../shared/types';
import { api } from '../lib/api';
import { pretty } from '../lib/body-format';
import { buildCurl, defaultDialectFor, type CurlDialect } from '../lib/curl';
import ResponseBodyViews from './ResponseBodyViews';
```

即：删掉本地的 `pretty` 函数定义（原第 6-16 行），改为从 `../lib/body-format` 导入；新增 `ResponseBodyViews` 导入。`HeaderTable` 与其余代码保持不动。

- [ ] **Step 2: 替换响应体小节**

把原第 129-130 行：

```tsx
      <h4>响应体</h4>
      <pre>{pretty(event.responseBody) || '（无）'}</pre>
```

替换为：

```tsx
      <h4>响应体</h4>
      <ResponseBodyViews body={event.responseBody} eventId={event.id} />
```

请求体小节（`<h4>请求体</h4>` 那两行）保持原样，继续用 `pretty`。

- [ ] **Step 3: 跑 typecheck 与全量单测**

Run: `npm run typecheck && npm test`
Expected: typecheck 无输出；单测全部 PASS

- [ ] **Step 4: 起 dev 手工验证一遍**

Run: `npm run dev`

在「流量」页随便选一条请求，逐项确认：

1. 响应体上方出现「原始 / gzip 解压 / gzip 压缩」三个小 tab，右侧有「复制」按钮
2. 普通明文响应体：解压 tab 是灰的（不可点），原始 tab 内容与改动前一致（JSON 仍被美化缩进）
3. 点「复制」→ 按钮文案变「已复制」
4. 点「gzip 压缩」→ 出现统计行与 hex dump，首行以 `00000000  1f 8b` 开头，右侧变成「复制 hex」「复制 base64」两个按钮
5. 切换到另一条请求 → tab 自动回到「原始」，复制态清空
6. 请求体区域渲染没有任何变化

验证完关掉 dev 进程。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/src/components/TrafficDetail.tsx
git commit -m "feat(ui): wire response body views into traffic detail"
```

---

### Task 7: E2E

**Files:**
- Create: `e2e/traffic-body-views.spec.ts`

- [ ] **Step 1: 写 e2e**

创建 `e2e/traffic-body-views.spec.ts`：

```ts
import { _electron as electron, test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { fetch, ProxyAgent } from 'undici';
import { gzipSync } from 'node:zlib';

let app: ElectronApplication;
let win: Page;

const RULE_NAMES = ['e2e-body-gzip-b64', 'e2e-body-plain'];
const PLAIN = '{"msg":"gzip 世界"}';
const B64_BODY = Buffer.from(gzipSync(new TextEncoder().encode(PLAIN), { level: 9 })).toString('base64');

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'] });
  win = await app.firstWindow();
});

test.afterAll(async () => {
  await win.evaluate(async (names: string[]) => {
    for (const r of await window.api.rulesList()) {
      if (names.includes(r.name)) await window.api.rulesRemove(r.id);
    }
  }, RULE_NAMES);
  await app.close();
});

async function ensureProxy(): Promise<number> {
  await win.evaluate(async () => {
    const status = await window.api.proxyStatus();
    if (!status.running) await window.api.proxyStart();
  });
  return (await win.evaluate(() => window.api.proxyStatus())).port;
}

async function fetchViaProxy(port: number, method: string, url: string): Promise<void> {
  const agent = new ProxyAgent(`http://127.0.0.1:${port}`);
  try {
    await fetch(url, { method, dispatcher: agent });
  } finally {
    await agent.close();
  }
}

async function selectRow(keyword: string): Promise<void> {
  const row = win.locator('.traffic-table .row', { hasText: keyword }).first();
  await row.waitFor({ state: 'visible', timeout: 10_000 });
  await row.click();
}

test('base64 gzip 响应体可解压查看，且原始视图不被改写', async () => {
  const port = await ensureProxy();
  await win.evaluate(
    async ([name, body]: [string, string]) => {
      await window.api.rulesAdd({
        name,
        enabled: true,
        match: { urlType: 'exact', urlPattern: 'http://e2e.example.test/body-gzip', method: 'GET' },
        action: { status: 200, headers: { 'content-type': 'text/plain' }, body },
      });
    },
    [RULE_NAMES[0]!, B64_BODY] as [string, string],
  );

  await fetchViaProxy(port, 'GET', 'http://e2e.example.test/body-gzip');
  await selectRow('body-gzip');

  const content = win.locator('[data-testid="body-view-content"]');

  await expect(content).toContainText(B64_BODY.slice(0, 24), { timeout: 5_000 });

  const gunzipTab = win.locator('[data-testid="body-view-gunzip"]');
  await expect(gunzipTab).toBeEnabled();
  await gunzipTab.click();
  await expect(content).toContainText('gzip 世界', { timeout: 5_000 });

  const copyGunzip = win.locator('[data-testid="copy-body-gunzip"]');
  await expect(copyGunzip).toBeVisible();
  await copyGunzip.click();
  await expect(copyGunzip).toHaveText('已复制', { timeout: 5_000 });

  await win.locator('[data-testid="body-view-gzip"]').click();
  await expect(win.locator('[data-testid="body-gzip-stats"]')).toContainText('原始', { timeout: 5_000 });
  await expect(content).toContainText(/1f 8b/);
  await expect(content).toContainText(/00000000/);

  const copyBase64 = win.locator('[data-testid="copy-body-base64"]');
  await expect(copyBase64).toBeVisible();
  await expect(win.locator('[data-testid="copy-body-hex"]')).toBeVisible();
  await copyBase64.click();
  await expect(copyBase64).toHaveText('已复制', { timeout: 5_000 });

  await win.locator('[data-testid="body-view-raw"]').click();
  await expect(content).toContainText(B64_BODY.slice(0, 24), { timeout: 5_000 });
});

test('普通明文响应体的解压 tab 置灰，压缩视图仍可用', async () => {
  const port = await ensureProxy();
  await win.evaluate(async (name: string) => {
    await window.api.rulesAdd({
      name,
      enabled: true,
      match: { urlType: 'exact', urlPattern: 'http://e2e.example.test/body-plain', method: 'GET' },
      action: { status: 200, headers: { 'content-type': 'text/plain' }, body: 'just plain text' },
    });
  }, RULE_NAMES[1]!);

  await fetchViaProxy(port, 'GET', 'http://e2e.example.test/body-plain');
  await selectRow('body-plain');

  const content = win.locator('[data-testid="body-view-content"]');
  await expect(content).toContainText('just plain text', { timeout: 5_000 });
  await expect(win.locator('[data-testid="body-view-gunzip"]')).toBeDisabled();

  const copyRaw = win.locator('[data-testid="copy-body-raw"]');
  await expect(copyRaw).toBeVisible();
  await copyRaw.click();
  await expect(copyRaw).toHaveText('已复制', { timeout: 5_000 });

  await win.locator('[data-testid="body-view-gzip"]').click();
  await expect(win.locator('[data-testid="body-gzip-stats"]')).toContainText('gzip', { timeout: 5_000 });
  await expect(content).toContainText(/1f 8b/);
});
```

写法说明：

- `toContainText(/1f 8b/)` 用正则而不是字面量，因为 Playwright 对字符串匹配会做空白归一化，hex dump 里的连续空格不可靠
- 剪贴板只断言按钮反馈文案（与既有 `e2e/traffic-ops.spec.ts` 的 copy as cURL 用例一致），不读剪贴板内容，避免权限相关的偶发失败
- 规则 body 用 base64 而非原始 gzip 字节：base64 是纯 ASCII，能完整穿过「mock 规则 → 代理 → `TrafficEvent.responseBody` 字符串」这条链路；原始字节会被 UTF-8 解码破坏

- [ ] **Step 2: 跑 e2e**

Run: `npm run test:e2e`
Expected: 全部 PASS，包含新增的 2 个用例

若 `body-gzip` 那条找不到行，先确认 dev 遗留的代理端口没被占用（`npm run test:e2e` 会先 build）。

- [ ] **Step 3: 提交**

```bash
git add e2e/traffic-body-views.spec.ts
git commit -m "test(e2e): response body gzip view switch coverage"
```

---

### Task 8: 文档与全量校验

**Files:**
- Modify: `README.md:8`（功能列表）
- Modify: `README.md:226-231`（「流量操作」小节）

- [ ] **Step 1: 更新功能列表**

把 `README.md` 第 8 行：

```markdown
- 实时流量列表与请求/响应详情（分面过滤 / 重放 / Copy as cURL / HAR 导入导出）
```

改为：

```markdown
- 实时流量列表与请求/响应详情（分面过滤 / 重放 / Copy as cURL / HAR 导入导出 / 响应体 gzip 视图）
```

- [ ] **Step 2: 更新「流量操作」小节**

把 `README.md` 第 226 行的「四个日常操作」改为「五个日常操作」，并在第 230 行（Copy as cURL 那条）之后插入一条：

```markdown
- **响应体多视图**：详情区响应体可在「原始 / gzip 解压 / gzip 压缩」三个小 tab 间切换，每个视图各自带复制按钮，压缩视图另有「复制 base64」。解压与压缩都是派生视图，不改写抓到的响应体本身；解压 tab 仅在响应体嗅探到 gzip 魔数时可用（原始字节或 base64 形式，后者更可靠，因为抓包链路已自动解过一层 `content-encoding`）。压缩视图给出原始/压缩后字节数与压缩率，hex dump 最多渲染前 4 KiB，但复制的是完整内容；响应体超过 5 MiB 时不做压缩
```

- [ ] **Step 3: 全量校验**

Run: `npm run typecheck && npm test`
Expected: typecheck 无输出；单测全部 PASS

Run: `npm run test:e2e`
Expected: 全部 PASS

- [ ] **Step 4: 提交**

```bash
git add README.md
git commit -m "docs: response body gzip views in traffic operation guide"
```

---

## Self-Review 结果

**Spec 覆盖：**

| Spec 章节 | 实现任务 |
|---|---|
| §3 模块边界（5 个单元） | Task 1 / 2-4 / 5 / 6 / 5 |
| §4.1 导出接口 | Task 2（sniff、decodeBytes）、Task 3（hex、base64）、Task 4（gunzip、compress） |
| §4.2 嗅探四步 | Task 2 Step 1 的 9 个 sniff 用例 + Step 3 实现 |
| §4.3 两条还原路径与有损说明 | Task 2 的 `gzipDecodeBytes` 用例；Task 4 的有损字节抛错用例 |
| §4.4 hex dump 格式 | Task 3 的 7 个 toHexDump 用例 |
| §4.5 base64 分块 / 压缩 / fatal 解码 | Task 3 的 toBase64 用例；Task 4 的实现与用例 |
| §5 UI 结构、按钮矩阵、testid | Task 5 Step 2；Task 7 断言 |
| §5 复制不继承显示截断 | Task 5 实现（copy 用 `text` / `gunzipCalc.value` / `toHexDump(r.bytes)`，均不经 `pretty`） |
| §6 懒计算、5 MiB、4 KiB、500k | Task 5 Step 2 的两个 effect 守卫与常量 |
| §7 错误处理六行（含 message 回退） | Task 5 的 `messageOf` 与各分支；Task 4 的抛错用例 |
| §8 回归面 | Task 6 Step 4 手工验证第 6 项；Task 8 Step 3 全量校验 |
| §9 单测两个文件 + e2e | Task 1 / 2-4 / 7 |

**类型一致性：** `CompressResult.bytes`（Task 2 声明、Task 4 填充、Task 5 消费为 `r.bytes`）；`GzipVia`（Task 2 声明，Task 5 经 `sniff.via` 传给 `gzipDecodeBytes`）；`pretty`（Task 1 定义，Task 5 与 Task 6 导入）；testid 命名在 Task 5 与 Task 7 间逐一对齐。

**未覆盖项（有意为之）：** `ResponseBodyViews` 没有 React 单测——仓库无 jsdom / testing-library，既有组件一律靠 e2e 覆盖，此处沿用现状而非新引入测试栈。
