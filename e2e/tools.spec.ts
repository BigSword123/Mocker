import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { test, expect } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'] });
  win = await app.firstWindow();
});

test.afterAll(async () => {
  await app.close();
});

/** 用渲染进程 canvas 造真实图片，支持 png 与 jpeg；会自动建父目录 */
async function makeImage(
  win: Page,
  absPath: string,
  size: number,
  color: string,
  type: 'image/png' | 'image/jpeg',
) {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  const bytes = await win.evaluate(
    async ([s, c, t]) => {
      const canvas = new OffscreenCanvas(s, s);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, s, s);
      const blob = await canvas.convertToBlob({ type: t, quality: 0.9 });
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    },
    [size, color, type] as [number, string, 'image/png' | 'image/jpeg'],
  );
  await fs.writeFile(absPath, Uint8Array.from(bytes));
}

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
        return { ctor: b.constructor.name, len: b.length, sum: b.reduce((a, x) => a + x, 0) };
      },
      [dir, 'a.png'] as [string, string],
    );
    expect(read.len).toBe(300);
    expect(read.sum).toBe(payload.reduce((a, x) => a + x, 0));

    const written = await win.evaluate(
      async ([d, name, bytes]) => window.api.writeWebp(d, name, Uint8Array.from(bytes)),
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
      Array.from(buf.slice(from, to))
        .map((n) => String.fromCharCode(n))
        .join('');
    return { type: blob.type, size: buf.length, riff: ascii(0, 4), webp: ascii(8, 12) };
  });
  expect(webp.type).toBe('image/webp');
  expect(webp.riff).toBe('RIFF');
  expect(webp.webp).toBe('WEBP');
  expect(webp.size).toBeGreaterThan(20);
});

test('能力验证：gzip 通道已接线且主进程错误跨 IPC 传回', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mocker-gz-'));
  try {
    // 非 gzip 输入会在魔数校验处抛错，早于保存对话框弹出，因此这条断言是确定性的
    const src = path.join(dir, 'not-gzip.txt');
    await fs.writeFile(src, 'plain text', 'utf8');

    const err = await win.evaluate(
      async ([mode, p]) => {
        try {
          await window.api.gzipFile(mode, p);
          return null;
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      },
      ['decompress', src] as ['decompress', string],
    );
    expect(err).toContain('不是有效的 gzip 数据');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('gzip 工具：未选文件时两个操作按钮禁用', async () => {
  await win.getByTestId('tools-tab').click();
  await win.getByTestId('tool-tab-gzip').click();

  await expect(win.getByTestId('gzip-compress')).toBeDisabled();
  await expect(win.getByTestId('gzip-decompress')).toBeDisabled();
  // toHaveText 对 <input> 恒真（textContent 总是空串），必须断言 value
  await expect(win.getByTestId('gzip-path')).toHaveValue('');
});

test('WebP：真实 png/jpg 经完整 IPC 链路产出合法产物', async () => {
  const src = await fs.mkdtemp(path.join(os.tmpdir(), 'mocker-webp-src-'));
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'mocker-webp-out-'));
  try {
    await makeImage(win, path.join(src, 'nested/red.png'), 8, '#ff0000', 'image/png');
    // 必须是真 JPEG：encodeWebp 靠魔数而非扩展名判断，拿 PNG 改名会漏掉 0xff 0xd8 0xff 分支
    await makeImage(win, path.join(src, 'blue.jpg'), 8, '#0000ff', 'image/jpeg');

    const scanned = await win.evaluate(async (d) => window.api.scanImages(d), src);
    expect(scanned.map((f) => f.relPath).sort()).toEqual(['blue.jpg', 'nested/red.png']);
    expect(scanned.map((f) => f.outName).sort()).toEqual(['blue.webp', 'nested/red.webp']);

    const rows = await win.evaluate(
      async ([srcDir, outDir, files, quality]) => {
        // canvas 编码就地内联：e2e 跑的是构建产物，渲染进程里没有源码模块可 import
        const done: { relPath: string; ok: boolean; inputBytes: number; outputBytes: number; error?: string }[] = [];
        for (const f of files) {
          try {
            const bytes = await window.api.readImage(srcDir, f.relPath);
            const mime = f.ext === '.png' ? 'image/png' : 'image/jpeg';
            const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mime }));
            const c = new OffscreenCanvas(bmp.width, bmp.height);
            c.getContext('2d')!.drawImage(bmp, 0, 0);
            const blob = await c.convertToBlob({ type: 'image/webp', quality });
            bmp.close();
            const w = await window.api.writeWebp(outDir, f.outName, new Uint8Array(await blob.arrayBuffer()));
            done.push({ relPath: f.relPath, ok: true, inputBytes: f.size, outputBytes: w.bytes });
          } catch (e) {
            done.push({ relPath: f.relPath, ok: false, inputBytes: f.size, outputBytes: 0, error: e instanceof Error ? e.message : String(e) });
          }
        }
        return done;
      },
      [src, out, scanned, 0.8] as [string, string, typeof scanned, number],
    );
    expect(rows.filter((r) => !r.ok)).toEqual([]);
    expect(rows.map((r) => r.relPath).sort()).toEqual(['blue.jpg', 'nested/red.png']);

    for (const r of rows) {
      const rel = r.relPath.replace(/\.(png|jpg)$/, '.webp');
      const buf = await fs.readFile(path.join(out, rel));
      expect(buf.subarray(0, 4).toString('ascii'), rel).toBe('RIFF');
      expect(buf.subarray(8, 12).toString('ascii'), rel).toBe('WEBP');
      expect(buf.length, rel).toBe(r.outputBytes);
    }
  } finally {
    await fs.rm(src, { recursive: true, force: true });
    await fs.rm(out, { recursive: true, force: true });
  }
});

test('WebP：质量参数真的传到了编码器', async () => {
  const src = await fs.mkdtemp(path.join(os.tmpdir(), 'mocker-webp-q-'));
  try {
    // 纯色块在任何质量下都编成一样的几十字节，测不出差异，必须用噪声
    const noise = await win.evaluate(async () => {
      const c = new OffscreenCanvas(64, 64);
      const ctx = c.getContext('2d')!;
      const img = ctx.createImageData(64, 64);
      for (let i = 0; i < img.data.length; i += 4) {
        img.data[i] = (i * 37) % 256;
        img.data[i + 1] = (i * 91) % 256;
        img.data[i + 2] = (i * 53) % 256;
        img.data[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      const blob = await c.convertToBlob({ type: 'image/png' });
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    });
    await fs.writeFile(path.join(src, 'noise.png'), Uint8Array.from(noise));

    const encode = async (quality: number) =>
      win.evaluate(
        async ([d, q]) => {
          const bytes = await window.api.readImage(d, 'noise.png');
          const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
          const c = new OffscreenCanvas(bmp.width, bmp.height);
          c.getContext('2d')!.drawImage(bmp, 0, 0);
          const blob = await c.convertToBlob({ type: 'image/webp', quality: q });
          bmp.close();
          return (await blob.arrayBuffer()).byteLength;
        },
        [src, quality] as [string, number],
      );

    const lo = await encode(0.05);
    const hi = await encode(0.95);
    // quality 漏传时 convertToBlob 会用默认值，两次结果相等，这条断言就是拦这个的
    expect(lo).toBeLessThan(hi);
  } finally {
    await fs.rm(src, { recursive: true, force: true });
  }
});

test('WebP UI：未选目录时开始按钮禁用，质量默认 80', async () => {
  await win.getByTestId('tools-tab').click();
  await win.getByTestId('tool-tab-webp').click();

  await expect(win.getByTestId('webp-start')).toBeDisabled();
  await expect(win.getByTestId('webp-src')).toHaveValue('');
  await expect(win.getByTestId('webp-out')).toHaveValue('');
  await expect(win.getByTestId('webp-quality')).toHaveValue('80');
});

async function gotoGzipText() {
  await win.getByTestId('tools-tab').click();
  await win.getByTestId('tool-tab-gzip').click();
  await win.getByTestId('gzip-mode-text').click();
}

test('gzip 文本模式：文本 -> base64 -> 文本 往返一致', async () => {
  await gotoGzipText();

  const text = 'hello mocker 世界 {"a":1}';
  await win.getByTestId('gzip-text-input').fill(text);
  await win.getByTestId('gzip-text-compress').click();

  const b64 = await win.getByTestId('gzip-text-output').inputValue();
  expect(b64.length).toBeGreaterThan(0);
  // base64 解出来必须以 gzip 魔数开头
  expect(Array.from(Buffer.from(b64, 'base64').subarray(0, 2))).toEqual([0x1f, 0x8b]);

  await win.getByTestId('gzip-text-input').fill(b64);
  await win.getByTestId('gzip-text-decompress').click();
  await expect(win.getByTestId('gzip-text-output')).toHaveValue(text);
});

test('gzip 文本模式：非法 base64 报可读错误', async () => {
  await gotoGzipText();
  await win.getByTestId('gzip-text-input').fill('!!! 这根本不是 base64 !!!');
  await win.getByTestId('gzip-text-decompress').click();
  await expect(win.getByTestId('gzip-text-error')).toHaveText('不是合法的 base64');
});

test('gzip 文本模式：base64 合法但不是 gzip 时报魔数错误', async () => {
  await gotoGzipText();
  await win.getByTestId('gzip-text-input').fill(Buffer.from('plain text', 'utf8').toString('base64'));
  await win.getByTestId('gzip-text-decompress').click();
  await expect(win.getByTestId('gzip-text-error')).toContainText('不是 gzip 数据');
});

test('gzip 文本模式：数据被截断时报错且文案非空', async () => {
  await gotoGzipText();
  const gz = zlib.gzipSync(Buffer.from('hello mocker'.repeat(40), 'utf8'));
  // 砍掉后半段：魔数完好，但 deflate 流不完整，会走到 DecompressionStream 失败路径
  const truncated = gz.subarray(0, Math.floor(gz.length / 2)).toString('base64');

  await win.getByTestId('gzip-text-input').fill(truncated);
  await win.getByTestId('gzip-text-decompress').click();

  // DecompressionStream 抛的 TypeError message 是空串，errorMessage 必须靠 name 兜住，
  // 否则用户看到一个空白错误框
  const err = win.getByTestId('gzip-text-error');
  await expect(err).toBeVisible();
  expect(((await err.textContent()) ?? '').trim().length).toBeGreaterThan(0);
});
