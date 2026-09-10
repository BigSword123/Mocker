import * as zlib from 'node:zlib';
import { promisify } from 'node:util';

// 主进程跑着 mockttp 代理，同步解压大文件会冻住抓包，必须用异步版
const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);

export const MAX_GUNZIP_BYTES = 256 * 1024 * 1024;

export async function gzipCompressBytes(buf: Uint8Array, level = 9): Promise<Buffer> {
  return Buffer.from(await gzipAsync(Buffer.from(buf), { level }));
}

export async function gzipDecompressBytes(
  buf: Uint8Array,
  maxOutputBytes = MAX_GUNZIP_BYTES,
): Promise<Buffer> {
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
