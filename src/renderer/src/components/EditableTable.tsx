import type { HeaderRow } from '../../../shared/types';

interface Columns {
  enabled?: boolean;
  namePlaceholder?: string;
  valuePlaceholder?: string;
  description?: boolean;
}

interface Props {
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
  columns?: Columns;
  ariaLabel?: string;
}

const EMPTY_ROW: HeaderRow = { enabled: true, name: '', value: '', description: '' };

export default function EditableTable({ rows, onChange, columns = {}, ariaLabel }: Props) {
  const showEnabled = columns.enabled !== false;
  const showDescription = columns.description !== false;

  const effective: HeaderRow[] = rows.length === 0 ? [EMPTY_ROW] : rows;
  const lastRow = effective[effective.length - 1];
  const needsTrailingEmpty =
    lastRow.name !== '' || lastRow.value !== '' || (lastRow.description ?? '') !== '';
  const visible = needsTrailingEmpty ? [...effective, { ...EMPTY_ROW }] : effective;

  const update = (idx: number, patch: Partial<HeaderRow>) => {
    const next = visible.map((r, i) => (i === idx ? { ...r, ...patch } : r));
    while (
      next.length > 1 &&
      next[next.length - 1].name === '' &&
      next[next.length - 1].value === '' &&
      (next[next.length - 1].description ?? '') === ''
    ) {
      next.pop();
    }
    onChange(next);
  };

  const remove = (idx: number) => {
    const next = visible.filter((_, i) => i !== idx);
    onChange(next.length === 0 ? [{ ...EMPTY_ROW }] : next);
  };

  return (
    <table className="editable-table" aria-label={ariaLabel}>
      <thead>
        <tr>
          {showEnabled && <th className="col-enabled"></th>}
          <th>名称</th>
          <th>值</th>
          {showDescription && <th>描述</th>}
          <th className="col-action"></th>
        </tr>
      </thead>
      <tbody>
        {visible.map((row, i) => (
          <tr key={i} className={!row.enabled ? 'disabled' : ''}>
            {showEnabled && (
              <td className="col-enabled">
                <input
                  type="checkbox"
                  checked={row.enabled}
                  onChange={(e) => update(i, { enabled: e.target.checked })}
                />
              </td>
            )}
            <td>
              <input
                value={row.name}
                placeholder={columns.namePlaceholder ?? 'Name'}
                onChange={(e) => update(i, { name: e.target.value })}
              />
            </td>
            <td>
              <input
                value={row.value}
                placeholder={columns.valuePlaceholder ?? 'Value'}
                onChange={(e) => update(i, { value: e.target.value })}
              />
            </td>
            {showDescription && (
              <td>
                <input
                  value={row.description ?? ''}
                  placeholder="Description"
                  onChange={(e) => update(i, { description: e.target.value })}
                />
              </td>
            )}
            <td className="col-action">
              <button type="button" aria-label="删除行" onClick={() => remove(i)}>
                ✕
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
