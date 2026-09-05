import type { CertInfo, CertInstallCommands, MockRule, ProxyStatus, RenderContext, ReplayRequest, RuleAction, RuleInput, RulePatch, Settings, TrafficEvent } from './types';

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
}

declare global {
  interface Window {
    api: Api;
  }
}
