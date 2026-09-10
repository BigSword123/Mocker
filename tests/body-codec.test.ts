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
