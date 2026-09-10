import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Dirent } from 'node:fs';
import type { ScannedImage } from '../../shared/types';

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg'] as const;
export const DEFAULT_SCAN_LIMIT = 5000;

/** 把 relPath 的原扩展名换成 .webp；a/b.png -> a/b.webp */
function webpName(relPath: string): string {
  return relPath.replace(/\.[^.]+$/, '.webp');
}

/** dir 与 relPath 都来自渲染进程 IPC，resolve 后必须仍落在 dir 内 */
function resolveInside(dir: string, rel: string): string {
  const root = path.resolve(dir);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('路径越界，拒绝访问源目录之外的文件');
  }
  return abs;
}

export async function scanImages(dir: string, limit = DEFAULT_SCAN_LIMIT): Promise<ScannedImage[]> {
  const found: { relPath: string; ext: string; size: number }[] = [];

  const walk = async (abs: string, rel: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return; // 无权限或已消失的子目录直接跳过，不让整批失败
    }
    for (const e of entries) {
      // 超限即停：否则防卡死的 limit 起不到作用（用户误选家目录时仍会走完整棵树）
      if (found.length > limit) return;
      const relChild = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        await walk(path.join(abs, e.name), relChild);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!(IMAGE_EXTENSIONS as readonly string[]).includes(ext)) continue;
      const st = await fs.stat(path.join(abs, e.name));
      found.push({ relPath: relChild, ext, size: st.size });
    }
  };

  await walk(path.resolve(dir), '');
  if (found.length > limit) {
    throw new Error(`匹配图片超过 ${limit} 张，请选择更小的子目录`);
  }

  // 同目录下 a.png 与 a.jpg 都会映射到 a.webp，撞名的一组全部保留原扩展名，避免静默互相覆盖
  const counts = new Map<string, number>();
  for (const f of found) {
    const n = webpName(f.relPath);
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  return found.map((f) => ({
    ...f,
    outName: counts.get(webpName(f.relPath))! > 1 ? `${f.relPath}.webp` : webpName(f.relPath),
  }));
}

export async function readImage(dir: string, relPath: string): Promise<Uint8Array> {
  return new Uint8Array(await fs.readFile(resolveInside(dir, relPath)));
}

export async function writeWebp(outDir: string, outName: string, bytes: Uint8Array): Promise<string> {
  const abs = resolveInside(outDir, outName);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, bytes);
  return abs;
}
