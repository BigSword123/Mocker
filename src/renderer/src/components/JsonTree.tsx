import { useState } from 'react';
import {
  coerceValue,
  kindOf,
  removeIn,
  renameIn,
  setIn,
  type JsonValueKind,
} from '../lib/json-tree';

const KIND_OPTIONS: Array<{ value: JsonValueKind; label: string }> = [
  { value: 'string', label: '字符串' },
  { value: 'number', label: '数字' },
  { value: 'boolean', label: '布尔' },
  { value: 'null', label: 'null' },
  { value: 'object', label: '对象' },
  { value: 'array', label: '数组' },
];

/** 默认全展开，与加 autoOpen 之前的行为逐字一致。 */
const ALWAYS_OPEN = (): boolean => true;

type AutoOpen = (depth: number, entryCount: number) => boolean;

interface NodeName {
  type: 'key' | 'index';
  value: string;
}

interface NodeProps {
  value: unknown;
  depth: number;
  name?: NodeName;
  onChange: (value: unknown) => void;
  onDelete?: () => void;
  onRename?: (nextKey: string) => void;
  readOnly: boolean;
  autoOpen: AutoOpen;
}

function NumberEditor({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="text"
      inputMode="decimal"
      value={draft ?? String(value)}
      aria-label="数字值"
      onChange={(e) => {
        const raw = e.target.value;
        const n = Number(raw);
        if (raw.trim() !== '' && Number.isFinite(n)) {
          onChange(n);
          setDraft(null);
        } else {
          setDraft(raw);
        }
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

function ValueEditor({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const kind = kindOf(value);
  return (
    <span className="json-tree-value">
      <select
        value={kind}
        aria-label="值类型"
        onChange={(e) => onChange(coerceValue(e.target.value as JsonValueKind))}
      >
        {KIND_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {kind === 'string' && (
        <input
          type="text"
          value={value as string}
          aria-label="字符串值"
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {kind === 'number' && (
        <NumberEditor value={value as number} onChange={onChange} />
      )}
      {kind === 'boolean' && (
        <label className="json-tree-bool">
          <input
            type="checkbox"
            checked={value as boolean}
            aria-label="布尔值"
            onChange={(e) => onChange(e.target.checked)}
          />
          {value ? 'true' : 'false'}
        </label>
      )}
      {kind === 'null' && <span className="json-tree-null">null</span>}
    </span>
  );
}

/** 只读渲染：字符串加引号，免得和数字/布尔分不清。 */
function ReadOnlyValue({ value }: { value: unknown }) {
  const kind = kindOf(value);
  if (kind === 'null') return <span className="json-tree-null">null</span>;
  if (kind === 'string') return <span className="json-tree-ro">"{value as string}"</span>;
  return <span className="json-tree-ro">{String(value)}</span>;
}

function JsonTreeNode({
  value,
  depth,
  name,
  onChange,
  onDelete,
  onRename,
  readOnly,
  autoOpen,
}: NodeProps) {
  const kind = kindOf(value);
  const isContainer = kind === 'object' || kind === 'array';
  const colorClass = `json-d${depth % 6}`;

  const entries = isContainer
    ? kind === 'object'
      ? Object.entries(value as Record<string, unknown>)
      : (value as unknown[]).map((v, i) => [String(i), v] as const)
    : [];

  const [open, setOpen] = useState(() => autoOpen(depth, entries.length));

  const addChild = () => {
    if (kind === 'object') onChange(setIn(value, [''], ''));
    else onChange(setIn(value, [entries.length], ''));
  };

  return (
    <div className="json-tree-node">
      <div className="json-tree-row">
        {isContainer ? (
          <button
            type="button"
            className="json-tree-toggle"
            aria-label={open ? '收起' : '展开'}
            onClick={() => setOpen(!open)}
          >
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="json-tree-toggle-space" />
        )}
        {name?.type === 'key' &&
          (readOnly ? (
            <span className={`json-tree-key ${colorClass}`}>{name.value}</span>
          ) : (
            <input
              type="text"
              className={`json-tree-key ${colorClass}`}
              value={name.value}
              aria-label="属性名"
              onChange={(e) => onRename?.(e.target.value)}
            />
          ))}
        {name?.type === 'index' && (
          <span className="json-tree-index">{name.value}</span>
        )}
        {!name && <span className="json-tree-root-label muted">root</span>}
        {isContainer ? (
          <>
            <span className={`json-tree-badge ${colorClass}`}>
              {kind === 'object' ? '{ }' : '[ ]'}
            </span>
            <span className="json-tree-meta muted">{entries.length} 项</span>
            {!readOnly && (
              <button type="button" className="json-tree-add" onClick={addChild}>
                +{kind === 'object' ? '属性' : '元素'}
              </button>
            )}
          </>
        ) : readOnly ? (
          <ReadOnlyValue value={value} />
        ) : (
          <ValueEditor value={value} onChange={onChange} />
        )}
        {!readOnly && onDelete && (
          <button
            type="button"
            className="json-tree-del"
            aria-label="删除节点"
            onClick={onDelete}
          >
            ✕
          </button>
        )}
      </div>
      {isContainer && open && (
        <div className="json-tree-children">
          {entries.map(([key, child], i) => (
            <JsonTreeNode
              key={i}
              value={child}
              depth={depth + 1}
              name={kind === 'object' ? { type: 'key', value: key } : { type: 'index', value: key }}
              readOnly={readOnly}
              autoOpen={autoOpen}
              onChange={(nv) => onChange(setIn(value, kind === 'object' ? [key] : [Number(key)], nv))}
              onDelete={
                readOnly
                  ? undefined
                  : () => onChange(removeIn(value, kind === 'object' ? [key] : [Number(key)]))
              }
              onRename={
                !readOnly && kind === 'object'
                  ? (nextKey) => onChange(renameIn(value, [], key, nextKey))
                  : undefined
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface Props {
  value: unknown;
  /** 只读时不会被调用，但保持必填以免编辑场景漏传后静默失效 */
  onChange: (value: unknown) => void;
  /** 隐藏增删改控件、值渲染成文本 */
  readOnly?: boolean;
  /** 初始展开判定，参数是 JsonTree 的 depth（根 = 1）与该容器的子项数 */
  autoOpen?: AutoOpen;
}

export default function JsonTree({
  value,
  onChange,
  readOnly = false,
  autoOpen = ALWAYS_OPEN,
}: Props) {
  return (
    <JsonTreeNode
      value={value}
      depth={1}
      onChange={onChange}
      readOnly={readOnly}
      autoOpen={autoOpen}
    />
  );
}
