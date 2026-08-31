import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef } from 'react';
import type { TrafficEvent } from '../../../shared/types';

interface Props {
  events: TrafficEvent[];
  selectedId: string | null;
  onSelect: (e: TrafficEvent) => void;
}

export default function TrafficTable({ events, selectedId, onSelect }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 20,
  });

  return (
    <div ref={parentRef} className="traffic-table">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const e = events[item.index];
          return (
            <div
              key={e.id}
              className={`row ${selectedId === e.id ? 'selected' : ''} ${e.mocked ? 'mocked' : ''} ${e.error ? 'errored' : ''}`}
              style={{ position: 'absolute', top: item.start, height: item.size, width: '100%' }}
              onClick={() => onSelect(e)}
            >
              <span className="cell status">{e.status ?? '…'}</span>
              <span className="cell method">{e.method}</span>
              <span className="cell url" title={e.url}>{e.url}</span>
              {e.mocked && <span className="badge">MOCK</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
