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
