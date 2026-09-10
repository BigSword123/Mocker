import type { AdbOpResult, AdbStatus, CertInfo, CertInstallCommands, GzipFileResult, GzipMode, MapLocalSaveInput, MockRule, MonitorMode, ProxyStatus, RedirectRule, RenderContext, ReplayRequest, RuleAction, RuleInput, RulePatch, ScannedImage, Scenario, Settings, TrafficEvent, WebpWriteResult } from './types';

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
  /** 保存设置并重启代理；系统代理若由 mocker 设置，重启后自动重设 */
  settingsApply(patch: Partial<Settings>): Promise<Settings>;
  certInfo(): Promise<CertInfo>;
  certInstallCommands(): Promise<CertInstallCommands>;
  systemProxyStatus(): Promise<boolean>;
  monitorSetMode(mode: MonitorMode): Promise<{ mode: MonitorMode; notice?: string }>;
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
  maplocalSave(input: MapLocalSaveInput): Promise<string>;
  openFileDialog(): Promise<string | null>;
  openDirectoryDialog(): Promise<string | null>;
  gzipFile(mode: GzipMode, inputPath: string): Promise<GzipFileResult>;
  scanImages(dir: string): Promise<ScannedImage[]>;
  readImage(dir: string, relPath: string): Promise<Uint8Array>;
  writeWebp(outDir: string, outName: string, bytes: Uint8Array): Promise<WebpWriteResult>;
  adbStatus(): Promise<AdbStatus>;
  adbSetupTunnel(): Promise<AdbOpResult>;
  adbSetPhoneProxy(): Promise<AdbOpResult>;
  adbClearPhoneProxy(): Promise<AdbOpResult>;
}

declare global {
  interface Window {
    api: Api;
  }
}
