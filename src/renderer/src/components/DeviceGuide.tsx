import { QRCodeSVG } from 'qrcode.react';
import { useCallback, useEffect, useState } from 'react';
import type { AdbOpResult, AdbStatus, CertInfo, ProxyStatus } from '../../../shared/types';
import { api } from '../lib/api';

export default function DeviceGuide() {
  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const [cert, setCert] = useState<CertInfo | null>(null);
  const [adb, setAdb] = useState<AdbStatus | null>(null);
  const [adbMsg, setAdbMsg] = useState('');
  const refreshAdb = useCallback(() => {
    api.adbStatus().then(setAdb).catch(() => setAdb(null));
  }, []);
  useEffect(() => {
    refreshAdb();
  }, [refreshAdb]);

  const runAdb = async (fn: () => Promise<AdbOpResult>) => {
    try {
      const r = await fn();
      setAdbMsg(r.message);
    } catch (err) {
      setAdbMsg(String(err));
    }
    refreshAdb();
  };
  const adbReady = !!adb?.adbAvailable && !!adb?.activeSerial;

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
      <h3>Android USB 直连（不同网段可用）</h3>
      <p className="muted">
        手机与电脑不在同一网络（如手机走流量）时，用数据线 + USB 调试把手机流量转到本机代理。HTTPS 抓包仍需手机先按上方流程安装证书。
      </p>
      <p>
        {adb === null && <span className="muted">检测 adb 中…</span>}
        {adb && !adb.adbAvailable && <span className="text-err">{adb.installHint}</span>}
        {adb?.adbAvailable && (
          <>
            <span className={adb.activeSerial ? 'text-ok' : 'text-err'}>
              {adb.activeSerial ? `设备 ${adb.activeSerial}` : '无已授权设备（连接数据线并在手机上允许 USB 调试）'}
            </span>
            {' · '}
            <span className={adb.tunnelActive ? 'text-ok' : ''}>隧道{adb.tunnelActive ? '已建立' : '未建立'}</span>
            {' · '}
            <span className={adb.phoneProxySet ? 'text-ok' : ''}>手机代理{adb.phoneProxySet ? '已设置' : '未设置'}</span>
          </>
        )}
      </p>
      <div className="toolbar">
        <button onClick={refreshAdb}>检测</button>
        <button data-testid="adb-tunnel" disabled={!adbReady} onClick={() => runAdb(() => api.adbSetupTunnel())}>建立隧道</button>
        <button data-testid="adb-proxy" disabled={!adbReady} onClick={() => runAdb(() => api.adbSetPhoneProxy())}>设置手机代理</button>
        <button data-testid="adb-clear" className="primary" disabled={!adbReady} onClick={() => runAdb(() => api.adbClearPhoneProxy())}>一键恢复手机网络</button>
      </div>
      {adbMsg && <p className="muted">{adbMsg}</p>}
      {status && (
        <>
          <h4>手动操作</h4>
          <CmdRow label="确认设备已连接（state 需为 device）" cmd="adb devices" />
          <CmdRow label="建立隧道（手机 127.0.0.1 → 电脑代理端口）" cmd={`adb reverse tcp:${status.port} tcp:${status.port}`} />
          <CmdRow label="设置手机全局代理" cmd={`adb shell settings put global http_proxy 127.0.0.1:${status.port}`} />
          <CmdRow label="验证隧道（应看到 tcp:端口映射）" cmd="adb reverse --list" />
          <CmdRow label="验证手机代理（应返回 127.0.0.1:端口）" cmd="adb shell settings get global http_proxy" />
          <CmdRow label="结束后清理（必做，否则手机断网）" cmd="adb shell settings put global http_proxy :0" />
          <CmdRow label="删除隧道（可选）" cmd={`adb reverse --remove tcp:${status.port}`} />
          <p className="muted">多设备时所有命令在 adb 后加 <code>-s &lt;serial&gt;</code>（serial 见 <code>adb devices</code>）。</p>
        </>
      )}
      <p className="text-warn">
        用完或拔线前务必点「一键恢复手机网络」，否则手机全局代理指向已失效端口会直接断网；拔线/重连后隧道失效，重新「建立隧道」即可。
      </p>
      <p className="muted">
        局限：绕过系统代理的应用（部分原生/游戏）与 QUIC（UDP 443）流量抓不到；此方案仅支持 Android。
      </p>
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

function CmdRow({ label, cmd }: { label?: string; cmd: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 剪贴板不可用时静默失败，用户可手动选中复制
    }
  };
  return (
    <div style={{ margin: '4px 0' }}>
      {label && <div className="muted">{label}</div>}
      <div className="cert-cmd-row">
        <code>{cmd}</code>
        <button onClick={copy}>{copied ? '已复制' : '复制'}</button>
      </div>
    </div>
  );
}
