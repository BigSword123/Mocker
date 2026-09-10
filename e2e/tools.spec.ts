import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { test, expect } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

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
