import { contextBridge, ipcRenderer } from 'electron';
import type { Api } from '../shared/api';
import type { RedirectRule, RenderContext, ReplayRequest, RuleAction, RuleInput, RulePatch, Settings, TrafficEvent } from '../shared/types';

const api: Api = {
  proxyStart: () => ipcRenderer.invoke('proxy:start'),
  proxyStop: () => ipcRenderer.invoke('proxy:stop'),
  proxyStatus: () => ipcRenderer.invoke('proxy:status'),
  rulesList: () => ipcRenderer.invoke('rules:list'),
  rulesAdd: (input: RuleInput) => ipcRenderer.invoke('rules:add', input),
  rulesUpdate: (id: string, patch: RulePatch) => ipcRenderer.invoke('rules:update', id, patch),
  rulesRemove: (id: string) => ipcRenderer.invoke('rules:remove', id),
  rulesValidate: (action: RuleAction) => ipcRenderer.invoke('rules:validate', action),
  templatePreview: (payload: { text: string; context: RenderContext; fakerLocale?: string }) =>
    ipcRenderer.invoke('template:preview', payload),
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch: Partial<Settings>) => ipcRenderer.invoke('settings:set', patch),
  certInfo: () => ipcRenderer.invoke('cert:info'),
  certInstallCommands: () => ipcRenderer.invoke('cert:install-commands'),
  systemProxySet: (enabled: boolean) => ipcRenderer.invoke('system-proxy:set', enabled),
  systemProxyStatus: () => ipcRenderer.invoke('system-proxy:status'),
  appPlatform: () => ipcRenderer.invoke('app:platform'),
  replaySend: (input: ReplayRequest, replayedFromId?: string) =>
    ipcRenderer.invoke('replay:send', input, replayedFromId),
  harExport: (payload: { events: TrafficEvent[]; defaultName: string }) =>
    ipcRenderer.invoke('har:export', payload),
  harImport: () => ipcRenderer.invoke('har:import'),
  redirectsList: () => ipcRenderer.invoke('redirects:list'),
  redirectsAdd: (input) => ipcRenderer.invoke('redirects:add', input),
  redirectsUpdate: (id: string, patch) => ipcRenderer.invoke('redirects:update', id, patch),
  redirectsRemove: (id: string) => ipcRenderer.invoke('redirects:remove', id),
  scenariosList: () => ipcRenderer.invoke('scenarios:list'),
  scenariosAdd: (name) => ipcRenderer.invoke('scenarios:add', name),
  scenariosRename: (oldName, newName) => ipcRenderer.invoke('scenarios:rename', oldName, newName),
  scenariosSetEnabled: (name, enabled) => ipcRenderer.invoke('scenarios:set-enabled', name, enabled),
  scenariosRemove: (name, moveTo) => ipcRenderer.invoke('scenarios:remove', name, moveTo),
  scenariosReorder: (names) => ipcRenderer.invoke('scenarios:reorder', names),
  rulesResetSequence: (ruleId) => ipcRenderer.invoke('rules:reset-sequence', ruleId),
  openFileDialog: () => ipcRenderer.invoke('dialog:open-file'),
};

contextBridge.exposeInMainWorld('api', api);
