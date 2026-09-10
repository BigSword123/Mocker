import { useState } from 'react';
import TimestampTool from './TimestampTool';
import GzipTool from './GzipTool';

type ToolKey = 'timestamp' | 'gzip';

const TOOLS: { key: ToolKey; label: string }[] = [
  { key: 'timestamp', label: '时间戳' },
  { key: 'gzip', label: 'gzip' },
];

export default function ToolsPanel() {
  const [tool, setTool] = useState<ToolKey>('timestamp');
  return (
    <div className="panel" data-testid="tools-panel">
      <h2>实用工具</h2>
      <div className="tab-row">
        {TOOLS.map((t) => (
          <button
            key={t.key}
            data-testid={`tool-tab-${t.key}`}
            className={tool === t.key ? 'active' : ''}
            onClick={() => setTool(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tool === 'timestamp' && <TimestampTool />}
      {tool === 'gzip' && <GzipTool />}
    </div>
  );
}
