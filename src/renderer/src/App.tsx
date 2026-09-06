import { useEffect, useState } from 'react';
import StatusBar from './components/StatusBar';
import TrafficPanel from './components/TrafficPanel';
import RulesPanel from './components/RulesPanel';
import RedirectsPanel from './components/RedirectsPanel';
import DeviceGuide from './components/DeviceGuide';
import SettingsPanel from './components/SettingsPanel';
import { api } from './lib/api';
import { useTrafficStore } from './stores/traffic';

type Tab = 'traffic' | 'rules' | 'redirects' | 'device' | 'settings';

export default function App() {
  const [tab, setTab] = useState<Tab>('traffic');
  const connect = useTrafficStore((s) => s.connect);

  useEffect(() => {
    api.settingsGet().then((s) => connect(s.wsPort)).catch(() => {});
  }, [connect]);

  return (
    <div className="app">
      <StatusBar />
      <nav className="tabs">
        <button data-testid="traffic-tab" className={tab === 'traffic' ? 'active' : ''} onClick={() => setTab('traffic')}>流量</button>
        <button data-testid="rules-tab" className={tab === 'rules' ? 'active' : ''} onClick={() => setTab('rules')}>规则</button>
        <button data-testid="redirects-tab" className={tab === 'redirects' ? 'active' : ''} onClick={() => setTab('redirects')}>重定向</button>
        <button data-testid="device-tab" className={tab === 'device' ? 'active' : ''} onClick={() => setTab('device')}>设备接入</button>
        <button data-testid="settings-tab" className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>设置</button>
      </nav>
      <main className="content">
        {tab === 'traffic' && <TrafficPanel />}
        {tab === 'rules' && <RulesPanel />}
        {tab === 'redirects' && <RedirectsPanel />}
        {tab === 'device' && <DeviceGuide />}
        {tab === 'settings' && <SettingsPanel />}
      </main>
    </div>
  );
}
