import type { TrafficEvent } from '../../../shared/types';

function pretty(body: string | undefined): string {
  if (!body) return '';
  if (body.length > 500_000) {
    return body.slice(0, 500_000) + '\n…（内容过长已截断）';
  }
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

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

export default function TrafficDetail({ event }: { event: TrafficEvent | null }) {
  if (!event) return <div className="detail empty">选择一个请求查看详情</div>;
  return (
    <div className="detail">
      <h3>{event.method} {event.url}</h3>
      {event.error && <div className="text-err">错误：{event.error}</div>}
      {event.mocked && <div className="text-ok">由规则命中（{event.matchedRuleId}）</div>}
      {event.errorTriggered && <div className="text-warn">本次命中网络异常分支</div>}
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
      <pre>{pretty(event.responseBody) || '（无）'}</pre>
    </div>
  );
}
