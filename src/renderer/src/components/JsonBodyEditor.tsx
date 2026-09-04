import { useMemo, useRef, useState, type RefObject } from 'react';
import { formatJson, parseJsonBody, tokenizeJson, type JsonToken } from '../lib/json-format';
import JsonTree from './JsonTree';

const HIGHLIGHT_MAX_LENGTH = 100_000;

export function JsonSpans({ tokens }: { tokens: JsonToken[] }) {
  return (
    <>
      {tokens.map((t, i) => {
        if (t.kind === 'plain') return <span key={i}>{t.text}</span>;
        if (t.kind === 'punct') return <span key={i} className="json-tk-punct">{t.text}</span>;
        return <span key={i} className={`json-d${t.depth % 6}`}>{t.text}</span>;
      })}
    </>
  );
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  describedBy?: string;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  ariaLabel?: string;
}

export default function JsonBodyEditor({
  value,
  onChange,
  rows = 16,
  placeholder,
  disabled = false,
  describedBy,
  textareaRef,
  ariaLabel,
}: Props) {
  const [tab, setTab] = useState<'edit' | 'tree'>('edit');
  const [treeValue, setTreeValue] = useState<unknown>(null);
  const [treeError, setTreeError] = useState('');
  const [formatError, setFormatError] = useState('');
  const hlRef = useRef<HTMLPreElement>(null);

  const highlight = !disabled && value.length <= HIGHLIGHT_MAX_LENGTH;
  const tokens = useMemo(
    () => (highlight ? tokenizeJson(value) : null),
    [highlight, value],
  );

  const format = () => {
    const r = formatJson(value);
    if (r.ok) {
      onChange(r.formatted);
      setFormatError('');
    } else {
      setFormatError(r.error);
    }
  };

  const enterTree = () => {
    const r = parseJsonBody(value);
    if (!r.ok) {
      setTreeError(r.error);
      setTab('tree');
      return;
    }
    setTreeValue(r.value);
    setTreeError('');
    setTab('tree');
  };

  const onTreeChange = (v: unknown) => {
    setTreeValue(v);
    onChange(JSON.stringify(v, null, 2));
  };

  const syncScroll = () => {
    const ta = textareaRef?.current;
    const hl = hlRef.current;
    if (ta && hl) {
      hl.scrollTop = ta.scrollTop;
      hl.scrollLeft = ta.scrollLeft;
    }
  };

  return (
    <div className={`json-editor${disabled ? ' disabled' : ''}`}>
      <div className="json-editor-bar">
        <div className="json-editor-tabs">
          <button
            type="button"
            className={`tab${tab === 'edit' ? ' active' : ''}`}
            onClick={() => setTab('edit')}
          >
            编辑
          </button>
          <button
            type="button"
            className={`tab${tab === 'tree' ? ' active' : ''}`}
            disabled={disabled}
            onClick={enterTree}
          >
            树视图
          </button>
        </div>
        {tab === 'edit' && !disabled && (
          <button type="button" onClick={format}>格式化 JSON</button>
        )}
        {tab === 'edit' && formatError && (
          <span className="json-editor-error text-err">{formatError}</span>
        )}
      </div>
      {tab === 'edit' ? (
        <div className={`json-editor-box${tokens ? ' has-hl' : ''}`}>
          {tokens && (
            <pre className="json-hl" ref={hlRef} aria-hidden="true">
              <JsonSpans tokens={tokens} />
              {'\n'}
            </pre>
          )}
          <textarea
            ref={textareaRef}
            rows={rows}
            value={value}
            disabled={disabled}
            aria-describedby={describedBy}
            aria-label={ariaLabel}
            placeholder={placeholder}
            onChange={(e) => {
              onChange(e.target.value);
              setFormatError('');
            }}
            onScroll={syncScroll}
          />
        </div>
      ) : treeError ? (
        <div className="json-tree-error">
          <span className="text-err">不是合法 JSON：{treeError}</span>
          <button type="button" onClick={() => setTab('edit')}>返回编辑</button>
        </div>
      ) : (
        <div className="json-tree">
          <JsonTree value={treeValue} onChange={onTreeChange} />
        </div>
      )}
    </div>
  );
}
