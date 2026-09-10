import { describe, expect, test } from 'vitest';
import { formatBytes, formatRatio } from '../src/renderer/src/lib/format-bytes';

describe('formatBytes', () => {
  test('分档显示', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
    expect(formatBytes(3.5 * 1024 * 1024)).toBe('3.50 MB');
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.00 GB');
  });

  test('超过 1KB 换算到 KB 档并保留一位小数', () => {
    expect(formatBytes(12345)).toBe('12.1 KB');
  });

  test('负数与非有限值返回占位', () => {
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(NaN)).toBe('—');
    expect(formatBytes(Infinity)).toBe('—');
  });
});

describe('formatRatio', () => {
  test('百分比保留一位小数', () => {
    expect(formatRatio(2310, 12345)).toBe('18.7%');
    expect(formatRatio(100, 100)).toBe('100.0%');
  });

  test('原体积为 0 时返回占位而非 NaN/Infinity', () => {
    expect(formatRatio(0, 0)).toBe('—');
    expect(formatRatio(10, 0)).toBe('—');
  });
});
