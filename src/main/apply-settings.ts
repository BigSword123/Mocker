import type { Settings } from '../shared/types';

export interface ApplySettingsDeps {
  /** 系统代理是否由 mocker 设置；Clash 等第三方工具设的不算 */
  systemProxyOwnedByUs: () => boolean;
  settingsSet: (patch: Partial<Settings>) => Promise<Settings>;
  proxyStop: () => Promise<void>;
  proxyStart: () => Promise<void>;
  enableSystemProxy: () => Promise<void>;
}

// 端口 / HTTPS 模式 / 白名单 / 上游代理只在 ProxyServer.doStart() 里读取一次，
// 所以必须重启才生效；规则、重定向、场景、限速是实时读取的，不走这里。
export async function applySettings(
  patch: Partial<Settings>,
  d: ApplySettingsDeps,
): Promise<Settings> {
  const next = await d.settingsSet(patch);
  // 归属必须在 proxyStop 之前读取：停止代理会还原系统代理并把归属标记清成 false
  const reapply = d.systemProxyOwnedByUs();
  await d.proxyStop();
  await d.proxyStart();
  if (reapply) await d.enableSystemProxy();
  return next;
}
