import { useEffect, useMemo, useRef, useState } from 'react';
import { FAKER_CATALOG, type FakerEntry } from '../../../shared/faker-catalog';

interface Props {
  open: boolean;
  onClose: () => void;
  onInsert: (snippet: string) => void;
}

export default function FakerCatalogModal({ open, onClose, onInsert }: Props) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [activeTab, setActiveTab] = useState(FAKER_CATALOG[0].id);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => setDebounced(query), 150);
    return () => clearTimeout(t);
  }, [query, open]);

  useEffect(() => {
    if (open) setTimeout(() => searchRef.current?.focus(), 0);
    else {
      setQuery('');
      setDebounced('');
    }
  }, [open]);

  const filtered = useMemo(() => {
    if (!debounced) return null;
    const q = debounced.toLowerCase();
    return FAKER_CATALOG.flatMap((c) =>
      c.entries.filter(
        (e) =>
          e.path.toLowerCase().includes(q) ||
          e.label.toLowerCase().includes(q) ||
          e.example.toLowerCase().includes(q),
      ),
    );
  }, [debounced]);

  if (!open) return null;

  const visibleEntries: FakerEntry[] =
    filtered ?? FAKER_CATALOG.find((c) => c.id === activeTab)!.entries;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal faker-modal" onClick={(e) => e.stopPropagation()}>
        <div className="faker-head">
          <h2>Faker 速查</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <input
          ref={searchRef}
          className="faker-search"
          placeholder="搜索方法或关键词…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {!filtered && (
          <div className="faker-tabs">
            {FAKER_CATALOG.map((c) => (
              <button
                key={c.id}
                className={activeTab === c.id ? 'tab active' : 'tab'}
                onClick={() => setActiveTab(c.id)}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
        <div className="faker-body">
          {visibleEntries.length === 0 && <div className="empty">无匹配</div>}
          {visibleEntries.map((e) => (
            <div key={e.path} className="faker-row">
              <div className="faker-path">{e.path}</div>
              <div className="faker-label">{e.label}</div>
              <div className="faker-example">示例: {e.example}</div>
              {e.args && <div className="faker-args">参数: {e.args}</div>}
              <button className="primary" onClick={() => onInsert(e.snippet)}>
                插入
              </button>
            </div>
          ))}
        </div>
        <div className="faker-foot">
          语法：<code>{'{{faker.<模块>.<方法>[:参数]}}'}</code>
          <a href="https://fakerjs.dev/api/" target="_blank" rel="noreferrer">
            完整文档 ↗
          </a>
        </div>
      </div>
    </div>
  );
}
