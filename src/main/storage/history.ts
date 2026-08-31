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
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `session-${Date.now()}.jsonl`);
    this.stream = fs.createWriteStream(file, { flags: 'a' });
  }

  write(event: TrafficEvent): void {
    if (!this.stream) return;
    this.stream.write(JSON.stringify(event) + '\n');
  }

  closeSession(): Promise<void> {
    if (!this.stream) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.stream!.end(() => resolve());
      this.stream = null;
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
