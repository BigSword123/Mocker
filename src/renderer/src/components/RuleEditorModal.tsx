import { useRef, useState } from 'react';
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
import {
  ERROR_TEMPLATES,
  findById as findErrorTemplate,
  type ErrorTemplateCategory,
} from '../../../shared/error-templates';
import { api } from '../lib/api';
import {
  CUSTOM_TEMPLATE_ID,
  applyErrorTemplate,
  isConnectionTemplateId,
  responseStatusError,
} from '../lib/error-template-apply';
import FakerCatalogModal from './FakerCatalogModal';
import {
  HEADER_LINE_SEP,
  buildRequestMatch,
  buildResponseHeaders,
  formatLines,
  legacyRequestEditorText,
  parseLines,
} from '../lib/rule-match-edit';

const METHODS: HttpMethod[] = ['ANY', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
const URL_TYPES: Array<{ value: UrlPatternType; label: string }> = [
  { value: 'exact', label: '精确' },
  { value: 'wildcard', label: '通配符' },
  { value: 'regex', label: '正则' },
];
const LOCALES = ['zh_CN', 'en', 'ja', 'ko', 'de', 'fr'];
const TEMPLATE_GROUPS: Array<{ category: ErrorTemplateCategory; label: string }> = [
  { category: 'http-4xx', label: '── 4XX 客户端错误 ──' },
  { category: 'http-5xx', label: '── 5XX 服务端错误 ──' },
  { category: 'connection', label: '── 连接异常 ──' },
];
const SNIPPETS = [
  { label: 'now', text: '{{now:iso}}' },
  { label: 'uuid', text: '{{uuid}}' },
  { label: 'req.path', text: '{{req.path}}' },
  { label: 'req.query.id', text: '{{req.query.id}}' },
  { label: 'faker.person.firstName', text: '{{faker.person.firstName}}' },
  { label: 'faker.internet.email', text: '{{faker.internet.email}}' },
];
// 无障碍关联用的固定 id：Modal 同一时刻最多一个实例，不会重复。
const TEMPLATE_SELECT_ID = 'rule-error-template';
const CONNECTION_NOTE_ID = 'rule-connection-only-note';

interface Props {
  initial: MockRule | null;
  draft?: RuleInput;
  onClose: () => void;
  onSaved: () => void;
}

export default function RuleEditorModal({ initial, draft, onClose, onSaved }: Props) {
  // initial（编辑现有规则）优先；新建时可由 draft（抓包转规则）预填。两者不会同时出现。
  const seed = initial ?? draft ?? null;
  // 打开时的请求匹配快照：保存时据此判断「请求头 / 请求体包含」是否真被用户改过，
  // 未改过的输入框不能把已迁移的 HeaderRow[] / body 规则降级成纯文本形态。
  const [opened] = useState(() => ({
    match: seed?.match,
    ...legacyRequestEditorText(seed?.match),
  }));
  const [name, setName] = useState(seed?.name ?? '');
  const [urlType, setUrlType] = useState<UrlPatternType>(seed?.match.urlType ?? 'wildcard');
  const [urlPattern, setUrlPattern] = useState(seed?.match.urlPattern ?? '');
  const [method, setMethod] = useState<HttpMethod>(seed?.match.method ?? 'ANY');
  const [queryText, setQueryText] = useState(formatLines(seed?.match.query, '='));
  const [headersText, setHeadersText] = useState(opened.headersText);
  const [bodyContains, setBodyContains] = useState(opened.bodyContainsText);
  const [status, setStatus] = useState(seed?.action.status ?? 200);
  const [respHeadersText, setRespHeadersText] = useState(formatLines(seed?.action.headers, HEADER_LINE_SEP));
  const [body, setBody] = useState(seed?.action.body ?? '');

  const [delayMs, setDelayMs] = useState<number | ''>(seed?.action.delayMs ?? '');
  const [fakerLocale, setFakerLocale] = useState(seed?.action.fakerLocale ?? 'zh_CN');
  const [neEnabled, setNeEnabled] = useState(Boolean(seed?.action.networkError));
  const [neProbability, setNeProbability] = useState<number | ''>(
    seed?.action.networkError?.probability ?? 100,
  );
  const [neType, setNeType] = useState<NetworkErrorType>(seed?.action.networkError?.type ?? 'ECONNRESET');
  const [neStatusCode, setNeStatusCode] = useState<number | ''>(
    seed?.action.networkError?.errorStatusCode ?? '',
  );
  const [preview, setPreview] = useState('');
  const [previewWarnings, setPreviewWarnings] = useState<string[]>([]);
  const [fakerOpen, setFakerOpen] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState('');
  const [selectedTemplateId, setSelectedTemplateId] = useState(CUSTOM_TEMPLATE_ID);

  // 连接级模板下不会有响应可言，因此禁用状态码 / 响应体；用户手动取消勾选「网络异常」后重新可编辑。
  const connectionOnly = neEnabled && isConnectionTemplateId(selectedTemplateId);

  /** 切换错误模板：把模板内容预填进现有字段。选回「无（自定义）」只清标记，不动已填值。 */
  const selectTemplate = (id: string) => {
    setSelectedTemplateId(id);
    const template = findErrorTemplate(id);
    if (!template) return;
    const next = applyErrorTemplate(
      { status, body, respHeadersText, neEnabled, neProbability, neType },
      template,
    );
    setStatus(next.status);
    setBody(next.body);
    setRespHeadersText(next.respHeadersText);
    setNeEnabled(next.neEnabled);
    setNeProbability(next.neProbability);
    setNeType(next.neType);
  };

  /**
   * 手工改动模板会预填的任一字段（状态码 / 响应体 / 响应头 / 网络异常开关、概率、类型）后，
   * 下拉回到「无（自定义）」，但保留用户已填入的值——此时的响应已不再是模板所描述的那个。
   */
  const clearTemplate = () => setSelectedTemplateId(CUSTOM_TEMPLATE_ID);

  const buildAction = (): RuleAction => {
    const action: RuleAction = {
      status,
      headers: buildResponseHeaders(respHeadersText),
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
    const statusError = responseStatusError(status, connectionOnly);
    if (statusError) {
      setError(statusError);
      return;
    }
    const query = parseLines(queryText, '=');
    const request = buildRequestMatch({
      source: opened.match,
      initialHeadersText: opened.headersText,
      headersText,
      initialBodyContainsText: opened.bodyContainsText,
      bodyContainsText: bodyContains,
    });
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
        ...request,
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

  const insertSnippet = (snippet: string) => {
    setBody((prev) => {
      const ta = bodyRef.current;
      if (!ta) return prev + snippet;
      const s = ta.selectionStart;
      const e = ta.selectionEnd;
      return prev.slice(0, s) + snippet + prev.slice(e);
    });
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
          <input
            type="number"
            value={status}
            disabled={connectionOnly}
            aria-describedby={connectionOnly ? CONNECTION_NOTE_ID : undefined}
            onChange={(e) => {
              setStatus(Number(e.target.value));
              clearTemplate();
            }}
          />
          <label>响应头（每行 k: v）</label>
          <textarea
            rows={2}
            value={respHeadersText}
            onChange={(e) => {
              setRespHeadersText(e.target.value);
              clearTemplate();
            }}
          />
          <label>响应体</label>
          <textarea
            ref={bodyRef}
            rows={8}
            value={body}
            disabled={connectionOnly}
            aria-describedby={connectionOnly ? CONNECTION_NOTE_ID : undefined}
            onChange={(e) => {
              setBody(e.target.value);
              clearTemplate();
            }}
            placeholder='{"code":0}'
          />
          {connectionOnly && (
            <p className="form-note" id={CONNECTION_NOTE_ID}>
              连接异常模板会让请求在连接层失败，不返回任何响应，因此状态码与响应体暂不可编辑；取消勾选「网络异常」即可恢复。
            </p>
          )}
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
              <button type="button" onClick={() => setFakerOpen(true)}>Faker 速查…</button>
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
            <label htmlFor={TEMPLATE_SELECT_ID}>错误模板</label>
            <select
              id={TEMPLATE_SELECT_ID}
              value={selectedTemplateId}
              onChange={(e) => selectTemplate(e.target.value)}
            >
              <option value={CUSTOM_TEMPLATE_ID}>无（自定义）</option>
              {TEMPLATE_GROUPS.map((group) => (
                <optgroup key={group.category} label={group.label}>
                  {ERROR_TEMPLATES.filter((t) => t.category === group.category).map((t) => (
                    <option key={t.id} value={t.id}>{t.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
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
                onChange={(e) => {
                  setNeEnabled(e.target.checked);
                  clearTemplate();
                }}
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
                  onChange={(e) => {
                    setNeProbability(e.target.value === '' ? '' : Number(e.target.value));
                    clearTemplate();
                  }}
                />
                <label>异常类型</label>
                <select
                  value={neType}
                  onChange={(e) => {
                    setNeType(e.target.value as NetworkErrorType);
                    clearTemplate();
                  }}
                >
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
      <FakerCatalogModal
        open={fakerOpen}
        onClose={() => setFakerOpen(false)}
        onInsert={insertSnippet}
      />
    </div>
  );
}
