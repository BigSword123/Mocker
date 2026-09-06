import * as path from 'node:path';
import type { Scenario } from '../../shared/types';
import { JsonStore } from './json-store';

const BUILTIN_DEFAULT: Scenario = { name: '默认', enabled: true, builtin: true };

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
      console.warn('[scenarios-store] failed to load, starting fresh:', err);
      this.scenarios = [];
    }
    // 默认组是恒存兜底分组：文件缺失或被手工删掉都要补种；追加在尾部，
    // 不打乱用户已持久化的场景顺序。
    if (!this.scenarios.some((s) => s.builtin)) {
      this.scenarios = [...this.scenarios, BUILTIN_DEFAULT];
      await this.persist();
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
    if (this.scenarios[idx]!.builtin) throw new Error('内置场景不可重命名');
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
    const target = this.scenarios.find((s) => s.name === name);
    if (!target) throw new Error(`场景不存在: ${name}`);
    if (target.builtin) throw new Error('内置场景不可删除');
    this.scenarios = this.scenarios.filter((s) => s.name !== name);
    await this.persist();
  }

  async reorder(names: string[]): Promise<void> {
    const current = this.scenarios.map((s) => s.name);
    const valid =
      names.length === current.length &&
      new Set(names).size === names.length &&
      names.every((n) => current.includes(n));
    if (!valid) throw new Error('reorder 名单必须与现有场景一一对应');
    const byName = new Map(this.scenarios.map((s) => [s.name, s] as const));
    this.scenarios = names.map((n) => byName.get(n)!);
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.store.write(this.scenarios);
  }
}
