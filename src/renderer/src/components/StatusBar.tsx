import { useCallback, useEffect, useRef, useState } from 'react';
import type { MonitorMode, ProxyStatus, ThrottleSettings } from '../../../shared/types';
import { THROTTLE_PRESET_LABELS } from '../../../shared/types';
import { api } from '../lib/api';
import { useTrafficStore } from '../stores/traffic';

const MODE_LABELS: Record<MonitorMode, string> = { off: '关', phone: '手机', computer: '电脑' };
const MODES: MonitorMode[] = ['off', 'phone', 'computer'];

export default function StatusBar({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const [throttle, setThrottle] = useState<ThrottleSettings | null>(null);
  const [mode, setMode] = useState<MonitorMode>('off');
  const [notice, setNotice] = useState('');
  const connected = useTrafficStore((s) => s.connected);
  const refreshing = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      setStatus(await api.proxyStatus());
      api.settingsGet()
        .then((s) => {
          setThrottle(s.throttle);
          setMode(s.monitorMode);
        })
        .catch(() => {});
    } catch {
      // keep last known status
    } finally {
      refreshing.current = false;
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  const toggle = async () => {
    try {
      if (status?.running) await api.proxyStop();
      else await api.proxyStart();
      await refresh();
    } catch {
      // ignore; next refresh will recover the status
    }
  };

  const switchMode = async (next: MonitorMode) => {
    if (next === mode) return;
    try {
      const r = await api.monitorSetMode(next);
      setMode(r.mode);
      setNotice(r.notice ?? '');
      if (r.notice) setTimeout(() => setNotice(''), 5000);
      await refresh();
    } catch (err) {
      setNotice(String(err));
      setTimeout(() => setNotice(''), 5000);
    }
  };

  return (
    <div className="status-bar">
      <span className={`dot ${connected ? 'ok' : 'err'}`} title="实时连接" />
      <span>Mocker</span>
      <span className="spacer" />
      {notice && (
        <span data-testid="monitor-notice" className="text-warn">
          {notice}
        </span>
      )}
      <span data-testid="monitor-mode">
        {MODES.map((m) => (
          <button
            key={m}
            data-testid={`monitor-${m}`}
            className={m === mode ? 'text-ok' : undefined}
            onClick={() => switchMode(m)}
          >
            {MODE_LABELS[m]}
          </button>
        ))}
      </span>
      {throttle?.enabled && (
        <button data-testid="throttle-chip" className="text-warn" onClick={onOpenSettings}>
          {throttle.preset === 'custom'
            ? `限速:${throttle.downKbps}KB/s`
            : `限速:${THROTTLE_PRESET_LABELS[throttle.preset]}`}
        </button>
      )}
      {status && (
        <>
          <span className={status.running ? 'text-ok' : 'text-err'}>
            {status.running ? `代理运行中 :${status.port}` : '代理已停止'}
          </span>
          <button onClick={toggle}>{status.running ? '停止' : '启动'}</button>
        </>
      )}
    </div>
  );
}
