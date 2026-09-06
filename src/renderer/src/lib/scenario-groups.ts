import type { Scenario } from '../../../shared/types';

/** 拖拽负载：组头之间拖 = 场景排序；行拖到组 = 条目换场景 */
export interface DragPayload {
  type: 'scenario' | 'item';
  value: string;
}

export const DND_MIME = 'application/x-mocker-drag';

export interface ScenarioGroupView<T> {
  /** undefined = 未分组伪组 */
  scenario: string | undefined;
  builtin: boolean;
  /** null = 未分组（无组开关，条目永远生效） */
  enabled: boolean | null;
  items: T[];
}

/** 未分组（若有）置顶，其余按场景持久化顺序；组内保持传入顺序（调用方按优先级排好） */
export function groupByScenario<T extends { scenario?: string }>(
  items: T[],
  scenarios: Scenario[],
): Array<ScenarioGroupView<T>> {
  const groups: Array<ScenarioGroupView<T>> = [];
  const unassigned = items.filter((it) => !it.scenario);
  if (unassigned.length > 0) {
    groups.push({ scenario: undefined, builtin: false, enabled: null, items: unassigned });
  }
  for (const s of scenarios) {
    groups.push({
      scenario: s.name,
      builtin: Boolean(s.builtin),
      enabled: s.enabled,
      items: items.filter((it) => it.scenario === s.name),
    });
  }
  return groups;
}
