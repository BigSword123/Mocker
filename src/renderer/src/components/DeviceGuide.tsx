import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useState } from 'react';
import type { CertInfo, ProxyStatus } from '../../../shared/types';
import { api } from '../lib/api';

export default function DeviceGuide() {
  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const [cert, setCert] = useState<CertInfo | null>(null);

  useEffect(() => {
    api.proxyStatus().then(setStatus).catch(() => {});
    api.certInfo().then(setCert).catch(() => {});
    const timer = setInterval(() => api.proxyStatus().then(setStatus).catch(() => {}), 3000);
    return () => clearInterval(timer);
  }, []);

  const ip = status?.localIps[0];
  const guideUrl = ip && status ? `http://${ip}:${status.port}` : '';

  return (
    <div className="panel guide">
      <h2>设备接入</h2>
      {!status?.running && <div className="text-err">代理未运行，请先在状态栏启动代理。</div>}
      {status?.running && ip && (
        <>
          <p>1. 手机与电脑连接同一网络。</p>
          <p>2. 手机系统代理设置为 <code>{ip}:{status.port}</code>。</p>
          <p>3. 手机浏览器扫码或访问 <code>{guideUrl}</code>，按页面指引安装证书。</p>
          <div style={{ margin: '16px 0', background: '#fff', padding: 12, display: 'inline-block', borderRadius: 8 }}>
            <QRCodeSVG value={guideUrl} size={180} />
          </div>
          <p>
            <button className="primary" onClick={() => window.open(`${guideUrl}/ca.pem`)}>下载根证书（本机）</button>
          </p>
          <p className="muted">
            HTTPS 抓包需在「设置」中把目标域名加入白名单（或切换全量解密模式）。
            {cert && ` 证书有效期至 ${new Date(cert.expiresAt).toLocaleDateString()}`}
          </p>
        </>
      )}
      <h3>已知限制</h3>
      <ul>
        <li>Android 7+ 应用默认不信任用户证书：仅 debuggable 或显式信任用户 CA 的应用可抓。</li>
        <li>SSL Pinning 应用无法抓包。</li>
        <li>iOS 需关闭 iCloud 私有中继。</li>
        <li>HTTP/3 (QUIC) 不走代理，无法抓取。</li>
      </ul>
    </div>
  );
}
