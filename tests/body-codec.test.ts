import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  gzipCompress,
  gzipDecodeBytes,
  gunzipText,
  sniffGzip,
  toBase64,
  toHexDump,
} from '../src/renderer/src/lib/body-codec';

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
