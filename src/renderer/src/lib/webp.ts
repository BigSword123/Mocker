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
