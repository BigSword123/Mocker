import { useCallback, useEffect, useState } from 'react';
import type { ProxyStatus } from '../../../shared/types';
import { api } from '../lib/api';
import { useTrafficStore } from '../stores/traffic';

export default function StatusBar() {
  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const connected = useTrafficStore((s) => s.connected);

  const refresh = useCallback(async () => {
    setStatus(await api.proxyStatus());
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  const toggle = async () => {
    if (status?.running) await api.proxyStop();
    else await api.proxyStart();
    await refresh();
  };

  return (
    <div className="status-bar">
      <span className={`dot ${connected ? 'ok' : 'err'}`} title="实时连接" />
      <span>Mocker</span>
      <span className="spacer" />
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
