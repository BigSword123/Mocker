import { useCallback, useEffect, useState } from 'react';
import type { Scenario } from '../../../shared/types';
import { api } from '../lib/api';

export default function ScenariosPanel() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<Scenario | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      setScenarios(await api.scenariosList());
    } catch {
      // ignore
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const add = async () => {
    setError('');
    const name = newName.trim();
    if (!name) { setError('名称不能为空'); return; }
    try {
      await api.scenariosAdd(name);
      setNewName('');
      setCreating(false);
      await refresh();
    } catch (e) { setError(String(e)); }
  };

  const toggle = async (s: Scenario, enabled: boolean) => {
    await api.scenariosSetEnabled(s.name, enabled);
    await refresh();
  };

  const doRename = async () => {
    if (!renaming) return;
    setError('');
    const newN = renameValue.trim();
    if (!newN || newN === renaming.name) { setRenaming(null); return; }
    try {
      await api.scenariosRename(renaming.name, newN);
      setRenaming(null);
      await refresh();
    } catch (e) { setError(String(e)); }
  };

  const remove = async (s: Scenario) => {
    if (!window.confirm(`确定删除场景「${s.name}」？引用此场景的规则与重定向将自动清除场景关联。`)) return;
    await api.scenariosRemove(s.name);
    await refresh();
  };

  return (
    <div className="panel">
      <div className="toolbar">
        <button className="primary" data-testid="scenario-new" onClick={() => setCreating(true)}>新建场景</button>
        <span className="muted">规则与重定向可挂到场景；场景关闭时挂入的条目一并失效</span>
      </div>
      {creating && (
        <div className="toolbar">
          <input data-testid="scenario-name-input" placeholder="场景名" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <button data-testid="scenario-add" onClick={add}>添加</button>
          <button onClick={() => setCreating(false)}>取消</button>
        </div>
      )}
      {renaming && (
        <div className="toolbar">
          <input data-testid="scenario-rename-input" placeholder="新名" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} />
          <button data-testid="scenario-rename-save" onClick={doRename}>保存</button>
          <button onClick={() => setRenaming(null)}>取消</button>
        </div>
      )}
      {error && <div className="text-err">{error}</div>}
      <table className="rules-table">
        <thead><tr><th className="col-enabled">启用</th><th className="col-name">名称</th><th className="col-ops">操作</th></tr></thead>
        <tbody>
          {scenarios.map((s) => (
            <tr key={s.name}>
              <td className="col-enabled">
                <input type="checkbox" checked={s.enabled} onChange={(e) => toggle(s, e.target.checked)} />
              </td>
              <td className="col-name" title={s.name}>{s.name}</td>
              <td className="col-ops">
                <div className="ops">
                  <button data-testid={`scenario-rename-${s.name}`} onClick={() => { setRenaming(s); setRenameValue(s.name); }}>重命名</button>
                  <button data-testid={`scenario-delete-${s.name}`} onClick={() => remove(s)}>删除</button>
                </div>
              </td>
            </tr>
          ))}
          {scenarios.length === 0 && <tr><td colSpan={3} className="muted">还没有场景，点击「新建场景」开始</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
