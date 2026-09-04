import type { HeaderRow, MockRule, RuleBody } from '../../shared/types';

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

/** Migrates a persisted rule array, dropping entries that cannot be recovered. */
export function migrateRules(raw: unknown[]): RuleMigrationResult {
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

  // `enabled` / `priority` are required by the store (toggling and sorting); repair them rather
  // than dropping an otherwise usable rule.
  if (typeof draft.enabled !== 'boolean') {
    draft.enabled = draft.enabled === undefined ? false : Boolean(draft.enabled);
    changed = true;
  }
  if (typeof draft.priority !== 'number' || !Number.isFinite(draft.priority)) {
    draft.priority = 0;
    changed = true;
  }

  return { rule: draft as unknown as MockRule, changed };
}

/** Legacy `match.headers` records become one enabled HeaderRow per entry, in input order. */
function migrateHeaders(match: Record<string, unknown>): boolean {
  if (!isPlainObject(match.headers)) return false;
  match.headers = Object.entries(match.headers).map(
    ([name, value]): HeaderRow => ({
      enabled: true,
      name,
      value: String(value ?? ''),
      description: '',
    }),
  );
  return true;
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
