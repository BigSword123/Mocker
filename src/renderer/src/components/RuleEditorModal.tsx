import { useState } from 'react';
import type { HttpMethod, MockRule, RuleInput, UrlPatternType } from '../../../shared/types';
import { api } from '../lib/api';

const METHODS: HttpMethod[] = ['ANY', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
const URL_TYPES: Array<{ value: UrlPatternType; label: string }> = [
  { value: 'exact', label: '精确' },
  { value: 'wildcard', label: '通配符' },
  { value: 'regex', label: '正则' },
];

function parseLines(text: string, sep: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf(sep);
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + sep.length).trim();
  }
  return out;
}

function formatLines(map: Record<string, string> | undefined, sep: string): string {
  return Object.entries(map ?? {})
    .map(([k, v]) => `${k}${sep}${v}`)
    .join('\n');
}

interface Props {
  initial: MockRule | null;
  onClose: () => void;
  onSaved: () => void;
}

export default function RuleEditorModal({ initial, onClose, onSaved }: Props) {
  const [name, setName] = useState(initial?.name ?? '');
  const [urlType, setUrlType] = useState<UrlPatternType>(initial?.match.urlType ?? 'wildcard');
  const [urlPattern, setUrlPattern] = useState(initial?.match.urlPattern ?? '');
  const [method, setMethod] = useState<HttpMethod>(initial?.match.method ?? 'ANY');
  const [queryText, setQueryText] = useState(formatLines(initial?.match.query, '='));
  const [headersText, setHeadersText] = useState(formatLines(initial?.match.headers, ': '));
  const [bodyContains, setBodyContains] = useState(initial?.match.bodyContains ?? '');
  const [status, setStatus] = useState(initial?.action.status ?? 200);
  const [respHeadersText, setRespHeadersText] = useState(formatLines(initial?.action.headers, ': '));
  const [body, setBody] = useState(initial?.action.body ?? '');
  const [error, setError] = useState('');

  const save = async () => {
    const query = parseLines(queryText, '=');
    const headers = parseLines(headersText, ': ');
    const input: RuleInput = {
      name: name.trim() || urlPattern,
      enabled: initial?.enabled ?? true,
      match: {
        urlType,
        urlPattern,
        method,
        query: Object.keys(query).length ? query : undefined,
        headers: Object.keys(headers).length ? headers : undefined,
        bodyContains: bodyContains || undefined,
      },
      action: {
        status,
        headers: { 'content-type': 'application/json', ...parseLines(respHeadersText, ': ') },
        body,
      },
    };
    if (!urlPattern) {
      setError('URL 匹配模式不能为空');
      return;
    }
    if (!(Number.isInteger(status) && status >= 100 && status <= 999)) {
      setError('响应状态码必须是 100-999 的整数');
      return;
    }
    try {
      if (initial) await api.rulesUpdate(initial.id, input);
      else await api.rulesAdd(input);
      onSaved();
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{initial ? '编辑规则' : '新建规则'}</h2>
        {error && <div className="text-err">{error}</div>}
        <div className="form-grid">
          <label>名称</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
          <label>URL 类型</label>
          <select value={urlType} onChange={(e) => setUrlType(e.target.value as UrlPatternType)}>
            {URL_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <label>URL 模式</label>
          <input value={urlPattern} onChange={(e) => setUrlPattern(e.target.value)} placeholder="http://api.example.com/*" />
          <label>Method</label>
          <select value={method} onChange={(e) => setMethod(e.target.value as HttpMethod)}>
            {METHODS.map((m) => <option key={m}>{m}</option>)}
          </select>
          <label>Query（每行 k=v）</label>
          <textarea rows={2} value={queryText} onChange={(e) => setQueryText(e.target.value)} />
          <label>请求头（每行 k: v）</label>
          <textarea rows={2} value={headersText} onChange={(e) => setHeadersText(e.target.value)} />
          <label>请求体包含</label>
          <input value={bodyContains} onChange={(e) => setBodyContains(e.target.value)} />
          <label>响应状态码</label>
          <input type="number" value={status} onChange={(e) => setStatus(Number(e.target.value))} />
          <label>响应头（每行 k: v）</label>
          <textarea rows={2} value={respHeadersText} onChange={(e) => setRespHeadersText(e.target.value)} />
          <label>响应体</label>
          <textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} placeholder='{"code":0}' />
        </div>
        <div className="toolbar">
          <button className="primary" onClick={save}>保存</button>
          <button onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}
