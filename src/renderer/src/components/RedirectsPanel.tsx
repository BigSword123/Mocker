import { useCallback, useEffect, useState } from 'react';
import type { RedirectRule } from '../../../shared/types';
import { api } from '../lib/api';
import RedirectEditorModal from './RedirectEditorModal';

export default function RedirectsPanel() {
  const [rules, setRules] = useState<RedirectRule[]>([]);
  const [editing, setEditing] = useState<RedirectRule | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setRules(await api.redirectsList());
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const toggle = async (rule: RedirectRule, enabled: boolean) => {
    await api.redirectsUpdate(rule.id, { enabled });
    await refresh();
  };
  const remove = async (rule: RedirectRule) => {
    await api.redirectsRemove(rule.id);
    await refresh();
  };

  return (
    <div className="panel">
      <div className="toolbar">
        <button className="primary" data-testid="redirect-new" onClick={() => setCreating(true)}>新建重定向</button>
        <span className="muted">Map Local 命中后返回本地文件；Map Remote 命中后改 host 转发上游</span>
      </div>
      <table className="rules-table">
        <thead>
          <tr>
            <th className="col-enabled">启用</th>
            <th className="col-name">名称</th>
            <th className="col-match">匹配</th>
            <th className="col-response">类型</th>
            <th className="col-ops">操作</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id}>
              <td className="col-enabled">
                <input type="checkbox" checked={r.enabled} onChange={(e) => toggle(r, e.target.checked)} />
              </td>
              <td className="col-name" title={r.name}>{r.name}</td>
              <td className="col-match muted" title={`${r.match.method} ${r.match.urlPattern}`}>{r.match.method} {r.match.urlPattern}</td>
              <td className="col-response muted">{r.action === 'mapLocal' ? '本地' : '远程'}</td>
              <td className="col-ops">
                <div className="ops">
                  <button onClick={() => setEditing(r)}>编辑</button>
                  <button onClick={() => remove(r)}>删除</button>
                </div>
              </td>
            </tr>
          ))}
          {rules.length === 0 && <tr><td colSpan={5} className="muted">还没有重定向，点击「新建重定向」开始</td></tr>}
        </tbody>
      </table>
      {(creating || editing) && (
        <RedirectEditorModal
          initial={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); refresh(); }}
        />
      )}
    </div>
  );
}
