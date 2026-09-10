import { useMemo, useState } from 'react';
import {
  detectTimestampUnit,
  formatTimestamp,
  listTimeZones,
  offsetToIso,
  parseZonedDateTime,
  toMillis,
  type UnitChoice,
} from '../lib/datetime';

export default function TimestampTool() {
  const zones = useMemo(() => listTimeZones(), []);
  const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [unit, setUnit] = useState<UnitChoice>('auto');
  const [tsInput, setTsInput] = useState(() => String(Date.now()));
  const [dtInput, setDtInput] = useState('');
  const [zoneQuery, setZoneQuery] = useState('');

  const tsResult = useMemo(() => {
    const raw = tsInput.trim();
    if (raw === '') return { ok: false as const, error: '请输入数字时间戳' };
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false as const, error: '请输入数字时间戳' };
    return formatTimestamp(toMillis(n, unit), timeZone);
  }, [tsInput, unit, timeZone]);

  const dtResult = useMemo(() => {
    if (dtInput.trim() === '') return null;
    return parseZonedDateTime(dtInput, timeZone);
  }, [dtInput, timeZone]);

  const detected = useMemo(() => {
    const n = Number(tsInput.trim());
    if (tsInput.trim() === '' || !Number.isFinite(n)) return '';
    return unit === 'auto' ? `识别为：${detectTimestampUnit(n) === 's' ? '秒' : '毫秒'}` : '';
  }, [tsInput, unit]);

  const filteredZones = useMemo(() => {
    const q = zoneQuery.trim().toLowerCase();
    if (q === '') return zones;
    return zones.filter((z) => z.id.toLowerCase().includes(q) || z.offsetLabel.toLowerCase().includes(q));
  }, [zones, zoneQuery]);

  // 改时间戳 → 同步标准时间；改标准时间 → 同步时间戳。各自单向，不会互相触发成环
  const onTsChange = (v: string) => {
    setTsInput(v);
    const raw = v.trim();
    const n = Number(raw);
    if (raw !== '' && Number.isFinite(n)) {
      const r = formatTimestamp(toMillis(n, unit), timeZone);
      if (r.ok) setDtInput(r.value.standard);
    }
  };

  const onDtChange = (v: string) => {
    setDtInput(v);
    if (v.trim() !== '') {
      const r = parseZonedDateTime(v, timeZone);
      if (r.ok) setTsInput(String(r.ms));
    }
  };

  const onZoneChange = (z: string) => {
    setTimeZone(z);
    const n = Number(tsInput.trim());
    if (tsInput.trim() !== '' && Number.isFinite(n)) {
      const r = formatTimestamp(toMillis(n, unit), z);
      if (r.ok) setDtInput(r.value.standard);
    }
  };

  const now = () => onTsChange(String(Date.now()));

  return (
    <div className="form-grid" style={{ maxWidth: 720 }}>
      <label htmlFor="ts-input">时间戳</label>
      <div className="form-row">
        <input
          id="ts-input"
          data-testid="ts-input"
          value={tsInput}
          onChange={(e) => onTsChange(e.target.value)}
          placeholder="1789000000123"
        />
        <select data-testid="ts-unit" value={unit} onChange={(e) => setUnit(e.target.value as UnitChoice)}>
          <option value="auto">自动</option>
          <option value="s">秒</option>
          <option value="ms">毫秒</option>
        </select>
        <button data-testid="ts-now" onClick={now}>现在</button>
      </div>

      <label htmlFor="ts-zone">时区</label>
      <div>
        <input
          data-testid="ts-zone-filter"
          value={zoneQuery}
          onChange={(e) => setZoneQuery(e.target.value)}
          placeholder="过滤时区（如 Shanghai 或 UTC+08）"
        />
        <select
          id="ts-zone"
          data-testid="ts-zone"
          value={timeZone}
          onChange={(e) => onZoneChange(e.target.value)}
          size={8}
          style={{ width: '100%', marginTop: 6 }}
        >
          {filteredZones.map((z) => (
            <option key={z.id} value={z.id}>
              {z.id}（{z.offsetLabel}）
            </option>
          ))}
        </select>
      </div>

      <label>标准时间</label>
      <div>
        {tsResult.ok ? (
          <>
            <div className="preview" data-testid="ts-standard">{tsResult.value.standard}</div>
            <div className="form-note">
              ISO 8601：<code data-testid="ts-iso">{tsResult.value.iso}</code>
              {' · '}偏移：<span data-testid="ts-offset">UTC{offsetToIso(tsResult.value.offsetSeconds)}</span>
              {detected && <> · <span data-testid="ts-detected">{detected}</span></>}
            </div>
            <div className="form-note">
              {tsResult.value.parts.year} 年 {tsResult.value.parts.month} 月 {tsResult.value.parts.day} 日
              {' '}{tsResult.value.parts.hour} 时 {tsResult.value.parts.minute} 分
              {' '}{tsResult.value.parts.second} 秒 {tsResult.value.parts.millis} 毫秒
            </div>
          </>
        ) : (
          <div className="text-err" data-testid="ts-error">{tsResult.error}</div>
        )}
      </div>

      <label htmlFor="dt-input">反向：标准时间</label>
      <input
        id="dt-input"
        data-testid="dt-input"
        value={dtInput}
        onChange={(e) => onDtChange(e.target.value)}
        placeholder="2026-09-10 08:26:40.123"
      />

      <label>反向结果</label>
      <div>
        {dtResult === null && <span className="muted">输入标准时间后显示对应时间戳</span>}
        {dtResult && !dtResult.ok && <span className="text-err" data-testid="dt-error">{dtResult.error}</span>}
        {dtResult?.ok && (
          <div className="form-note">
            毫秒：<code data-testid="dt-ms">{dtResult.ms}</code>
            {' · '}秒：<code data-testid="dt-s">{Math.trunc(dtResult.ms / 1000)}</code>
          </div>
        )}
      </div>

      <label />
      <div className="form-note">
        支持公元 1000-9999 年；更早的年份格式无纪元符号，往返会歧义，故直接报错。
        1900 年前多数时区使用 LMT（地方平太阳时），偏移带秒精度，本工具如实显示。
      </div>
    </div>
  );
}
