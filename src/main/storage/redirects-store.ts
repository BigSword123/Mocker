import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { RedirectRule } from '../../shared/types';
import { JsonStore } from './json-store';

export type RedirectInput = Omit<RedirectRule, 'id' | 'priority'>;
export type RedirectPatch = Partial<Omit<RedirectRule, 'id'>>;

export class RedirectsStore {
  private store: JsonStore<RedirectRule[]>;
  private rules: RedirectRule[] = [];

  constructor(dataDir: string) {
    this.store = new JsonStore<RedirectRule[]>(path.join(dataDir, 'redirects.json'), []);
  }

  async load(): Promise<void> {
    try {
      this.rules = await this.store.read();
    } catch (err) {
      console.warn('[redirects-store] failed to load, starting empty:', err);
      this.rules = [];
    }
  }

  list(): RedirectRule[] {
    return [...this.rules].sort((a, b) => a.priority - b.priority).map(cloneRule);
  }

  async add(input: RedirectInput): Promise<RedirectRule> {
    const rule: RedirectRule = { ...input, id: randomUUID(), priority: this.nextPriority() };
    this.rules.push(rule);
    await this.persist();
    return cloneRule(rule);
  }

  async update(id: string, patch: RedirectPatch): Promise<RedirectRule> {
    const idx = this.rules.findIndex((r) => r.id === id);
    if (idx === -1) throw new Error(`重定向规则不存在: ${id}`);
    this.rules[idx] = { ...this.rules[idx], ...patch };
    await this.persist();
    return cloneRule(this.rules[idx]!);
  }

  async remove(id: string): Promise<void> {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r.id !== id);
    if (this.rules.length === before) throw new Error(`重定向规则不存在: ${id}`);
    await this.persist();
  }

  private nextPriority(): number {
    return this.rules.reduce((m, r) => Math.max(m, r.priority), 0) + 1;
  }

  private async persist(): Promise<void> {
    await this.store.write(this.rules);
  }
}

function cloneRule(rule: RedirectRule): RedirectRule {
  return {
    ...rule,
    match: { ...rule.match },
  };
}
