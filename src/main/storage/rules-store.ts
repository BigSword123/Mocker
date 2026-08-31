import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { MockRule, RuleInput, RulePatch } from '../../shared/types';
import { JsonStore } from './json-store';

const MAX_SNAPSHOTS = 50;

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
    return [...this.rules].sort((a, b) => a.priority - b.priority);
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
    return this.rules.length === 0 ? 1 : Math.max(...this.rules.map((r) => r.priority)) + 1;
  }

  private async persist(): Promise<void> {
    await this.store.write(this.rules);
    await this.snapshot();
    for (const fn of this.listeners) fn();
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
