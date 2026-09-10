import { useEffect, useState } from 'react';
import type { TrafficEvent } from '../../../shared/types';
import { api } from '../lib/api';
import { pretty } from '../lib/body-format';
import { buildCurl, defaultDialectFor, type CurlDialect } from '../lib/curl';
import ResponseBodyViews from './ResponseBodyViews';

function HeaderTable({ headers }: { headers?: Record<string, string> }) {
  if (!headers || Object.keys(headers).length === 0) return <div className="muted">（无）</div>;
  return (
    <table className="kv">
      <tbody>
        {Object.entries(headers).map(([k, v]) => (
          <tr key={k}>
            <td className="k">{k}</td>
            <td className="v">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface Props {
  event: TrafficEvent | null;
  onCaptureToRule?: (event: TrafficEvent) => void;
  onCaptureToMapLocal?: (event: TrafficEvent) => void;
  onReplay?: (event: TrafficEvent) => void;
  onCompose?: (event: TrafficEvent) => void;
}

export default function TrafficDetail({ event, onCaptureToRule, onCaptureToMapLocal, onReplay, onCompose }: Props) {
  const [dialect, setDialect] = useState<CurlDialect>('bash');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.appPlatform()
      .then((p) => setDialect(defaultDialectFor(p)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setCopied(false);
  }, [event?.id]);

  if (!event) return <div className="detail empty">选择一个请求查看详情</div>;

  const copyCurl = async () => {
    try {
      await navigator.clipboard.writeText(buildCurl(event, dialect));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="detail">
      <div className="detail-head">
        <h3>{event.method} {event.url}</h3>
        {onCaptureToRule && (
          <button data-testid="capture-to-rule" onClick={() => onCaptureToRule(event)}>
            转为规则
          </button>
        )}
        {onCaptureToMapLocal && (
          <button data-testid="capture-to-maplocal" onClick={() => onCaptureToMapLocal(event)}>
            转为 MapLocal
          </button>
        )}
        {onReplay && (
          <button data-testid="replay" onClick={() => onReplay(event)}>
            重放
          </button>
        )}
        {onCompose && (
          <button data-testid="compose" onClick={() => onCompose(event)}>
            编辑后重发…
          </button>
        )}
        <select
          data-testid="curl-dialect"
          aria-label="cURL 方言"
          value={dialect}
          onChange={(e) => setDialect(e.target.value as CurlDialect)}
        >
          <option value="bash">bash</option>
          <option value="cmd">cmd</option>
          <option value="powershell">PowerShell</option>
        </select>
        <button data-testid="copy-curl" onClick={copyCurl}>
          {copied ? '已复制' : 'Copy as cURL'}
        </button>
      </div>
      {event.error && <div className="text-err">错误：{event.error}</div>}
      {event.mocked && <div className="text-ok">由规则命中（{event.matchedRuleId}）</div>}
      {event.errorTriggered && <div className="text-warn">本次命中网络异常分支</div>}
      {event.throttledMs !== undefined && (
        <div className="text-warn" data-testid="throttle-mark">
          限速 +{event.throttledMs}ms
        </div>
      )}
      {event.renderWarnings && event.renderWarnings.length > 0 && (
        <details>
          <summary>模板告警 ({event.renderWarnings.length})</summary>
          <ul>
            {event.renderWarnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
      <h4>请求头</h4>
      <HeaderTable headers={event.requestHeaders} />
      <h4>请求体</h4>
      <pre>{pretty(event.requestBody) || '（无）'}</pre>
      <h4>响应头</h4>
      <HeaderTable headers={event.responseHeaders} />
      <h4>响应体</h4>
      <ResponseBodyViews body={event.responseBody} eventId={event.id} />
    </div>
  );
}
