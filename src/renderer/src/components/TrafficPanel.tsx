import { useEffect, useMemo, useState } from 'react';
import type { RedirectRule, RuleInput, TrafficEvent } from '../../../shared/types';
import { api } from '../lib/api';
import { captureToRedirectDraft } from '../lib/capture-to-maplocal';
import { captureToRuleInput } from '../lib/capture-to-rule';
import { EMPTY_FILTER, matchesFilter } from '../lib/traffic-filter';
import { useTrafficStore } from '../stores/traffic';
import ComposeModal from './ComposeModal';
import RedirectEditorModal from './RedirectEditorModal';
import RuleEditorModal from './RuleEditorModal';
import TrafficDetail from './TrafficDetail';
import TrafficTable from './TrafficTable';

const FILTER_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

export default function TrafficPanel() {
  const { list, filter, paused, setFilter, togglePause, clear, setEvents } = useTrafficStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RuleInput | null>(null);
  const [redirectDraft, setRedirectDraft] = useState<Omit<RedirectRule, 'id' | 'priority'> | null>(null);
  const [composeSeed, setComposeSeed] = useState<TrafficEvent | null>(null);
  const [textDraft, setTextDraft] = useState('');
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setFilter({ text: textDraft }), 200);
    return () => clearTimeout(t);
  }, [textDraft, setFilter]);

  const filtered = useMemo(() => list.filter((e) => matchesFilter(e, filter)), [list, filter]);

  const selected = useMemo(
    () => list.find((e) => e.id === selectedId) ?? null,
    [list, selectedId],
  );

  const replay = async (event: TrafficEvent) => {
    setActionError('');
    try {
      const id = await api.replaySend(
        { method: event.method, url: event.url, headers: event.requestHeaders, body: event.requestBody ?? '' },
        event.id,
      );
      setSelectedId(id);
    } catch (err) {
      setActionError(String(err));
    }
  };

  const captureToMapLocal = async (event: TrafficEvent) => {
    setActionError('');
    try {
      const target = await api.maplocalSave({
        url: event.url,
        responseHeaders: event.responseHeaders,
        responseBody: event.responseBody,
      });
      setRedirectDraft(captureToRedirectDraft(event, target));
    } catch (err) {
      setActionError(String(err));
    }
  };

  const exportHar = async () => {
    setActionError('');
    try {
      await api.harExport({
        events: filtered.filter((e) => e.completedAt !== undefined),
        defaultName: `mocker-${new Date().toISOString().replace(/[:.]/g, '-')}.har`,
      });
    } catch (err) {
      setActionError(String(err));
    }
  };

  const importHar = async () => {
    setActionError('');
    try {
      const res = await api.harImport();
      if (!res.events) return;
      if (list.length > 0 && !window.confirm(`导入 ${res.events.length} 条将替换当前流量列表，继续？`)) return;
      setEvents(res.events);
      setSelectedId(null);
    } catch (err) {
      setActionError(String(err));
    }
  };

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
        <button data-testid="har-export" disabled={!filtered.some((e) => e.completedAt !== undefined)} onClick={exportHar}>
          导出 HAR
        </button>
        <button data-testid="har-import" onClick={importHar}>
          导入 HAR
        </button>
        <button onClick={togglePause}>{paused ? '继续' : '暂停'}</button>
        <button onClick={() => { clear(); setSelectedId(null); }}>清空</button>
        <span className="muted">{filtered.length} 条</span>
        {actionError && <span className="text-err">{actionError}</span>}
      </div>
      <div className="split">
        <TrafficTable events={filtered} selectedId={selectedId} onSelect={(e) => setSelectedId(e.id)} />
        <TrafficDetail
          event={selected}
          onCaptureToRule={(e) => setDraft(captureToRuleInput(e))}
          onCaptureToMapLocal={captureToMapLocal}
          onReplay={replay}
          onCompose={(e) => setComposeSeed(e)}
        />
      </div>
      {draft && (
        <RuleEditorModal
          initial={null}
          draft={draft}
          onClose={() => setDraft(null)}
          onSaved={() => setDraft(null)}
        />
      )}
      {redirectDraft && (
        <RedirectEditorModal
          initial={null}
          draft={redirectDraft}
          onClose={() => setRedirectDraft(null)}
          onSaved={() => setRedirectDraft(null)}
        />
      )}
      {composeSeed && (
        <ComposeModal
          seed={composeSeed}
          onClose={() => setComposeSeed(null)}
          onSent={(id) => {
            setComposeSeed(null);
            setSelectedId(id);
          }}
        />
      )}
    </div>
  );
}
