import { describe, expect, it, vi } from 'vitest';
import { applyMonitorMode, type MonitorModeDeps } from '../src/main/monitor-mode';

function makeDeps(over: Partial<MonitorModeDeps> = {}): MonitorModeDeps {
  return {
    proxyRunning: vi.fn(() => true),
    startProxy: vi.fn(async () => {}),
    systemProxySetByUs: vi.fn(() => false),
    restoreSystemProxy: vi.fn(async () => {}),
    enableSystemProxy: vi.fn(async () => {}),
    setupPhoneProxy: vi.fn(async () => ({ ok: true, message: 'ok' })),
    clearPhoneProxy: vi.fn(async () => ({ ok: true, message: 'ok' })),
    persistMode: vi.fn(async () => {}),
    ...over,
  };
}

describe('applyMonitorMode', () => {
  it('phone: restores system proxy first, then sets phone proxy, persists mode', async () => {
    const d = makeDeps({ systemProxySetByUs: vi.fn(() => true) });
    const r = await applyMonitorMode('phone', d);
    expect(d.restoreSystemProxy).toHaveBeenCalledOnce();
    expect(d.setupPhoneProxy).toHaveBeenCalledOnce();
    expect(d.persistMode).toHaveBeenCalledWith('phone');
    expect(r.notice).toBeUndefined();
  });

  it('phone: device offline keeps mode persisted and surfaces adb message', async () => {
    const d = makeDeps({
      setupPhoneProxy: vi.fn(async () => ({ ok: false, message: '未检测到已授权设备' })),
    });
    const r = await applyMonitorMode('phone', d);
    expect(r.notice).toContain('未检测到已授权设备');
    expect(d.persistMode).toHaveBeenCalledWith('phone');
  });

  it('phone: starts proxy when not running', async () => {
    const d = makeDeps({ proxyRunning: vi.fn(() => false) });
    await applyMonitorMode('phone', d);
    expect(d.startProxy).toHaveBeenCalledOnce();
  });

  it('computer: clears phone proxy, enables system proxy, does not touch restore', async () => {
    const d = makeDeps();
    const r = await applyMonitorMode('computer', d);
    expect(d.clearPhoneProxy).toHaveBeenCalledOnce();
    expect(d.enableSystemProxy).toHaveBeenCalledOnce();
    expect(d.restoreSystemProxy).not.toHaveBeenCalled();
    expect(d.persistMode).toHaveBeenCalledWith('computer');
    expect(r.notice).toBeUndefined();
  });

  it('off: clears phone proxy and restores system proxy', async () => {
    const d = makeDeps({ systemProxySetByUs: vi.fn(() => true) });
    await applyMonitorMode('off', d);
    expect(d.clearPhoneProxy).toHaveBeenCalledOnce();
    expect(d.restoreSystemProxy).toHaveBeenCalledOnce();
    expect(d.persistMode).toHaveBeenCalledWith('off');
  });

  it('off: clearing phone proxy best-effort, failure adds no notice', async () => {
    const d = makeDeps({
      clearPhoneProxy: vi.fn(async () => ({ ok: false, message: '未检测到已授权设备' })),
    });
    const r = await applyMonitorMode('off', d);
    expect(r.notice).toBeUndefined();
    expect(d.persistMode).toHaveBeenCalledWith('off');
  });

  it('computer: enable failure surfaces notice but still persists', async () => {
    const d = makeDeps({
      enableSystemProxy: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const r = await applyMonitorMode('computer', d);
    expect(r.notice).toContain('boom');
    expect(d.persistMode).toHaveBeenCalledWith('computer');
  });
});
