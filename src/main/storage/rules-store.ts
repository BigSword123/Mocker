import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { MockRule, RuleInput, RulePatch } from '../../shared/types';
import { JsonStore } from './json-store';

const MAX_SNAPSHOTS = 50;

function cloneRule(rule: MockRule): MockRule {
  return {
    ...rule,
    match: {
      ...rule.match,
      ...(rule.match.query ? { query: { ...rule.match.query } } : {}),
      ...(rule.match.headers
        ? {
            headers: Array.isArray(rule.match.headers)
              ? rule.match.headers.map((h) => ({ ...h }))
              : { ...rule.match.headers },
          }
        : {}),
      ...(rule.match.body
        ? {
            body: {
              ...rule.match.body,
              ...(rule.match.body.form ? { form: rule.match.body.form.map((h) => ({ ...h })) } : {}),
            },
          }
        : {}),
    },
    action: {
      ...rule.action,
      headers: { ...rule.action.headers },
      ...(rule.action.networkError ? { networkError: { ...rule.action.networkError } } : {}),
    },
  };
}

export class RulesStore {
  private rules: MockRule[] = [];
  private readonly store: JsonStore<MockRule[]>;
  private readonly snapshotsDir: string;
  private listeners = new Set<() => void>();

  constructor(dataDir: string) {
    this.store = new JsonStore<MockRule[]>(path.join(dataDir, 'rules.json'), []);
    this.snapshotsDir = path.join(dataDir, 'snapshots');
  }

  async load(): Promise<void> {
    this.rules = await this.store.read();
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
