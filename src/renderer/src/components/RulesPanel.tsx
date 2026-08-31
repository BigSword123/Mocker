import { useCallback, useEffect, useState } from 'react';
import type { MockRule, RulePatch } from '../../../shared/types';
import { api } from '../lib/api';
import RuleEditorModal from './RuleEditorModal';

// RulePatch intentionally excludes `priority` from the public update contract,
// but the main-process RulesStore applies any patched field as-is, so a priority
// patch is safe for reordering. Keep the escape hatch local to this panel.
function priorityPatch(priority: number): RulePatch {
  return { priority } as unknown as RulePatch;
}

export default function RulesPanel() {
  const [rules, setRules] = useState<MockRule[]>([]);
  const [editing, setEditing] = useState<MockRule | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setRules(await api.rulesList());
    } catch {
      // keep the current list if the IPC call fails
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const move = async (rule: MockRule, dir: -1 | 1) => {
    const idx = rules.findIndex((r) => r.id === rule.id);
    const other = rules[idx + dir];
    if (!other) return;
    try {
      await api.rulesUpdate(rule.id, priorityPatch(other.priority));
      await api.rulesUpdate(other.id, priorityPatch(rule.priority));
      await refresh();
    } catch {
      await refresh();
    }
  };

  const toggleEnabled = async (rule: MockRule, enabled: boolean) => {
    try {
      await api.rulesUpdate(rule.id, { enabled });
      await refresh();
    } catch {
      await refresh();
    }
  };

  const removeRule = async (rule: MockRule) => {
    try {
      await api.rulesRemove(rule.id);
      await refresh();
    } catch {
      await refresh();
    }
  };

  return (
    <div className="panel">
      <div className="toolbar">
        <button className="primary" onClick={() => setCreating(true)}>新建规则</button>
        <span className="muted">优先级从上到下递减；开启即生效</span>
      </div>
      <table className="rules-table">
        <thead>
          <tr><th>启用</th><th>名称</th><th>匹配</th><th>响应</th><th>操作</th></tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id}>
              <td>
                <input
                  type="checkbox"
                  checked={r.enabled}
                  onChange={(e) => toggleEnabled(r, e.target.checked)}
                />
              </td>
              <td>{r.name}</td>
              <td className="muted">{r.match.method} {r.match.urlPattern}</td>
              <td className="muted">{r.action.status}</td>
              <td>
                <div className="ops">
                  <button onClick={() => move(r, -1)}>↑</button>
                  <button onClick={() => move(r, 1)}>↓</button>
                  <button onClick={() => setEditing(r)}>编辑</button>
                  <button onClick={() => removeRule(r)}>删除</button>
                </div>
              </td>
            </tr>
          ))}
          {rules.length === 0 && (
            <tr><td colSpan={5} className="muted">还没有规则，点击「新建规则」开始</td></tr>
          )}
        </tbody>
      </table>
      {(creating || editing) && (
        <RuleEditorModal
          initial={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); refresh(); }}
        />
      )}
    </div>
  );
}
