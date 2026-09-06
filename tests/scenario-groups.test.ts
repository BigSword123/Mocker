import { describe, expect, it } from 'vitest';
import { DND_MIME, groupByScenario, type DragPayload } from '../src/renderer/src/lib/scenario-groups';
import type { Scenario } from '../src/shared/types';

interface Item { id: string; scenario?: string }

const scenarios: Scenario[] = [
  { name: '默认', enabled: true, builtin: true },
  { name: 'dev', enabled: false },
];

describe('groupByScenario', () => {
  it('puts unassigned items in a leading ungrouped pseudo-group', () => {
    const items: Item[] = [{ id: 'a' }, { id: 'b', scenario: 'dev' }, { id: 'c' }];
    const groups = groupByScenario(items, scenarios);
    expect(groups).toEqual([
      { scenario: undefined, builtin: false, enabled: null, items: [{ id: 'a' }, { id: 'c' }] },
      { scenario: '默认', builtin: true, enabled: true, items: [] },
      { scenario: 'dev', builtin: false, enabled: false, items: [{ id: 'b', scenario: 'dev' }] },
    ]);
  });

  it('omits ungrouped group when nothing unassigned', () => {
    const groups = groupByScenario<Item>([{ id: 'b', scenario: '默认' }], scenarios);
    expect(groups.map((g) => g.scenario)).toEqual(['默认', 'dev']);
  });

  it('keeps item order inside groups', () => {
    const items: Item[] = [{ id: '2', scenario: 'dev' }, { id: '1', scenario: 'dev' }];
    const [devGroup] = groupByScenario(items, scenarios).filter((g) => g.scenario === 'dev');
    expect(devGroup!.items.map((i) => i.id)).toEqual(['2', '1']);
  });

  it('returns only ungrouped group when scenario list is empty', () => {
    const groups = groupByScenario<Item>([{ id: 'a' }], []);
    expect(groups).toEqual([{ scenario: undefined, builtin: false, enabled: null, items: [{ id: 'a' }] }]);
  });

  it('exports a stable DnD mime and payload shape', () => {
    const payload: DragPayload = { type: 'item', value: 'r1' };
    expect(DND_MIME).toBeTruthy();
    expect(JSON.parse(JSON.stringify(payload)).type).toBe('item');
  });
});
