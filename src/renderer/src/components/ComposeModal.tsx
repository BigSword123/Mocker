import { useState } from 'react';
import type { HeaderRow, HttpMethod, ReplayRequest, TrafficEvent } from '../../../shared/types';
import { api } from '../lib/api';
import { SKIP_HEADERS } from '../lib/curl';
import EditableTable from './EditableTable';
import JsonBodyEditor from './JsonBodyEditor';

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
type ComposeBodyMode = 'none' | 'raw' | 'form-data' | 'urlencoded';

const BODY_MODES: Array<{ value: ComposeBodyMode; label: string }> = [
  { value: 'none', label: '无' },
  { value: 'raw', label: 'raw' },
  { value: 'form-data', label: 'form-data' },
  { value: 'urlencoded', label: 'x-www-form-urlencoded' },
];

const EMPTY_ROW: HeaderRow = { enabled: true, name: '', value: '', description: '' };

function toMethod(raw: string): HttpMethod {
  const upper = raw.toUpperCase();
  return (METHODS as string[]).includes(upper) ? (upper as HttpMethod) : 'GET';
}

function rowsFromHeaders(headers: Record<string, string>): HeaderRow[] {
  const rows = Object.entries(headers)
    .filter(([k]) => !SKIP_HEADERS.has(k.toLowerCase()))
    .map(([name, value]) => ({ enabled: true, name, value, description: '' }));
  return rows.length > 0 ? rows : [{ ...EMPTY_ROW }];
}

function hasContentType(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
}

interface Props {
  seed: TrafficEvent;
  onClose: () => void;
  onSent: (id: string) => void;
}

export default function ComposeModal({ seed, onClose, onSent }: Props) {
  const [method, setMethod] = useState<HttpMethod>(toMethod(seed.method));
  const [url, setUrl] = useState(seed.url);
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>(() => rowsFromHeaders(seed.requestHeaders));
  const [mode, setMode] = useState<ComposeBodyMode>(seed.requestBody ? 'raw' : 'none');
  const [raw, setRaw] = useState(seed.requestBody ?? '');
  const [formRows, setFormRows] = useState<HeaderRow[]>([{ ...EMPTY_ROW }]);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);

  const send = async () => {
    setError('');
    try {
      new URL(url);
    } catch {
      setError('URL 不合法');
      return;
    }
    const headers: Record<string, string> = {};
    for (const r of headerRows) {
      if (r.enabled && r.name.trim() !== '') headers[r.name.trim()] = r.value;
    }

    let body = '';
    if (mode === 'raw') {
      body = raw;
    } else if (mode === 'urlencoded') {
      const params = new URLSearchParams();
      for (const r of formRows) {
        if (r.enabled && r.name.trim() !== '') params.append(r.name.trim(), r.value);
      }
      body = params.toString();
      if (!hasContentType(headers)) headers['content-type'] = 'application/x-www-form-urlencoded';
    } else if (mode === 'form-data') {
      const boundary = `----Mocker${Date.now().toString(36)}`;
      const parts: string[] = [];
      for (const r of formRows) {
        if (!r.enabled || r.name.trim() === '') continue;
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${r.name.trim()}"\r\n\r\n${r.value}\r\n`);
      }
      body = `${parts.join('')}--${boundary}--\r\n`;
      if (!hasContentType(headers)) {
        headers['content-type'] = `multipart/form-data; boundary=${boundary}`;
      }
    }

    const payload: ReplayRequest = { method, url, headers, body };
    setSending(true);
    try {
      const id = await api.replaySend(payload, seed.id);
      onSent(id);
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>编辑后重发</h3>
        <div className="form-row">
          <select
            data-testid="compose-method"
            aria-label="方法"
            value={method}
            onChange={(e) => setMethod(e.target.value as HttpMethod)}
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <input
            data-testid="compose-url"
            placeholder="完整 URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            style={{ flex: 1 }}
          />
        </div>
        <h4>请求头</h4>
        <EditableTable rows={headerRows} onChange={setHeaderRows} columns={{ description: false }} ariaLabel="请求头" />
        <h4>请求体</h4>
        <div className="tab-row">
          {BODY_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              className={mode === m.value ? 'active' : ''}
              data-testid={`compose-body-${m.value}`}
              onClick={() => setMode(m.value)}
            >
              {m.label}
            </button>
          ))}
        </div>
        {mode === 'raw' && (/^[\s]*[[{]/.test(raw) ? (
          <JsonBodyEditor value={raw} onChange={setRaw} ariaLabel="raw 请求体" />
        ) : (
          <textarea
            data-testid="compose-raw"
            aria-label="raw 请求体"
            rows={10}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
          />
        ))}
        {(mode === 'form-data' || mode === 'urlencoded') && (
          <EditableTable rows={formRows} onChange={setFormRows} columns={{ description: false }} ariaLabel="表单字段" />
        )}
        {error && <div className="text-err" data-testid="compose-error">{error}</div>}
        <div className="modal-actions">
          <button onClick={onClose}>取消</button>
          <button data-testid="compose-send" disabled={sending} onClick={send}>
            {sending ? '发送中…' : '发送'}
          </button>
        </div>
      </div>
    </div>
  );
}
