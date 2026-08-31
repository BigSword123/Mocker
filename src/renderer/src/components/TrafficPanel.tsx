import { useMemo, useState } from 'react';
import type { TrafficEvent } from '../../../shared/types';
import { useTrafficStore } from '../stores/traffic';
import TrafficDetail from './TrafficDetail';
import TrafficTable from './TrafficTable';

export default function TrafficPanel() {
  const { list, filter, paused, setFilter, togglePause, clear } = useTrafficStore();
  const [selected, setSelected] = useState<TrafficEvent | null>(null);

  const filtered = useMemo(
    () => (filter ? list.filter((e) => e.url.includes(filter)) : list),
    [list, filter],
  );

  return (
    <div className="traffic-panel">
      <div className="toolbar">
        <input placeholder="过滤 URL…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button onClick={togglePause}>{paused ? '继续' : '暂停'}</button>
        <button onClick={() => { clear(); setSelected(null); }}>清空</button>
        <span className="muted">{filtered.length} 条</span>
      </div>
      <div className="split">
        <TrafficTable events={filtered} selectedId={selected?.id ?? null} onSelect={setSelected} />
        <TrafficDetail event={selected} />
      </div>
    </div>
  );
}
