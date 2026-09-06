import { useState, type ReactNode } from 'react';
import { DND_MIME, type DragPayload } from '../lib/scenario-groups';

export interface MoveTarget {
  /** '' = 未分组 */
  value: string;
  label: string;
}

interface Props {
  /** 稳定 testid 前缀，如 group-默认 / group-ungrouped */
  testId: string;
  name: string;
  /** undefined = 未分组 */
  scenario: string | undefined;
  builtin: boolean;
  enabled: boolean | null;
  count: number;
  createLabel: string;
  moveTargets: MoveTarget[];
  /** 未分组不可作为排序拖拽源 */
  draggableScenario: boolean;
  onToggle?: (enabled: boolean) => void;
  onRename?: (newName: string) => void;
  onDelete?: (moveTo: string | null) => void;
  onCreateItem?: () => void;
  onDropPayload?: (payload: DragPayload) => void;
  children: ReactNode;
}

export default function ScenarioGroup({
  testId, name, scenario, builtin, enabled, count, createLabel, moveTargets,
  draggableScenario, onToggle, onRename, onDelete, onCreateItem, onDropPayload, children,
}: Props) {
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [moveTo, setMoveTo] = useState('');
  const [dropHover, setDropHover] = useState(false);

  const submitRename = () => {
    const next = nameDraft.trim();
    setRenaming(false);
    if (!next || next === name) return;
    onRename?.(next);
  };

  const acceptDrop = (e: React.DragEvent) => {
    const raw = e.dataTransfer.getData(DND_MIME);
    if (!raw) return;
    try {
      onDropPayload?.(JSON.parse(raw) as DragPayload);
    } catch {
      // 非本应用拖拽源，忽略
    }
  };

  return (
    <div
      className={`scenario-group${dropHover ? ' drop-hover' : ''}`}
      data-testid={testId}
      onDragOver={(e) => {
        if (!onDropPayload) return;
        e.preventDefault();
        setDropHover(true);
      }}
      onDragLeave={() => setDropHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropHover(false);
        acceptDrop(e);
      }}
    >
      <div
        className="scenario-head"
        data-testid={`${testId}-head`}
        draggable={draggableScenario}
        onDragStart={(e) => {
          if (!draggableScenario || scenario === undefined) return;
          e.dataTransfer.setData(
            DND_MIME,
            JSON.stringify({ type: 'scenario', value: scenario } satisfies DragPayload),
          );
          e.dataTransfer.effectAllowed = 'move';
        }}
      >
        <span className="drag-handle" aria-hidden="true">⠿</span>
        {enabled !== null && (
          <input
            type="checkbox"
            data-testid={`${testId}-toggle`}
            checked={enabled}
            aria-label={`场景 ${name} 启用`}
            onChange={(e) => onToggle?.(e.target.checked)}
          />
        )}
        {renaming ? (
          <input
            data-testid={`${testId}-rename-input`}
            value={nameDraft}
            autoFocus
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={submitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') {
                setNameDraft(name);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <span className="scenario-name" data-testid={`${testId}-name`} title={name}>{name}</span>
        )}
        <span className="muted">({count})</span>
        {!builtin && onRename && !renaming && (
          <button data-testid={`${testId}-rename`} onClick={() => { setNameDraft(name); setRenaming(true); }}>重命名</button>
        )}
        {!builtin && onDelete && !confirming && (
          <button
            data-testid={`${testId}-delete`}
            onClick={() => {
              setMoveTo(moveTargets[0]?.value ?? '');
              setConfirming(true);
            }}
          >删除</button>
        )}
        {confirming && (
          <span className="scenario-confirm">
            条目去向
            <select
              data-testid={`${testId}-move-to`}
              value={moveTo}
              onChange={(e) => setMoveTo(e.target.value)}
            >
              {moveTargets.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            <button data-testid={`${testId}-confirm-delete`} onClick={() => { setConfirming(false); onDelete?.(moveTo === '' ? null : moveTo); }}>确认删除</button>
            <button onClick={() => setConfirming(false)}>取消</button>
          </span>
        )}
      </div>
      <div className="scenario-body">{children}</div>
      {onCreateItem && (
        <div className="scenario-footer">
          <button data-testid={`${testId}-create`} onClick={onCreateItem}>{createLabel}</button>
        </div>
      )}
    </div>
  );
}
