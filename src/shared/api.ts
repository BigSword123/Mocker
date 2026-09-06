import type { CertInfo, CertInstallCommands, MockRule, ProxyStatus, RedirectRule, RenderContext, ReplayRequest, RuleAction, RuleInput, RulePatch, Scenario, Settings, TrafficEvent } from './types';

export interface Api {
  proxyStart(): Promise<void>;
  proxyStop(): Promise<void>;
  proxyStatus(): Promise<ProxyStatus>;
  rulesList(): Promise<MockRule[]>;
  rulesAdd(input: RuleInput): Promise<MockRule>;
  rulesUpdate(id: string, patch: RulePatch): Promise<MockRule>;
  rulesRemove(id: string): Promise<void>;
  rulesValidate(action: RuleAction): Promise<void>;
  templatePreview(payload: {
    text: string;
    context: RenderContext;
    fakerLocale?: string;
  }): Promise<{ rendered: string; warnings: string[] }>;
  settingsGet(): Promise<Settings>;
  settingsSet(patch: Partial<Settings>): Promise<Settings>;
  certInfo(): Promise<CertInfo>;
  certInstallCommands(): Promise<CertInstallCommands>;
  systemProxySet(enabled: boolean): Promise<void>;
  systemProxyStatus(): Promise<boolean>;
  appPlatform(): Promise<'macos' | 'windows' | 'other'>;
  replaySend(input: ReplayRequest, replayedFromId?: string): Promise<string>;
  harExport(payload: { events: TrafficEvent[]; defaultName: string }): Promise<{ saved: boolean; filePath?: string }>;
  harImport(): Promise<{ events: TrafficEvent[] | null }>;
  redirectsList(): Promise<RedirectRule[]>;
  redirectsAdd(input: Omit<RedirectRule, 'id' | 'priority'>): Promise<RedirectRule>;
  redirectsUpdate(id: string, patch: Partial<Omit<RedirectRule, 'id'>>): Promise<RedirectRule>;
  redirectsRemove(id: string): Promise<void>;
  scenariosList(): Promise<Scenario[]>;
  scenariosAdd(name: string): Promise<Scenario>;
  scenariosRename(oldName: string, newName: string): Promise<void>;
  scenariosSetEnabled(name: string, enabled: boolean): Promise<void>;
  /** moveTo 为目标场景名；null = 条目转为未分组 */
  scenariosRemove(name: string, moveTo: string | null): Promise<void>;
  scenariosReorder(names: string[]): Promise<void>;
  rulesResetSequence(ruleId: string): Promise<void>;
  openFileDialog(): Promise<string | null>;
}

declare global {
  interface Window {
    api: Api;
  }
}
