import { useMemo, useRef, useState } from 'react';
import {
  DELAY_MS_MAX,
  NETWORK_ERROR_TYPES,
  type BodyMatchStrategy,
  type BodyMode,
  type HeaderRow,
  type HttpMethod,
  type MockRule,
  type NetworkErrorType,
  type RenderContext,
  type RuleAction,
  type RuleBody,
  type RuleInput,
  type SequentialResponse,
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
import EditableTable from './EditableTable';
import FakerCatalogModal from './FakerCatalogModal';
import JsonBodyEditor, { JsonSpans } from './JsonBodyEditor';
import ScenarioField from './ScenarioField';
import { parseJsonBody, tokenizeJson } from '../lib/json-format';

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

const EMPTY_ROW: HeaderRow = { enabled: true, name: '', value: '', description: '' };

/** 旧规则把 query 存成 Record，新规则与 headers 一样存 HeaderRow[]，两种都能预填。 */
function queryToRows(query: Record<string, string> | HeaderRow[] | undefined): HeaderRow[] {
  if (Array.isArray(query)) return query;
  if (query) {
    return Object.entries(query).map(([name, value]) => ({
      enabled: true,
      name,
      value,
      description: '',
    }));
  }
  return [{ ...EMPTY_ROW }];
}

interface Props {
  initial: MockRule | null;
  draft?: RuleInput;
  /** 新建（无 initial/draft）时预挂的场景 */
  presetScenario?: string;
  onClose: () => void;
  onSaved: () => void;
}

export default function RuleEditorModal({ initial, draft, presetScenario, onClose, onSaved }: Props) {
  // initial（編集现有规则）优先；新建时可由 draft（抓包转规则）预填。两者不会同时出现。
  const seed = initial ?? draft ?? null;
  const [name, setName] = useState(seed?.name ?? '');
  const [urlType, setUrlType] = useState<UrlPatternType>(seed?.match.urlType ?? 'wildcard');
  const [urlPattern, setUrlPattern] = useState(seed?.match.urlPattern ?? '');
  const [method, setMethod] = useState<HttpMethod>(seed?.match.method ?? 'ANY');
  const [queryRows, setQueryRows] = useState<HeaderRow[]>(() => queryToRows(seed?.match.query));
  const [headersRows, setHeadersRows] = useState<HeaderRow[]>(() => {
    if (Array.isArray(seed?.match.headers)) return seed.match.headers;
    if (seed?.match.headers && typeof seed.match.headers === 'object') {
      return Object.entries(seed.match.headers as Record<string, string>).map(([name, value]) => ({
        enabled: true,
        name,
        value,
        description: '',
      }));
    }
    return [{ enabled: true, name: '', value: '', description: '' }];
  });
  const seedBody: RuleBody = seed?.match.body ?? {
    mode: seed?.match.bodyContains ? 'raw' : 'none',
    raw: seed?.match.bodyContains ?? '',
    matchStrategy: 'contains',
  };
  const [bodyRule, setBodyRule] = useState<RuleBody>(seedBody);
  const seedAction = seed && !('responses' in seed.action) ? seed.action : undefined;
  const [status, setStatus] = useState<number>(seedAction?.status ?? 200);
  const [respHeadersRows, setRespHeadersRows] = useState<HeaderRow[]>(() => {
    if (seedAction?.headers) {
      return Object.entries(seedAction.headers).map(([name, value]) => ({
        enabled: true,
        name,
        value,
        description: '',
      }));
    }
    return [{ enabled: true, name: '', value: '', description: '' }];
  });
  const [body, setBody] = useState<string>(seedAction?.body ?? '');

  const [delayMs, setDelayMs] = useState<number | ''>(seedAction?.delayMs ?? '');
  const [fakerLocale, setFakerLocale] = useState(seedAction?.fakerLocale ?? 'zh_CN');
  const [neEnabled, setNeEnabled] = useState(Boolean(seedAction?.networkError));
  const [neProbability, setNeProbability] = useState<number | ''>(
    seedAction?.networkError?.probability ?? 100,
  );
  const [neType, setNeType] = useState<NetworkErrorType>(seedAction?.networkError?.type ?? 'ECONNRESET');
  const [neStatusCode, setNeStatusCode] = useState<number | ''>(
    seedAction?.networkError?.errorStatusCode ?? '',
  );

  const [mode, setMode] = useState<'static' | 'sequential'>(
    seed && 'responses' in seed.action ? 'sequential' : 'static',
  );
  const [seqResponses, setSeqResponses] = useState<SequentialResponse[]>(
    seed && 'responses' in seed.action ? seed.action.responses : [{ status: 200, headers: {}, body: '' }],
  );
  const [scenario, setScenario] = useState<string | undefined>(seed?.scenario ?? presetScenario);

  const patchSeq = (idx: number, patch: Partial<SequentialResponse>) => {
    setSeqResponses((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };
  const updateSeq = (idx: number, patch: Partial<SequentialResponse>) => {
    patchSeq(idx, patch);
    // 模板标记的语义是「最后一条响应与模板一致」，只有改动最后一条才算脱离模板
    if (idx === seqResponses.length - 1) clearTemplate();
  };
  const removeSeq = (idx: number) => {
    setSeqResponses((prev) => prev.filter((_, i) => i !== idx));
    clearTemplate();
  };
  const addSeq = () => {
    setSeqResponses((prev) => [...prev, { status: 200, headers: {}, body: '' }]);
    clearTemplate();
  };
  const [preview, setPreview] = useState('');
  const previewTokens = useMemo(() => tokenizeJson(preview), [preview]);
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
    if (mode === 'sequential') {
      // 序列模式下模板填入最后一条响应；连接类模板是规则级网络异常，对单条响应不可表达
      if (template.payload.kind !== 'http' || seqResponses.length === 0) return;
      const idx = seqResponses.length - 1;
      const row = seqResponses[idx]!;
      patchSeq(idx, {
        status: template.payload.status,
        body: template.payload.body,
        headers: {
          'content-type': 'application/json',
          ...row.headers,
          ...template.payload.headers,
        },
      });
      return;
    }
    const next = applyErrorTemplate(
      { status, body, respHeadersRows, neEnabled, neProbability, neType },
      template,
    );
    setStatus(next.status);
    setBody(next.body);
    setRespHeadersRows(next.respHeadersRows);
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
    if (mode === 'sequential') {
      const responses = seqResponses.length > 0 ? seqResponses : [{ status: 200, headers: {}, body: '' }];
      const action: RuleAction = { responses };
      if (fakerLocale) action.fakerLocale = fakerLocale;
      return action;
    }
    const respHeaders: Record<string, string> = {};
    const hasContentType = respHeadersRows.some(
      (r) => r.enabled && r.name && r.name.toLowerCase() === 'content-type',
    );
    if (!hasContentType) respHeaders['content-type'] = 'application/json';
    for (const r of respHeadersRows.filter((r) => r.enabled && r.name)) {
      respHeaders[r.name] = r.value;
    }
    const action: RuleAction = {
      status,
      headers: respHeaders,
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
    const query = queryRows.some((r) => r.name || r.value) ? queryRows : undefined;
    const action = buildAction();
    try {
      await api.rulesValidate(action);
    } catch (err) {
      setError(String(err));
      return;
    }
    const matchBody: RuleBody | undefined =
      bodyRule.mode === 'none'
        ? undefined
        : bodyRule.mode === 'raw'
          ? {
              mode: 'raw',
              raw: bodyRule.raw,
              rawContentType: bodyRule.rawContentType,
              matchStrategy: bodyRule.matchStrategy,
            }
          : {
              mode: bodyRule.mode,
              form: bodyRule.form?.filter((r) => r.name || r.value),
            };

    const input: RuleInput = {
      name: name.trim() || urlPattern,
      enabled: initial?.enabled ?? true,
      match: {
        urlType,
        urlPattern,
        method,
        query,
        headers: headersRows.some((r) => r.name || r.value) ? headersRows : undefined,
        body: matchBody,
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
      const parsed = parseJsonBody(result.rendered);
      setPreview(parsed.ok ? JSON.stringify(parsed.value, null, 2) : result.rendered);
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
          <label>Query 参数</label>
          <EditableTable rows={queryRows} onChange={setQueryRows} ariaLabel="Query 参数" />
          <label>请求头</label>
          <EditableTable rows={headersRows} onChange={setHeadersRows} ariaLabel="请求头" />
          <label>请求体</label>
          <div className="body-tabs">
            {(['none', 'raw', 'form-data', 'urlencoded'] as BodyMode[]).map((m) => (
              <button
                key={m}
                type="button"
                className={`tab ${bodyRule.mode === m ? 'active' : ''}`}
                onClick={() =>
                  setBodyRule({
                    ...bodyRule,
                    mode: m,
                    form: bodyRule.form ?? [{ enabled: true, name: '', value: '', description: '' }],
                  })
                }
              >
                {m === 'none' ? '无' : m === 'raw' ? 'raw' : m === 'form-data' ? 'form-data' : 'x-www-form'}
              </button>
            ))}
          </div>
          {bodyRule.mode === 'none' && <div className="hint">此规则不匹配请求体</div>}
          {bodyRule.mode === 'raw' && (
            <>
              <div className="body-options">
                <label>
                  内容类型
                  <input
                    value={bodyRule.rawContentType ?? 'application/json'}
                    onChange={(e) => setBodyRule({ ...bodyRule, rawContentType: e.target.value })}
                  />
                </label>
                <label>
                  匹配策略
                  <select
                    value={bodyRule.matchStrategy ?? 'contains'}
                    onChange={(e) =>
                      setBodyRule({ ...bodyRule, matchStrategy: e.target.value as BodyMatchStrategy })
                    }
                  >
                    <option value="contains">包含</option>
                    <option value="equals">完全相等</option>
                    <option value="json-deep">JSON 深度相等</option>
                  </select>
                </label>
              </div>
              <JsonBodyEditor
                rows={12}
                value={bodyRule.raw ?? ''}
                onChange={(raw) => setBodyRule({ ...bodyRule, raw })}
                placeholder='{"keyword": "test"}'
                ariaLabel="请求体"
              />
            </>
          )}
          {(bodyRule.mode === 'form-data' || bodyRule.mode === 'urlencoded') && (
            <EditableTable
              rows={bodyRule.form ?? [{ enabled: true, name: '', value: '', description: '' }]}
              onChange={(form) => setBodyRule({ ...bodyRule, form })}
              columns={{ description: false }}
              ariaLabel="请求体表单"
            />
          )}
          {mode === 'static' ? (
            <>
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
              <label>响应头</label>
              <EditableTable
                rows={respHeadersRows}
                onChange={(rows) => {
                  setRespHeadersRows(rows);
                  clearTemplate();
                }}
                ariaLabel="响应头"
              />
              <label>响应体</label>
              <JsonBodyEditor
                rows={16}
                value={body}
                disabled={connectionOnly}
                describedBy={connectionOnly ? CONNECTION_NOTE_ID : undefined}
                textareaRef={bodyRef}
                onChange={(v) => {
                  setBody(v);
                  clearTemplate();
                }}
                placeholder='{"code":0}'
                ariaLabel="响应体"
              />
              {connectionOnly && (
                <p className="form-note" id={CONNECTION_NOTE_ID}>
                  连接异常模板会让请求在连接层失败，不返回任何响应，因此状态码与响应体暂不可编辑；取消勾选「网络异常」即可恢复。
                </p>
              )}
            </>
          ) : (
            <>
              <label>序列响应</label>
              <div data-testid="sequential-editor">
                {seqResponses.map((r, i) => (
                  <div key={i} className="seq-row" data-testid={`seq-row-${i}`}>
                    <div className="seq-row-head">
                      <span className="seq-index">#{i + 1}</span>
                      <input
                        type="number"
                        data-testid={`seq-status-${i}`}
                        value={r.status}
                        aria-label={`序列响应 ${i + 1} 状态码`}
                        onChange={(e) => updateSeq(i, { status: Number(e.target.value) })}
                      />
                      <button
                        type="button"
                        data-testid={`seq-remove-${i}`}
                        aria-label={`删除序列响应 ${i + 1}`}
                        onClick={() => removeSeq(i)}
                      >×</button>
                    </div>
                    <JsonBodyEditor
                      rows={4}
                      value={r.body}
                      onChange={(body) => updateSeq(i, { body })}
                      placeholder='{"code":0}'
                      ariaLabel={`序列响应 ${i + 1} 响应体`}
                    />
                  </div>
                ))}
                <button type="button" data-testid="seq-add" onClick={addSeq}>+ 添加响应</button>
              </div>
            </>
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
              <pre className="preview">
                {preview ? <JsonSpans tokens={previewTokens} /> : '(点击"刷新预览"查看)'}
              </pre>
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
            <label>响应模式</label>
            <div>
              <label>
                <input
                  type="radio"
                  name="response-mode"
                  data-testid="mode-static"
                  checked={mode === 'static'}
                  onChange={() => {
                    setMode('static');
                    clearTemplate();
                  }}
                />
                静态响应
              </label>{' '}
              <label>
                <input
                  type="radio"
                  name="response-mode"
                  data-testid="mode-sequential"
                  checked={mode === 'sequential'}
                  onChange={() => {
                    setMode('sequential');
                    clearTemplate();
                  }}
                />
                序列响应
              </label>
            </div>
            <label>场景</label>
            <ScenarioField value={scenario} onChange={setScenario} />
            <label>本地化</label>
            <select value={fakerLocale} onChange={(e) => setFakerLocale(e.target.value)}>
              {LOCALES.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
            <label htmlFor={TEMPLATE_SELECT_ID}>错误模板</label>
            <select
              id={TEMPLATE_SELECT_ID}
              value={selectedTemplateId}
              onChange={(e) => selectTemplate(e.target.value)}
            >
              <option value={CUSTOM_TEMPLATE_ID}>无（自定义）</option>
              {TEMPLATE_GROUPS.map((group) => {
                if (mode === 'sequential' && group.category === 'connection') return null;
                return (
                  <optgroup key={group.category} label={group.label}>
                    {ERROR_TEMPLATES.filter((t) => t.category === group.category).map((t) => (
                      <option key={t.id} value={t.id}>{t.label}</option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
            {mode === 'sequential' && (
              <p className="form-note">模板填入最后一条响应（当前第 {seqResponses.length} 条）</p>
            )}
            {mode === 'static' && (
              <>
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
