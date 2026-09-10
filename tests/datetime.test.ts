import { describe, expect, test } from 'vitest';
import {
  detectTimestampUnit,
  formatTimestamp,
  listTimeZones,
  parseZonedDateTime,
  toMillis,
} from '../src/renderer/src/lib/datetime';

/** 现实窗口：1900-2100，LMT 与 4 位年份边界都安全落在内部 */
const LO = Date.UTC(1900, 0, 1);
const HI = Date.UTC(2100, 11, 31, 23, 59, 59, 999);
const ZONES = [
  'UTC',
  'Asia/Shanghai',
  'America/New_York',
  'Europe/London',
  'Pacific/Kiritimati',
  'Pacific/Niue',
  'Asia/Kathmandu',
  'Australia/Lord_Howe',
  'Antarctica/Troll',
];
const VALUES = [0, 1, -1, 999, 1000, -1000, 1789000000123, LO, HI, Date.UTC(1969, 6, 20, 20, 17, 40)];

describe('detectTimestampUnit', () => {
  test('1e11 以下判为秒，以上判为毫秒', () => {
    expect(detectTimestampUnit(1789000000)).toBe('s');
    expect(detectTimestampUnit(1789000000123)).toBe('ms');
    expect(detectTimestampUnit(0)).toBe('s');
  });

  test('负值按绝对值判定', () => {
    expect(detectTimestampUnit(-1789000000)).toBe('s');
    expect(detectTimestampUnit(-1789000000123)).toBe('ms');
  });
});

describe('toMillis', () => {
  test('auto 走自动识别，显式单位强制换算', () => {
    expect(toMillis(1789000000, 'auto')).toBe(1789000000000);
    expect(toMillis(1789000000, 'ms')).toBe(1789000000);
    expect(toMillis(1789000000123, 's')).toBe(1789000000123000);
  });
});

describe('formatTimestamp', () => {
  test('已知答案：UTC / 上海 / 纽约', () => {
    const ms = 1789000000123;
    expect(formatTimestamp(ms, 'UTC')).toEqual({
      ok: true,
      value: expect.objectContaining({
        standard: '2026-09-10 00:26:40.123',
        iso: '2026-09-10T00:26:40.123+00:00',
        offsetSeconds: 0,
      }),
    });
    expect(formatTimestamp(ms, 'Asia/Shanghai')).toEqual({
      ok: true,
      value: expect.objectContaining({
        standard: '2026-09-10 08:26:40.123',
        iso: '2026-09-10T08:26:40.123+08:00',
        offsetMinutes: 480,
      }),
    });
    expect(formatTimestamp(ms, 'America/New_York')).toEqual({
      ok: true,
      value: expect.objectContaining({ iso: '2026-09-09T20:26:40.123-04:00', offsetMinutes: -240 }),
    });
  });

  test('拆分 parts 与 standard 自洽', () => {
    const r = formatTimestamp(1789000000123, 'UTC');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.parts).toEqual({
      year: 2026, month: 9, day: 10, hour: 0, minute: 26, second: 40, millis: 123,
    });
    expect(r.value.millis).toBe(123);
  });

  test('拒绝非有限值与超出 Date 范围', () => {
    expect(formatTimestamp(NaN, 'UTC').ok).toBe(false);
    expect(formatTimestamp(Infinity, 'UTC').ok).toBe(false);
    expect(formatTimestamp(9e15, 'UTC').ok).toBe(false);
  });

  test('4 位年份窗口外报错而非输出歧义年份', () => {
    // -8.64e15 是公元 271822 年 BC，格式化会丢掉纪元符号，必须拒绝
    const r = formatTimestamp(-8.64e15, 'UTC');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('1000-9999');
  });
});

describe('parseZonedDateTime', () => {
  test('支持 - 与 / 分隔、T 与空格分隔、秒与毫秒可省略', () => {
    const want = Date.UTC(2026, 8, 11, 14, 30, 5);
    expect(parseZonedDateTime('2026-09-11 14:30:05', 'UTC')).toEqual({ ok: true, ms: want });
    expect(parseZonedDateTime('2026/09/11 14:30:05', 'UTC')).toEqual({ ok: true, ms: want });
    expect(parseZonedDateTime('2026-09-11T14:30:05', 'UTC')).toEqual({ ok: true, ms: want });
    expect(parseZonedDateTime('2026-09-11 14:30', 'UTC')).toEqual({ ok: true, ms: Date.UTC(2026, 8, 11, 14, 30) });
  });

  test('毫秒不足 3 位按右侧补零', () => {
    expect(parseZonedDateTime('2026-09-11 14:30:05.1', 'UTC')).toEqual({
      ok: true, ms: Date.UTC(2026, 8, 11, 14, 30, 5, 100),
    });
    expect(parseZonedDateTime('2026-09-11 14:30:05.12', 'UTC')).toEqual({
      ok: true, ms: Date.UTC(2026, 8, 11, 14, 30, 5, 120),
    });
  });

  test('非法输入返回结构化错误而非抛异常', () => {
    for (const bad of ['nope', '', '   ', '2026-13-11 14:30:05', '2026-09-11 24:30:05', '275760-09-13 00:00:00']) {
      const r = parseZonedDateTime(bad, 'UTC');
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    }
  });
});

describe('往返一致', () => {
  test('9 个时区 × 10 个时间戳全部精确往返', () => {
    for (const zone of ZONES) {
      for (const ms of VALUES) {
        const f = formatTimestamp(ms, zone);
        expect(f.ok, `${zone} ${ms}`).toBe(true);
        if (!f.ok) continue;
        expect(parseZonedDateTime(f.value.standard, zone), `${zone} ${ms} ${f.value.standard}`).toEqual({ ok: true, ms });
      }
    }
  });

  test('全部 418+1 个时区在现代值与 1850 年 LMT 值上往返', () => {
    for (const zone of listTimeZones()) {
      for (const ms of [1789000000123, Date.UTC(1850, 5, 15, 12, 0, 0)]) {
        const f = formatTimestamp(ms, zone.id);
        if (!f.ok) continue;
        expect(parseZonedDateTime(f.value.standard, zone.id), `${zone.id} ${ms}`).toEqual({ ok: true, ms });
      }
    }
  });

  test('LMT 保留秒精度：上海 1850 年偏移为 +08:05:43', () => {
    const ms = Date.UTC(1850, 5, 15, 12, 0, 0);
    const r = formatTimestamp(ms, 'Asia/Shanghai');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 四舍五入到分钟会让往返差 17 秒，这条断言钉住秒精度
    expect(r.value.iso.endsWith('+08:05:43')).toBe(true);
    expect(r.value.offsetSeconds).toBe(29143);
    expect(parseZonedDateTime(r.value.standard, 'Asia/Shanghai')).toEqual({ ok: true, ms });
  });

  test('DST：纽约 2026 春进 03:30 为 EDT(-240)，01:30 为 EST(-300)', () => {
    const spring = parseZonedDateTime('2026-03-08 03:30:00', 'America/New_York');
    expect(spring.ok).toBe(true);
    if (spring.ok) {
      const f = formatTimestamp(spring.ms, 'America/New_York');
      expect(f.ok && f.value.offsetMinutes).toBe(-240);
    }
    const before = parseZonedDateTime('2026-03-08 01:30:00', 'America/New_York');
    expect(before.ok).toBe(true);
    if (before.ok) {
      const f = formatTimestamp(before.ms, 'America/New_York');
      expect(f.ok && f.value.offsetMinutes).toBe(-300);
    }
  });

  test('DST 回拨的歧义时刻可解析且不抛异常', () => {
    const r = parseZonedDateTime('2026-11-01 01:30:00', 'America/New_York');
    expect(r.ok).toBe(true);
  });
});

describe('listTimeZones', () => {
  test('显式并入 UTC（supportedValuesOf 不含任何 UTC/GMT 条目）', () => {
    const zones = listTimeZones();
    expect(zones.length).toBe(Intl.supportedValuesOf('timeZone').length + 1);
    expect(zones.some((z) => z.id === 'UTC')).toBe(true);
    expect(zones.filter((z) => z.id === 'UTC')).toHaveLength(1);
  });

  test('本地时区置顶、UTC 次之，其余按 id 排序', () => {
    const zones = listTimeZones();
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(zones[0]!.id).toBe(local);
    expect(zones[1]!.id).toBe('UTC');
    const rest = zones.slice(2).map((z) => z.id);
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b)));
  });

  test('每项带 UTC 偏移标签', () => {
    for (const z of listTimeZones()) {
      expect(z.offsetLabel, z.id).toMatch(/^UTC[+-]\d{2}:\d{2}(:\d{2})?$/);
    }
  });
});
