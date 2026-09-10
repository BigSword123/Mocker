export type TimestampUnit = 's' | 'ms';
export type UnitChoice = TimestampUnit | 'auto';

export interface ZoneOption {
  id: string;
  /** 形如 `UTC+08:00`，LMT 时区可能是 `UTC+08:05:43` */
  offsetLabel: string;
}

export interface ZonedDateTime {
  /** `2026-09-10 08:26:40.123` */
  standard: string;
  /** `2026-09-10T08:26:40.123+08:00` */
  iso: string;
  offsetSeconds: number;
  offsetMinutes: number;
  millis: number;
  parts: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    millis: number;
  };
}

export type FormatResult = { ok: true; value: ZonedDateTime } | { ok: false; error: string };
export type ParseResult = { ok: true; ms: number } | { ok: false; error: string };

const MS_MAX = 8.64e15;
/** 当前秒级约 1.7e9、毫秒级约 1.7e12，1e11 阈值两侧余量都超过一个数量级 */
const UNIT_THRESHOLD = 1e11;
/** 只接受 4 位年份：更早/更晚的年份格式无纪元符号，往返会产生歧义 */
const ZONED_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/;

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function zoneParts(ms: number, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(ms))) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    // hour12:false 在部分 ICU 版本把午夜输出为 "24"
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

// 保留秒精度：1900 年前多数时区用 LMT（上海 1850 年为 +08:05:43），舍入到分钟会让往返差 17 秒
function zoneOffsetSeconds(ms: number, timeZone: string): number {
  const p = zoneParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 1000);
}

function offsetToIso(offSec: number): string {
  const sign = offSec < 0 ? '-' : '+';
  const a = Math.abs(offSec);
  const ss = a % 60;
  return `${sign}${pad(Math.floor(a / 3600))}:${pad(Math.floor((a % 3600) / 60))}${ss === 0 ? '' : `:${pad(ss)}`}`;
}

export function detectTimestampUnit(value: number): TimestampUnit {
  return Math.abs(value) < UNIT_THRESHOLD ? 's' : 'ms';
}

export function toMillis(value: number, unit: UnitChoice): number {
  const u = unit === 'auto' ? detectTimestampUnit(value) : unit;
  return u === 's' ? value * 1000 : value;
}

export function formatTimestamp(ms: number, timeZone: string): FormatResult {
  if (!Number.isFinite(ms) || Math.abs(ms) > MS_MAX) {
    return { ok: false, error: `时间戳超出有效范围 ±${MS_MAX} 毫秒` };
  }
  const p = zoneParts(ms, timeZone);
  if (p.year < 1000 || p.year > 9999) {
    return { ok: false, error: '标准时间格式仅支持公元 1000-9999 年' };
  }
  const millis = ((Math.floor(ms) % 1000) + 1000) % 1000;
  const date = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  const time = `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}.${pad(millis, 3)}`;
  const offsetSeconds = zoneOffsetSeconds(ms, timeZone);
  return {
    ok: true,
    value: {
      standard: `${date} ${time}`,
      iso: `${date}T${time}${offsetToIso(offsetSeconds)}`,
      offsetSeconds,
      offsetMinutes: Math.round(offsetSeconds / 60),
      millis,
      parts: { ...p, millis },
    },
  };
}

export function parseZonedDateTime(text: string, timeZone: string): ParseResult {
  const m = text.trim().match(ZONED_RE);
  if (!m) return { ok: false, error: '无法解析，需形如 2026-09-11 14:30:05.123' };
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23) {
    return { ok: false, error: '月/日/时取值不合法' };
  }
  // 可选捕获组未参与匹配时是 undefined 而非空串，必须兜底
  const millis = Number((m[7] || '0').padEnd(3, '0'));
  const guess = Date.UTC(Number(m[1]), month - 1, day, hour, Number(m[5]), Number(m[6] || '0'), millis);
  if (Number.isNaN(guess)) return { ok: false, error: '日期不存在' };
  // 两遍收敛：第一遍拿粗略偏移，第二遍用修正后的时刻重算，覆盖 DST 切换点
  const first = guess - zoneOffsetSeconds(guess, timeZone) * 1000;
  return { ok: true, ms: guess - zoneOffsetSeconds(first, timeZone) * 1000 };
}

export function listTimeZones(): ZoneOption[] {
  const now = Date.now();
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // supportedValuesOf 只返回地理时区，不含 UTC/GMT 任何条目，必须显式补上
  const ids = new Set<string>([local, 'UTC', ...Intl.supportedValuesOf('timeZone')]);
  const rank = (id: string): number => (id === local ? 0 : id === 'UTC' ? 1 : 2);
  return [...ids]
    .map((id) => ({ id, offsetLabel: `UTC${offsetToIso(zoneOffsetSeconds(now, id))}` }))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}
