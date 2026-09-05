import { useEffect, useMemo, useState } from 'react';
import type { RuleInput, TrafficEvent } from '../../../shared/types';
import { captureToRuleInput } from '../lib/capture-to-rule';
import { EMPTY_FILTER, matchesFilter } from '../lib/traffic-filter';
import { useTrafficStore } from '../stores/traffic';
import RuleEditorModal from './RuleEditorModal';
import TrafficDetail from './TrafficDetail';
import TrafficTable from './TrafficTable';

const FILTER_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

export default function TrafficPanel() {
  const { list, filter, paused, setFilter, togglePause, clear } = useTrafficStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RuleInput | null>(null);
  const [textDraft, setTextDraft] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setFilter({ text: textDraft }), 200);
    return () => clearTimeout(t);
  }, [textDraft, setFilter]);

  const filtered = useMemo(() => list.filter((e) => matchesFilter(e, filter)), [list, filter]);

  const selected = useMemo(
    () => list.find((e) => e.id === selectedId) ?? null,
    [list, selectedId],
  );

  return (
    <div className="traffic-panel">
      <div className="toolbar">
        <select
          data-testid="filter-method"
          value={filter.method}
          onChange={(e) => setFilter({ method: e.target.value })}
        >
          <option value="">全部方法</option>
          {FILTER_METHODS.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <select
          data-testid="filter-status"
          value={filter.status}
          onChange={(e) => setFilter({ status: e.target.value })}
        >
          <option value="">全部状态</option>
          <option value="2">2xx</option>
          <option value="3">3xx</option>
          <option value="4">4xx</option>
          <option value="5">5xx</option>
          <option value="error">错误</option>
        </select>
        <input
          data-testid="filter-host"
          className="filter-host"
          placeholder="域名…"
          value={filter.host}
          onChange={(e) => setFilter({ host: e.target.value })}
        />
        <input
          data-testid="filter-text"
          placeholder="搜索 URL / 头 / 体…"
          value={textDraft}
          onChange={(e) => setTextDraft(e.target.value)}
        />
        <button data-testid="filter-clear" onClick={() => { setTextDraft(''); setFilter(EMPTY_FILTER); }}>
          清除
        </button>
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
