const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;
const BASE64_PREFIX_LEN = 16;
const BASE64_PREFIX_PATTERN = /^[A-Za-z0-9+/=]+$/;
const BASE64_MIN_PREFIX_LEN = 4;
const HEX_ROW_BYTES = 16;
const BASE64_CHUNK_BYTES = 8192;

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

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
