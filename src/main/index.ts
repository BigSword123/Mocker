import { app, BrowserWindow, dialog } from 'electron';
import { join } from 'node:path';
import { Bridge } from './bridge/ws-server';
import { ensureCa } from './certs/ca';
import { registerIpc } from './ipc';
import { ProxyServer } from './proxy/proxy-server';
import { HistoryWriter } from './storage/history';
import { RulesStore } from './storage/rules-store';
import { SettingsStore } from './storage/settings-store';
import { disableSystemProxy } from './system-proxy';

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

  const proxy = new ProxyServer({
    caKey: ca.keyPem,
    caCert: ca.certPem,
    getSettings: () => settings.get(),
    getRules: () => rules.list(),
    onEvent: (event) => {
      bridge.publish(event);
      history.write(event);
    },
  });

  registerIpc({
    proxy,
    rules,
    settings,
    ca,
    onSystemProxyChanged: (enabled) => {
      systemProxySetByUs = enabled;
    },
  });

  if (settings.get().autoStartProxy) {
    try {
      await proxy.start();
      history.openSession();
    } catch (err) {
      dialog.showErrorBox('代理启动失败', String(err));
    }
  }

  createWindow();

  app.on('before-quit', async (event) => {
    // Electron does not await async before-quit handlers, so prevent the quit,
    // run cleanup ourselves, then exit explicitly. The guard makes sure this
    // runs exactly once even if quit is triggered again mid-cleanup.
    if (cleaningUp) return;
    cleaningUp = true;
    event.preventDefault();
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

app.whenReady().then(bootstrap);
