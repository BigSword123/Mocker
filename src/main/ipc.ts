import { BrowserWindow, dialog, ipcMain } from 'electron';
import * as fs from 'node:fs';
import { networkInterfaces } from 'node:os';
import type { ProxyServer } from './proxy/proxy-server';
import type { HistoryWriter } from './storage/history';
import type { RedirectsStore } from './storage/redirects-store';
import type { RulesStore } from './storage/rules-store';
import type { ScenariosStore } from './storage/scenarios-store';
import type { SettingsStore } from './storage/settings-store';
import { disableSystemProxy, enableSystemProxy, systemProxyEnabled } from './system-proxy';
import type { CaMaterial } from './certs/ca';
import { buildCertInstallCommands } from './certs/install-commands';
import type { RenderContext, ReplayRequest, RuleAction, RuleInput, RulePatch, Settings, TrafficEvent } from '../shared/types';
import type { OpenDialogOptions, SaveDialogOptions } from 'electron';
import { validateAction } from './rules/validate';
import { renderTemplate } from './rules/template';
import { fromHar, toHar } from '../shared/har';
import type { ReplayService } from './replay/replay';

export interface IpcContext {
  proxy: ProxyServer;
  rules: RulesStore;
  redirects: RedirectsStore;
  scenarios: ScenariosStore;
  settings: SettingsStore;
  ca: CaMaterial;
  history: HistoryWriter;
  dataDir: string;
  systemProxySetByUs: () => boolean;
  onSystemProxyChanged: (enabled: boolean) => void;
  replay: ReplayService;
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
  ipcMain.handle('rules:add', (_e, input: RuleInput) => {
    validateAction(input.action);
    return ctx.rules.add(input);
  });
  ipcMain.handle('rules:update', (_e, id: string, patch: RulePatch) => {
    if (patch.action) validateAction(patch.action);
    return ctx.rules.update(id, patch);
  });
  ipcMain.handle('rules:remove', (_e, id: string) => ctx.rules.remove(id));

  ipcMain.handle('rules:validate', (_e, action: RuleAction) => {
    validateAction(action);
  });

  ipcMain.handle(
    'template:preview',
    (_e, payload: { text: string; context: RenderContext; fakerLocale?: string }) => {
      const warnings: string[] = [];
      const rendered = renderTemplate(payload.text, payload.context, payload.fakerLocale, warnings);
      return { rendered, warnings };
    },
  );

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

  ipcMain.handle('app:platform', () =>
    process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'other',
  );

  ipcMain.handle('replay:send', (_e, input: ReplayRequest, replayedFromId?: string) =>
    ctx.replay.send(input, replayedFromId),
  );

  ipcMain.handle('har:export', async (_e, payload: { events: TrafficEvent[]; defaultName: string }) => {
    const { canceled, filePath } = await showSaveDialog({
      defaultPath: payload.defaultName,
      filters: [{ name: 'HAR', extensions: ['har'] }],
    });
    if (canceled || !filePath) return { saved: false as const };
    await fs.promises.writeFile(filePath, JSON.stringify(toHar(payload.events), null, 2), 'utf8');
    return { saved: true as const, filePath };
  });

  ipcMain.handle('har:import', async () => {
    const { canceled, filePaths } = await showOpenDialog({
      filters: [{ name: 'HAR', extensions: ['har'] }],
      properties: ['openFile'],
    });
    if (canceled || filePaths.length === 0) return { events: null };
    const text = await fs.promises.readFile(filePaths[0]!, 'utf8');
    return { events: fromHar(text) };
  });

  ipcMain.handle('dialog:open-file', async () => {
    const { canceled, filePaths } = await showOpenDialog({
      properties: ['openFile'],
    });
    if (canceled || filePaths.length === 0) return null;
    return filePaths[0]!;
  });

  ipcMain.handle('redirects:list', () => ctx.redirects.list());
  ipcMain.handle('redirects:add', (_e, input) => ctx.redirects.add(input));
  ipcMain.handle('redirects:update', (_e, id: string, patch) => ctx.redirects.update(id, patch));
  ipcMain.handle('redirects:remove', (_e, id: string) => ctx.redirects.remove(id));

  ipcMain.handle('scenarios:list', () => ctx.scenarios.list());
  ipcMain.handle('scenarios:add', (_e, name: string) => ctx.scenarios.add(name));
  ipcMain.handle('scenarios:rename', async (_e, oldName: string, newName: string) => {
    await ctx.scenarios.rename(oldName, newName);
    for (const r of ctx.rules.list()) {
      if (r.scenario === oldName) await ctx.rules.update(r.id, { scenario: newName });
    }
    for (const r of ctx.redirects.list()) {
      if (r.scenario === oldName) await ctx.redirects.update(r.id, { scenario: newName });
    }
  });
  ipcMain.handle('scenarios:set-enabled', (_e, name: string, enabled: boolean) => ctx.scenarios.setEnabled(name, enabled));
  ipcMain.handle('scenarios:remove', async (_e, name: string, moveTo: string | null) => {
    // 先校验去向再动手：目标不存在时整体放弃，不产生半删除状态
    if (moveTo !== null && moveTo !== name && !ctx.scenarios.list().some((s) => s.name === moveTo)) {
      throw new Error(`目标场景不存在: ${moveTo}`);
    }
    await ctx.scenarios.remove(name);
    const next = moveTo === null ? undefined : moveTo;
    for (const r of ctx.rules.list()) {
      if (r.scenario === name) await ctx.rules.update(r.id, { scenario: next });
    }
    for (const r of ctx.redirects.list()) {
      if (r.scenario === name) await ctx.redirects.update(r.id, { scenario: next });
    }
  });
  ipcMain.handle('scenarios:reorder', (_e, names: string[]) => ctx.scenarios.reorder(names));

  ipcMain.handle('rules:reset-sequence', (_e, ruleId: string) => {
    ctx.proxy.resetSequenceCounter(ruleId);
  });
}

async function showSaveDialog(opts: SaveDialogOptions) {
  const win = BrowserWindow.getFocusedWindow();
  return win ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts);
}

async function showOpenDialog(opts: OpenDialogOptions) {
  const win = BrowserWindow.getFocusedWindow();
  return win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts);
}
