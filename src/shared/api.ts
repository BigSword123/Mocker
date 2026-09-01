import type { CertInfo, CertInstallCommands, MockRule, ProxyStatus, RuleInput, RulePatch, Settings } from './types';

export interface Api {
  proxyStart(): Promise<void>;
  proxyStop(): Promise<void>;
  proxyStatus(): Promise<ProxyStatus>;
  rulesList(): Promise<MockRule[]>;
  rulesAdd(input: RuleInput): Promise<MockRule>;
  rulesUpdate(id: string, patch: RulePatch): Promise<MockRule>;
  rulesRemove(id: string): Promise<void>;
  settingsGet(): Promise<Settings>;
  settingsSet(patch: Partial<Settings>): Promise<Settings>;
  certInfo(): Promise<CertInfo>;
  certInstallCommands(): Promise<CertInstallCommands>;
  systemProxySet(enabled: boolean): Promise<void>;
  systemProxyStatus(): Promise<boolean>;
}

declare global {
  interface Window {
    api: Api;
  }
}
