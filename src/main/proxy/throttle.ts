import { DELAY_MS_MAX, type Settings, type ThrottleSettings } from '../../shared/types';
import { sleep } from '../util/sleep';

export function computeThrottleDelayMs(
  t: ThrottleSettings,
  bodyBytes: number,
  rng: () => number = Math.random,
): number {
  if (!t.enabled) return 0;
  const jitterSpan = t.jitterMs * 2 + 1;
  const latencyPart = Math.max(0, t.latencyMs + Math.floor(rng() * jitterSpan) - t.jitterMs);
  const kbps = Math.max(1, t.downKbps);
  const transferMs = (bodyBytes / (kbps * 1024)) * 1000;
  return Math.min(latencyPart + transferMs, DELAY_MS_MAX);
}
