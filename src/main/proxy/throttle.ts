import { DELAY_MS_MAX, DOWN_KBPS_MAX, JITTER_MS_MAX, LATENCY_MS_MAX, THROTTLE_PRESET_LABELS, type Settings, type ThrottleSettings } from '../../shared/types';
import { sleep } from '../util/sleep';

export function assertValidThrottle(t: ThrottleSettings): void {
  if (typeof t.enabled !== 'boolean') throw new Error('限速开关必须是布尔值');
  if (!(t.preset in THROTTLE_PRESET_LABELS)) throw new Error('限速预设非法');
  if (!Number.isInteger(t.downKbps) || t.downKbps < 1 || t.downKbps > DOWN_KBPS_MAX) {
    throw new Error(`下行带宽必须是 1-${DOWN_KBPS_MAX} 的整数`);
  }
  if (!Number.isInteger(t.latencyMs) || t.latencyMs < 0 || t.latencyMs > LATENCY_MS_MAX) {
    throw new Error(`延迟必须是 0-${LATENCY_MS_MAX} 的整数`);
  }
  if (!Number.isInteger(t.jitterMs) || t.jitterMs < 0 || t.jitterMs > JITTER_MS_MAX) {
    throw new Error(`抖动必须是 0-${JITTER_MS_MAX} 的整数`);
  }
}

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

const THROTTLE_SLICE_MS = 200;

/**
 * 按当前设置睡完限速时延，返回实际睡掉的 ms。
 * 分片睡眠：每片醒来重读最新设置——已关闭则立即放行；参数变化则按新设置
 * 重算总时延并减去已睡时间。signal 触发时以 AbortError 拒绝（与 sleep 一致）。
 */
export async function applyThrottle(
  getSettings: () => Settings,
  bodyBytes: number,
  signal?: AbortSignal,
): Promise<number> {
  const start = Date.now();
  let remaining = computeThrottleDelayMs(getSettings().throttle, bodyBytes);
  while (remaining > 0) {
    if (signal?.aborted) throw new DOMException('sleep aborted', 'AbortError');
    const slice = Math.min(THROTTLE_SLICE_MS, remaining);
    await sleep(slice, signal);
    const recomputed = computeThrottleDelayMs(getSettings().throttle, bodyBytes);
    remaining = Math.max(0, Math.min(remaining - slice, recomputed - (Date.now() - start)));
  }
  return Date.now() - start;
}
