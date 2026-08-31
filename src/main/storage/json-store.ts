import { promises as fs } from 'node:fs';
import * as path from 'node:path';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class JsonStore<T> {
  private pending: Promise<void> = Promise.resolve();
  private tmpCounter = 0;

  constructor(
    private readonly filePath: string,
    private readonly defaults: T,
  ) {}

  async read(): Promise<T> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return clone(this.defaults);
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.quarantine();
      return clone(this.defaults);
    }
    if (Array.isArray(this.defaults)) {
      return Array.isArray(parsed) ? (parsed as T) : clone(this.defaults);
    }
    if (isPlainObject(this.defaults) && isPlainObject(parsed)) {
      return { ...this.defaults, ...parsed } as T;
    }
    return clone(this.defaults);
  }

  async write(value: T): Promise<void> {
    const task = this.pending.then(() => this.doWrite(value));
    this.pending = task.catch(() => {});
    await task;
  }

  private async doWrite(value: T): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${this.tmpCounter++}`;
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await fs.rename(tmp, this.filePath);
  }

  private async quarantine(): Promise<void> {
    try {
      await fs.rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
    } catch {
      // 文件已不存在则忽略
    }
  }
}
