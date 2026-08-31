import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export class JsonStore<T> {
  constructor(
    private readonly filePath: string,
    private readonly defaults: T,
  ) {}

  async read(): Promise<T> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      return { ...this.defaults, ...JSON.parse(raw) };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...this.defaults };
      await this.quarantine();
      return { ...this.defaults };
    }
  }

  async write(value: T): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
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
