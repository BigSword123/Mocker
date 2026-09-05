import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { Scenario } from '../../../shared/types';

interface Props {
  value: string | undefined;
  onChange: (name: string | undefined) => void;
}

export default function ScenarioField({ value, onChange }: Props) {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);

  useEffect(() => {
    api.scenariosList()
      .then(setScenarios)
      .catch(() => {});
  }, []);

  return (
    <select
      data-testid="scenario-field"
      aria-label="场景"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
    >
      <option value="">无</option>
      {scenarios.map((s) => (
        <option key={s.name} value={s.name}>{s.name}</option>
      ))}
    </select>
  );
}
