import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HistoryWriter } from '../src/main/storage/history';
import type { TrafficEvent } from '../src/shared/types';

let dir: string;

const event = (id: string): TrafficEvent => ({
  id,
  startedAt: Date.now(),
  method: 'GET',
  url: 'http://x.com/',
  host: 'x.com',
  path: '/',
  requestHeaders: {},
  mocked: false,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mocker-history-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('HistoryWriter', () => {
  it('writes events as jsonl into the open session file', async () => {
    const writer = new HistoryWriter(dir);
    writer.openSession();
    writer.write(event('e1'));
    writer.write(event('e2'));
    await writer.closeSession();
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    const lines = (await readFile(join(dir, files[0]), 'utf8')).trim().split('\n');
    expect(lines.map((l) => JSON.parse(l).id)).toEqual(['e1', 'e2']);
  });

  it('ignores writes when no session is open', () => {
    const writer = new HistoryWriter(dir);
    expect(() => writer.write(event('e1'))).not.toThrow();
  });

  it('prunes old sessions beyond the limit', async () => {
    const writer = new HistoryWriter(dir, 2);
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 5));
      writer.openSession();
      writer.write(event(`e${i}`));
      await writer.closeSession();
    }
    await writer.prune();
    const files = await readdir(dir);
    expect(files).toHaveLength(2);
  });

  it('opening a second session while one is open does not throw and keeps writing to the newest file', async () => {
    const writer = new HistoryWriter(dir);
    writer.openSession();
    writer.write(event('e1'));
    await new Promise((r) => setTimeout(r, 5));
    expect(() => writer.openSession()).not.toThrow();
    writer.write(event('e2'));
    await writer.closeSession();
    const files = (await readdir(dir)).sort();
    expect(files).toHaveLength(2);
    const newer = (await readFile(join(dir, files[1]), 'utf8')).trim().split('\n');
    expect(newer.map((l) => JSON.parse(l).id)).toEqual(['e2']);
  });
});
