import { describe, expect, it, vi } from 'vitest';
import { applySettings, type ApplySettingsDeps } from '../src/main/apply-settings';
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/types';

const PATCH: Partial<Settings> = { proxyPort: 9999 };
const NEXT: Settings = { ...DEFAULT_SETTINGS, proxyPort: 9999 };

function makeDeps(over: Partial<ApplySettingsDeps> = {}): ApplySettingsDeps {
  return {
    systemProxyOwnedByUs: vi.fn(() => false),
    settingsSet: vi.fn(async () => NEXT),
    proxyStop: vi.fn(async () => {}),
    proxyStart: vi.fn(async () => {}),
    enableSystemProxy: vi.fn(async () => {}),
    ...over,
  };
}

describe('applySettings', () => {
  it('saves then restarts the proxy in stop-before-start order', async () => {
    const order: string[] = [];
    const d = makeDeps({
      settingsSet: vi.fn(async () => {
        order.push('set');
        return NEXT;
      }),
      proxyStop: vi.fn(async () => {
        order.push('stop');
      }),
      proxyStart: vi.fn(async () => {
        order.push('start');
      }),
    });
    await expect(applySettings(PATCH, d)).resolves.toBe(NEXT);
    expect(d.settingsSet).toHaveBeenCalledWith(PATCH);
    expect(order).toEqual(['set', 'stop', 'start']);
  });

  it('re-applies the system proxy after restart when mocker owns it', async () => {
    const d = makeDeps({ systemProxyOwnedByUs: vi.fn(() => true) });
    await applySettings(PATCH, d);
    expect(d.enableSystemProxy).toHaveBeenCalledOnce();
  });

  it('leaves the system proxy alone when another tool owns it', async () => {
    // 回归 Bug B：Clash 等工具设的系统代理不得被劫持到 mocker 端口
    const d = makeDeps({ systemProxyOwnedByUs: vi.fn(() => false) });
    await applySettings(PATCH, d);
    expect(d.enableSystemProxy).not.toHaveBeenCalled();
  });

  it('snapshots ownership before stop, so a stop that clears the flag still re-applies', async () => {
    // 回归 Bug A：proxyStop 会还原系统代理并把归属标记清成 false，
    // 归属必须在停止之前读取，否则重启后不会重设，用户的系统代理被静默关掉
    let owned = true;
    const d = makeDeps({
      systemProxyOwnedByUs: () => owned,
      proxyStop: vi.fn(async () => {
        owned = false;
      }),
    });
    await applySettings(PATCH, d);
    expect(d.enableSystemProxy).toHaveBeenCalledOnce();
  });

  it('does not restart or read ownership when validation rejects the patch', async () => {
    const d = makeDeps({
      settingsSet: vi.fn(async () => {
        throw new Error('代理端口必须是 1-65535 的整数');
      }),
      systemProxyOwnedByUs: vi.fn(() => true),
    });
    await expect(applySettings(PATCH, d)).rejects.toThrow('代理端口必须是 1-65535 的整数');
    expect(d.systemProxyOwnedByUs).not.toHaveBeenCalled();
    expect(d.proxyStop).not.toHaveBeenCalled();
    expect(d.proxyStart).not.toHaveBeenCalled();
    expect(d.enableSystemProxy).not.toHaveBeenCalled();
  });
});
