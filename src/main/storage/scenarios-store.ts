import * as path from 'node:path';
import type { Scenario } from '../../shared/types';
import { JsonStore } from './json-store';

export class ScenariosStore {
  private store: JsonStore<Scenario[]>;
  private scenarios: Scenario[] = [];

  constructor(dataDir: string) {
    this.store = new JsonStore<Scenario[]>(path.join(dataDir, 'scenarios.json'), []);
  }

  async load(): Promise<void> {
    try {
      this.scenarios = await this.store.read();
    } catch (err) {
      console.warn('[scenarios-store] failed to load, starting empty:', err);
      this.scenarios = [];
    }
  }

  list(): Scenario[] {
    return this.scenarios.map((s) => ({ ...s }));
  }

  async add(name: string): Promise<Scenario> {
    if (this.scenarios.some((s) => s.name === name)) {
      throw new Error(`场景已存在: ${name}`);
    }
    const scenario: Scenario = { name, enabled: true };
    this.scenarios.push(scenario);
    await this.persist();
    return { ...scenario };
  }

  async rename(oldName: string, newName: string): Promise<void> {
    const idx = this.scenarios.findIndex((s) => s.name === oldName);
    if (idx === -1) throw new Error(`场景不存在: ${oldName}`);
    if (oldName !== newName && this.scenarios.some((s) => s.name === newName)) {
      throw new Error(`目标场景名已存在: ${newName}`);
    }
    this.scenarios[idx] = { ...this.scenarios[idx], name: newName };
    await this.persist();
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const idx = this.scenarios.findIndex((s) => s.name === name);
    if (idx === -1) throw new Error(`场景不存在: ${name}`);
    this.scenarios[idx] = { ...this.scenarios[idx], name, enabled };
    await this.persist();
  }

  async remove(name: string): Promise<void> {
    const before = this.scenarios.length;
    this.scenarios = this.scenarios.filter((s) => s.name !== name);
    if (this.scenarios.length === before) throw new Error(`场景不存在: ${name}`);
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.store.write(this.scenarios);
  }
}
