import type { AdbOpResult, MonitorMode } from '../shared/types';

export interface MonitorModeDeps {
  proxyRunning: () => boolean;
  startProxy: () => Promise<void>;
  systemProxySetByUs: () => boolean;
  restoreSystemProxy: () => Promise<void>;
  enableSystemProxy: () => Promise<void>;
  setupPhoneProxy: () => Promise<AdbOpResult>;
  clearPhoneProxy: () => Promise<AdbOpResult>;
  persistMode: (mode: MonitorMode) => Promise<void>;
}

export interface MonitorModeResult {
  mode: MonitorMode;
  notice?: string;
}

function errText(err: unknown): string {
  return String((err as Error)?.message ?? err);
}

export async function applyMonitorMode(
  mode: MonitorMode,
  d: MonitorModeDeps,
): Promise<MonitorModeResult> {
  const notices: string[] = [];

  // 目标不是电脑模式时，先恢复系统代理（互斥：一次只监控一边）
  if (mode !== 'computer' && d.systemProxySetByUs()) {
    try {
      await d.restoreSystemProxy();
    } catch (err) {
      notices.push(`恢复系统代理失败：${errText(err)}`);
    }
  }

  // 目标不是手机模式时，尽力清掉手机代理
  if (mode !== 'phone') {
    try {
      await d.clearPhoneProxy();
    } catch {
      // 设备不在线等：尽力而为，静默
    }
  }

  if (mode === 'phone') {
    if (!d.proxyRunning()) await d.startProxy();
    const res = await d.setupPhoneProxy();
    if (!res.ok) notices.push(res.message);
  } else if (mode === 'computer') {
    if (!d.proxyRunning()) await d.startProxy();
    try {
      await d.enableSystemProxy();
    } catch (err) {
      notices.push(`设置系统代理失败：${errText(err)}`);
    }
  }

  await d.persistMode(mode);
  return { mode, notice: notices.length ? notices.join('；') : undefined };
}
