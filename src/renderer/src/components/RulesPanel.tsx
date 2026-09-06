import { useCallback, useEffect, useState } from 'react';
import type { MockRule, Scenario } from '../../../shared/types';
import { api } from '../lib/api';
import { DND_MIME, groupByScenario, type DragPayload } from '../lib/scenario-groups';
import RuleEditorModal from './RuleEditorModal';
import ScenarioCreate from './ScenarioCreate';
import ScenarioGroup, { type MoveTarget } from './ScenarioGroup';

const UNGROUPED_ID = 'group-ungrouped';

export default function RulesPanel() {
  const [rules, setRules] = useState<MockRule[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [editor, setEditor] = useState<{ rule: MockRule | null; scenario: string | undefined } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([api.rulesList(), api.scenariosList()]);
      setRules(r);
      setScenarios(s);
    } catch {
      // keep the current list if the IPC call fails
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const moveTargets = (exclude: string | undefined): MoveTarget[] => [
    { value: '', label: '未分组' },
    ...scenarios.filter((s) => s.name !== exclude).map((s) => ({ value: s.name, label: s.name })),
  ];

  const toggleGroup = async (name: string, enabled: boolean) => {
    await api.scenariosSetEnabled(name, enabled);
    await refresh();
  };

  const renameGroup = async (oldName: string, newName: string) => {
    try {
      await api.scenariosRename(oldName, newName);
    } catch {
      // keep the old name on failure (e.g. duplicated)
    }
    await refresh();
  };

  const deleteGroup = async (name: string, moveTo: string | null) => {
    try {
      await api.scenariosRemove(name, moveTo);
    } catch {
      // keep everything on failure
    }
    await refresh();
  };

  const moveRule = async (rule: MockRule, target: string) => {
    await api.rulesUpdate(rule.id, { scenario: target === '' ? undefined : target });
    await refresh();
  };

  const handleDrop = async (targetScenario: string | undefined, payload: DragPayload) => {
    if (payload.type === 'item') {
      const rule = rules.find((r) => r.id === payload.value);
      if (!rule) return;
      await moveRule(rule, targetScenario ?? '');
      return;
    }
    if (targetScenario === undefined || payload.value === targetScenario) return;
    const names = scenarios.map((s) => s.name).filter((n) => n !== payload.value);
    const idx = names.indexOf(targetScenario);
    if (idx === -1) return;
    names.splice(idx, 0, payload.value);
    try {
      await api.scenariosReorder(names);
    } catch {
      // ignore invalid order payloads
    }
    await refresh();
  };

  const groups = groupByScenario(rules, scenarios);

  return (
    <div className="panel">
      <div className="toolbar">
        <ScenarioCreate onCreated={refresh} />
        <span className="muted">命中顺序跨场景全局按优先级，取第一个命中；组开关只决定整组是否生效</span>
      </div>
      {groups.map((g) => {
        const testId = g.scenario === undefined ? UNGROUPED_ID : `group-${g.scenario}`;
        return (
          <ScenarioGroup
            key={g.scenario ?? UNGROUPED_ID}
            testId={testId}
            name={g.scenario ?? '未分组'}
            scenario={g.scenario}
            builtin={g.builtin}
            enabled={g.enabled}
            count={g.items.length}
            createLabel="+ 新建规则"
            moveTargets={moveTargets(g.scenario)}
            draggableScenario={g.scenario !== undefined}
            onToggle={g.scenario === undefined ? undefined : (enabled) => toggleGroup(g.scenario!, enabled)}
            onRename={g.scenario === undefined ? undefined : (newName) => renameGroup(g.scenario!, newName)}
            onDelete={g.scenario === undefined ? undefined : (moveTo) => deleteGroup(g.scenario!, moveTo)}
            onCreateItem={() => setEditor({ rule: null, scenario: g.scenario })}
            onDropPayload={(payload) => void handleDrop(g.scenario, payload)}
          >
            <table className="rules-table">
              <thead>
                <tr><th className="col-enabled">启用</th><th className="col-name">名称</th><th className="col-match">匹配</th><th className="col-response">响应</th><th className="col-ops">操作</th></tr>
              </thead>
              <tbody>
                {g.items.map((r) => (
                  <tr
                    key={r.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(
                        DND_MIME,
                        JSON.stringify({ type: 'item', value: r.id } satisfies DragPayload),
                      );
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                  >
                    <td className="col-enabled">
                      <input
                        type="checkbox"
                        checked={r.enabled}
                        onChange={async (e) => {
                          await api.rulesUpdate(r.id, { enabled: e.target.checked });
                          await refresh();
                        }}
                      />
                    </td>
                    <td className="col-name" title={r.name}>{r.name}</td>
                    <td className="col-match muted" title={`${r.match.method} ${r.match.urlPattern}`}>{r.match.method} {r.match.urlPattern}</td>
                    <td className="col-response muted">{'status' in r.action ? r.action.status : '—'}</td>
                    <td className="col-ops">
                      <div className="ops">
                        <select
                          aria-label={`移动规则 ${r.name}`}
                          data-testid={`move-${r.name}`}
                          value={r.scenario ?? ''}
                          onChange={(e) => moveRule(r, e.target.value)}
                        >
                          <option value="">未分组</option>
                          {scenarios.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
                        </select>
                        <button onClick={() => moveRuleByPriority(r, -1)}>↑</button>
                        <button onClick={() => moveRuleByPriority(r, 1)}>↓</button>
                        <button onClick={() => setEditor({ rule: r, scenario: undefined })}>编辑</button>
                        <button onClick={() => removeRule(r)}>删除</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {g.items.length === 0 && (
                  <tr><td colSpan={5} className="muted">此场景暂无规则</td></tr>
                )}
              </tbody>
            </table>
          </ScenarioGroup>
        );
      })}
      {editor && (
        <RuleEditorModal
          initial={editor.rule}
          presetScenario={editor.rule ? undefined : editor.scenario}
          onClose={() => setEditor(null)}
          onSaved={() => { setEditor(null); refresh(); }}
        />
      )}
    </div>
  );

  async function moveRuleByPriority(rule: MockRule, dir: -1 | 1) {
    const idx = rules.findIndex((r) => r.id === rule.id);
    const other = rules[idx + dir];
    if (!other) return;
    try {
      await api.rulesUpdate(rule.id, { priority: other.priority });
      await api.rulesUpdate(other.id, { priority: rule.priority });
      await refresh();
    } catch {
      await refresh();
    }
  }

  async function removeRule(rule: MockRule) {
    try {
      await api.rulesRemove(rule.id);
      await refresh();
    } catch {
      await refresh();
    }
  }
}
