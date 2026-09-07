import { app, BrowserWindow, dialog, shell } from 'electron';
import { join } from 'node:path';
import { Bridge } from './bridge/ws-server';
import { ensureCa } from './certs/ca';
import { registerIpc } from './ipc';
import { ProxyServer } from './proxy/proxy-server';
import { ReplayService } from './replay/replay';
import { HistoryWriter } from './storage/history';
import { MapLocalStore } from './storage/maplocal-store';
import { RedirectsStore } from './storage/redirects-store';
import { RulesStore } from './storage/rules-store';
import { ScenariosStore } from './storage/scenarios-store';
import { SettingsStore } from './storage/settings-store';
import { AdbService } from './adb/adb-service';
import { disableSystemProxy, enableSystemProxy } from './system-proxy';
import type { Scenario, TrafficEvent } from '../shared/types';

// Held as a module-level reference so the window is not garbage-collected.
let mainWindow: BrowserWindow | null = null;
let systemProxySetByUs = false;
let cleaningUp = false;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

async function bootstrap(): Promise<void> {
  const dataDir = app.getPath('userData');

  const settings = new SettingsStore(dataDir);
  await settings.load();
  const rules = new RulesStore(dataDir);
  await rules.load();
  const ca = await ensureCa(dataDir);

  const history = new HistoryWriter(join(dataDir, 'history'));
  const bridge = new Bridge();
  await bridge.start(settings.get().wsPort);

  const onEvent = (event: TrafficEvent): void => {
    bridge.publish(event);
    history.write(event);
  };

  const redirects = new RedirectsStore(dataDir);
  const scenarios = new ScenariosStore(dataDir);
  const maplocal = new MapLocalStore(join(dataDir, 'maplocal'));
  await redirects.load();
  await scenarios.load();

  const scenariosMap = (): Map<string, Scenario> =>
    new Map(scenarios.list().map((s) => [s.name, s]));

  const proxy = new ProxyServer({
    caKey: ca.keyPem,
    caCert: ca.certPem,
    getSettings: () => settings.get(),
    getRules: () => rules.list(),
    getRedirects: () => redirects.list(),
    getScenarios: scenariosMap,
    onEvent,
  });

  const replay = new ReplayService({
    getRules: () => rules.list(),
    getRedirects: () => redirects.list(),
    getScenarios: scenariosMap,
    onEvent,
  });

  const adb = new AdbService();

  registerIpc({
    proxy,
    rules,
    redirects,
    maplocal,
    scenarios,
    settings,
    ca,
    history,
    dataDir,
    adb,
    systemProxySetByUs: () => systemProxySetByUs,
    onSystemProxyChanged: (enabled) => {
      systemProxySetByUs = enabled;
    },
    replay,
  });

  if (settings.get().autoStartProxy) {
    try {
      await proxy.start();
      history.openSession();
      // Best-effort cleanup of stale session files; never fail start over it.
      await history.prune().catch(() => {});

      const mode = settings.get().monitorMode;
      if (mode === 'computer') {
        try {
          await enableSystemProxy(proxy.port);
          systemProxySetByUs = true;
        } catch (err) {
          console.warn('自动恢复系统代理失败', err);
        }
      } else if (mode === 'phone') {
        try {
          const tunnel = await adb.setupTunnel(proxy.port);
          if (tunnel.ok) await adb.setPhoneProxy(proxy.port);
        } catch {
          // 没插线/没装 adb：静默跳过
        }
      }
    } catch (err) {
      dialog.showErrorBox('代理启动失败', String(err));
    }
  }

  createWindow();

  app.on('before-quit', async (event) => {
    // Electron does not await async before-quit handlers, so prevent the quit
    // on every entry (a second Cmd+Q mid-cleanup must not slip through), run
    // cleanup ourselves, then exit explicitly. The guard keeps cleanup to once.
    event.preventDefault();
    // Watchdog: a hung cleanup must not wedge quit forever.
    setTimeout(() => app.exit(0), 3000);
    if (cleaningUp) return;
    cleaningUp = true;
    try {
      // Restoring the OS proxy is highest priority: leaving it pointed at a
      // dead port breaks the user's internet.
      if (systemProxySetByUs) {
        try {
          await disableSystemProxy();
        } catch {
          // 退出时尽力恢复，失败忽略
        }
      }
      await history.closeSession();
      await proxy.stop();
      await bridge.stop();
    } finally {
      app.exit(0);
    }
  });
}

app.whenReady().then(bootstrap).catch((err) => {
  dialog.showErrorBox('Mocker 启动失败', String(err));
  app.exit(1);
});
