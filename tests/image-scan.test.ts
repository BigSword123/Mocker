import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_SCAN_LIMIT, readImage, scanImages, writeWebp } from '../src/main/tools/image-scan';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mocker-scan-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const touch = async (rel: string, content = 'x') => {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
};

describe('scanImages', () => {
  test('空目录返回空数组', async () => {
    expect(await scanImages(root)).toEqual([]);
  });

  test('递归收集 png/jpg/jpeg，忽略其它扩展名', async () => {
    await touch('a.png');
    await touch('sub/b.jpg');
    await touch('sub/deep/c.jpeg');
    await touch('skip.gif');
    await touch('skip.webp');
    await touch('notes.txt');

    const r = await scanImages(root);
    expect(r.map((f) => f.relPath).sort()).toEqual(['a.png', 'sub/b.jpg', 'sub/deep/c.jpeg']);
  });

  test('扩展名大小写不敏感', async () => {
    await touch('A.PNG');
    await touch('B.JpG');
    const r = await scanImages(root);
    expect(r.map((f) => f.relPath).sort()).toEqual(['A.PNG', 'B.JpG']);
    expect(r.map((f) => f.ext).sort()).toEqual(['.jpg', '.png']);
  });

  test('relPath 用 POSIX 分隔符，size 为真实字节数', async () => {
    await touch('sub/dir/pic.png', 'hello');
    const r = await scanImages(root);
    expect(r).toEqual([{ relPath: 'sub/dir/pic.png', ext: '.png', size: 5, outName: 'sub/dir/pic.webp' }]);
  });

  test('outName 把原扩展名替换为 .webp', async () => {
    await touch('a/b.jpeg');
    const r = await scanImages(root);
    expect(r[0]!.outName).toBe('a/b.webp');
  });

  test('同目录 b.png 与 b.jpg 撞名时两个都保留原扩展名', async () => {
    await touch('d/b.png');
    await touch('d/b.jpg');
    const r = await scanImages(root);
    expect(r.map((f) => f.outName).sort()).toEqual(['d/b.jpg.webp', 'd/b.png.webp']);
  });

  test('不撞名时不受其它目录同名文件影响', async () => {
    await touch('x/b.png');
    await touch('y/b.jpg');
    const r = await scanImages(root);
    expect(r.map((f) => f.outName).sort()).toEqual(['x/b.webp', 'y/b.webp']);
  });

  test('超过 limit 抛可操作的错误', async () => {
    for (let i = 0; i < 5; i++) await touch(`p${i}.png`);
    await expect(scanImages(root, 4)).rejects.toThrow(/超过 4 张/);
    expect((await scanImages(root, 5)).length).toBe(5);
  });

  test('limit 默认为 5000', () => {
    expect(DEFAULT_SCAN_LIMIT).toBe(5000);
  });
});

describe('readImage', () => {
  test('读到真实字节', async () => {
    await touch('a.png', 'PNGDATA');
    const bytes = await readImage(root, 'a.png');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(bytes).toString('utf8')).toBe('PNGDATA');
  });

  test('拒绝越出源目录的 relPath', async () => {
    await touch('a.png');
    await expect(readImage(root, '../secret.png')).rejects.toThrow(/越界/);
    await expect(readImage(root, '/etc/passwd')).rejects.toThrow(/越界/);
  });
});

describe('writeWebp', () => {
  test('自动建父目录并镜像结构', async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'mocker-out-'));
    try {
      const p = await writeWebp(out, 'sub/dir/a.webp', new Uint8Array([1, 2, 3]));
      expect(p).toBe(path.join(out, 'sub/dir/a.webp'));
      expect(Buffer.from(await fs.readFile(p))).toEqual(Buffer.from([1, 2, 3]));
    } finally {
      await fs.rm(out, { recursive: true, force: true });
    }
  });

  test('拒绝越出输出目录的 outName', async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'mocker-out-'));
    try {
      await expect(writeWebp(out, '../evil.webp', new Uint8Array([1]))).rejects.toThrow(/越界/);
    } finally {
      await fs.rm(out, { recursive: true, force: true });
    }
  });
});
