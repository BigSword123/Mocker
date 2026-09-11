import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState } from 'react';
import type { JsonPathRow } from '../lib/json-flatten';

/** 必须和 CSS 里 .path-row 的行高一致。 */
export const ROW_HEIGHT = 24;

/** 缩进只表意，深度上百时再缩下去就把路径挤出列了。 */
const MAX_INDENT_DEPTH = 8;

interface Props {
  rows: JsonPathRow[];
  /** flattenJson 撞到行数上限时为 true：表里是前 N 行，不是全部 */
  truncated: boolean;
}

/**
 * 把响应体拍平成「路径 → 类型 → 值」的可搜索表。
 * 行高固定，所以和文本视图共用一套虚拟滚动；缩进用 padding 而不是嵌套元素。
 */
export default function PathTable({ rows, truncated }: Props) {
  const [query, setQuery] = useState('');
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim();
    return q ? rows.filter((r) => r.path.includes(q)) : rows;
  }, [rows, query]);

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  const copy = async (path: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(path);
      setCopiedPath(path);
    } catch {
      setCopiedPath(null);
    }
  };

  return (
    <div className="path-table">
      <div className="path-table-bar">
        <input
          type="search"
          className="path-table-search"
          data-testid="path-table-search"
          value={query}
          placeholder="搜索路径，如 items[0].id"
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="path-table-count" data-testid="path-table-count">
          {query.trim() ? `${filtered.length.toLocaleString('en-US')} / ` : ''}
          {rows.length.toLocaleString('en-US')} 行
        </span>
      </div>
      {truncated && (
        <div className="text-warn path-table-truncated" data-testid="path-table-truncated">
          行数超过上限，仅展示前 {rows.length.toLocaleString('en-US')} 行
        </div>
      )}
      <div className="path-table-head">
        <span>路径</span>
        <span>类型</span>
        <span>值</span>
        <span />
      </div>
      <div ref={parentRef} className="path-table-body" data-testid="path-table">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = filtered[item.index]!;
            return (
              <div
                key={row.path}
                className="path-row"
                data-path={row.path}
                style={{ position: 'absolute', top: item.start, height: item.size, width: '100%' }}
                title={row.path}
              >
                <span className="path-cell path-cell-path" style={{ paddingLeft: Math.min(row.depth, MAX_INDENT_DEPTH) * 12 }}>
                  {row.path}
                </span>
                <span className={`path-cell path-cell-kind kind-${row.kind}`}>{row.kind}</span>
                <span className="path-cell path-cell-preview" title={typeof row.value === 'string' ? row.value : undefined}>
                  {row.preview}
                </span>
                <span className="path-cell path-cell-copy">
                  <button
                    type="button"
                    data-testid="path-copy"
                    onClick={() => void copy(row.path)}
                    title="复制路径"
                  >
                    {copiedPath === row.path ? '已复制' : '复制'}
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
