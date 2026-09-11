import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef } from 'react';
import type { JsonToken } from '../lib/json-format';
import { JsonSpans } from './JsonBodyEditor';

/** 必须和 CSS 里 .virtual-line 的行高一致，否则总高度和实际渲染会对不上。 */
export const LINE_HEIGHT = 18;

interface Props {
  lines: JsonToken[][];
}

/**
 * 等高行虚拟滚动，只渲染视口内的行。
 * 横向不换行（white-space: pre）：一旦换行，行高就不再固定，虚拟滚动的定位会全乱。
 */
export default function VirtualLines({ lines }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: 30,
  });

  return (
    <div ref={parentRef} className="virtual-lines" data-testid="virtual-lines" data-line-count={lines.length}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.index}
            className="virtual-line"
            style={{ position: 'absolute', top: item.start, height: item.size }}
          >
            <span className="virtual-line-no">{item.index + 1}</span>
            <span className="virtual-line-text">
              <JsonSpans tokens={lines[item.index]!} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
