import { ipcMain } from 'electron';
import { networkInterfaces } from 'node:os';
import type { ProxyServer } from './proxy/proxy-server';
import type { HistoryWriter } from './storage/history';
import type { RulesStore } from './storage/rules-store';
import type { SettingsStore } from './storage/settings-store';
import { disableSystemProxy, enableSystemProxy, systemProxyEnabled } from './system-proxy';
import type { CaMaterial } from './certs/ca';
import { buildCertInstallCommands } from './certs/install-commands';
import type { RuleInput, RulePatch, Settings } from '../shared/types';

export interface IpcContext {
  proxy: ProxyServer;
  rules: RulesStore;
  settings: SettingsStore;
  ca: CaMaterial;
  history: HistoryWriter;
  dataDir: string;
  systemProxySetByUs: () => boolean;
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
    ctx.history.openSession();
    // Best-effort cleanup of stale session files; never fail start over it.
    await ctx.history.prune().catch(() => {});
  });
  ipcMain.handle('proxy:stop', async () => {
    // Restore the OS proxy first while the proxy still serves, so traffic is
    // never routed at a dead port. Only our own setting is ours to undo.
    if (ctx.systemProxySetByUs()) {
      try {
        await disableSystemProxy();
      } catch {
        // 尽力恢复，失败不阻塞停止流程
      }
      ctx.onSystemProxyChanged(false);
    }
    await ctx.proxy.stop();
    await ctx.history.closeSession();
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
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    if (patch.proxyPort !== undefined) {
      if (!Number.isInteger(patch.proxyPort) || patch.proxyPort < 1 || patch.proxyPort > 65535) {
        throw new Error('代理端口必须是 1-65535 的整数');
      }
    }
    return ctx.settings.set(patch);
  });

  ipcMain.handle('cert:info', () => ({ expiresAt: ctx.ca.notAfter.getTime() }));
  ipcMain.handle('cert:install-commands', () => buildCertInstallCommands(ctx.dataDir));

  ipcMain.handle('system-proxy:set', async (_e, enabled: boolean) => {
    if (enabled && !ctx.proxy.running) throw new Error('请先启动代理服务');
    if (enabled) {
      await enableSystemProxy(ctx.proxy.port);
    } else {
      await disableSystemProxy();
    }
    ctx.onSystemProxyChanged(enabled);
  });
  ipcMain.handle('system-proxy:status', () => systemProxyEnabled());
}
