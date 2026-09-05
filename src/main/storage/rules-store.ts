import { randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { HeaderRow, MockRule, RuleInput, RulePatch } from '../../shared/types';
import { JsonStore } from './json-store';
import { migrateRules } from './migrate';

const MAX_SNAPSHOTS = 50;
const LEGACY_BACKUP_SUFFIX = '.v1-bak';

function cloneRows(rows: HeaderRow[]): HeaderRow[] {
  return rows.map((row) => ({ ...row }));
}

/**
 * Copies a rule deeply enough that a listed rule shares no mutable structure with the store.
 * Every nested container is checked before it is walked: migration normalises the persisted
 * shapes, but listing rules must not throw even if unexpected data ever reaches the store.
 */
function cloneRule(rule: MockRule): MockRule {
  const { query, headers, body } = rule.match;
  const base = {
    ...rule,
    match: {
      ...rule.match,
      ...(query ? { query: Array.isArray(query) ? cloneRows(query) : { ...query } } : {}),
      ...(headers ? { headers: Array.isArray(headers) ? cloneRows(headers) : { ...headers } } : {}),
      ...(body
        ? {
            body: {
              ...body,
              ...(Array.isArray(body.form) ? { form: cloneRows(body.form) } : {}),
            },
          }
        : {}),
    },
  } as MockRule;
  if (rule.action.kind === 'sequential') {
    base.action = {
      kind: 'sequential',
      responses: rule.action.responses.map((r) => ({ ...r, headers: { ...r.headers } })),
      ...(rule.action.fakerLocale !== undefined ? { fakerLocale: rule.action.fakerLocale } : {}),
    };
  } else {
    base.action = {
      ...rule.action,
      headers: { ...rule.action.headers },
      ...(rule.action.networkError ? { networkError: { ...rule.action.networkError } } : {}),
    };
  }
  return base;
}

export class RulesStore {
  private rules: MockRule[] = [];
  private readonly store: JsonStore<MockRule[]>;
  private readonly rulesPath: string;
  private readonly snapshotsDir: string;
  private listeners = new Set<() => void>();

  constructor(dataDir: string) {
    this.rulesPath = path.join(dataDir, 'rules.json');
    this.store = new JsonStore<MockRule[]>(this.rulesPath, []);
    this.snapshotsDir = path.join(dataDir, 'snapshots');
  }

  async load(): Promise<void> {
    const raw: unknown = await this.store.read();
    const { rules, skipped, changed } = migrateRules(raw);
    this.rules = rules;
    if (skipped > 0) {
      console.warn(
        `[rules-store] skipped ${skipped} unreadable rule(s) while migrating ${this.rulesPath}`,
      );
    }
    // A skipped entry always makes the output differ from the input, so `changed` covers it too.
    if (!changed) return;
    // The in-memory rules are already migrated, so persisting them is best-effort: an unwritable
    // data dir must not stop the app from starting, and the next mutation persists again anyway.
    if (!(await this.backupBeforeMigration())) return;
    try {
      await this.store.write(this.rules);
    } catch (err: unknown) {
      // keep the migrated rules in memory; the original file stays intact next to its backup
      console.warn(`[rules-store] could not write migrated rules to ${this.rulesPath}:`, err);
    }
  }

  /**
   * Makes the one-time exact copy of the pre-migration rules.json and reports whether rewriting
   * the file is safe. The exclusive copy keeps an existing backup (from an earlier migration)
   * untouched; a missing source file has nothing to protect. Any other failure means the original
   * is unprotected, so the caller must not rewrite it.
   */
  private async backupBeforeMigration(): Promise<boolean> {
    const backupPath = `${this.rulesPath}${LEGACY_BACKUP_SUFFIX}`;
    try {
      await fs.copyFile(this.rulesPath, backupPath, fsConstants.COPYFILE_EXCL);
      return true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOENT') return true;
      console.warn(
        `[rules-store] no migration backup at ${backupPath}, keeping ${this.rulesPath} as it is:`,
        err,
      );
      return false;
    }
  }

  list(): MockRule[] {
    return [...this.rules].sort((a, b) => a.priority - b.priority).map((r) => cloneRule(r));
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async add(input: RuleInput): Promise<MockRule> {
    const rule: MockRule = { ...input, id: randomUUID(), priority: this.nextPriority() };
    this.rules.push(rule);
    await this.persist();
    return rule;
  }

  async update(id: string, patch: RulePatch): Promise<MockRule> {
    const idx = this.rules.findIndex((r) => r.id === id);
    if (idx === -1) throw new Error(`rule not found: ${id}`);
    this.rules[idx] = { ...this.rules[idx], ...patch };
    await this.persist();
    return this.rules[idx];
  }

  async remove(id: string): Promise<void> {
    this.rules = this.rules.filter((r) => r.id !== id);
    await this.persist();
  }

  private nextPriority(): number {
    return this.rules.reduce((m, r) => Math.max(m, r.priority), 0) + 1;
  }

  private async persist(): Promise<void> {
    await this.store.write(this.rules);
    await this.snapshot();
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        // ignore listener errors so one bad listener cannot block others or the mutation
      }
    }
  }

  private async snapshot(): Promise<void> {
    await fs.mkdir(this.snapshotsDir, { recursive: true });
    await fs.writeFile(
      path.join(this.snapshotsDir, `rules-${Date.now()}-${randomUUID().slice(0, 8)}.json`),
      JSON.stringify(this.rules, null, 2),
      'utf8',
    );
    const files = (await fs.readdir(this.snapshotsDir))
      .map((f) => path.join(this.snapshotsDir, f))
      .sort();
    while (files.length > MAX_SNAPSHOTS) {
      await fs.unlink(files.shift()!);
    }
  }
}
