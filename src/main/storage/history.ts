import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TrafficEvent } from '../../shared/types';

export class HistoryWriter {
  private stream: fs.WriteStream | null = null;

  constructor(
    private readonly dir: string,
    private readonly maxSessions = 20,
  ) {}

  openSession(): void {
    if (this.stream) {
      const old = this.stream;
      old.on('error', () => {});
      old.end();
    }
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `session-${Date.now()}.jsonl`);
    this.stream = fs.createWriteStream(file, { flags: 'a' });
    this.stream.on('error', () => {
      this.stream = null;
    });
  }

  write(event: TrafficEvent): void {
    if (!this.stream) return;
    this.stream.write(JSON.stringify(event) + '\n');
  }

  async closeSession(): Promise<void> {
    const stream = this.stream;
    this.stream = null;
    if (!stream) return;
    await new Promise<void>((resolve) => {
      stream.once('error', () => resolve());
      stream.end(() => resolve());
    });
  }

  async prune(): Promise<void> {
    const files = (await fs.promises.readdir(this.dir))
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(this.dir, f))
      .sort();
    while (files.length > this.maxSessions) {
      await fs.promises.unlink(files.shift()!);
    }
  }
}
