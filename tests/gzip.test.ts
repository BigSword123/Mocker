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
