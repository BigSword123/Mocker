import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  DOWN_KBPS_MAX,
  JITTER_MS_MAX,
  LATENCY_MS_MAX,
  THROTTLE_PRESETS,
  THROTTLE_PRESET_LABELS,
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
