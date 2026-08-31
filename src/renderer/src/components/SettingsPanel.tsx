import { useEffect, useState } from 'react';
import type { HttpsMode, Settings } from '../../../shared/types';
import { api } from '../lib/api';

export default function SettingsPanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [systemProxy, setSystemProxy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    api.settingsGet().then(setSettings).catch(() => {});
    api.systemProxyStatus().then(setSystemProxy).catch(() => setSystemProxy(false));
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
    </div>
  );
}
