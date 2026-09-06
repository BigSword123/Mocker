import { describe, expect, it } from 'vitest';
import { applyThrottle, computeThrottleDelayMs } from '../src/main/proxy/throttle';
import {
  DEFAULT_SETTINGS,
  DOWN_KBPS_MAX,
  JITTER_MS_MAX,
  LATENCY_MS_MAX,
  THROTTLE_PRESETS,
  THROTTLE_PRESET_LABELS,
  type Settings,
  type ThrottlePreset,
} from '../src/shared/types';

describe('THROTTLE_PRESETS', () => {
  it('covers every non-custom preset with in-range values', () => {
    const keys = (Object.keys(THROTTLE_PRESETS) as Exclude<ThrottlePreset, 'custom'>[]).sort();
    expect(keys).toEqual(['dialup', 'slow-three-g', 'weak-wifi', 'three-g'].sort());
    for (const v of Object.values(THROTTLE_PRESETS)) {
      expect(v.downKbps).toBeGreaterThanOrEqual(1);
      expect(v.downKbps).toBeLessThanOrEqual(DOWN_KBPS_MAX);
      expect(v.latencyMs).toBeGreaterThanOrEqual(0);
      expect(v.latencyMs).toBeLessThanOrEqual(LATENCY_MS_MAX);
      expect(v.jitterMs).toBeGreaterThanOrEqual(0);
      expect(v.jitterMs).toBeLessThanOrEqual(JITTER_MS_MAX);
    }
  });

  it('labels every preset including custom', () => {
    const all: ThrottlePreset[] = ['three-g', 'slow-three-g', 'dialup', 'weak-wifi', 'custom'];
    for (const p of all) expect(THROTTLE_PRESET_LABELS[p]).toBeTruthy();
  });

  it('default settings ship throttle disabled with a preset', () => {
    expect(DEFAULT_SETTINGS.throttle.enabled).toBe(false);
    expect(DEFAULT_SETTINGS.throttle.preset).toBe('three-g');
  });
});

describe('computeThrottleDelayMs', () => {
  const base = { enabled: true, preset: 'custom' as const, downKbps: 200, latencyMs: 300, jitterMs: 100 };

  it('returns 0 when disabled', () => {
    expect(computeThrottleDelayMs({ ...base, enabled: false }, 10000)).toBe(0);
  });

  it('latency minus jitter floors at 0 (rng=0)', () => {
    // 300 + floor(0*201) - 100 = 200
    expect(computeThrottleDelayMs(base, 0, () => 0)).toBe(200);
    // jitter 大于 latency 时下限为 0
    expect(computeThrottleDelayMs({ ...base, latencyMs: 50, jitterMs: 100 }, 0, () => 0)).toBe(0);
  });

  it('latency plus jitter at rng upper bound', () => {
    // floor(0.999*201)=200 → 300 + 200 - 100 = 400
    expect(computeThrottleDelayMs(base, 0, () => 0.999)).toBe(400);
  });

  it('transfer time from body bytes', () => {
    // 2048 bytes @ 2KB/s = 1s，latency/jitter 为 0
    expect(computeThrottleDelayMs({ ...base, downKbps: 2, latencyMs: 0, jitterMs: 0 }, 2048, () => 0)).toBe(1000);
  });

  it('caps at DELAY_MS_MAX (300000)', () => {
    expect(computeThrottleDelayMs({ ...base, downKbps: 1, latencyMs: 0, jitterMs: 0 }, 1e9, () => 0)).toBe(300000);
  });
});

describe('applyThrottle', () => {
  it('sleeps at least the computed latency', async () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, throttle: { enabled: true, preset: 'custom', downKbps: 100000, latencyMs: 300, jitterMs: 0 } };
    const started = Date.now();
    await applyThrottle(() => settings, 0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
  }, 10000);

  it('releases early when throttle is disabled mid-flight', async () => {
    let settings: Settings = { ...DEFAULT_SETTINGS, throttle: { enabled: true, preset: 'custom', downKbps: 100000, latencyMs: 900, jitterMs: 0 } };
    const get = () => settings;
    const started = Date.now();
    const p = applyThrottle(get, 0);
    setTimeout(() => {
      settings = { ...settings, throttle: { ...settings.throttle, enabled: false } };
    }, 250);
    await p;
    expect(Date.now() - started).toBeLessThan(650);
  }, 10000);

  it('rejects with AbortError when signal fires', async () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, throttle: { enabled: true, preset: 'custom', downKbps: 100000, latencyMs: 5000, jitterMs: 0 } };
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await expect(applyThrottle(() => settings, 0, ac.signal)).rejects.toThrow(/abort/i);
  }, 10000);
});
