import { useMemo, useState } from 'react';
import type { RuleInput } from '../../../shared/types';
import { captureToRuleInput } from '../lib/capture-to-rule';
import { useTrafficStore } from '../stores/traffic';
import RuleEditorModal from './RuleEditorModal';
import TrafficDetail from './TrafficDetail';
import TrafficTable from './TrafficTable';

export default function TrafficPanel() {
  const { list, filter, paused, setFilter, togglePause, clear } = useTrafficStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RuleInput | null>(null);

  const filtered = useMemo(
    () => (filter ? list.filter((e) => e.url.includes(filter)) : list),
    [list, filter],
  );

  const selected = useMemo(
    () => list.find((e) => e.id === selectedId) ?? null,
    [list, selectedId],
  );

  return (
    <div className="traffic-panel">
      <div className="toolbar">
        <input placeholder="过滤 URL…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button onClick={togglePause}>{paused ? '继续' : '暂停'}</button>
        <button onClick={() => { clear(); setSelectedId(null); }}>清空</button>
        <span className="muted">{filtered.length} 条</span>
      </div>
      <div className="split">
        <TrafficTable events={filtered} selectedId={selectedId} onSelect={(e) => setSelectedId(e.id)} />
        <TrafficDetail event={selected} onCaptureToRule={(e) => setDraft(captureToRuleInput(e))} />
      </div>
      {draft && (
        <RuleEditorModal
          initial={null}
          draft={draft}
          onClose={() => setDraft(null)}
          onSaved={() => setDraft(null)}
        />
      )}
    </div>
  );
}
