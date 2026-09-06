import { useEffect, useState } from 'react';
import type {
  CertInstallCommands,
  HttpsMode,
  Settings,
  ThrottlePreset,
  ThrottleSettings,
} from '../../../shared/types';
import { THROTTLE_PRESETS, THROTTLE_PRESET_LABELS } from '../../../shared/types';
import { api } from '../lib/api';

export default function SettingsPanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [systemProxy, setSystemProxy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [certCmds, setCertCmds] = useState<CertInstallCommands | null>(null);

  useEffect(() => {
    api.settingsGet().then(setSettings).catch(() => {});
    api.systemProxyStatus().then(setSystemProxy).catch(() => setSystemProxy(false));
    api.certInstallCommands().then(setCertCmds).catch(() => {});
  }, []);

  if (!settings) return <div className="panel muted">加载中…</div>;

  const save = async (patch: Partial<Settings>) => {
    setSaving(true);
    try {
      if (
        !Number.isInteger(settings.proxyPort) ||
        settings.proxyPort < 1 ||
        settings.proxyPort > 65535
      ) {
        setMessage('代理端口必须是 1-65535 的整数');
        return;
      }
      const next = await api.settingsSet(patch);
      setSettings(next);
      // 端口或模式变更后重启代理使其生效
      await api.proxyStop();
      await api.proxyStart();
      if (systemProxy) {
        await api.systemProxySet(true);
      }
      setMessage('已保存，代理已重启生效');
      setTimeout(() => setMessage(''), 3000);
    } catch (err) {
      setMessage(String(err));
    } finally {
      setSaving(false);
    }
  };

  const toggleSystemProxy = async () => {
    try {
      await api.systemProxySet(!systemProxy);
      setSystemProxy(!systemProxy);
    } catch (err) {
      setMessage(String(err));
    }
  };

  // 限速即时生效，不走 save() 的代理重启链路
  const saveThrottle = async (throttle: ThrottleSettings) => {
    setSaving(true);
    try {
      const next = await api.settingsSet({ throttle });
      setSettings(next);
      setMessage('限速设置已保存，即时生效');
      setTimeout(() => setMessage(''), 3000);
    } catch (err) {
      setMessage(String(err));
    } finally {
      setSaving(false);
    }
  };

  const patchThrottle = (p: Partial<ThrottleSettings>) => {
    if (!settings) return;
    const next = { ...settings.throttle, ...p };
    if (p.downKbps !== undefined || p.latencyMs !== undefined || p.jitterMs !== undefined) {
      next.preset = 'custom';
    }
    setSettings({ ...settings, throttle: next });
  };

  const applyThrottlePreset = (p: ThrottlePreset) => {
    if (!settings) return;
    if (p === 'custom') {
      setSettings({ ...settings, throttle: { ...settings.throttle, preset: 'custom' } });
      return;
    }
    setSettings({ ...settings, throttle: { ...settings.throttle, preset: p, ...THROTTLE_PRESETS[p] } });
  };

  return (
    <div className="panel">
      <div className="form-grid">
        <label>代理端口</label>
        <input
          type="number"
          min={1}
          max={65535}
          value={settings.proxyPort}
          onChange={(e) => setSettings({ ...settings, proxyPort: Number(e.target.value) })}
        />
        <label>HTTPS 模式</label>
        <select
          value={settings.httpsMode}
          onChange={(e) => setSettings({ ...settings, httpsMode: e.target.value as HttpsMode })}
        >
          <option value="whitelist">白名单（仅解密下列域名）</option>
          <option value="full">全量解密</option>
        </select>
        <label>白名单域名（每行一个）</label>
        <textarea
          rows={5}
          value={settings.whitelist.join('\n')}
          onChange={(e) =>
            setSettings({ ...settings, whitelist: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })
          }
        />
        <label>启动时自动开代理</label>
        <input
          type="checkbox"
          checked={settings.autoStartProxy}
          onChange={(e) => setSettings({ ...settings, autoStartProxy: e.target.checked })}
        />
        <label>系统代理</label>
        <div>
          <button onClick={toggleSystemProxy}>{systemProxy ? '关闭系统代理' : '开启系统代理'}</button>
        </div>
      </div>
      <div className="toolbar">
        <button
          className="primary"
          disabled={saving}
          onClick={() =>
            save({
              proxyPort: settings.proxyPort,
              httpsMode: settings.httpsMode,
              whitelist: settings.whitelist,
              autoStartProxy: settings.autoStartProxy,
            })
          }
        >
          保存并重启代理
        </button>
        {message && <span className="muted">{message}</span>}
      </div>
      <div className="cert-section">
        <h3>弱网限速</h3>
        <div className="form-grid">
          <label>启用限速</label>
          <input
            data-testid="throttle-enabled"
            type="checkbox"
            checked={settings.throttle.enabled}
            onChange={(e) =>
              setSettings({ ...settings, throttle: { ...settings.throttle, enabled: e.target.checked } })
            }
          />
          <label>预设</label>
          <select
            data-testid="throttle-preset"
            value={settings.throttle.preset}
            onChange={(e) => applyThrottlePreset(e.target.value as ThrottlePreset)}
          >
            {(Object.keys(THROTTLE_PRESET_LABELS) as ThrottlePreset[]).map((p) => (
              <option key={p} value={p}>
                {THROTTLE_PRESET_LABELS[p]}
              </option>
            ))}
          </select>
          <label>下行带宽（KB/s）</label>
          <input
            data-testid="throttle-down"
            type="number"
            min={1}
            value={settings.throttle.downKbps}
            onChange={(e) => patchThrottle({ downKbps: Number(e.target.value) })}
          />
          <label>延迟（ms）</label>
          <input
            data-testid="throttle-latency"
            type="number"
            min={0}
            value={settings.throttle.latencyMs}
            onChange={(e) => patchThrottle({ latencyMs: Number(e.target.value) })}
          />
          <label>抖动（ms）</label>
          <input
            data-testid="throttle-jitter"
            type="number"
            min={0}
            value={settings.throttle.jitterMs}
            onChange={(e) => patchThrottle({ jitterMs: Number(e.target.value) })}
          />
        </div>
        <div className="toolbar">
          <button className="primary" data-testid="throttle-save" disabled={saving} onClick={() => saveThrottle(settings.throttle)}>
            保存限速设置
          </button>
          <span className="muted">即时生效，无需重启代理</span>
        </div>
      </div>
      {certCmds && (
        <div className="cert-section">
          <h3>安装根证书（HTTPS 解密必需）</h3>
          <CertCmd
            label={`macOS${certCmds.platform === 'macos' ? '（当前系统）' : ''}`}
            note="在终端执行，需输入管理员密码"
            cmd={certCmds.macos}
          />
          <CertCmd
            label={`Windows${certCmds.platform === 'windows' ? '（当前系统）' : ''}`}
            note="在管理员权限的 CMD 中执行"
            cmd={certCmds.windows}
          />
        </div>
      )}
    </div>
  );
}

function CertCmd({ label, note, cmd }: { label: string; note: string; cmd: string }) {
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
    <div className="cert-cmd-block">
      <div className="cert-cmd-label">
        {label} <span className="muted">{note}</span>
      </div>
      <div className="cert-cmd-row">
        <code>{cmd}</code>
        <button onClick={copy}>{copied ? '已复制' : '复制'}</button>
      </div>
    </div>
  );
}
