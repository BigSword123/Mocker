import { useState } from 'react';
import { api } from '../lib/api';

export default function ScenarioCreate({ onCreated }: { onCreated: () => void }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  const add = async () => {
    setError('');
    const n = name.trim();
    if (!n) { setError('名称不能为空'); return; }
    try {
      await api.scenariosAdd(n);
      setName('');
      setCreating(false);
      onCreated();
    } catch (e) {
      setError(String(e));
    }
  };

  if (!creating) {
    return <button data-testid="scenario-new" onClick={() => setCreating(true)}>+ 新建场景</button>;
  }
  return (
    <span className="scenario-create">
      <input
        data-testid="scenario-name-input"
        placeholder="场景名"
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void add(); }}
      />
      <button data-testid="scenario-add" onClick={add}>添加</button>
      <button onClick={() => setCreating(false)}>取消</button>
      {error && <span className="text-err">{error}</span>}
    </span>
  );
}
