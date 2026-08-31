import { ipcMain } from 'electron';
import { networkInterfaces } from 'node:os';
import type { ProxyServer } from './proxy/proxy-server';
import type { RulesStore } from './storage/rules-store';
import type { SettingsStore } from './storage/settings-store';
import { disableSystemProxy, enableSystemProxy, systemProxyEnabled } from './system-proxy';
import type { CaMaterial } from './certs/ca';
import type { RuleInput, RulePatch, Settings } from '../shared/types';

export interface IpcContext {
  proxy: ProxyServer;
  rules: RulesStore;
  settings: SettingsStore;
  ca: CaMaterial;
  onSystemProxyChanged: (enabled: boolean) => void;
}

export function localIps(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i): i is NonNullable<typeof i> => !!i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

export function registerIpc(ctx: IpcContext): void {
  ipcMain.handle('proxy:start', async () => {
    await ctx.proxy.start();
  });
  ipcMain.handle('proxy:stop', async () => {
    await ctx.proxy.stop();
  });
  ipcMain.handle('proxy:status', () => ({
    running: ctx.proxy.running,
    port: ctx.proxy.port,
    localIps: localIps(),
  }));

  ipcMain.handle('rules:list', () => ctx.rules.list());
  ipcMain.handle('rules:add', (_e, input: RuleInput) => ctx.rules.add(input));
  ipcMain.handle('rules:update', (_e, id: string, patch: RulePatch) => ctx.rules.update(id, patch));
  ipcMain.handle('rules:remove', (_e, id: string) => ctx.rules.remove(id));

  ipcMain.handle('settings:get', () => ctx.settings.get());
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => ctx.settings.set(patch));

  ipcMain.handle('cert:info', () => ({ expiresAt: ctx.ca.notAfter.getTime() }));

  ipcMain.handle('system-proxy:set', async (_e, enabled: boolean) => {
    if (enabled) {
      await enableSystemProxy(ctx.proxy.port);
    } else {
      await disableSystemProxy();
    }
    ctx.onSystemProxyChanged(enabled);
  });
  ipcMain.handle('system-proxy:status', () => systemProxyEnabled());
}
