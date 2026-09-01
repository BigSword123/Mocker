import { useState } from 'react';
import {
  DELAY_MS_MAX,
  NETWORK_ERROR_TYPES,
  type HttpMethod,
  type MockRule,
  type NetworkErrorType,
  type RenderContext,
  type RuleAction,
  type RuleInput,
  type UrlPatternType,
} from '../../../shared/types';
import { api } from '../lib/api';

const METHODS: HttpMethod[] = ['ANY', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
const URL_TYPES: Array<{ value: UrlPatternType; label: string }> = [
  { value: 'exact', label: '精确' },
  { value: 'wildcard', label: '通配符' },
  { value: 'regex', label: '正则' },
];
const LOCALES = ['zh_CN', 'en', 'ja', 'ko', 'de', 'fr'];
const SNIPPETS = [
  { label: 'now', text: '{{now:iso}}' },
  { label: 'uuid', text: '{{uuid}}' },
  { label: 'req.path', text: '{{req.path}}' },
  { label: 'req.query.id', text: '{{req.query.id}}' },
  { label: 'faker.person.firstName', text: '{{faker.person.firstName}}' },
  { label: 'faker.internet.email', text: '{{faker.internet.email}}' },
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

  const [delayMs, setDelayMs] = useState<number | ''>(initial?.action.delayMs ?? '');
  const [fakerLocale, setFakerLocale] = useState(initial?.action.fakerLocale ?? 'zh_CN');
  const [neEnabled, setNeEnabled] = useState(Boolean(initial?.action.networkError));
  const [neProbability, setNeProbability] = useState<number | ''>(
    initial?.action.networkError?.probability ?? 100,
  );
  const [neType, setNeType] = useState<NetworkErrorType>(initial?.action.networkError?.type ?? 'ECONNRESET');
  const [neStatusCode, setNeStatusCode] = useState<number | ''>(
    initial?.action.networkError?.errorStatusCode ?? '',
  );
  const [preview, setPreview] = useState('');
  const [previewWarnings, setPreviewWarnings] = useState<string[]>([]);
  const [error, setError] = useState('');

  const buildAction = (): RuleAction => {
    const action: RuleAction = {
      status,
      headers: { 'content-type': 'application/json', ...parseLines(respHeadersText, ': ') },
      body,
    };
    if (delayMs !== '') action.delayMs = delayMs;
    if (fakerLocale) action.fakerLocale = fakerLocale;
    if (neEnabled) {
      action.networkError = {
        probability: neProbability === '' ? 100 : Number(neProbability),
        type: neType,
        ...(neType === 'HTTP_STATUS' && neStatusCode !== ''
          ? { errorStatusCode: Number(neStatusCode) }
          : {}),
      };
    }
    return action;
  };

  const save = async () => {
    if (!urlPattern) {
      setError('URL 匹配模式不能为空');
      return;
    }
    if (!(Number.isInteger(status) && status >= 100 && status <= 999)) {
      setError('响应状态码必须是 100-999 的整数');
      return;
    }
    const query = parseLines(queryText, '=');
    const headers = parseLines(headersText, ': ');
    const action = buildAction();
    try {
      await api.rulesValidate(action);
    } catch (err) {
      setError(String(err));
      return;
    }
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
      action,
    };
    try {
      if (initial) await api.rulesUpdate(initial.id, input);
      else await api.rulesAdd(input);
      onSaved();
    } catch (err) {
      setError(String(err));
    }
  };

  const refreshPreview = async () => {
    const context: RenderContext = {
      method: 'GET',
      url: 'http://example.test/preview?x=1',
      host: 'example.test',
      path: '/preview',
      query: { x: '1' },
      headers: { 'content-type': 'application/json' },
      body: '{}',
    };
    try {
      const result = await api.templatePreview({
        text: body,
        context,
        fakerLocale: fakerLocale || undefined,
      });
      setPreview(result.rendered);
      setPreviewWarnings(result.warnings);
    } catch (err) {
      setPreview(`预览失败: ${String(err)}`);
      setPreviewWarnings([]);
    }
  };

  const insertSnippet = (text: string) => setBody((prev) => prev + text);

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

        <details className="form-section" open>
          <summary>动态数据</summary>
          <div className="form-grid">
            <label>Faker locale</label>
            <select value={fakerLocale} onChange={(e) => setFakerLocale(e.target.value)}>
              {LOCALES.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
            <label>变量速查</label>
            <div className="snippet-bar">
              {SNIPPETS.map((s) => (
                <button type="button" key={s.label} onClick={() => insertSnippet(s.text)}>
                  +{s.label}
                </button>
              ))}
            </div>
            <label>渲染预览</label>
            <div>
              <button type="button" onClick={refreshPreview}>刷新预览</button>
              <pre className="preview">{preview || '(点击"刷新预览"查看)'}</pre>
              {previewWarnings.length > 0 && (
                <ul className="text-warn">
                  {previewWarnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              )}
            </div>
          </div>
        </details>

        <details className="form-section" open>
          <summary>行为模拟</summary>
          <div className="form-grid">
            <label>延迟（ms）</label>
            <input
              type="number"
              value={delayMs}
              min={0}
              max={DELAY_MS_MAX}
              onChange={(e) => setDelayMs(e.target.value === '' ? '' : Number(e.target.value))}
            />
            <label>网络异常</label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={neEnabled}
                onChange={(e) => setNeEnabled(e.target.checked)}
              />
              命中时按概率触发网络异常
            </label>
            {neEnabled && (
              <>
                <label>异常概率（%）</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.1}
                  value={neProbability}
                  onChange={(e) => setNeProbability(e.target.value === '' ? '' : Number(e.target.value))}
                />
                <label>异常类型</label>
                <select value={neType} onChange={(e) => setNeType(e.target.value as NetworkErrorType)}>
                  {NETWORK_ERROR_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                {neType === 'HTTP_STATUS' && (
                  <>
                    <label>错误状态码</label>
                    <input
                      type="number"
                      value={neStatusCode}
                      onChange={(e) => setNeStatusCode(e.target.value === '' ? '' : Number(e.target.value))}
                    />
                  </>
                )}
              </>
            )}
          </div>
        </details>

        <div className="toolbar">
          <button className="primary" onClick={save}>保存</button>
          <button onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}
