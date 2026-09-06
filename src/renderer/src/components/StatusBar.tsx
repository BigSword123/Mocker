import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProxyStatus, ThrottleSettings } from '../../../shared/types';
import { THROTTLE_PRESET_LABELS } from '../../../shared/types';
import { api } from '../lib/api';
import { useTrafficStore } from '../stores/traffic';

export default function StatusBar({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const [throttle, setThrottle] = useState<ThrottleSettings | null>(null);
  const connected = useTrafficStore((s) => s.connected);
  const refreshing = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      setStatus(await api.proxyStatus());
      api.settingsGet().then((s) => setThrottle(s.throttle)).catch(() => {});
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

  return (
    <div className="status-bar">
      <span className={`dot ${connected ? 'ok' : 'err'}`} title="实时连接" />
      <span>Mocker</span>
      <span className="spacer" />
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
