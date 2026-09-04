import type { BodyMode, HeaderRow, MockRule, RuleBody } from '../../shared/types';

/**
 * Result of migrating a persisted rule array.
 *
 * `rules` keeps the input order of every rule that could be migrated, `skipped` counts the
 * fundamentally invalid entries that were dropped. `changed` is an internal signal for the rules
 * store: it is true whenever the migrated output differs from the input (a rule was rewritten or an
 * entry was skipped) and therefore has to be persisted.
 */
export interface RuleMigrationResult {
  rules: MockRule[];
  skipped: number;
  changed: boolean;
}

interface MigratedRule {
  rule: MockRule;
  changed: boolean;
}

/**
 * Migrates one persisted rule into the current representation, or returns undefined when the
 * record is not recognisable as a rule at all. Pure: the input is never mutated and the output
 * shares no references with it.
 */
export function migrateRule(raw: unknown): MockRule | undefined {
  return migrateOne(raw)?.rule;
}

/**
 * Migrates a persisted rule array, dropping entries that cannot be recovered. The persisted file is
 * untrusted, so anything that is not an array yields an empty, unchanged result instead of throwing.
 */
export function migrateRules(raw: unknown): RuleMigrationResult {
  if (!Array.isArray(raw)) return { rules: [], skipped: 0, changed: false };
  const rules: MockRule[] = [];
  let skipped = 0;
  let changed = false;
  for (const entry of raw) {
    const migrated = migrateOne(entry);
    if (migrated === undefined) {
      skipped += 1;
      changed = true;
      continue;
    }
    if (migrated.changed) changed = true;
    rules.push(migrated.rule);
  }
  return { rules, skipped, changed };
}

function migrateOne(raw: unknown): MigratedRule | undefined {
  if (!isPlainObject(raw)) return undefined;
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string') return undefined;
  if (!isPlainObject(raw.match) || !isPlainObject(raw.action)) return undefined;

  const draft = deepClone(raw);
  if (draft === undefined) return undefined;

  let changed = false;
  const match = draft.match as Record<string, unknown>;
  if (migrateHeaders(match)) changed = true;
  if (migrateBody(match)) changed = true;
  if (normaliseBody(match)) changed = true;

  // `enabled` / `priority` are required by the store (toggling and sorting); repair them rather
  // than dropping an otherwise usable rule.
  if (typeof draft.enabled !== 'boolean') {
    draft.enabled = draft.enabled === undefined ? false : Boolean(draft.enabled);
    changed = true;
  }
  if (typeof draft.priority !== 'number' || !Number.isFinite(draft.priority)) {
    draft.priority = toPriority(draft.priority);
    changed = true;
  }

  return { rule: draft as unknown as MockRule, changed };
}

/**
 * Brings `match.headers` into the current representation. A legacy record becomes one enabled
 * HeaderRow per entry (in input order); an existing row array is only repaired where a malformed
 * row would break the matcher (`row.name.toLowerCase()`) or the store's cloning; anything else
 * (string, number, null, ...) is dropped because it cannot express a header constraint.
 */
function migrateHeaders(match: Record<string, unknown>): boolean {
  if (!('headers' in match)) return false;
  const headers = match.headers;
  if (isPlainObject(headers)) {
    match.headers = Object.entries(headers).map(
      ([name, value]): HeaderRow => ({
        enabled: true,
        name,
        value: toText(value),
        description: '',
      }),
    );
    return true;
  }
  if (Array.isArray(headers)) {
    const normalised = normaliseRows(headers);
    match.headers = normalised.rows;
    return normalised.changed;
  }
  delete match.headers;
  return true;
}

/** Drops entries that are not objects and repairs the remaining rows. */
function normaliseRows(rows: unknown[]): { rows: HeaderRow[]; changed: boolean } {
  const out: HeaderRow[] = [];
  let changed = false;
  for (const entry of rows) {
    if (!isPlainObject(entry)) {
      changed = true;
      continue;
    }
    const normalised = normaliseRow(entry);
    if (normalised.changed) changed = true;
    out.push(normalised.row);
  }
  return { rows: out, changed };
}

/**
 * Repairs only the fields whose type the matcher and the UI rely on, so a valid row is returned
 * unchanged (and keeps any extra stored field) instead of being rewritten.
 */
function normaliseRow(row: Record<string, unknown>): { row: HeaderRow; changed: boolean } {
  const out: Record<string, unknown> = { ...row };
  let changed = false;
  if (typeof out.enabled !== 'boolean') {
    // The matcher only honours `enabled === true`, so an unusable flag becomes a disabled row.
    out.enabled = out.enabled === undefined ? false : Boolean(out.enabled);
    changed = true;
  }
  if (typeof out.name !== 'string') {
    out.name = toText(out.name);
    changed = true;
  }
  if (typeof out.value !== 'string') {
    out.value = toText(out.value);
    changed = true;
  }
  if ('description' in out && typeof out.description !== 'string') {
    out.description = toText(out.description);
    changed = true;
  }
  return { row: out as unknown as HeaderRow, changed };
}

/** Header, query and form values are text; scalars keep their meaning, structures cannot. */
function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return '';
}

/**
 * Recovers the sort order from a priority that is not a usable number: a numeric string (a shape
 * older releases persisted) keeps its value, anything else - empty, non-numeric or non-finite -
 * falls back to the front of the list.
 */
function toPriority(value: unknown): number {
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/**
 * Legacy `match.bodyContains` becomes a raw/contains {@link RuleBody}. A body already stored in the
 * current representation wins; the legacy field is removed either way so the persisted rule only
 * carries the current representation.
 */
function migrateBody(match: Record<string, unknown>): boolean {
  if (!('bodyContains' in match)) return false;
  const legacy = match.bodyContains;
  delete match.bodyContains;
  if (!isPlainObject(match.body) && typeof legacy === 'string') {
    const body: RuleBody = { mode: 'raw', raw: legacy, matchStrategy: 'contains' };
    match.body = body;
  }
  return true;
}

const BODY_MODES = new Set<string>(['none', 'raw', 'form-data', 'urlencoded'] satisfies BodyMode[]);

/**
 * Makes `match.body` safe to clone and to match against: a body that is not an object cannot
 * express a constraint and is dropped, an unrecognised mode becomes `none` (which is what the
 * matcher already does with it), and `form` is reduced to well-formed rows so neither the store's
 * cloning nor the matcher can trip over a non-array `form` or a malformed row.
 */
function normaliseBody(match: Record<string, unknown>): boolean {
  if (!('body' in match)) return false;
  const body = match.body;
  if (!isPlainObject(body)) {
    delete match.body;
    return true;
  }
  let changed = false;
  if (!isBodyMode(body.mode)) {
    body.mode = 'none';
    changed = true;
  }
  if ('form' in body) {
    if (Array.isArray(body.form)) {
      const normalised = normaliseRows(body.form);
      body.form = normalised.rows;
      if (normalised.changed) changed = true;
    } else {
      delete body.form;
      changed = true;
    }
  }
  return changed;
}

function isBodyMode(value: unknown): value is BodyMode {
  return typeof value === 'string' && BODY_MODES.has(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep copy of the plain JSON shapes we persist, so migration can never leak references into or
 * out of its input. Returns undefined for pathological input (e.g. a cyclic object, which blows
 * the stack) so the caller can treat the rule as unmigratable.
 */
function deepClone(value: Record<string, unknown>): Record<string, unknown> | undefined {
  try {
    return cloneValue(value) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = cloneValue(value[key]);
    return out;
  }
  return value;
}
