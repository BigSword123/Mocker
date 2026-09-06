import { useState } from 'react';
import type { HeaderRow, HttpMethod, RedirectRule, RuleMatch } from '../../../shared/types';
import { api } from '../lib/api';
import EditableTable from './EditableTable';
import ScenarioField from './ScenarioField';

type ActionKind = 'mapLocal' | 'mapRemote';

interface Props {
  initial: RedirectRule | null;
  /** 新建时预挂的场景 */
  presetScenario?: string;
  onClose: () => void;
  onSaved: () => void;
}

const URL_TYPES: Array<{ value: RuleMatch['urlType']; label: string }> = [
  { value: 'exact', label: '精确' },
  { value: 'wildcard', label: '通配符' },
  { value: 'regex', label: '正则' },
];
const METHODS: HttpMethod[] = ['ANY', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
const EMPTY_ROW: HeaderRow = { enabled: true, name: '', value: '', description: '' };

export default function RedirectEditorModal({ initial, presetScenario, onClose, onSaved }: Props) {
  const seed = initial;
  const [name, setName] = useState(seed?.name ?? '');
  const [enabled, setEnabled] = useState(seed?.enabled ?? true);
  const [urlType, setUrlType] = useState<RuleMatch['urlType']>(seed?.match.urlType ?? 'exact');
  const [urlPattern, setUrlPattern] = useState(seed?.match.urlPattern ?? '');
  const [method, setMethod] = useState<HttpMethod>(seed?.match.method ?? 'ANY');
  const [headers, setHeaders] = useState<HeaderRow[]>(() => {
    const out: HeaderRow[] = Object.entries(seed?.match.headers ?? {}).map(([name, value]) => ({
      enabled: true, name, value, description: '',
    }));
    return out.length > 0 ? out : [{ ...EMPTY_ROW }];
  });
  const [actionKind, setActionKind] = useState<ActionKind>(seed?.action ?? 'mapLocal');
  const [target, setTarget] = useState(seed?.target ?? '');
  const [scenario, setScenario] = useState<string | undefined>(seed?.scenario ?? presetScenario);
  const [error, setError] = useState('');

  const chooseFile = async () => {
    const filePath = await api.openFileDialog();
    if (typeof filePath === 'string') setTarget(filePath);
  };

  const save = async () => {
    setError('');
    if (!urlPattern.trim()) { setError('URL 模式不能为空'); return; }
    if (!target.trim()) { setError('目标不能为空'); return; }
    const headersObj: Record<string, string> = {};
    for (const r of headers) if (r.enabled && r.name.trim()) headersObj[r.name.trim()] = r.value;
    const match: RuleMatch = { urlType, urlPattern, method, headers: headersObj };
    try {
      if (seed) {
        await api.redirectsUpdate(seed.id, { name, enabled, match, action: actionKind, target, scenario });
      } else {
        await api.redirectsAdd({ name, enabled, match, action: actionKind, target, scenario });
      }
      onSaved();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{seed ? '编辑重定向' : '新建重定向'}</h2>
        <div className="form-grid">
          <label>名称</label>
          <input data-testid="redirect-name" value={name} onChange={(e) => setName(e.target.value)} />
          <label>启用</label>
          <input type="checkbox" data-testid="redirect-enabled" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <label>URL 模式</label>
          <select data-testid="redirect-url-type" value={urlType} onChange={(e) => setUrlType(e.target.value as RuleMatch['urlType'])}>
            {URL_TYPES.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
          </select>
          <label>URL</label>
          <input data-testid="redirect-url-pattern" value={urlPattern} onChange={(e) => setUrlPattern(e.target.value)} />
          <label>方法</label>
          <select data-testid="redirect-method" value={method} onChange={(e) => setMethod(e.target.value as HttpMethod)}>
            {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <label>请求头</label>
          <EditableTable rows={headers} onChange={setHeaders} columns={{ description: false }} ariaLabel="请求头" />
          <label>类型</label>
          <select data-testid="redirect-action-kind" value={actionKind} onChange={(e) => setActionKind(e.target.value as ActionKind)}>
            <option value="mapLocal">Map Local（本地文件）</option>
            <option value="mapRemote">Map Remote（远程转发）</option>
          </select>
          <label>目标</label>
          <div>
            <input data-testid="redirect-target" value={target} onChange={(e) => setTarget(e.target.value)} placeholder={actionKind === 'mapLocal' ? '本地文件绝对路径' : 'host:port'} />
            {actionKind === 'mapLocal' && (
              <button type="button" data-testid="redirect-choose-file" onClick={chooseFile}>选择文件</button>
            )}
          </div>
          <label>场景</label>
          <ScenarioField value={scenario} onChange={setScenario} />
        </div>
        {error && <div className="text-err" data-testid="redirect-error">{error}</div>}
        <div className="modal-actions">
          <button onClick={onClose}>取消</button>
          <button data-testid="redirect-save" onClick={save}>保存</button>
        </div>
      </div>
    </div>
  );
}
