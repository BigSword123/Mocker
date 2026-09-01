import { describe, expect, it } from 'vitest';
import { sleep } from '../src/main/util/sleep';

describe('sleep', () => {
  it('resolves after the given ms', async () => {
    const start = Date.now();
    await sleep(30);
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });

  it('resolves immediately for 0ms', async () => {
    const start = Date.now();
    await sleep(0);
    expect(Date.now() - start).toBeLessThan(20);
  });

  it('rejects when aborted', async () => {
    const ctrl = new AbortController();
    const p = sleep(5_000, ctrl.signal);
    setTimeout(() => ctrl.abort(), 20);
    await expect(p).rejects.toThrow(/aborted/i);
  });

  it('rejects immediately if signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(sleep(1_000, ctrl.signal)).rejects.toThrow(/aborted/i);
  });
});
