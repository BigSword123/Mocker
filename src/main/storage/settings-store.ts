import * as path from 'node:path';
import { DEFAULT_SETTINGS, type Settings } from '../../shared/types';
import { JsonStore } from './json-store';

export class SettingsStore {
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private readonly store: JsonStore<Settings>;
  private listeners = new Set<() => void>();

  constructor(dataDir: string) {
    this.store = new JsonStore<Settings>(path.join(dataDir, 'settings.json'), DEFAULT_SETTINGS);
  }

  async load(): Promise<void> {
    this.settings = await this.store.read();
  }

  get(): Settings {
    return { ...this.settings };
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async set(patch: Partial<Settings>): Promise<Settings> {
    this.settings = { ...this.settings, ...patch };
    await this.store.write(this.settings);
    for (const fn of this.listeners) fn();
    return this.get();
  }
}
